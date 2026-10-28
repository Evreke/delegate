/**
 * pi-delegate — src/swarm/journal.ts — the fleet event journal, WRITER side.
 *
 * MODULE_CONTRACT — append-only, single-writer, durable (ARCHITECTURE §4.1.2).
 *
 * Purpose: the writer half of the journal module family (`src/swarm/journal*.ts`)
 * — the ONLY writer CODE for `events.db`: the closed kind set, the event
 * append protocol, the writer factory, and the Law 7 version gate. The family
 * siblings own the rest: `journal-schema.ts` the versioned DDL contract (the
 * byte-pinned v1 events table + the v2 side tables + the open+migrate path),
 * `journal-retry.ts` the bounded SQLITE_BUSY protocol, `journal-receipt.ts`
 * the receipt side-table writer, `journal-read.ts` the tolerant reader,
 * `journal-compact.ts` the operator-invoked compaction (the family's one
 * DELETE site).
 *
 * Advisory to the pipeline (Law 8/Law 13): `append()` NEVER throws and never
 * propagates a failure to a spawn or collect. The ONE loud exception is the
 * Law 7 version gate: a FUTURE `user_version` makes every append return the
 * structured `E_JOURNAL_VERSION` failure — never a silent no-op (the store
 * design's C5 amendment; the reader stays tolerant).
 *
 * Location (Law 1): ONE database at `join(getAgentDir(), "delegate-journal", "events.db")`
 * — resolved through pi's `getAgentDir()` (never hardcoded, never the exchange
 * root). `journalDbPath()` is the single source of that path.
 *
 * Single-writer code, multi-process database: every concurrent pi session
 * process writes the same `events.db`, so SQLite itself serializes writers.
 * The pinned DDL sets `busy_timeout = 5000` ms; every append retries
 * `SQLITE_BUSY` under the bounded backoff-plus-jitter (./journal-retry.ts)
 * and stays a short single-statement transaction. A torn write (process death
 * mid-append) leaves the last record intact or absent — never corrupt; WAL +
 * `synchronous = FULL` is what buys that (verified by `test/journal-check.ts`
 * against a SIGKILLed writer child).
 *
 * Append-only by absence: this module contains NO UPDATE and NO DELETE
 * statement. The sole documented exception in §4.1.2 is the operator-invoked
 * compaction path; it lives in its own family file `src/swarm/journal-compact.ts`
 * so this writer never grows past the Law 5 threshold — it is the one place a
 * DELETE may appear in the family, and `journal-check.ts` scans these sources
 * for write keywords so that confinement is a tested state, not a convention.
 *
 * Dependencies: the sqlite driver via `./journal-driver.ts` (adaptive bun:sqlite / node:sqlite — pi runs under both runtimes),
 * the family siblings, pi's `getAgentDir()`, node builtins, and `./clock.ts`
 * (the injected ClockPort supplies `ts`). No herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - `JOURNAL_SCHEMA_V1_DDL` (./journal-schema.ts) is the DDL pinned in
 *     §4.1.2, applied verbatim — BYTE-IDENTICAL including its `PRAGMA user_version = 1`
 *     line (Law 7); the v2 DDL re-stamps the version after it on every open.
 *   - The Law 7 version gate is LOUD (C5): a FUTURE `user_version` makes
 *     `append()`/`appendReceipt()` return the structured `E_JOURNAL_VERSION`
 *     failure — never a silent no-op writer; the READER stays tolerant
 *     (missing db / future version → empty, never a throw).
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
 */

import { type JournalDb } from "./journal-driver.ts";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { systemClock, type ClockPort } from "../clock.ts";
import {
	JOURNAL_DB_VERSION,
	openMigratedDatabase,
} from "./journal-schema.ts";
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
export { journalBackoffMs, JOURNAL_RETRY_DEFAULTS, type JournalRetryOptions } from "./journal-retry.ts";
export {
	JOURNAL_RECEIPTS,
	type JournalReceipt,
	type JournalReceiptInput,
	type JournalReceiptResult,
} from "./journal-receipt.ts";

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
// The closed v1 kind set (§4.1.2) — new kinds only by addition, never rename
// ---------------------------------------------------------------------------

/** The closed v1 kinds (additive-only, §4.1.2): the issue's 11 plus
 *  `reconcile-summary`, `compaction-marker`, and the #23 `report` addition
 *  (payload = the validated report JSON verbatim). `termination-notice` /
 *  `partial-report` are forward-compat (#15) before their producers land. */
export const JOURNAL_KINDS = [
	"spawn",
	"stamp",
	"collect",
	"ask",
	"answer",
	"steer",
	"progress",
	"report",
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

/** The closed MESSAGE kind subset (the store design §2): the four kinds whose
 *  rows ARE messages — the shadow-write surface (`swarm.messageShadow`) and
 *  the 1.20.0 truth flip ride exactly these. `report` stays reserved for the
 *  report axis and is NEVER a message kind. */
export const JOURNAL_MESSAGE_KINDS = ["ask", "answer", "steer", "progress"] as const;

export type JournalMessageKind = (typeof JOURNAL_MESSAGE_KINDS)[number];

const JOURNAL_MESSAGE_KIND_SET: ReadonlySet<string> = new Set(JOURNAL_MESSAGE_KINDS);

export function isJournalMessageKind(v: unknown): v is JournalMessageKind {
	return typeof v === "string" && JOURNAL_MESSAGE_KIND_SET.has(v);
}

// ---------------------------------------------------------------------------
// Structured, never-throwing results (Law 8)
// ---------------------------------------------------------------------------

/** Failure codes this module can return. `E_JOURNAL_BUSY` means the bounded
 *  retry budget was exhausted under cross-process contention.
 *  `E_JOURNAL_VERSION` is the LOUD Law 7 gate (C5): the database carries a
 *  FUTURE `user_version` — a newer build's schema. `E_JOURNAL_FORBIDDEN` is
 *  the receipt writer-authority refusal (store design §3). */
export type JournalFailureCode =
	| "E_JOURNAL_KIND"
	| "E_JOURNAL_BUSY"
	| "E_JOURNAL_WRITE"
	| "E_JOURNAL_OPEN"
	| "E_JOURNAL_VERSION"
	| "E_JOURNAL_FORBIDDEN";

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

/** The single-statement append (bound params, never interpolated). */
const INSERT_EVENT_SQL =
	"INSERT INTO events(ts, kind, session_id, task, worker, payload) VALUES (?, ?, ?, ?, ?, ?)";

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
	const opened = openMigratedDatabase(dbPath, opts.busyTimeoutMs);
	// The LOUD Law 7 gate (C5): a future version is remembered and every append
	// fails structured E_JOURNAL_VERSION — never a silent no-op writer.
	const versionRefused = "reason" in opened && opened.reason === "future-version" ? opened.found : null;
	let db: JournalDb | null = opened.db;
	let closed = false;

	function versionFailure(): JournalFailure {
		return {
			ok: false,
			code: "E_JOURNAL_VERSION",
			error: `journal database user_version ${versionRefused} is ahead of this build's schema version ${JOURNAL_DB_VERSION} — upgrade the extension before writing`,
			attempts: 0,
		};
	}

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
				if (versionRefused !== null) {
					const refused = versionFailure();
					notifySink(opts.onError, { ...refused, kind: input.kind });
					return refused;
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
				const handle = db;
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
				if (run.ok) return { ok: true, seq: Number(run.value.lastInsertRowid) };
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
			if (versionRefused !== null) {
				const refused = versionFailure();
				notifySink(opts.onError, { ...refused, kind: `receipt:${String(input.receipt)}` });
				return refused;
			}
			if (closed || db === null) {
				return {
					ok: false,
					code: "E_JOURNAL_OPEN",
					error: "journal database is not open",
					attempts: 0,
				};
			}
			const handle = db;
			return appendReceiptTo(handle, input, { clock, rng, retry });
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
