/**
 * R-check — the kind→reaction map (the P2 safety gate) + the wake-latency
 * trial instrument (design-queue-delivery §6.4/§6.5).
 *
 * Run with: bun test/watch-reaction-map-check.ts   (from the extension dir)
 *
 * Checks:
 *   M1  The map: every kind of the closed WatchEventKind set declares its
 *       reaction class, and the classification matches the known truth
 *       (design-queue-delivery §6.4). The REACTION_OF_EVERY_KIND Record
 *       below is the build-time gate: a kind added without a reaction fails
 *       tsc (test/tsconfig.qa.json) — together with the map's own
 *       exhaustive switch (no default clause).
 *   M2  Consume-once ordering (the ack-before-advance rule): the map's
 *       consume-once-acked set is exactly {"worker-stale"}; the release ACK
 *       must exist before the close decision (evaluateRetire); the
 *       scheduled-wake ACK (markDelivered, id#run) lands BEFORE the durable
 *       cursor commit on a real send, and neither fires on a failed or a
 *       silent send. The marker-consumed-after-close ordering is pinned by
 *       retire-check R5.8c — not duplicated here.
 *   M3  The wake-latency trial line: exactly ONE line per real send, with
 *       both stamps and the non-negative delta; no line on a quiet tick, a
 *       failed send or a silent send; the pure format is pinned byte-exact.
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWatcher, evaluateRetire } from "../src/observe.ts";
import { formatWakeLatencyAuditLine } from "../src/watcher.ts";
import {
	wakeReactionClass,
	workersFromManifests,
	type WatchEvent,
	type WatchEventKind,
	type WakeReactionClass,
	type WatchSnapshot,
} from "../src/watch-detect.ts";
import type { DueWake, SchedulePort } from "../src/watch-schedule.ts";
import type { AgentStatus, Transport } from "../src/host.ts";
import { reportPathFor } from "../src/exchange.ts";
import { releasePathFor } from "../src/mailbox-store.ts";
import { type ExchangeManifest, type ManifestWorker } from "../src/manifest-store.ts";
import { answerPathFor, writeAnswer } from "../src/mailbox-store.ts";
import { answerPendingUnread, detectEvents } from "../src/watch-detect.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const TEST_SELF = "/tmp/sessions/check-self.jsonl";

// ---------------------------------------------------------------------------
// Fixtures — the minimal shapes (same builders as watcher-check, trimmed)
// ---------------------------------------------------------------------------

const FIX = mkdtempSync(join(tmpdir(), "watch-reaction-map-check-fix-"));

function taskDir(name: string): string {
	const dir = join(FIX, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function mkWorker(dir: string, name: string): ManifestWorker {
	return {
		name,
		placement: {
			kind: "worktree",
			workspaceId: "w1",
			paneId: "w1:p1",
			branch: `delegate/${name}`,
			checkoutPath: `/tmp/wt/${name}`,
		},
		briefPath: `${dir}/brief-${name}.md`,
		reportPath: reportPathFor(dir, name),
		provider: "p",
		model: "unknown-model",
		thinking: "low",
		startedAt: new Date(NOW - 10 * 60_000).toISOString(),
	};
}

function writeValidReport(dir: string, name: string): string {
	const p = reportPathFor(dir, name);
	writeFileSync(
		p,
		JSON.stringify({
			worker: name,
			status: "pass",
			summary: "done",
			artifacts: [],
			evidence: [{ claim: "c", file: "f.ts:1" }],
		}),
	);
	return p;
}

const LIVE = (name: string): AgentStatus => ({ name, status: "working" });
const DONE = (name: string): AgentStatus => ({ name, status: "done" });

function snapshotFor(workers: ManifestWorker[], statuses: AgentStatus[]): WatchSnapshot {
	const byDir = new Map<string, ManifestWorker[]>();
	for (const w of workers) {
		const dir = dirname(w.briefPath);
		byDir.set(dir, [...(byDir.get(dir) ?? []), w]);
	}
	const manifests = [...byDir].map(([dir, ws]) => {
		const manifest: ExchangeManifest = { task: dir.split("/").pop() ?? "task", dir, workers: ws };
		return manifest;
	});
	return workersFromManifests(manifests, statuses, { sessionFile: TEST_SELF }, NOW);
}

// ---------------------------------------------------------------------------
// M1. The kind → reaction map
// ---------------------------------------------------------------------------

// TYPE-LEVEL MIRROR (the build-time gate): if a kind is added to
// WatchEventKind without a reaction, this Record annotation fails to
// compile (tsc -p test/tsconfig.qa.json — the check suite's typecheck leg),
// together with the map's own exhaustive switch in src/watch-detect.ts.
// An obsolete key on a REMOVED kind fails the same way (excess property).
const REACTION_OF_EVERY_KIND: Record<WatchEventKind, WakeReactionClass> = {
	"report-ready": "idempotent",
	"report-invalid": "idempotent",
	"mailbox-question": "idempotent",
	"nudge-failed": "idempotent",
	"grill-deck": "idempotent",
	"context-critical": "idempotent",
	"worker-dead": "read-only",
	"provider-empty": "read-only",
	"fleet-in-flight": "read-only",
	"answer-pending": "read-only",
	"worker-stale": "consume-once-acked",
};

{
	let i = 0;
	for (const [kind, expected] of Object.entries(REACTION_OF_EVERY_KIND)) {
		i++;
		check(`M1.${i} ${kind} → ${expected}`, wakeReactionClass(kind as WatchEventKind) === expected);
	}
	check("M1.11 the closed kind set has 11 kinds (growth is the event the gate exists for)", i === 11, String(i));
}

// ---------------------------------------------------------------------------
// M2. Consume-once ordering — the ack-before-advance rule
// ---------------------------------------------------------------------------

{
	const consumeOnce = Object.entries(REACTION_OF_EVERY_KIND)
		.filter(([, c]) => c === "consume-once-acked")
		.map(([k]) => k);
	check("M2.1 the map's consume-once-acked set is exactly {worker-stale}", consumeOnce.length === 1 && consumeOnce[0] === "worker-stale", JSON.stringify(consumeOnce));

	// The release ACK must EXIST before the close decision (the destructive
	// reaction): the same retirable worker, with and without the marker.
	const dir = taskDir("ack-gate");
	const w = mkWorker(dir, "r-ack");
	writeValidReport(dir, "r-ack");
	const view = snapshotFor([w], [DONE("r-ack")]).workers[0]!;
	const noAck = evaluateRetire(view, { nowMs: NOW });
	check(
		"M2.2 no release marker → retirable but NO close decision (the ACK gates the reaction)",
		noAck.retirable && noAck.decision === undefined,
		JSON.stringify(noAck),
	);
	writeFileSync(releasePathFor(dir, "r-ack"), JSON.stringify({ from: "orchestrator", ts: "T" }));
	const ack = evaluateRetire(view, { nowMs: NOW });
	check("M2.3 the marker exists → decision ack (the reaction may proceed)", ack.decision?.reason === "ack", JSON.stringify(ack));
}

{
	// The in-tick ACK ordering: markDelivered (the id#run consume-once key)
	// lands BEFORE the durable cursor commit on a real send — and NEITHER
	// fires on a failed or a silent send.
	const dir = taskDir("tick-order");
	const w = mkWorker(dir, "w-order");
	writeValidReport(dir, "w-order");
	const snap = snapshotFor([w], [LIVE("w-order")]);
	const dueWake: DueWake = { id: "w1", run: 1, kind: "once", text: "wake", dueAtMs: NOW - 1_000 };
	const order: string[] = [];
	const schedulePort: SchedulePort = {
		dueWakes: () => [dueWake],
		markDelivered: (id, run) => order.push(`ack:${id}#${run}`),
	};
	const logs: string[] = [];
	const transport = { backendName: () => "herdr", listStatuses: async () => [LIVE("w-order")] } as unknown as Transport;

	const handle = createWatcher({
		transport,
		intervalMs: 3_600_000, // hand-driven ticks — the check never waits on a timer
		send: () => ({ delivered: true, mode: "sent" }),
		snapshot: async () => snap,
		journal: null,
		schedules: schedulePort,
		commitDelivery: async () => {
			order.push("commit");
		},
		self: { sessionFile: TEST_SELF },
		detect: { legacyFailOpen: true }, // the fixture worker carries no owner field
		log: (m) => logs.push(m),
	});
	const batch = await handle.tick();
	check("M2.4 the batch carries the event and the due wake", batch.length === 1 && batch[0].kind === "report-ready");
	check(
		"M2.5 ACK before advance: markDelivered lands BEFORE the cursor commit, each exactly once",
		order.length === 2 && order[0] === "ack:w1#1" && order[1] === "commit",
		JSON.stringify(order),
	);
	handle.stop();

	// Failed send: no ACK, no advance (the schedule stays pending, the cursor
	// is untouched — the re-fire discipline).
	const failOrder: string[] = [];
	const failLogs: string[] = [];
	const failHandle = createWatcher({
		transport,
		intervalMs: 3_600_000,
		send: () => {
			throw new Error("sink exploded");
		},
		snapshot: async () => snap,
		journal: null,
		schedules: { dueWakes: () => [dueWake], markDelivered: (id, run) => failOrder.push(`ack:${id}#${run}`) },
		commitDelivery: async () => {
			failOrder.push("commit");
		},
		self: { sessionFile: TEST_SELF },
		detect: { legacyFailOpen: true },
		log: (m) => failLogs.push(m),
	});
	await failHandle.tick();
	check("M2.6 failed send → neither the ACK nor the cursor advance fires", failOrder.length === 0, JSON.stringify(failOrder));
	failHandle.stop();

	// Silent send: the same refusal — silence is never a delivery.
	const silentOrder: string[] = [];
	const silentHandle = createWatcher({
		transport,
		intervalMs: 3_600_000,
		send: () => ({ delivered: false, mode: "silent" }),
		snapshot: async () => snap,
		journal: null,
		schedules: { dueWakes: () => [dueWake], markDelivered: (id, run) => silentOrder.push(`ack:${id}#${run}`) },
		commitDelivery: async () => {
			silentOrder.push("commit");
		},
		self: { sessionFile: TEST_SELF },
		detect: { legacyFailOpen: true },
		log: () => {},
	});
	await silentHandle.tick();
	check("M2.7 silent send → neither the ACK nor the cursor advance fires", silentOrder.length === 0, JSON.stringify(silentOrder));
	silentHandle.stop();
}

// ---------------------------------------------------------------------------
// M3. The wake-latency trial line
// ---------------------------------------------------------------------------

{
	// Pure format, byte-exact: the operator's grep target.
	const detectedAtMs = Date.parse("2026-09-06T12:00:00.000Z");
	const sentAtMs = detectedAtMs + 10_000;
	const e1 = { worker: "w1", dir: "/tmp/x", kind: "report-ready", message: "m" } as WatchEvent;
	const e2 = { worker: "w2", dir: "/tmp/x", kind: "mailbox-question", message: "m" } as WatchEvent;
	const wake: DueWake = { id: "w1", run: 2, kind: "periodic", text: "t", dueAtMs: detectedAtMs };
	const line = formatWakeLatencyAuditLine(detectedAtMs, sentAtMs, [e1, e2], [wake]);
	const expected =
		"wake-up latency: detected 2026-09-06T12:00:00.000Z → sent 2026-09-06T12:00:10.000Z (10000 ms) — 2 event(s) + 1 scheduled";
	check("M3.1 the trial line format is byte-exact (the operator's grep target)", line === expected, line);
	const eventsOnly = formatWakeLatencyAuditLine(detectedAtMs, sentAtMs, [e1], []);
	check(
		"M3.2 no scheduled wakes → the tail carries events only",
		eventsOnly === "wake-up latency: detected 2026-09-06T12:00:00.000Z → sent 2026-09-06T12:00:10.000Z (10000 ms) — 1 event(s)",
		eventsOnly,
	);
}

{
	// Through the loop: exactly ONE latency line per real send; none on a
	// quiet tick, a failed send or a silent send; the stamps parse and the
	// delta is the true sent−detected difference.
	const dir = taskDir("latency");
	const w = mkWorker(dir, "w-lat");
	let snap = snapshotFor([w], [LIVE("w-lat")]); // no report yet — the first tick stays quiet
	const logs: string[] = [];
	const transport = { backendName: () => "herdr", listStatuses: async () => [LIVE("w-lat")] } as unknown as Transport;
	const handle = createWatcher({
		transport,
		intervalMs: 3_600_000,
		send: () => ({ delivered: true, mode: "sent" }),
		snapshot: async () => snap,
		journal: null,
		schedules: null,
		self: { sessionFile: TEST_SELF },
		detect: { legacyFailOpen: true },
		log: (m) => logs.push(m),
	});

	check("M3.3 quiet tick → no latency line", (await handle.tick()).length === 0 && latencyLines(logs).length === 0);

	writeValidReport(dir, "w-lat");
	snap = snapshotFor([w], [LIVE("w-lat")]);
	await handle.tick();
	const lines = latencyLines(logs);
	check("M3.4 a real send → exactly ONE latency line", lines.length === 1, JSON.stringify(lines));
	const m = lines[0]?.match(/detected (\S+) → sent (\S+) \((\d+) ms\)/) ?? [];
	const detected = Date.parse(m[1] ?? "");
	const sent = Date.parse(m[2] ?? "");
	const delta = Number(m[3]);
	check(
		"M3.5 the line carries both ISO stamps and the true non-negative delta",
		Number.isFinite(detected) && Number.isFinite(sent) && sent >= detected && delta === sent - detected,
		lines[0] ?? "",
	);
	handle.stop();

	// Failed send: the send never happened → no latency line.
	const failLogs: string[] = [];
	const failHandle = createWatcher({
		transport,
		intervalMs: 3_600_000,
		send: () => {
			throw new Error("sink exploded");
		},
		snapshot: async () => snap,
		journal: null,
		schedules: null,
		self: { sessionFile: TEST_SELF },
		detect: { legacyFailOpen: true },
		log: (m) => failLogs.push(m),
	});
	await failHandle.tick();
	check("M3.6 failed send → no latency line (no real send, no trial datum)", latencyLines(failLogs).length === 0, JSON.stringify(failLogs));
	failHandle.stop();

	// Silent send: the same refusal.
	const silentLogs: string[] = [];
	const silentHandle = createWatcher({
		transport,
		intervalMs: 3_600_000,
		send: () => ({ delivered: false, mode: "silent" }),
		snapshot: async () => snap,
		journal: null,
		schedules: null,
		self: { sessionFile: TEST_SELF },
		detect: { legacyFailOpen: true },
		log: (m) => silentLogs.push(m),
	});
	await silentHandle.tick();
	check("M3.7 silent send → no latency line", latencyLines(silentLogs).length === 0, JSON.stringify(silentLogs));
	silentHandle.stop();
}

function latencyLines(logs: string[]): string[] {
	return logs.filter((l) => l.startsWith("wake-up latency:"));
}

// ---------------------------------------------------------------------------
// M3. answer-pending — the unread-answer wake class (the delivery round)
// ---------------------------------------------------------------------------

{
	// The condition is file-truth: the a-file exists, is valid, and postdates
	// the report (the drain rule's consumed definition, mailboxDrained). The
	// worker must be actively reachable (working/blocked) and uncollected.
	const dir = taskDir("answer-pending");
	const w = mkWorker(dir, "w-ans");
	const reportPath = writeValidReport(dir, "w-ans");
	// Backdate the report: the mtime comparisons are millisecond-resolution,
	// and the fixture writes would otherwise tie with the answer writes.
	utimesSync(reportPath, new Date(NOW - 60_000), new Date(NOW - 60_000));
	const live = () => snapshotFor([w], [LIVE("w-ans")]).workers[0]!;

	check("M3.1 no answer → no wake", answerPendingUnread(live()) === null);

	// The answer is posted AFTER the report → unread.
	writeFileSync(answerPathFor(dir, "w-ans"), JSON.stringify({ from: "orchestrator", ts: "2026-09-06T12:00:01.000Z", answer: "use plan B" }));
	const fp1 = answerPendingUnread(live());
	check("M3.2 an unread answer (newer than the report) → wake with the envelope ts as the fingerprint", fp1 === "2026-09-06T12:00:01.000Z", String(fp1));

	// The worker consumes the answer: its report mtime postdates the answer.
	writeValidReport(dir, "w-ans"); // rewrite the report → newer mtime
	check("M3.3 a consumed answer (report newer than the answer) → silent", answerPendingUnread(live()) === null);

	// A NEW answer re-arms (the fingerprint changes → the D1 reset forgets the
	// old key and the new one fires fresh).
	utimesSync(reportPath, new Date(NOW - 60_000), new Date(NOW - 60_000)); // re-backdate (ms ties)
	writeFileSync(answerPathFor(dir, "w-ans"), JSON.stringify({ from: "orchestrator", ts: "2026-09-06T12:00:02.000Z", answer: "also plan C" }));
	const fp2 = answerPendingUnread(live());
	check("M3.4 a NEW answer re-arms (fingerprint = the new envelope ts)", fp2 === "2026-09-06T12:00:02.000Z" && fp2 !== fp1, String(fp2));

	// Terminal workers are not woken (nobody home).
	const settled = snapshotFor([w], [DONE("w-ans")]).workers[0]!;
	check("M3.5 a settled (done) worker is not woken", answerPendingUnread(settled) === null);

	// A collected worker is not woken (already delivered — nobody to wake).
	const collected = { ...live(), collectedAt: "2026-09-06T11:00:00.000Z" };
	check("M3.6 a collected worker is not woken", answerPendingUnread(collected) === null);

	// A torn a-file degrades to no wake (total, never a throw).
	writeFileSync(answerPathFor(dir, "w-ans"), "{not json");
	check("M3.7 a torn a-file → no wake (tolerant, never a throw)", answerPendingUnread(live()) === null);

	// End-to-end through detectEvents: the event is emitted once, deduped on
	// the second tick (same fingerprint), and forgotten when consumed.
	utimesSync(reportPath, new Date(NOW - 60_000), new Date(NOW - 60_000)); // re-backdate (ms ties)
	writeFileSync(answerPathFor(dir, "w-ans"), JSON.stringify({ from: "orchestrator", ts: "2026-09-06T12:00:03.000Z", answer: "go" }));
	const seen = new Map();
	const snap = () => snapshotFor([w], [LIVE("w-ans")]);
	// The fixture manifest carries no owner fields → the canonical no-owner
	// verdict is fail-closed; the legacyFailOpen rollback is the fixture's
	// explicit stand-in for a real owner match (the ownership gate itself is
	// pinned by watcher-check, not here).
	const opts = { legacyFailOpen: true, selfSessionFile: TEST_SELF };
	const first = detectEvents(snap(), seen, opts);
	const second = detectEvents(snap(), seen, opts);
	check(
		"M3.8 detectEvents emits answer-pending once, dedupes the next tick",
		first.filter((e) => e.kind === "answer-pending").length === 1 && second.filter((e) => e.kind === "answer-pending").length === 0,
		JSON.stringify({ first: first.map((e) => e.kind), second: second.map((e) => e.kind) }),
	);
	writeValidReport(dir, "w-ans"); // the worker consumes the answer
	const third = detectEvents(snap(), seen, opts);
	check(
		"M3.9 consumption resets the key (the D1 rule — the condition turned false)",
		third.every((e) => e.kind !== "answer-pending"),
		JSON.stringify(third.map((e) => e.kind)),
	);
}

if (failures > 0) {
	console.error(`\nFAIL — ${failures} check(s) red`);
	process.exit(1);
}
console.log("\nALL PASS");
