/**
 * pi-delegate — src/swarm/journal.ts — the fleet event journal, WRITER side.
 *
 * MODULE_CONTRACT — append-only, single-writer, durable (ARCHITECTURE §4.1.2).
 *
 * Purpose: the writer half of the journal module family (`src/swarm/journal*.ts`)
 * — the ONLY writer CODE for `events.db`, schema migration to version 1, the
 * closed v1 kind set, and the append protocol. Phase A note: the module may
 * land while receiving no production writes (§4.1.3); it is a product surface,
 * advisory to the pipeline (Law 8/Law 13) — `append()` NEVER throws and never
 * propagates a failure to a spawn or collect.
 *
 * Location (Law 1): ONE database at
 * `join(getAgentDir(), "delegate-journal", "events.db")` — resolved through
 * pi's `getAgentDir()` (never hardcoded, never the exchange root, never the
 * repository). `journalDbPath()` is the single source of that path.
 *
 * Single-writer code, multi-process database: every concurrent pi session
 * process writes the same `events.db`, so SQLite itself serializes writers.
 * This module pins `busy_timeout = 5000` ms, retries `SQLITE_BUSY` with
 * bounded backoff-plus-jitter, and keeps every append a short single-statement
 * transaction. A torn write (process death mid-append) leaves the last record
 * intact or absent — never corrupt; WAL + `synchronous = FULL` is what buys
 * that (verified by `test/journal-check.ts` against a SIGKILLed writer child).
 *
 * Append-only by absence: this module contains NO UPDATE and NO DELETE
 * statement. The sole documented exception in §4.1.2 is the operator-invoked
 * compaction path (export fleet events to JSONL, then delete, gated on the
 * all-terminal rule); compaction is DEFERRED out of #22 and lands in its own
 * family file `src/swarm/journal-compact.ts` (covered by the journal*.ts glob)
 * so this writer never grows past the Law 5 threshold — it is the one place a
 * DELETE may appear in the family, and `journal-check.ts` scans these sources
 * for write keywords so the deferral is a tested state, not a convention.
 *
 * Dependencies: `bun:sqlite` (the platform driver — Law 1, the platform is the
 * API), pi's `getAgentDir()`, node builtins, and `./clock.ts` (the injected
 * ClockPort supplies `ts`). No herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - `JOURNAL_SCHEMA_V1_DDL` is the DDL pinned in §4.1.2, applied verbatim;
 *     `PRAGMA user_version = 1` is the Law 7 version gate for the database.
 *   - `createJournalWriter()` and `append()` are total: they return structured
 *     results and never throw (advisory-by-contract, Law 8).
 *   - The kind set is closed at 13; an unknown kind is refused, not stored.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { systemClock, type ClockPort } from "../clock.ts";

// ---------------------------------------------------------------------------
// Location (Law 1) — one spelling
// ---------------------------------------------------------------------------

/** Journal directory name under the pi agent dir. */
export const JOURNAL_DB_DIR_NAME = "delegate-journal";
/** Journal database file name. */
export const JOURNAL_DB_FILE_NAME = "events.db";

/**
 * The ONE journal location (§4.1.2, Law 1): resolved live per call through
 * pi's `getAgentDir()` (which honors `PI_CODING_AGENT_DIR`), never hardcoded.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: absolute path `<agentDir>/delegate-journal/events.db`
 * Guarantees: pure path assembly; the exchange root is never consulted (it
 *   dies on reboot); never throws
 * Raises: never
 */
export function journalDbPath(): string {
	return join(getAgentDir(), JOURNAL_DB_DIR_NAME, JOURNAL_DB_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Law 7 — the database version gate + the pinned v1 DDL
// ---------------------------------------------------------------------------

/** Database schema version (Law 7). `PRAGMA user_version` absent (0) is a
 *  fresh database and migrates to 1; a value ABOVE this is a future version
 *  this build cannot parse — writers refuse, readers yield empty. */
export const JOURNAL_DB_VERSION = 1;

/**
 * The v1 DDL, byte-pinned by ARCHITECTURE §4.1.2. Applied on every writer open
 * (idempotent: `IF NOT EXISTS` + a version gate that refuses future versions
 * BEFORE this runs). Do not reshape — the schema is a versioned contract.
 */
export const JOURNAL_SCHEMA_V1_DDL = `PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;  -- cross-process write rule, see below
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,   -- ISO-8601 UTC, injected clock (ClockPort)
  kind       TEXT NOT NULL,   -- one of the closed kind set below
  session_id TEXT NOT NULL,   -- owning orchestrator session (the SwarmGraph SessionId: stable hash of the session file path)
  task       TEXT NOT NULL,   -- exchange task name
  worker     TEXT,            -- canonical worker name; NULL on fleet-scoped events
  payload    TEXT NOT NULL    -- kind-shaped JSON (contract below)
);
CREATE INDEX IF NOT EXISTS events_by_fleet ON events(session_id, task, seq);`;

/** The single-statement append. Payload/ts are bound parameters — never
 *  interpolated. */
const INSERT_EVENT_SQL =
	"INSERT INTO events(ts, kind, session_id, task, worker, payload) VALUES (?, ?, ?, ?, ?, ?)";

// ---------------------------------------------------------------------------
// The closed v1 kind set (§4.1.2) — new kinds only by addition, never rename
// ---------------------------------------------------------------------------

/** The 13 v1 kinds: the issue's 11 PLUS `reconcile-summary` and
 *  `compaction-marker` (operator-approved additions in §4.1.2). The last two
 *  kinds (`termination-notice`, `partial-report`) are forward-compat with
 *  #15: reserved in the schema before their producers land. */
export const JOURNAL_KINDS = [
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
] as const;

export type JournalKind = (typeof JOURNAL_KINDS)[number];

const JOURNAL_KIND_SET: ReadonlySet<string> = new Set(JOURNAL_KINDS);

export function isJournalKind(v: unknown): v is JournalKind {
	return typeof v === "string" && JOURNAL_KIND_SET.has(v);
}

// ---------------------------------------------------------------------------
// Structured, never-throwing results (Law 8)
// ---------------------------------------------------------------------------

/** Failure codes this module can return. `E_JOURNAL_BUSY` means the bounded
 *  retry budget was exhausted under cross-process contention. */
export type JournalFailureCode =
	| "E_JOURNAL_KIND"
	| "E_JOURNAL_BUSY"
	| "E_JOURNAL_WRITE"
	| "E_JOURNAL_OPEN";

export interface JournalSuccess {
	ok: true;
	/** The committed row's AUTOINCREMENT seq — the durable cursor for readers. */
	seq: number;
}

export interface JournalFailure {
	ok: false;
	code: JournalFailureCode;
	error: string;
	attempts: number;
}

export type JournalAppendResult = JournalSuccess | JournalFailure;

/** A lifecycle fact to append. `worker` is NULL/absent on fleet-scoped events;
 *  `payload` is the kind-shaped JSON contract object (additive-only after v1). */
export interface JournalAppendInput {
	kind: JournalKind;
	sessionId: string;
	task: string;
	worker?: string | null;
	payload?: unknown;
}

// ---------------------------------------------------------------------------
// Bounded, jittered SQLITE_BUSY backoff (§4.1.2 cross-process rule)
// ---------------------------------------------------------------------------

/** Bounded SQLITE_BUSY retry budget: attempts (incl. the first), exponential
 *  base in ms, and a per-delay ceiling in ms. */
export interface JournalRetryOptions { attempts?: number; baseMs?: number; maxMs?: number; }

export const JOURNAL_RETRY_DEFAULTS: Required<JournalRetryOptions> = { attempts: 4, baseMs: 20, maxMs: 400 };

/**
 * Bounded jittered backoff for attempt index `attempt` (0-based).
 * FUNCTION_CONTRACT: Input — attempt, rng (jitter in [0,1)), opts. Output —
 * a delay in [0, maxMs]. Pure given rng; never throws.
 */
export function journalBackoffMs(
	attempt: number,
	rng: () => number = Math.random,
	opts: JournalRetryOptions = {},
): number {
	const base = opts.baseMs ?? JOURNAL_RETRY_DEFAULTS.baseMs;
	const max = opts.maxMs ?? JOURNAL_RETRY_DEFAULTS.maxMs;
	const cap = Math.min(max, base * 2 ** Math.max(0, attempt));
	const jitter = 0.5 + 0.5 * Math.min(1, Math.max(0, rng()));
	return Math.max(0, Math.floor(cap * jitter));
}

// ---------------------------------------------------------------------------
// Writer factory
// ---------------------------------------------------------------------------

export interface JournalWriterOptions {
	/** Database path override (tests sandbox here). Default `journalDbPath()`. */
	dbPath?: string;
	/** Clock injected for `ts`. Default `systemClock`. */
	clock?: ClockPort;
	/** SQLITE_BUSY retry budget. Defaults to `JOURNAL_RETRY_DEFAULTS`. */
	retry?: JournalRetryOptions;
	/** Jitter source for the backoff. Default `Math.random`. */
	rng?: () => number;
	/** TEST-ONLY override of the pinned 5000 ms busy timeout (the pinned DDL still sets 5000). */
	busyTimeoutMs?: number;
	/** Advisory sink, called once per failed append (also returned); default no-op. */
	onError?: (failure: JournalFailure & { kind: string }) => void;
}

export interface JournalWriter {
	readonly dbPath: string;
	/** Append one event. Total: never throws; a failure is a structured result
	 *  the pipeline records and skips (advisory-by-contract). */
	append(input: JournalAppendInput): Promise<JournalAppendResult>;
	/** Close the connection (idempotent). */
	close(): void;
}

function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return typeof e === "string" ? e : JSON.stringify(e);
}

function isBusyError(e: unknown): boolean {
	const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
	if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
	return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(errorMessage(e));
}

/** Invoke the advisory error sink, swallowing a throwing sink (the sink is
 *  advisory too) so no sink can escape append() or trigger a second call. */
function notifySink(
	sink: ((f: JournalFailure & { kind: string }) => void) | undefined,
	f: JournalFailure & { kind: string },
): void {
	if (!sink) return;
	try {
		sink(f);
	} catch {
		// swallowed — the sink is advisory
	}
}

/** Never-throwing read of the input kind (append(null) is caught by append). */
function safeKind(input: unknown): string {
	const k = typeof input === "object" && input !== null ? (input as { kind?: unknown }).kind : undefined;
	return typeof k === "string" ? k : "unknown";
}

function readUserVersion(db: Database): number {
	const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;
	return Number(row?.user_version ?? 0);
}

/**
 * Open + migrate the database. Returns null when the file cannot be opened or
 * carries a FUTURE `user_version` (Law 7 gate) — the caller degrades to an
 * advisory no-op writer.
 */
function openDatabase(dbPath: string, busyTimeoutMs?: number): Database | null {
	try {
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = new Database(dbPath, { create: true });
		if (readUserVersion(db) > JOURNAL_DB_VERSION) {
			db.close();
			return null;
		}
		db.exec(JOURNAL_SCHEMA_V1_DDL);
		if (busyTimeoutMs !== undefined) {
			const ms = Math.max(0, Math.floor(busyTimeoutMs));
			db.run(`PRAGMA busy_timeout = ${ms}`);
		}
		return db;
	} catch {
		return null;
	}
}

/**
 * Create the journal writer. Total by contract: a database that cannot be
 * opened still yields a writer whose `append()` returns `E_JOURNAL_OPEN` —
 * the pipeline can never be failed by the journal (Law 8, Law 13).
 */
export function createJournalWriter(opts: JournalWriterOptions = {}): JournalWriter {
	const dbPath = opts.dbPath ?? journalDbPath();
	const clock = opts.clock ?? systemClock;
	const rng = opts.rng ?? Math.random;
	const retry: Required<JournalRetryOptions> = {
		attempts: opts.retry?.attempts ?? JOURNAL_RETRY_DEFAULTS.attempts,
		baseMs: opts.retry?.baseMs ?? JOURNAL_RETRY_DEFAULTS.baseMs,
		maxMs: opts.retry?.maxMs ?? JOURNAL_RETRY_DEFAULTS.maxMs,
	};
	let db: Database | null = openDatabase(dbPath, opts.busyTimeoutMs);
	let closed = false;

	return {
		dbPath,
		async append(input: JournalAppendInput): Promise<JournalAppendResult> {
			try {
				if (!isJournalKind(input.kind)) {
					return {
						ok: false,
						code: "E_JOURNAL_KIND",
						error: `unknown journal kind: ${String(input.kind)}`,
						attempts: 0,
					};
				}
				if (closed || db === null) {
					return {
						ok: false,
						code: "E_JOURNAL_OPEN",
						error: "journal database is not open",
						attempts: 0,
					};
				}
				let payloadText: string;
				try {
					const json = JSON.stringify(input.payload ?? {});
					payloadText = json === undefined ? "null" : json;
				} catch (e) {
					return {
						ok: false,
						code: "E_JOURNAL_WRITE",
						error: `payload is not JSON-serializable: ${errorMessage(e)}`,
						attempts: 0,
					};
				}
				const ts = new Date(clock.now()).toISOString();
				let lastError: unknown = null;
				let attempts = 0;
				for (let attempt = 0; attempt < retry.attempts; attempt++) {
					attempts = attempt + 1;
					try {
						const res = db.run(INSERT_EVENT_SQL, [
							ts,
							input.kind,
							input.sessionId,
							input.task,
							input.worker ?? null,
							payloadText,
						]);
						return { ok: true, seq: Number(res.lastInsertRowid) };
					} catch (e) {
						lastError = e;
						if (!isBusyError(e) || attempt >= retry.attempts - 1) break;
						await clock.delay(journalBackoffMs(attempt, rng, retry));
					}
				}
				const busy = isBusyError(lastError);
				const failure: JournalFailure & { kind: string } = {
					ok: false,
					code: busy ? "E_JOURNAL_BUSY" : "E_JOURNAL_WRITE",
					error: errorMessage(lastError),
					attempts,
					kind: input.kind,
				};
				notifySink(opts.onError, failure);
				return failure;
			} catch (e) {
				// Structural advisory guarantee: no path out of append() throws.
				const failure: JournalFailure & { kind: string } = {
					ok: false,
					code: "E_JOURNAL_WRITE",
					error: errorMessage(e),
					attempts: 0,
					kind: safeKind(input),
				};
				notifySink(opts.onError, failure);
				return failure;
			}
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				db?.close();
			} catch {
				// advisory — a close failure never propagates
			}
			db = null;
		},
	};
}
