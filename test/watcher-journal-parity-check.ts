/**
 * T-watcher-journal-parity — issue #26 acceptance 1.
 *
 * The watcher's durable dedup moved from the retired delivered-facts store
 * (`delivered-<key>.json`) to the journal cursor (`cursor-<key>.json`,
 * src/watch-cursor.ts). This harness proves:
 *
 *   P1. Parity: the same fixtures through the OLD pure detection
 *       (`detectEvents`) and through the NEW cursor-backed watcher produce the
 *       same event stream (kind, worker, fingerprint, message) — the wake-up
 *       formats and event names are unchanged.
 *   P2. Exactly-once across a restart: a second watcher mount (fresh memory)
 *       over the same fixtures delivers NOTHING — the cursor is the durable
 *       dedup.
 *   P3. `eventsAfter(cursor)` is the cursor read: the watcher reads the
 *       journal each tick and advances the cursor `seq` on a successful
 *       commit; a throwing reader SKIPS the tick (advisory, Law 8) and never
 *       touches the send.
 *   P4. The delivered-facts store is retired: a successful commit writes
 *       `cursor-<key>.json` and no `delivered-<key>.json` exists.
 *   P5. First-run migration: an absent cursor reads as seq 0 / no records —
 *       the documented bounded repeat volley (never seeded).
 *
 * Run with: bun test/watcher-journal-parity-check.ts
 * Exit 0 only if all checks pass.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import {
	createWatcher,
	detectEvents,
	workersFromManifests,
	type WatchEvent,
	type WatchSnapshot,
} from "../src/observe.ts";
import {
	cursorRecordKey,
	questionPathFor,
	readWatchCursor,
	reportPathFor,
	watcherKeyFor,
	watchCursorPathFor,
	type ExchangeManifest,
	type ManifestWorker,
} from "../src/exchange.ts";
import type { AgentStatus, Transport } from "../src/host.ts";
import { journalAudienceMatch, ownerFieldsFromJournalRows } from "../src/watch-role.ts";
import { resolveSwarmStorage, swarmSessionIdFor } from "../src/swarm/storage.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const FIX = mkdtempSync(join(tmpdir(), "watcher-journal-parity-"));
const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const SELF = "/tmp/sessions/parity-self.jsonl";

function taskDir(name: string): string {
	const dir = join(FIX, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function mkWorker(dir: string, name: string, over: Partial<ManifestWorker> = {}): ManifestWorker {
	return {
		name,
		placement: {
			kind: "worktree",
			workspaceId: "w1",
			paneId: "w1:p1",
			branch: `delegate/${name}`,
			checkoutPath: `/tmp/wt/${name}`,
		},
		briefPath: join(dir, `brief-${name}.md`),
		reportPath: reportPathFor(dir, name),
		provider: "p",
		model: "unknown-model",
		thinking: "low",
		startedAt: new Date(NOW - 10 * 60_000).toISOString(), // past the dead grace
		...over,
	};
}

function snapshotFor(workers: ManifestWorker[], statuses: AgentStatus[]): WatchSnapshot {
	const byDir = new Map<string, ManifestWorker[]>();
	for (const w of workers) {
		const dir = dirname(w.briefPath);
		byDir.set(dir, [...(byDir.get(dir) ?? []), w]);
	}
	const manifests: ExchangeManifest[] = [...byDir].map(([dir, ws]) => ({
		task: dir.split("/").pop() ?? "task",
		dir,
		workers: ws,
	}));
	// Legacy no-owner fixtures: the tests are not ABOUT ownership, so the
	// explicit fail-open rollback is on (the same default watcher-check uses).
	return workersFromManifests(manifests, statuses, {}, NOW);
}

function writeValidReport(dir: string, name: string): void {
	writeFileSync(
		reportPathFor(dir, name),
		JSON.stringify({ worker: name, status: "pass", summary: "done", artifacts: [], evidence: [{ claim: "c", file: "f.ts:1" }] }),
	);
}

function writeQuestion(dir: string, name: string, question: string): void {
	writeFileSync(questionPathFor(dir, name), JSON.stringify({ worker: name, ts: new Date(NOW).toISOString(), question }));
}

const eventId = (e: WatchEvent): string => `${e.kind}|${e.worker}|${e.fingerprint ?? ""}|${e.message}`;
const LIVE = (name: string): AgentStatus => ({ name, status: "working" });
const transportStub = { listStatuses: async () => [] } as unknown as Transport;

// ---------------------------------------------------------------------------
// Fixture: a report-ready, a mailbox-question, and a dead worker (a gauge
// kind derived from absence, not from a journal row) — one snapshot, three
// event classes, so parity covers both journal-shaped and gauge-shaped kinds.
// ---------------------------------------------------------------------------
const dir = taskDir("parity");
const wReport = mkWorker(dir, "w-report");
const wQuestion = mkWorker(dir, "w-question");
const wDead = mkWorker(dir, "w-dead");
writeValidReport(dir, "w-report");
writeQuestion(dir, "w-question", "which branch?");
const snap = snapshotFor([wReport, wQuestion, wDead], [LIVE("w-report"), LIVE("w-question")]);

const detectOpts = { nowMs: NOW, selfSessionFile: SELF, legacyFailOpen: true } as const;

// P1 — old pure detection.
const oldEvents = detectEvents(snap, new Map(), { ...detectOpts });

// P1 — new cursor-backed watcher, first tick (short interval, driven manually).
const sent: string[] = [];
const logs: string[] = [];
const handle = createWatcher({
	transport: transportStub,
	intervalMs: 3_600_000,
	send: (t: string) => {
		sent.push(t);
	},
	snapshot: async () => snap,
	self: { sessionFile: SELF },
	detect: { ...detectOpts },
	journal: null, // no real journal in this fixture; the read is covered by P3
	log: (m) => logs.push(m),
});
const newEvents = await handle.tick();

check(
	"P1.1 the new cursor-backed watcher delivers the SAME event set as old detection",
	JSON.stringify(newEvents.map(eventId).sort()) === JSON.stringify(oldEvents.map(eventId).sort()),
	`old=${JSON.stringify(oldEvents.map(eventId))} new=${JSON.stringify(newEvents.map(eventId))}`,
);
check("P1.2 exactly one batch send for the fixture", sent.length === 1, JSON.stringify(sent));
check(
	"P1.3 the batch message header/format is unchanged",
	sent[0]?.startsWith("DELEGATE WATCHER — 3 event(s) need attention"),
	sent[0] ?? "",
);

// P2 — restart: fresh watcher instance (fresh memory), same audience + files.
// The cursor committed by the first tick suppresses the re-delivery.
const sent2: string[] = [];
const handle2 = createWatcher({
	transport: transportStub,
	intervalMs: 3_600_000,
	send: (t: string) => {
		sent2.push(t);
	},
	snapshot: async () => snap,
	self: { sessionFile: SELF },
	detect: { ...detectOpts },
	journal: null,
	log: () => {},
});
const restarted = await handle2.tick();
check(
	"P2.1 a restarted watcher delivers NOTHING over the same fixtures (the cursor is the durable dedup)",
	restarted.length === 0 && sent2.length === 0,
	`${JSON.stringify(restarted.map(eventId))} ${JSON.stringify(sent2)}`,
);

// P4 — the cursor file exists, the delivered-facts store does not.
const cursorPath = watchCursorPathFor(dir, watcherKeyFor(SELF));
const deliveredPath = join(dir, `delivered-${watcherKeyFor(SELF)}.json`);
check("P4.1 a successful commit wrote cursor-<key>.json", existsSync(cursorPath), cursorPath);
check("P4.2 the retired delivered-facts file was NOT written", !existsSync(deliveredPath), deliveredPath);
const cursor = readWatchCursor(dir, watcherKeyFor(SELF));
check(
	"P4.3 the cursor holds one record per delivered event with the canonical key",
	Object.keys(cursor.records).length === newEvents.length &&
		newEvents.every((e) => cursor.records[cursorRecordKey(e.worker, e.kind, e.fingerprint ?? "")] !== undefined),
	JSON.stringify(cursor.records),
);
handle.stop();
handle2.stop();

// ---------------------------------------------------------------------------
// P3 — the journal cursor read: eventsAfter(cursor) is called each tick and
// the cursor seq advances to the last consumed row; a throwing reader skips
// the tick (advisory) without touching the send.
// ---------------------------------------------------------------------------
{
	const jdir = taskDir("journal-read");
	const jw = mkWorker(jdir, "w-journal");
	writeValidReport(jdir, "w-journal");
	const jsnap = snapshotFor([jw], [LIVE("w-journal")]);
	// The live fleet key is the journal's own (session_id, task) — the watcher
	// derives the same values from the task dir. A foreign row with a HIGHER
	// seq must NOT advance this audience's cursor (orchestrator ruling 2a).
	const sid = swarmSessionIdFor(jdir, resolveSwarmStorage());
	const jtask = basename(jdir);
	const rows = [
		{ seq: 1, ts: new Date(NOW).toISOString(), kind: "report" as const, sessionId: sid, task: jtask, worker: "w-journal", payload: {} },
		{ seq: 2, ts: new Date(NOW).toISOString(), kind: "collect" as const, sessionId: sid, task: jtask, worker: "w-journal", payload: {} },
		{ seq: 50, ts: new Date(NOW).toISOString(), kind: "spawn" as const, sessionId: "foreign-session", task: "foreign-task", worker: "w-foreign", payload: {} },
	];
	const seenCursors: number[] = [];
	const harness = createWatcher({
		transport: transportStub,
		intervalMs: 3_600_000,
		send: () => {},
		snapshot: async () => jsnap,
		self: { sessionFile: SELF },
		detect: { ...detectOpts },
		journal: {
			eventsAfter(cursorSeq: number) {
				seenCursors.push(cursorSeq);
				return rows.filter((r) => r.seq > cursorSeq);
			},
		},
		log: () => {},
	});
	await harness.tick();
	check("P3.1 the watcher reads eventsAfter(cursor) each tick (cursor starts at 0)", seenCursors[0] === 0, JSON.stringify(seenCursors));
	check(
		"P3.2 the cursor seq advances to the last consumed row of THIS audience's live fleet (a foreign row with seq 50 does NOT advance it)",
		readWatchCursor(jdir, watcherKeyFor(SELF)).seq === 2,
		String(readWatchCursor(jdir, watcherKeyFor(SELF)).seq),
	);
	const before = seenCursors.length;
	await harness.tick();
	check(
		"P3.3 the next tick reads eventsAfter(the advanced seq) — no re-read of consumed rows",
		seenCursors[before] === 2,
		JSON.stringify(seenCursors),
	);
	harness.stop();

	// Throwing reader → tick skipped, advisory only.
	const tdir = taskDir("journal-throw");
	const tw = mkWorker(tdir, "w-throw");
	writeValidReport(tdir, "w-throw");
	const tsnap = snapshotFor([tw], [LIVE("w-throw")]);
	const tsent: string[] = [];
	const tlogs: string[] = [];
	const tHandle = createWatcher({
		transport: transportStub,
		intervalMs: 3_600_000,
		send: (t: string) => {
			tsent.push(t);
		},
		snapshot: async () => tsnap,
		self: { sessionFile: SELF },
		detect: { ...detectOpts },
		journal: {
			eventsAfter() {
				throw new Error("journal exploded");
			},
		},
		log: (m) => tlogs.push(m),
	});
	const tEvents = await tHandle.tick();
	check(
		"P3.4 a throwing journal read SKIPS the tick (advisory, no send, no throw)",
		tEvents.length === 0 && tsent.length === 0,
		`${JSON.stringify(tEvents.map(eventId))} ${JSON.stringify(tsent)}`,
	);
	check(
		"P3.5 the skipped tick names the journal read failure in the audit line",
		tlogs.some((m) => /journal read failed/.test(m)),
		JSON.stringify(tlogs),
	);
	tHandle.stop();
}

// ---------------------------------------------------------------------------
// P5 — first-run migration: an absent cursor reads as seq 0 / no records.
// ---------------------------------------------------------------------------
{
	const mdir = taskDir("migration");
	check("P5.1 an absent cursor file reads as an EMPTY cursor", !existsSync(watchCursorPathFor(mdir, "deadbeef")));
	const empty = readWatchCursor(mdir, "deadbeef");
	check(
		"P5.2 the migration default is seq 0 with no records (never seeded → bounded repeat volley)",
		empty.seq === 0 && Object.keys(empty.records).length === 0,
		JSON.stringify(empty),
	);
}

// ---------------------------------------------------------------------------
// P6 — ownership verdicts as predicates over journal rows (same fail-closed
// semantics as the manifest-based workerAudienceMatch), SCOPED by the
// journal's own (session_id, task) fleet key.
// ---------------------------------------------------------------------------
{
	const scope = { sessionId: "s1", task: "t1" };
	const rows = [
		{ kind: "spawn", worker: "w1", seq: 1, sessionId: "s1", task: "t1", payload: { entry: { orchestratorSessionPath: SELF } } },
		{ kind: "spawn", worker: "w2", seq: 2, sessionId: "s1", task: "t1", payload: { entry: { orchestratorSessionPath: "/tmp/sessions/other.jsonl" } } },
	];
	check(
		"P6.1 a journal spawn row proving this session owns the worker → 'mine'",
		journalAudienceMatch(rows, "w1", scope, { sessionFile: SELF }, { legacyFailOpen: false }) === "mine",
	);
	check(
		"P6.2 a journal spawn row proving a FOREIGN owner → 'foreign' (untouched)",
		journalAudienceMatch(rows, "w2", scope, { sessionFile: SELF }, { legacyFailOpen: false }) === "foreign",
	);
	check(
		"P6.3 no journal row proving an owner → 'no-owner' (fail-closed, no configuration escape for no-self-id)",
		journalAudienceMatch(rows, "w3", scope, { sessionFile: SELF }, { legacyFailOpen: true }) === "no-owner",
	);
	check(
		"P6.4 a degraded self-id → 'no-self-id' even with legacyFailOpen",
		journalAudienceMatch(rows, "w1", scope, {}, { legacyFailOpen: true }) === "no-self-id",
	);
	check(
		"P6.5 garbage journal payloads prove nothing (tolerant) — 'no-owner'",
		Object.keys(ownerFieldsFromJournalRows([{ kind: "spawn", worker: "w9", seq: 9, sessionId: "s1", task: "t1", payload: "garbage" }], "w9", scope)).length === 0,
	);
	// Regression (orchestrator ruling 2b): a SAME-NAMED worker in a FOREIGN
	// fleet must never fold owner fields — scope is (session_id AND task).
	const foreignRows = [
		{ kind: "spawn", worker: "w1", seq: 10, sessionId: "s1", task: "t1", payload: { entry: { orchestratorSessionPath: SELF } } },
		{ kind: "spawn", worker: "w1", seq: 11, sessionId: "s2", task: "t1", payload: { entry: { orchestratorSessionPath: "/tmp/sessions/foreign.jsonl" } } },
		{ kind: "spawn", worker: "w1", seq: 12, sessionId: "s1", task: "t2", payload: { entry: { orchestratorSessionPath: "/tmp/sessions/foreign2.jsonl" } } },
	];
	const folded = ownerFieldsFromJournalRows(foreignRows, "w1", scope);
	check(
		"P6.6 a same-named worker in a foreign fleet (session_id OR task mismatch) does NOT fold owner fields",
		folded.orchestratorSessionPath === SELF,
		JSON.stringify(folded),
	);
	check(
		"P6.7 an unscoped read proves nothing (never worker-name alone)",
		Object.keys(ownerFieldsFromJournalRows(foreignRows, "w1", {})).length === 0,
	);
}

console.log(failures === 0 ? "\nwatcher-journal-parity: OK" : `\nwatcher-journal-parity: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);