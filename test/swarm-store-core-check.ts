/**
 * swarm-store-core-check — the 1.19.0-shadow store core (the store design at
 * HEAD 1edf1f8 + the critics' amendments C5/C6/K2).
 *
 * Run with: bun test/swarm-store-core-check.ts   (from the repo root)
 *
 * Legs (each maps to one acceptance item of the impl-store-core brief):
 *   S0  Receipt API (schema v2 side tables): `appendReceipt` writes the
 *       `sent` receipt; the closed receipt set refuses unknown states; the
 *       writer-owned key is enforced (E_JOURNAL_FORBIDDEN); the API is total.
 *   S1  The LOUD version gate (C5): a FUTURE `user_version` makes the writer
 *       fail structured E_JOURNAL_VERSION (never a silent no-op), the CLI
 *       verb FAILS (exit 1, structured envelope) when its journal write is
 *       attempted, the reader stays tolerant (empty, never a throw), and
 *       shadow-off files mode keeps the exact 1.18 surface (no gate trip).
 *   S2  Shadow message writes behind swarm.messageShadow (K2): files-mode
 *       message rows + sent receipts, advisory on failure with a warn-once
 *       uiLog line, envelopes byte-identical to shadow-off (the journal field
 *       stays absent), files stay truth.
 *   S3  Audience-scoped compaction (C6): the all-terminal rule, the extended
 *       healthy-snapshot guard (unclassifiable audience → refuse the range),
 *       the live-audience unconsumed refusal, dead audiences deletable.
 *   S4  Per-kind visibility: per-kind row counts + oldest-row-ts reachable
 *       from the events read surface.
 *
 * Fail-fast (AGENTS.md command discipline): every child spawn is bounded and
 * a top-level watchdog exits non-zero no matter what. Exit 0 only if all
 * checks pass.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
	createJournalWriter,
	JOURNAL_DB_VERSION,
	JOURNAL_MESSAGE_KINDS,
	JOURNAL_RECEIPTS,
	JOURNAL_SCHEMA_V1_DDL,
	JOURNAL_SCHEMA_V2_DDL,
	type JournalReceiptInput,
} from "../src/swarm/journal.ts";
import { createJournalReader } from "../src/swarm/journal-read.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-store-core-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 60_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const CLI = join(ROOT, "src", "swarm", "cli.ts");
const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-store-core-check-"));
const AGENT = join(SANDBOX, "agent"); // hermetic config tier (no real operator config)
const EX = join(SANDBOX, "ex");
const FIXED_TS = "2026-06-01T00:00:00.000Z";
const FIXED_MS = Date.parse(FIXED_TS);
const FIXED_CLOCK = { now: () => FIXED_MS, delay: () => Promise.resolve() };
mkdirSync(AGENT, { recursive: true });

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	json: Record<string, unknown> | null;
}

/** Spawn the swarm CLI (bounded) under an explicit env overlay. */
function runCli(args: string[], env: Record<string, string> = {}): RunResult {
	const e: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
	e.PI_DELEGATE_EXCHANGE_ROOT = EX;
	e.PI_CODING_AGENT_DIR = AGENT;
	e.SWARM_STORAGE = "files";
	e.SWARM_FIXED_TS = FIXED_TS;
	Object.assign(e, env);
	const res = spawnSync("bun", [CLI, ...args], { env: e, encoding: "utf8", timeout: 15_000 });
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse((res.stdout ?? "").trim()) as Record<string, unknown>;
	} catch {
		// leave null; the failing check prints stdout
	}
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", json };
}

const errCode = (r: RunResult): unknown => (r.json?.error as { code?: unknown } | undefined)?.code;

/** A future-version database fixture: user_version ahead of this build. */
function makeFutureVersionDb(dbPath: string): void {
	mkdirSync(dirname(dbPath), { recursive: true });
	const raw = new Database(dbPath, { create: true });
	raw.exec(
		`PRAGMA user_version = ${JOURNAL_DB_VERSION + 1}; CREATE TABLE events (seq INTEGER PRIMARY KEY, ts TEXT, kind TEXT, session_id TEXT, task TEXT, worker TEXT, payload TEXT);`,
	);
	raw.close();
}

// ---------------------------------------------------------------------------
// S0 — receipt API (schema v2 side tables)
// ---------------------------------------------------------------------------

{
	const db = join(SANDBOX, "s0", "events.db");
	const writer = createJournalWriter({ dbPath: db, clock: FIXED_CLOCK });

	const appended = await writer.append({ kind: "ask", sessionId: "sess-a", task: "t0", worker: "w0", payload: { text: "q" } });
	check("S0.1 the message row appends (the receipt's subject row)", appended.ok === true, JSON.stringify(appended));

	if (appended.ok) {
		const sent = await writer.appendReceipt({
			msgSeq: appended.seq,
			audienceSession: "sess-a",
			receipt: "sent",
			writerSession: "sess-a",
		});
		check("S0.2 the sender's own `sent` receipt appends (writer-owned key satisfied)", sent.ok === true, JSON.stringify(sent));
	}

	const foreign: JournalReceiptInput = {
		msgSeq: 1,
		audienceSession: "sess-b",
		receipt: "delivered",
		writerSession: "sess-a",
	};
	const refused = await writer.appendReceipt(foreign);
	check(
		"S0.3 a receipt whose audience is not the writer refuses E_JOURNAL_FORBIDDEN (writer authority in code, store design §3)",
		refused.ok === false && refused.code === "E_JOURNAL_FORBIDDEN",
		JSON.stringify(refused),
	);

	const unknown = await writer.appendReceipt({ msgSeq: 1, audienceSession: "sess-a", receipt: "read" as never, writerSession: "sess-a" });
	check(
		"S0.4 an unknown receipt state refuses E_JOURNAL_KIND (closed additive set)",
		unknown.ok === false && unknown.code === "E_JOURNAL_KIND",
		JSON.stringify(unknown),
	);
	check(
		"S0.5 the receipt set is exactly sent|delivered|consumed|failed (additive-only)",
		JOURNAL_RECEIPTS.join(",") === "sent,delivered,consumed,failed",
		JOURNAL_RECEIPTS.join(","),
	);

	const raw = new Database(db);
	const rows = raw.query("SELECT msg_seq, audience_session, receipt, ts, writer_session FROM message_receipts").all() as Array<
		Record<string, unknown>
	>;
	raw.close();
	check(
		"S0.6 exactly one receipt row landed with the stamped ts and the writer session",
		rows.length === 1 && rows[0]!.msg_seq === 1 && rows[0]!.receipt === "sent" && rows[0]!.ts === FIXED_TS && rows[0]!.writer_session === "sess-a",
		JSON.stringify(rows),
	);

	const blocker = join(SANDBOX, "s0-blocker");
	writeFileSync(blocker, "not a directory");
	const broken = createJournalWriter({ dbPath: join(blocker, "events.db") });
	let receiptThrew = false;
	let brokenRes: Awaited<ReturnType<typeof broken.appendReceipt>> | null = null;
	try {
		brokenRes = await broken.appendReceipt({ msgSeq: 1, audienceSession: "s", receipt: "sent", writerSession: "s" });
	} catch {
		receiptThrew = true;
	}
	broken.close();
	check(
		"S0.7 appendReceipt is total: an unopenable database yields E_JOURNAL_OPEN, never a throw",
		!receiptThrew && brokenRes?.ok === false && brokenRes.code === "E_JOURNAL_OPEN",
		JSON.stringify(brokenRes),
	);

	writer.close();
}

// ---------------------------------------------------------------------------
// S1 — the LOUD version gate (C5)
// ---------------------------------------------------------------------------

{
	const futureDb = join(SANDBOX, "s1-future", "events.db");
	makeFutureVersionDb(futureDb);

	const writer = createJournalWriter({ dbPath: futureDb, clock: FIXED_CLOCK });
	const appendRes = await writer.append({ kind: "ask", sessionId: "s", task: "t", worker: "w", payload: {} });
	const receiptRes = await writer.appendReceipt({ msgSeq: 1, audienceSession: "s", receipt: "sent", writerSession: "s" });
	writer.close();
	check(
		"S1.1 a future user_version refuses the writer LOUDLY: structured E_JOURNAL_VERSION on append and appendReceipt (never a silent no-op)",
		appendRes.ok === false && appendRes.code === "E_JOURNAL_VERSION" && appendRes.attempts === 0 && receiptRes.ok === false && receiptRes.code === "E_JOURNAL_VERSION",
		JSON.stringify({ appendRes, receiptRes }),
	);

	const reader = createJournalReader({ dbPath: futureDb });
	const tolerant = reader.eventsAfter(0).length === 0 && reader.count() === 0 && reader.dbSizeBytes() > 0;
	reader.close();
	check(
		"S1.2 the READER stays tolerant: the future-version database reads empty and never throws",
		tolerant,
	);

	rmSync(join(SANDBOX, "s1-future"), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// S2 — shadow message writes behind swarm.messageShadow (K2 + envelope silence)
// ---------------------------------------------------------------------------

{
	const db = join(SANDBOX, "s2", "events.db");
	const task = "shadow-fleet";
	const worker = "shadoww";
	const baseEnv = { SWARM_JOURNAL_DB: db, SWARM_SESSION_ID: "sess-shadow" };

	// S2.1 — files mode, shadow ON (default): the verb succeeds, the envelope
	// carries NO journal field (envelope-silent), the file is published, and
	// the db gained the ask row + the sender's sent receipt.
	const rOn = runCli(["ask", "--question", "shadow?", "--task", task, "--worker", worker], baseEnv);
	const qOn = join(EX, task, `q-${worker}.json`);
	const onEnvelope = rOn.json ?? {};
	check(
		"S2.1 files-mode ask under the shadow: exit 0, NO journal field, the q-file published",
		rOn.status === 0 && onEnvelope.ok === true && !("journal" in onEnvelope) && existsSync(qOn),
		JSON.stringify({ status: rOn.status, stdout: rOn.stdout.slice(0, 200) }),
	);
	{
		const raw = new Database(db);
		const rows = raw.query("SELECT kind, session_id, worker FROM events ORDER BY seq").all() as Array<Record<string, unknown>>;
		const receipts = raw.query("SELECT msg_seq, audience_session, receipt, writer_session FROM message_receipts").all() as Array<
			Record<string, unknown>
		>;
		raw.close();
		check(
			"S2.2 the shadow wrote the ask row + the sender's sent receipt (files stay truth; the receipt's audience = the sender session)",
			rows.length === 1 && rows[0]!.kind === "ask" && rows[0]!.session_id === "sess-shadow" &&
				receipts.length === 1 && receipts[0]!.receipt === "sent" && receipts[0]!.audience_session === "sess-shadow" && receipts[0]!.writer_session === "sess-shadow",
			JSON.stringify({ rows, receipts }),
		);
	}

	// S2.3 — BYTE-IDENTITY: the same ask under shadow-off (the exact 1.18
	// surface) produces the same stdout envelope bytes and the same q-file
	// bytes in the SAME task dir (the projection wiped between runs), and
	// shadow-off creates NO database at all.
	const onStdout = rOn.stdout;
	const onFile = readFileSync(qOn);
	rmSync(qOn, { force: true });
	rmSync(dirname(db), { recursive: true, force: true });
	const rOff = runCli(["ask", "--question", "shadow?", "--task", task, "--worker", worker], {
		...baseEnv,
		SWARM_MESSAGE_SHADOW: "0",
	});
	check(
		"S2.3 shadow-off stdout is byte-identical to shadow-on (the journal field stays absent in both) and the q-file bytes match",
		rOff.status === 0 && rOff.stdout === onStdout && readFileSync(qOn).equals(onFile),
		JSON.stringify({ on: onStdout.slice(0, 120), off: rOff.stdout.slice(0, 120) }),
	);
	check("S2.4 shadow-off creates NO database (the exact 1.18 write surface)", !existsSync(db));

	// S2.5 — write-progress shadows too: row + receipt, envelope-silent.
	rmSync(qOn, { force: true });
	const rp = runCli(["write-progress", "--phase", "build", "--pct", "40", "--task", task, "--worker", worker], baseEnv);
	{
		const raw = new Database(db);
		const kinds = (raw.query("SELECT kind FROM events ORDER BY seq").all() as Array<{ kind: string }>).map((r) => r.kind);
		const receipts = raw.query("SELECT receipt FROM message_receipts").all() as Array<{ receipt: string }>;
		raw.close();
		check(
			"S2.5 files-mode write-progress under the shadow: exit 0, no journal field, the progress row + sent receipt landed",
			rp.status === 0 && !("journal" in (rp.json ?? {})) && kinds.join(",") === "progress" && receipts.length === 1 && receipts[0]!.receipt === "sent",
			JSON.stringify({ status: rp.status, kinds, receipts, stdout: rp.stdout.slice(0, 200) }),
		);
	}

	// S2.6 — K2 visibility: a FAILED shadow write keeps the verb green and the
	// envelope byte-identical, and surfaces ONE warn-once uiLog line on stderr.
	const blocker = join(SANDBOX, "s2-blocker");
	writeFileSync(blocker, "not a directory");
	const rFault = runCli(["ask", "--question", "shadow?", "--task", task, "--worker", worker], {
		...baseEnv,
		SWARM_JOURNAL_DB: join(blocker, "events.db"),
	});
	check(
		"S2.6 a failed shadow write is advisory: exit 0, byte-identical envelope, the file still published",
		rFault.status === 0 && rFault.stdout === onStdout && existsSync(qOn),
		JSON.stringify({ status: rFault.status, stdout: rFault.stdout.slice(0, 200), stderr: rFault.stderr.slice(0, 200) }),
	);
	check(
		"S2.7 the failed shadow write is VISIBLE: one warn-once uiLog line on stderr (K2 — never silent)",
		rFault.stderr.includes("message shadow write failed") && rFault.stderr.includes("the file stays truth"),
		JSON.stringify(rFault.stderr.slice(0, 300)),
	);

	// S2.8 — the loud gate through the CLI (C5): files mode + shadow on + a
	// future-version db fails the verb structured E_JOURNAL_VERSION and
	// publishes nothing; shadow-off on the same db keeps the 1.18 surface.
	const futureDb = join(SANDBOX, "s2-future", "events.db");
	makeFutureVersionDb(futureDb);
	const qFuture = join(EX, task, `q-${worker}.json`);
	rmSync(qFuture, { force: true });
	const rGate = runCli(["ask", "--question", "gate?", "--task", task, "--worker", worker], {
		...baseEnv,
		SWARM_JOURNAL_DB: futureDb,
	});
	check(
		"S2.8 `swarm ask` on a future-version db (shadow on) fails structured E_JOURNAL_VERSION and publishes nothing",
		rGate.status === 1 && errCode(rGate) === "E_JOURNAL_VERSION" && !existsSync(qFuture),
		JSON.stringify({ status: rGate.status, stdout: rGate.stdout.slice(0, 200), qExists: existsSync(qFuture) }),
	);
	const rGateOff = runCli(["ask", "--question", "gate?", "--task", task, "--worker", worker], {
		...baseEnv,
		SWARM_JOURNAL_DB: futureDb,
		SWARM_MESSAGE_SHADOW: "0",
	});
	check(
		"S2.9 shadow-off on a future-version db keeps the exact 1.18 surface: exit 0, no journal field, the file published",
		rGateOff.status === 0 && !("journal" in (rGateOff.json ?? {})) && existsSync(qFuture),
		JSON.stringify({ status: rGateOff.status, stdout: rGateOff.stdout.slice(0, 200) }),
	);

	// S2.10 — journal mode: the message row + receipt ride the existing write,
	// the envelope surfaces journal:{seq}; a future-version db fails LOUD.
	const jdb = join(SANDBOX, "s2-journal", "events.db");
	const rJ = runCli(["ask", "--question", "jmode?", "--task", task, "--worker", worker], {
		...baseEnv,
		SWARM_STORAGE: "journal",
		SWARM_JOURNAL_DB: jdb,
	});
	{
		const raw = new Database(jdb);
		const kinds = (raw.query("SELECT kind FROM events ORDER BY seq").all() as Array<{ kind: string }>).map((r) => r.kind);
		const receipts = raw.query("SELECT receipt FROM message_receipts").all() as Array<{ receipt: string }>;
		raw.close();
		const jseq = (rJ.json?.journal as { seq?: unknown } | undefined)?.seq;
		check(
			"S2.10 journal-mode ask: envelope journal:{seq}, the ask row + sent receipt landed",
			rJ.status === 0 && typeof jseq === "number" && kinds.join(",") === "ask" && receipts.length === 1,
			JSON.stringify({ status: rJ.status, stdout: rJ.stdout.slice(0, 200), kinds, receipts }),
		);
	}
	const rJGate = runCli(["ask", "--question", "jgate?", "--task", task, "--worker", worker], {
		...baseEnv,
		SWARM_STORAGE: "journal",
		SWARM_JOURNAL_DB: futureDb,
	});
	check(
		"S2.11 journal-mode ask on a future-version db fails structured E_JOURNAL_VERSION (the loud gate in every mode)",
		rJGate.status === 1 && errCode(rJGate) === "E_JOURNAL_VERSION",
		JSON.stringify({ status: rJGate.status, stdout: rJGate.stdout.slice(0, 200) }),
	);

	rmSync(join(SANDBOX, "s2-future"), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// S4 — per-kind visibility (the §4 retention-visibility extension)
// ---------------------------------------------------------------------------

{
	const db = join(SANDBOX, "s4", "events.db");
	mkdirSync(dirname(db), { recursive: true });
	const writer = createJournalWriter({ dbPath: db, clock: FIXED_CLOCK });
	const seed: Array<{ kind: "spawn" | "ask" | "progress" | "collect"; worker: string | null }> = [
		{ kind: "spawn", worker: "w" },
		{ kind: "progress", worker: "w" },
		{ kind: "progress", worker: "w" },
		{ kind: "ask", worker: "w" },
		{ kind: "collect", worker: "w" },
	];
	for (const r of seed) {
		const res = await writer.append({ kind: r.kind, sessionId: "sess-vis", task: "vis-fleet", worker: r.worker, payload: {} });
		if (!res.ok) throw new Error(`seed failed: ${res.code}`);
	}
	// One UNKNOWN (future) kind row, inserted raw: visibility must still COUNT
	// it — disk growth an operator must see, even though row reads skip it.
	const raw = new Database(db);
	raw.run(
		"INSERT INTO events(ts, kind, session_id, task, worker, payload) VALUES (?, ?, ?, ?, ?, ?)",
		[FIXED_TS, "future-kind", "sess-vis", "vis-fleet", null, "{}"],
	);
	raw.close();
	writer.close();

	const reader = createJournalReader({ dbPath: db });
	const stats = reader.kindStats();
	reader.close();
	const byKind = Object.fromEntries(stats.map((s) => [s.kind, s]));
	check(
		"S4.1 kindStats: per-kind counts (progress=2), ordered by kind, oldest ts stamped",
		stats.length === 5 &&
			stats.map((s) => s.kind).join(",") === "ask,collect,future-kind,progress,spawn" &&
			byKind["progress"]!.count === 2 &&
			byKind["spawn"]!.count === 1 &&
			byKind["ask"]!.oldestTs === FIXED_TS,
		JSON.stringify(stats),
	);
	check(
		"S4.2 visibility counts EVERY row: the unknown future kind is counted, never hidden",
		byKind["future-kind"] !== undefined && byKind["future-kind"]!.count === 1,
		JSON.stringify(byKind["future-kind"]),
	);

	// S4.3 — the events read surface carries the same stats.
	const r = runCli(["events", "--after", "0", "--task", "vis-fleet"], { SWARM_JOURNAL_DB: db });
	const kinds = (r.json?.journal as { kinds?: unknown } | undefined)?.kinds;
	check(
		"S4.3 `swarm events` surfaces journal.kinds (per-kind counts + oldest-row-ts) from the read surface",
		r.status === 0 && JSON.stringify(kinds) === JSON.stringify(stats),
		JSON.stringify({ status: r.status, kinds }),
	);

	const absent = createJournalReader({ dbPath: join(SANDBOX, "s4-absent", "events.db") });
	const empty = absent.kindStats().length === 0 && absent.count() === 0;
	absent.close();
	check("S4.4 kindStats is tolerant: an absent database yields [] (never a throw)", empty);

	rmSync(dirname(db), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Static pins — the byte-pinned v1 DDL and the closed message-kind set
// ---------------------------------------------------------------------------

check(
	"P.1 the v1 events DDL string is byte-identical to the §4.1.2 pin (Law 7) — the user_version=1 line included",
	JOURNAL_SCHEMA_V1_DDL.includes("PRAGMA user_version = 1;") &&
		JOURNAL_SCHEMA_V1_DDL.includes("CREATE TABLE IF NOT EXISTS events") &&
		JOURNAL_SCHEMA_V1_DDL.includes("CREATE INDEX IF NOT EXISTS events_by_fleet ON events(session_id, task, seq);"),
);
check(
	"P.2 the v2 DDL stamps user_version 2 and documents the nullable msg_seq (NULL = file-detected, no 0 sentinel)",
	JOURNAL_SCHEMA_V2_DDL.includes("PRAGMA user_version = 2;") && JOURNAL_SCHEMA_V2_DDL.includes("msg_seq          INTEGER,"),
);
check(
	"P.3 the message-kind subset is exactly ask|answer|steer|progress (the shadow surface)",
	JOURNAL_MESSAGE_KINDS.join(",") === "ask,answer,steer,progress",
	JOURNAL_MESSAGE_KINDS.join(","),
);

// ---------------------------------------------------------------------------

rmSync(SANDBOX, { recursive: true, force: true });
clearTimeout(watchdog);

if (failures > 0) {
	console.error(`\nswarm-store-core-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-store-core-check: all checks passed");
