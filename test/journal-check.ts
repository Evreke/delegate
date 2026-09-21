/**
 * Journal check — issue #22 acceptance (ARCHITECTURE §4.1.2).
 *
 * Run with: bun run test/journal-check.ts   (from the repo root)
 *
 * Checks:
 *   J1  Location + pinned DDL (Law 1/Law 7): `journalDbPath()` resolves under
 *       pi's `getAgentDir()` (never the exchange root); the v1 DDL is the
 *       pinned text (WAL, synchronous=FULL, busy_timeout=5000, user_version=1,
 *       table + fleet index).
 *   J2  Live schema: opening the writer stamps user_version=1 and the pinned
 *       connection pragmas; table + index exist.
 *   J3  Full lifecycle replayable from the journal alone (acceptance 1): a
 *       fleet's spawn/stamp/ask/answer/steer/progress/collect/retire plus the
 *       fleet-scoped reconcile-summary/compaction-marker replay to the same
 *       derived state through `eventsAfter(0)` only.
 *   J4  Cursor semantics (§4.1.2): `eventsAfter(cursor)` is strictly `seq >
 *       cursor`, ascending; per-task and per-worker reads are scoped.
 *   J5  Closed v1 kind set: exactly the 13 kinds; all accepted; an unknown
 *       kind is refused and stored nowhere.
 *   J6  Append-only by absence: no UPDATE/DELETE in the writer sources, no
 *       INSERT/UPDATE/DELETE in the reader, and no update/delete methods on
 *       either handle (the §4.1.2 compaction path is deferred).
 *   J7  Torn write (acceptance 1): a SIGKILLed writer child leaves the last
 *       committed record intact, its uncommitted record absent, and the
 *       database passes `PRAGMA integrity_check`.
 *   J8  Cross-process contention: the bounded jittered backoff is bounded; an
 *       append survives a held write lock once released; exhausting the budget
 *       returns `E_JOURNAL_BUSY` without throwing.
 *   J9  Advisory by contract (Law 8/Law 13): an unopenable database, a future
 *       user_version, a non-serializable payload, and an absent reader file all
 *       yield structured/empty results — never a throw.
 *
 * Fail-fast: a top-level watchdog exits non-zero no matter what.
 * Exit 0 only if all checks pass.
 */

import { Database } from "bun:sqlite";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	createJournalWriter,
	journalBackoffMs,
	journalDbPath,
	JOURNAL_DB_VERSION,
	JOURNAL_KINDS,
	JOURNAL_SCHEMA_V1_DDL,
	type JournalAppendInput,
} from "../src/swarm/journal.ts";
import { createJournalReader, type JournalEvent } from "../src/swarm/journal-read.ts";

const watchdog = setTimeout(() => {
	console.error("JOURNAL CHECK WATCHDOG FIRED (a step hung)");
	process.exit(1);
}, 20_000);
watchdog.unref();

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "journal-check-"));
const DB = join(SANDBOX, "events.db");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

/** Comment-stripped source (the append-only scan must see CODE, not prose). */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
		.replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

// ---------------------------------------------------------------------------
// J1 — location + pinned DDL
// ---------------------------------------------------------------------------

check(
	"J1.1 journalDbPath() is <agentDir>/delegate-journal/events.db (Law 1)",
	journalDbPath() === join(getAgentDir(), "delegate-journal", "events.db"),
	journalDbPath(),
);
{
	const src = readFileSync(resolve(ROOT, "src/swarm/journal.ts"), "utf8");
	check(
		"J1.2 the writer resolves the location through pi's getAgentDir() and never the exchange root",
		src.includes("getAgentDir()") && !src.includes("exchangeRoot"),
	);
	const pinned = [
		"PRAGMA journal_mode = WAL;",
		"PRAGMA synchronous = FULL;",
		"PRAGMA busy_timeout = 5000;",
		"PRAGMA user_version = 1;",
		"CREATE TABLE IF NOT EXISTS events",
		"seq        INTEGER PRIMARY KEY AUTOINCREMENT",
		"session_id TEXT NOT NULL",
		"payload    TEXT NOT NULL",
		"CREATE INDEX IF NOT EXISTS events_by_fleet ON events(session_id, task, seq);",
	];
	const missing = pinned.filter((p) => !JOURNAL_SCHEMA_V1_DDL.includes(p));
	check(
		`J1.3 JOURNAL_SCHEMA_V1_DDL is the §4.1.2 DDL and user_version=${JOURNAL_DB_VERSION}`,
		missing.length === 0 && JOURNAL_DB_VERSION === 1,
		missing.join(" | "),
	);
}

// ---------------------------------------------------------------------------
// J2 — live schema
// ---------------------------------------------------------------------------

const writer = createJournalWriter({ dbPath: DB });
{
	const raw = new Database(DB);
	const uv = raw.query("PRAGMA user_version").get() as { user_version: number };
	const jm = raw.query("PRAGMA journal_mode").get() as { journal_mode: string };
	const table = raw
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
		.get();
	const index = raw
		.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_by_fleet'")
		.get();
	// user_version and journal_mode are PERSISTENT database state; the
	// per-connection pragmas (synchronous, busy_timeout) cannot be read back
	// through a second connection — they are pinned textually by J1.3 and
	// behaviorally by J8.4.
	check(
		"J2.1 writer open stamps the persistent schema state: user_version=1, journal_mode=wal",
		uv.user_version === 1 && jm.journal_mode === "wal",
		JSON.stringify({ uv, jm }),
	);
	check("J2.2 events table + events_by_fleet index exist", !!table && !!index);
	raw.close();
}

// ---------------------------------------------------------------------------
// J3 — full lifecycle replayable from the journal alone
// ---------------------------------------------------------------------------

const SESSION = "sess-1";
const TASK = "task-a";

interface FleetState {
	workers: Map<string, { started: boolean; terminal: string | null; asks: number; answers: number; steers: number }>;
	reconcileSummaries: number;
	compactionMarkers: number;
	lastSeq: number;
}

function replay(events: JournalEvent[]): FleetState {
	const state: FleetState = {
		workers: new Map(),
		reconcileSummaries: 0,
		compactionMarkers: 0,
		lastSeq: 0,
	};
	for (const e of events) {
		state.lastSeq = Math.max(state.lastSeq, e.seq);
		if (e.worker) {
			const w = state.workers.get(e.worker) ?? {
				started: false,
				terminal: null,
				asks: 0,
				answers: 0,
				steers: 0,
			};
			if (e.kind === "spawn") w.started = true;
			if (e.kind === "ask") w.asks++;
			if (e.kind === "answer") w.answers++;
			if (e.kind === "steer") w.steers++;
			if (e.kind === "collect" || e.kind === "retire" || e.kind === "dead-reboot") {
				w.terminal = e.kind;
			}
			state.workers.set(e.worker, w);
		}
		if (e.kind === "reconcile-summary") state.reconcileSummaries++;
		if (e.kind === "compaction-marker") state.compactionMarkers++;
	}
	return state;
}

const lifecycle: JournalAppendInput[] = [
	{ kind: "spawn", sessionId: SESSION, task: TASK, worker: "w1", payload: { backend: "fake", placementRef: "fake:1", briefPath: "/x/brief-w1.md", briefText: "# brief w1" } },
	{ kind: "stamp", sessionId: SESSION, task: TASK, worker: "w1", payload: { field: "collectedAt", value: "2026-01-01T00:00:00.000Z" } },
	{ kind: "ask", sessionId: SESSION, task: TASK, worker: "w1", payload: { text: "q?" } },
	{ kind: "answer", sessionId: SESSION, task: TASK, worker: "w1", payload: { text: "a!" } },
	{ kind: "steer", sessionId: SESSION, task: TASK, worker: "w1", payload: { text: "go" } },
	{ kind: "progress", sessionId: SESSION, task: TASK, worker: "w1", payload: { phase: "working" } },
	{ kind: "spawn", sessionId: SESSION, task: TASK, worker: "w2", payload: { backend: "fake", placementRef: "fake:2", briefPath: "/x/brief-w2.md", briefText: "# brief w2" } },
	{ kind: "collect", sessionId: SESSION, task: TASK, worker: "w1", payload: { status: "pass", reportPath: "/x/report-w1.json", archivePath: "/a/report-w1.json" } },
	{ kind: "retire", sessionId: SESSION, task: TASK, worker: "w2", payload: { reason: "operator" } },
	{ kind: "reconcile-summary", sessionId: SESSION, task: TASK, payload: { lost: ["w2"], collectedBeforeLoss: 1 } },
	{ kind: "compaction-marker", sessionId: SESSION, task: TASK, payload: { exportedTo: "/a/fleet.jsonl", deletedCount: 2, lastDeletedSeq: 9 } },
];

const seqs: number[] = [];
for (const input of lifecycle) {
	const res = await writer.append(input);
	if (res.ok) seqs.push(res.seq);
	else failures++;
}
check("J3.1 every lifecycle append commits with an increasing seq", seqs.length === lifecycle.length && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.join(","));

{
	const reader = createJournalReader({ dbPath: DB });
	const events = reader.eventsAfter(0);
	const state = replay(events);
	const w1 = state.workers.get("w1");
	const w2 = state.workers.get("w2");
	check(
		"J3.2 the lifecycle replays from eventsAfter(0) alone: two workers, w1 collected, w2 retired",
		state.workers.size === 2 &&
			w1?.started === true &&
			w1?.terminal === "collect" &&
			w2?.started === true &&
			w2?.terminal === "retire",
		JSON.stringify({ size: state.workers.size, w1, w2 }),
	);
	check(
		"J3.3 mailbox facts and fleet-scoped events replay (w1 ask/answer/steer = 1/1/1, one summary, one marker)",
		w1?.asks === 1 && w1?.answers === 1 && w1?.steers === 1 && state.reconcileSummaries === 1 && state.compactionMarkers === 1,
		JSON.stringify({ w1, summaries: state.reconcileSummaries, markers: state.compactionMarkers }),
	);
	check("J3.4 lastSeq equals the final committed seq", state.lastSeq === seqs[seqs.length - 1], `${state.lastSeq} vs ${seqs[seqs.length - 1]}`);
	reader.close();
}

// ---------------------------------------------------------------------------
// J4 — cursor + per-task / per-worker reads
// ---------------------------------------------------------------------------

{
	const reader = createJournalReader({ dbPath: DB });
	const all = reader.eventsAfter(0);
	const after5 = reader.eventsAfter(5);
	const ascending = all.every((e, i) => i === 0 || e.seq > all[i - 1].seq);
	check(
		"J4.1 eventsAfter(cursor) returns strictly seq > cursor, ascending",
		all.length === lifecycle.length && ascending && after5.length === lifecycle.length - 5 && after5[0].seq === 6,
		`all=${all.length} after5=${after5.length}`,
	);
	check(
		"J4.2 eventsAfter(lastSeq) is empty (cursor exhaustion)",
		reader.eventsAfter(seqs[seqs.length - 1]).length === 0,
	);
	check(
		"J4.3 per-task read scopes to (sessionId, task)",
		reader.eventsForTask(SESSION, TASK).length === lifecycle.length &&
			reader.eventsForTask("other-session", TASK).length === 0,
	);
	const w1Events = reader.eventsForWorker(SESSION, TASK, "w1");
	const w2Events = reader.eventsForWorker(SESSION, TASK, "w2");
	check(
		"J4.4 per-worker read scopes to one worker and excludes fleet-scoped rows",
		w1Events.length === 7 && w1Events.every((e) => e.worker === "w1") && w2Events.length === 2,
		`w1=${w1Events.length} w2=${w2Events.length}`,
	);
	check(
		"J4.5 payloads round-trip as parsed JSON (spawn briefText preserved)",
		(w1Events[0]?.payload as { briefText?: string } | undefined)?.briefText === "# brief w1",
	);
	check("J4.6 count() and dbSizeBytes() expose retention visibility", reader.count() === lifecycle.length && reader.dbSizeBytes() > 0);
	reader.close();
}

// ---------------------------------------------------------------------------
// J5 — closed v1 kind set
// ---------------------------------------------------------------------------

const EXPECTED_KINDS = [
	"spawn",
	"stamp",
	"collect",
	"ask",
	"answer",
	"steer",
	"progress",
	"retire",
	"dead-reboot",
	"reconcile-summary",
	"compaction-marker",
	"termination-notice",
	"partial-report",
];
check(
	"J5.1 the kind set is exactly the 13 §4.1.2 kinds",
	JOURNAL_KINDS.length === 13 && EXPECTED_KINDS.every((k) => (JOURNAL_KINDS as readonly string[]).includes(k)),
	JOURNAL_KINDS.join(","),
);
{
	const kindsDb = join(SANDBOX, "kinds.db");
	const kw = createJournalWriter({ dbPath: kindsDb });
	let allAccepted = true;
	for (const kind of JOURNAL_KINDS) {
		const res = await kw.append({ kind, sessionId: "s", task: "t", payload: {} });
		if (!res.ok) allAccepted = false;
	}
	const bad = await kw.append({ kind: "not-a-kind" as never, sessionId: "s", task: "t" });
	const kr = createJournalReader({ dbPath: kindsDb });
	check(
		"J5.2 all 13 kinds are accepted; an unknown kind is refused and stored nowhere",
		allAccepted && bad.ok === false && bad.code === "E_JOURNAL_KIND" && kr.count() === 13,
		JSON.stringify({ allAccepted, bad, count: kr.count() }),
	);
	kr.close();
	kw.close();
}

// ---------------------------------------------------------------------------
// J6 — append-only enforced by absence
// ---------------------------------------------------------------------------

{
	const writerSrc = stripComments(readFileSync(resolve(ROOT, "src/swarm/journal.ts"), "utf8"));
	const readerSrc = stripComments(readFileSync(resolve(ROOT, "src/swarm/journal-read.ts"), "utf8"));
	const writeVerb = /\b(UPDATE|DELETE)\b/i;
	check(
		"J6.1 the writer module contains no UPDATE/DELETE statement (compaction deferred)",
		!writeVerb.test(writerSrc),
		(writerSrc.match(writeVerb) ?? []).join(","),
	);
	check(
		"J6.2 the reader module contains no INSERT/UPDATE/DELETE statement",
		!/\b(INSERT|UPDATE|DELETE)\b/i.test(readerSrc),
	);
	const reader = createJournalReader({ dbPath: DB });
	const writerKeys = Object.keys(writer);
	const readerKeys = Object.keys(reader);
	const mutationKey = (k: string) => /^(update|delete|remove|drop|clear)/i.test(k);
	check(
		"J6.3 neither handle exposes a mutation method (append-only by absence)",
		!writerKeys.some(mutationKey) && !readerKeys.some(mutationKey),
		`writer=${writerKeys.join(",")} reader=${readerKeys.join(",")}`,
	);
	reader.close();
}

// ---------------------------------------------------------------------------
// J7 — torn write: SIGKILL a writer mid-transaction
// ---------------------------------------------------------------------------

const CRASH_DB = join(SANDBOX, "crash.db");
const crashWriter = createJournalWriter({ dbPath: CRASH_DB });
await crashWriter.append({ kind: "spawn", sessionId: "sess-crash", task: "task-crash", worker: "committed", payload: {} });
crashWriter.close();

const CRASH_CHILD = `
import { Database } from "bun:sqlite";
const db = new Database(process.argv[1]);
db.exec("PRAGMA busy_timeout = 5000;");
db.run("INSERT INTO events(ts, kind, session_id, task, worker, payload) VALUES (?, ?, ?, ?, ?, ?)", ["2026-01-01T00:00:00.000Z", "progress", "sess-crash", "task-crash", "sentinel", "{}"]);
db.exec("BEGIN IMMEDIATE");
db.run("INSERT INTO events(ts, kind, session_id, task, worker, payload) VALUES (?, ?, ?, ?, ?, ?)", ["2026-01-01T00:00:01.000Z", "collect", "sess-crash", "task-crash", "torn", "{}"]);
process.kill(process.pid, "SIGKILL");
`;
const crash = spawnSync(process.execPath, ["-e", CRASH_CHILD, CRASH_DB], { encoding: "utf8", timeout: 15_000 });
{
	const raw = new Database(CRASH_DB);
	const integrity = raw.query("PRAGMA integrity_check").get() as { integrity_check: string };
	const torn = raw.query("SELECT COUNT(*) AS c FROM events WHERE worker = 'torn'").get() as { c: number };
	const sentinel = raw.query("SELECT COUNT(*) AS c FROM events WHERE worker = 'sentinel'").get() as { c: number };
	const committed = raw.query("SELECT COUNT(*) AS c FROM events WHERE worker = 'committed'").get() as { c: number };
	raw.close();
	check(
		"J7.1 the child reached its uncommitted insert (its committed sentinel survived the SIGKILL)",
		sentinel.c === 1 && committed.c === 1,
		JSON.stringify({ sentinel, committed }),
	);
	check(
		"J7.2 the uncommitted (torn) record is absent after the crash",
		torn.c === 0,
		JSON.stringify(torn),
	);
	check(
		"J7.3 the database passes PRAGMA integrity_check (never corrupt)",
		integrity.integrity_check === "ok" && (crash.signal === "SIGKILL" || crash.status !== 0),
		`integrity=${integrity.integrity_check} signal=${crash.signal} status=${crash.status}`,
	);
	const reader = createJournalReader({ dbPath: CRASH_DB });
	check("J7.4 the reader replays the surviving records after the crash", reader.eventsAfter(0).length === 2);
	reader.close();
}

// ---------------------------------------------------------------------------
// J8 — cross-process contention: bounded jittered backoff
// ---------------------------------------------------------------------------

check(
	"J8.1 journalBackoffMs is bounded by maxMs and jitter-dependent",
	journalBackoffMs(0, () => 0) === 10 &&
		journalBackoffMs(0, () => 1) === 20 &&
		journalBackoffMs(9, () => 1, { maxMs: 100 }) === 100 &&
		journalBackoffMs(3, () => 1, { baseMs: 5, maxMs: 40 }) === 40,
);
{
	const lockDb = join(SANDBOX, "lock.db");
	const seed = createJournalWriter({ dbPath: lockDb });
	seed.close();

	// The writers are opened BEFORE any lock is taken: opening runs the pinned
	// DDL (`PRAGMA journal_mode = WAL`), which itself waits on a held write
	// lock — so only the append below may be the contended operation.
	const contending = createJournalWriter({ dbPath: lockDb, busyTimeoutMs: 1, retry: { attempts: 6, baseMs: 10, maxMs: 100 } });
	const holder = new Database(lockDb);
	holder.exec("PRAGMA busy_timeout = 0;");
	holder.exec("BEGIN IMMEDIATE");
	holder.run("INSERT INTO events(ts, kind, session_id, task, worker, payload) VALUES (?, ?, ?, ?, ?, ?)", ["t", "spawn", "s", "t", "holder", "{}"]);

	const pending = contending.append({ kind: "progress", sessionId: "s", task: "t", worker: "late", payload: {} });
	await new Promise((r) => setTimeout(r, 5));
	holder.exec("ROLLBACK");
	const res = await pending;
	check(
		"J8.2 an append survives a held write lock: bounded retry succeeds once the lock is released",
		res.ok === true,
		JSON.stringify(res),
	);
	contending.close();

	const exhausting = createJournalWriter({ dbPath: lockDb, busyTimeoutMs: 1, retry: { attempts: 3, baseMs: 1, maxMs: 2 } });
	holder.exec("BEGIN IMMEDIATE");
	const exhausted = await exhausting.append({ kind: "progress", sessionId: "s", task: "t", worker: "never", payload: {} });
	holder.exec("ROLLBACK");
	holder.close();
	check(
		"J8.3 exhausting the retry budget returns E_JOURNAL_BUSY (bounded, never throws)",
		exhausted.ok === false && exhausted.code === "E_JOURNAL_BUSY" && exhausted.attempts === 3,
		JSON.stringify(exhausted),
	);
	exhausting.close();

	// J8.4 — the pinned busy_timeout=5000 is ACTIVE. The lock must be held by a
	// SEPARATE PROCESS: `append()`'s single INSERT is synchronous, so a
	// same-process holder could never release the lock while the busy handler
	// blocks the event loop. The child holds BEGIN IMMEDIATE, marks a flag file,
	// then releases after 150 ms; a single-attempt writer with the default
	// connection timeout must WAIT for the lock and commit (a writer without the
	// busy handler would return E_JOURNAL_BUSY immediately).
	const btDb = join(SANDBOX, "busy-timeout.db");
	const btSeed = createJournalWriter({ dbPath: btDb });
	btSeed.close();
	// Open the waiting writer BEFORE the lock is taken: the open itself runs
	// the pinned DDL (journal_mode WAL) and can absorb a busy wait, which would
	// otherwise mask whether `append()` waited.
	const waiting = createJournalWriter({ dbPath: btDb, retry: { attempts: 1 } });
	const lockFlag = join(SANDBOX, "lock.flag");
	const HOLDER_CHILD = `
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const db = new Database(process.argv[1]);
db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
writeFileSync(process.argv[2], "locked");
setTimeout(() => { db.exec("ROLLBACK"); process.exit(0); }, 150);
`;
	const holderProc = spawn(process.execPath, ["-e", HOLDER_CHILD, btDb, lockFlag], { stdio: "ignore" });
	let lockWait = 0;
	while (!existsSync(lockFlag) && lockWait < 200) {
		await new Promise((r) => setTimeout(r, 5));
		lockWait++;
	}
	const started = Date.now();
	const waited = await waiting.append({ kind: "progress", sessionId: "s", task: "t", worker: "waited", payload: {} });
	const elapsed = Date.now() - started;
	waiting.close();
	await new Promise<void>((r) => holderProc.on("exit", () => r()));
	check(
		"J8.4 the pinned busy_timeout makes a single-attempt append wait for a cross-process lock release",
		waited.ok === true && elapsed >= 50 && elapsed < 5000,
		JSON.stringify({ waited, elapsed, lockWait }),
	);

	// J8.5 — a THROWING onError sink is swallowed: append() still resolves with
	// its structured failure and the sink is invoked exactly once (the
	// busy-exhaustion path), so the "NEVER throws" contract is true, not just
	// asserted (Law 2).
	const sinkDb = join(SANDBOX, "sink.db");
	const sinkSeed = createJournalWriter({ dbPath: sinkDb });
	sinkSeed.close();
	let sinkCalls = 0;
	const sinkWriter = createJournalWriter({
		dbPath: sinkDb,
		busyTimeoutMs: 1,
		retry: { attempts: 1 },
		onError: () => {
			sinkCalls++;
			throw new Error("sink exploded");
		},
	});
	const sinkHolder = new Database(sinkDb);
	sinkHolder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
	let sinkThrew = false;
	let sinkRes: Awaited<ReturnType<typeof sinkWriter.append>> | null = null;
	try {
		sinkRes = await sinkWriter.append({ kind: "progress", sessionId: "s", task: "t", worker: "sink", payload: {} });
	} catch {
		sinkThrew = true;
	}
	sinkHolder.exec("ROLLBACK");
	sinkHolder.close();
	sinkWriter.close();
	check(
		"J8.5 a throwing onError sink is swallowed: append resolves E_JOURNAL_BUSY and invokes the sink exactly once",
		!sinkThrew && sinkRes?.ok === false && sinkRes.code === "E_JOURNAL_BUSY" && sinkCalls === 1,
		JSON.stringify({ sinkThrew, sinkRes, sinkCalls }),
	);
}

// ---------------------------------------------------------------------------
// J9 — advisory by contract: no failure path throws
// ---------------------------------------------------------------------------

{
	const blocker = join(SANDBOX, "blocker");
	writeFileSync(blocker, "not a directory");
	let threw = false;
	let res: Awaited<ReturnType<typeof writer.append>> | null = null;
	try {
		const broken = createJournalWriter({ dbPath: join(blocker, "events.db") });
		res = await broken.append({ kind: "spawn", sessionId: "s", task: "t" });
		broken.close();
	} catch {
		threw = true;
	}
	check(
		"J9.1 an unopenable database yields E_JOURNAL_OPEN and never throws",
		!threw && res?.ok === false && res.code === "E_JOURNAL_OPEN",
		JSON.stringify(res),
	);

	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const serialization = await writer.append({ kind: "spawn", sessionId: "s", task: "t", payload: circular });
	check(
		"J9.2 a non-JSON-serializable payload is refused structurally",
		serialization.ok === false && serialization.code === "E_JOURNAL_WRITE",
		JSON.stringify(serialization),
	);

	const absent = createJournalReader({ dbPath: join(SANDBOX, "absent.db") });
	check(
		"J9.3 an absent reader file yields empty/valid results",
		absent.eventsAfter(0).length === 0 && absent.count() === 0 && absent.dbSizeBytes() === 0,
	);
	absent.close();

	const futureDb = join(SANDBOX, "future.db");
	const raw = new Database(futureDb, { create: true });
	raw.exec("PRAGMA user_version = 2; CREATE TABLE events (seq INTEGER PRIMARY KEY, ts TEXT, kind TEXT, session_id TEXT, task TEXT, worker TEXT, payload TEXT);");
	raw.close();
	const futureWriter = createJournalWriter({ dbPath: futureDb });
	const futureAppend = await futureWriter.append({ kind: "spawn", sessionId: "s", task: "t" });
	futureWriter.close();
	const futureReader = createJournalReader({ dbPath: futureDb });
	check(
		"J9.4 a future user_version is refused by the writer and reads empty (Law 7 gate)",
		futureAppend.ok === false && futureAppend.code === "E_JOURNAL_OPEN" && futureReader.eventsAfter(0).length === 0,
		JSON.stringify(futureAppend),
	);
	futureReader.close();
}

// ---------------------------------------------------------------------------

writer.close();
rmSync(SANDBOX, { recursive: true, force: true });
clearTimeout(watchdog);

if (failures > 0) {
	console.error(`\njournal-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\njournal-check: all checks passed");
