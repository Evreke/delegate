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
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWatcher, evaluateRetire } from "../src/observe.ts";
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
import { releasePathFor, reportPathFor, type ExchangeManifest, type ManifestWorker } from "../src/exchange.ts";

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
	"worker-stale": "consume-once-acked",
};

{
	let i = 0;
	for (const [kind, expected] of Object.entries(REACTION_OF_EVERY_KIND)) {
		i++;
		check(`M1.${i} ${kind} → ${expected}`, wakeReactionClass(kind as WatchEventKind) === expected);
	}
	check("M1.11 the closed kind set has 10 kinds (growth is the event the gate exists for)", i === 10, String(i));
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

if (failures > 0) {
	console.error(`\nFAIL — ${failures} check(s) red`);
	process.exit(1);
}
console.log("\nALL PASS");
