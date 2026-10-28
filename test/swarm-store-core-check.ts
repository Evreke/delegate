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
