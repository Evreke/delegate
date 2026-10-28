/**
 * pi-delegate — src/swarm/journal.ts — the fleet event journal, WRITER side.
 *
 * MODULE_CONTRACT — append-only, single-writer, durable (ARCHITECTURE §4.1.2).
 *
 * Purpose: the writer half of the journal module family (`src/swarm/journal*.ts`)
 * — the ONLY writer CODE: the event append protocol, the writer factory, and
 * the Law 7 version gate. The family siblings own the rest:
 * `journal-schema.ts` the versioned contract (byte-pinned DDLs + the closed
 * kind set + the open+migrate path), `journal-shards.ts` the shard layout
 * (per-task locations + the legacy cutover rename), `journal-retry.ts` the
 * bounded SQLITE_BUSY protocol, `journal-receipt.ts` the receipt side-table
 * writer, `journal-read.ts` the tolerant reader, `journal-compact.ts` the
 * operator-invoked compaction (the family's one DELETE site).
 *
 * Advisory to the pipeline (Law 8/Law 13): `append()` NEVER throws and never
 * propagates a failure to a spawn or collect. The ONE loud exception is the
 * Law 7 version gate (below). Location (Law 1): ONE database PER TASK at
 * `<agentDir>/delegate-journal/tasks/<shard-name>.db`; the dbPath override
 * (SWARM_JOURNAL_DB / opts.dbPath) keeps the pre-shard single-database
 * behavior for tests and scripting. Concurrent pi session processes write the
 * same task's shard — SQLite serializes writers (`busy_timeout = 5000` ms + a
 * bounded retry); WAL + `synchronous = FULL` makes a torn write intact-or-
 * absent, never corrupt (verified by `test/journal-check.ts` against a
 * SIGKILLed writer child).
 *
 * Append-only by absence: this module contains NO UPDATE and NO DELETE
 * statement. The sole documented exception in §4.1.2 is the operator-invoked
 * compaction path; it lives in its own family file `src/swarm/journal-compact.ts`
 * (the one place a DELETE may appear in the family), and `journal-check.ts`
 * scans these sources for write keywords so the confinement is a tested
 * state, not a convention.
 *
 * Dependencies: the sqlite driver via `./journal-driver.ts` (adaptive bun:sqlite / node:sqlite — pi runs under both runtimes),
 * the family siblings, node builtins, and `./clock.ts`
 * (the injected ClockPort supplies `ts`). No herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - `JOURNAL_SCHEMA_V1_DDL` (./journal-schema.ts) is the DDL pinned in
 *     §4.1.2, applied verbatim — BYTE-IDENTICAL including its `PRAGMA user_version = 1`
 *     line (Law 7); the v2 DDL re-stamps the version after it on every open.
 *   - The Law 7 version gate is LOUD (C5) and holds PER SHARD: a FUTURE
 *     `user_version` in ONE task's shard makes every append to THAT task
 *     return the structured `E_JOURNAL_VERSION` failure — never a silent
 *     no-op (the store design's C5 amendment); other tasks' shards are
 *     unaffected. The READER stays tolerant (missing db / future version →
 *     empty, never a throw).
 *   - `createJournalWriter()`, `append()` and `appendReceipt()` are total:
 *     structured results, never a throw (Law 8) — the version gate included.
 *   - The kind set is closed (14 kinds; the §4.1.2 thirteen plus `report`,
 *     the operator-approved #23 addition); an unknown kind is refused, not
 *     stored. The message kinds (`ask`/`answer`/`steer`/`progress`) are the closed
 *     subset the message-store shadow writes (store design §2).
 *   - The receipt set is closed (`sent` | `delivered` | `consumed` | `failed`,
 *     additive); a receipt's writer-owned key is enforced in code — the
 *     writing process's own session id must equal the receipt's
 *     `audience_session` (store design §3), else `E_JOURNAL_FORBIDDEN`.
 *   - Shard mode (no dbPath override): the writer opens each task's shard
 *     lazily on its first append and caches the handle; a receipt routes to
 *     the shard of the most recent successful append on THIS writer (the
 *     CLI's one-append-then-receipt pattern); the legacy cutover rename runs
 *     before the first shard open.
 */

import { type JournalDb } from "./journal-driver.ts";
import { systemClock, type ClockPort } from "../clock.ts";
import {
	JOURNAL_DB_VERSION,
	isJournalKind,
	openMigratedDatabase,
	type JournalAppendInput,
	type JournalAppendResult,
	type JournalFailure,
	type JournalFailureCode,
	type JournalKind,
	type JournalSuccess,
} from "./journal-schema.ts";
import {
	journalShardPathFor,
	journalTasksDir,
	migrateLegacyJournalDatabase,
} from "./journal-shards.ts";
import {
	errorMessage,
	isBusyError,
	JOURNAL_RETRY_DEFAULTS,
	runWithBusyRetry,
	type JournalRetryOptions,
} from "./journal-retry.ts";
import { appendReceiptTo, type JournalReceiptInput, type JournalReceiptResult } from "./journal-receipt.ts";

// Family re-exports (ONE import surface for clients; the checks and the verb
// plumbing import the versioned contract and the receipt types from here).
export { JOURNAL_DB_VERSION, JOURNAL_SCHEMA_V1_DDL, JOURNAL_SCHEMA_V2_DDL } from "./journal-schema.ts";
export {
	isJournalKind,
	isJournalMessageKind,
	JOURNAL_KINDS,
	JOURNAL_MESSAGE_KINDS,
	type JournalAppendInput,
	type JournalAppendResult,
	type JournalFailure,
	type JournalFailureCode,
	type JournalKind,
	type JournalMessageKind,
	type JournalSuccess,
} from "./journal-schema.ts";
export { journalBackoffMs, JOURNAL_RETRY_DEFAULTS, type JournalRetryOptions } from "./journal-retry.ts";
export {
	JOURNAL_RECEIPTS,
	type JournalReceipt,
	type JournalReceiptInput,
	type JournalReceiptResult,
} from "./journal-receipt.ts";
export {
	journalDbPath,
	journalRootDir,
	journalShardFileName,
	journalShardPathFor,
	journalTasksDir,
	listJournalShardPaths,
	JOURNAL_DB_DIR_NAME,
	JOURNAL_DB_FILE_NAME,
	JOURNAL_TASKS_DIR_NAME,
} from "./journal-shards.ts";

export interface JournalWriterOptions {
	/** Single-database override (tests/scripting): EVERY append goes to this
	 *  one file — the pre-shard layout. Default (absent): SHARD MODE — one
	 *  database per task under `<agentDir>/delegate-journal/tasks/`. */
	dbPath?: string;
	/** Shard-root override (tests): shards resolve under
	 *  `<rootDir>/tasks/` instead of the agentDir layout. Ignored when dbPath
	 *  is set. */
	rootDir?: string;
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
	/** The database location this writer serves: the single-db override path
	 *  in override mode, the shard DIRECTORY in shard mode (one database per
	 *  task under it). */
	readonly dbPath: string;
	/** Append one event. Total: never throws; a failure is a structured result
	 *  the pipeline records and skips (advisory-by-contract) — EXCEPT the Law 7
	 *  version gate, which returns the structured `E_JOURNAL_VERSION` failure
	 *  the verb plumbing turns into a LOUD verb failure (C5: never a silent
	 *  no-op against a newer schema). */
	append(input: JournalAppendInput): Promise<JournalAppendResult>;
	/** Append one receipt fact for a message row. Total: never throws; the
	 *  writer-owned key is enforced (E_JOURNAL_FORBIDDEN when `audienceSession`
	 *  is not the writing process's own session id). */
	appendReceipt(input: JournalReceiptInput): Promise<JournalReceiptResult>;
	/** Close the connection (idempotent). */
	close(): void;
}

/** Never-throwing read of the input kind (append(null) is caught by append). */
function safeKind(input: unknown): string {
	const k = typeof input === "object" && input !== null ? (input as { kind?: unknown }).kind : undefined;
	return typeof k === "string" ? k : "unknown";
}

/** Invoke the advisory error sink, swallowing a throwing sink so no sink can
 *  escape append() or trigger a second call (the sink is advisory too). */
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

/** The single-statement append (bound params, never interpolated). */
const INSERT_EVENT_SQL =
	"INSERT INTO events(ts, kind, session_id, task, worker, payload) VALUES (?, ?, ?, ?, ?, ?)";

/**
 * Create the journal writer. Total by contract: a database that cannot be
 * opened still yields a writer whose `append()` returns `E_JOURNAL_OPEN` —
 * the pipeline can never be failed by the journal (Law 8, Law 13). Shard
 * mode (no dbPath override): each task's shard opens lazily on its first
 * append (after the legacy cutover rename) and stays cached until close();
 * the Law 7 gate holds per shard; `appendReceipt` routes to the shard of the
 * most recent successful append on THIS writer (no prior append in shard
 * mode → structured E_JOURNAL_OPEN — the shard would be a guess); the
 * override mode keeps the pre-shard behavior (one unambiguous database).
 */
export function createJournalWriter(opts: JournalWriterOptions = {}): JournalWriter {
	const singleDbPath = opts.dbPath ?? null;
	const shardMode = singleDbPath === null;
	const clock = opts.clock ?? systemClock;
	const rng = opts.rng ?? Math.random;
	const retry: Required<JournalRetryOptions> = {
		attempts: opts.retry?.attempts ?? JOURNAL_RETRY_DEFAULTS.attempts,
		baseMs: opts.retry?.baseMs ?? JOURNAL_RETRY_DEFAULTS.baseMs,
		maxMs: opts.retry?.maxMs ?? JOURNAL_RETRY_DEFAULTS.maxMs,
	};
	// One open shard per task (shard mode) or the single override database
	// (key ""); `versionRefused` is the LOUD per-shard Law 7 gate (C5).
	interface ShardState {
		db: JournalDb | null;
		versionRefused: number | null;
	}
	const shards = new Map<string, ShardState>();
	let closed = false;
	let lastAppendTask: string | null = null;

	// Override mode opens the one database EAGERLY (the pre-shard factory
	// behavior — the open outcome is remembered, never re-tried); shard mode
	// opens lazily per task.
	if (!shardMode) {
		const opened = openMigratedDatabase(singleDbPath as string, opts.busyTimeoutMs);
		shards.set("", "reason" in opened && opened.reason === "future-version"
			? { db: null, versionRefused: opened.found }
			: "reason" in opened
				? { db: null, versionRefused: null }
				: { db: opened.db, versionRefused: null });
	}

	function shardFor(task: string): ShardState {
		const key = shardMode ? task : "";
		const cached = shards.get(key);
		if (cached) return cached;
		const path = shardMode ? journalShardPathFor(task, opts.rootDir) : (singleDbPath as string);
		if (shardMode) migrateLegacyJournalDatabase(opts.rootDir);
		const opened = openMigratedDatabase(path, opts.busyTimeoutMs);
		const state: ShardState =
			"reason" in opened && opened.reason === "future-version"
				? { db: null, versionRefused: opened.found }
				: "reason" in opened
					? { db: null, versionRefused: null }
					: { db: opened.db, versionRefused: null };
		shards.set(key, state);
		return state;
	}

	function versionFailure(found: number): JournalFailure {
		return {
			ok: false,
			code: "E_JOURNAL_VERSION",
			error: `journal database user_version ${found} is ahead of this build's schema version ${JOURNAL_DB_VERSION} — upgrade the extension before writing`,
			attempts: 0,
		};
	}

	return {
		dbPath: shardMode ? journalTasksDir(opts.rootDir) : (singleDbPath as string),
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
				if (closed) {
					return {
						ok: false,
						code: "E_JOURNAL_OPEN",
						error: "journal database is not open",
						attempts: 0,
					};
				}
				const shard = shardFor(input.task);
				if (shard.versionRefused !== null) {
					const refused = versionFailure(shard.versionRefused);
					notifySink(opts.onError, { ...refused, kind: input.kind });
					return refused;
				}
				if (shard.db === null) {
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
				const handle = shard.db;
				const run = await runWithBusyRetry(
					() =>
						handle.run(INSERT_EVENT_SQL, [
							ts,
							input.kind,
							input.sessionId,
							input.task,
							input.worker ?? null,
							payloadText,
						]),
					{ clock, rng, retry },
				);
				if (run.ok) {
					lastAppendTask = input.task; // the receipt router's shard key
					return { ok: true, seq: Number(run.value.lastInsertRowid) };
				}
				const busy = isBusyError(run.lastError);
				const failure: JournalFailure & { kind: string } = {
					ok: false,
					code: busy ? "E_JOURNAL_BUSY" : "E_JOURNAL_WRITE",
					error: errorMessage(run.lastError),
					attempts: run.attempts,
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
		async appendReceipt(input: JournalReceiptInput): Promise<JournalReceiptResult> {
			if (closed) {
				return {
					ok: false,
					code: "E_JOURNAL_OPEN",
					error: "journal database is not open",
					attempts: 0,
				};
			}
			// The receipt belongs to the message row this writer just appended —
			// its shard is that append's task's shard. In shard mode a receipt
			// with no prior append on THIS writer has no shard (a guess is
			// refused, never invented); the override mode keeps the pre-shard
			// behavior (the one database is unambiguous).
			if (shardMode && lastAppendTask === null) {
				return {
					ok: false,
					code: "E_JOURNAL_OPEN",
					error: "receipt refused: no journal row was appended on this writer — the receipt's shard is unknown",
					attempts: 0,
				};
			}
			const shard = shardFor(lastAppendTask ?? "");
			if (shard.versionRefused !== null) {
				const refused = versionFailure(shard.versionRefused);
				notifySink(opts.onError, { ...refused, kind: `receipt:${String(input.receipt)}` });
				return refused;
			}
			if (shard.db === null) {
				return {
					ok: false,
					code: "E_JOURNAL_OPEN",
					error: "journal database is not open",
					attempts: 0,
				};
			}
			const handle = shard.db;
			return appendReceiptTo(handle, input, { clock, rng, retry });
		},
		close() {
			if (closed) return;
			closed = true;
			for (const shard of shards.values()) {
				try {
					shard.db?.close();
				} catch {
					// advisory — a close failure never propagates
				}
			}
			shards.clear();
		},
	};
}
