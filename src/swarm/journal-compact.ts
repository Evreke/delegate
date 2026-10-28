/**
 * MODULE_CONTRACT
 * journal-compact.ts — the operator-invoked compaction path of the journal
 * module family (`src/swarm/journal*.ts`): export a fleet's events to JSONL,
 * then delete them — the family's ONE DELETE site (§4.1.2 retention, operator
 * decision DP7), extended with the store design's C6 amendment: the deletion
 * is AUDIENCE-SCOPED and runs only on a HEALTHY SNAPSHOT.
 *
 * Binding rules (DP7 + C6 — never softened):
 *   - All-terminal rule (DP7): deletion is allowed ONLY for fleets whose
 *     workers are ALL terminal — every worker named in the fleet's rows must
 *     carry a `collect` / `retire` / `dead-reboot` row. Verified from the
 *     journal (the audit truth), never from the mutable manifest alone.
 *   - Audience classification (C6): before deleting a range, EVERY
 *     audience_session with side-table rows for the task is classified:
 *       · LIVE audience (its session JSONL exists) with UNCONSUMED rows in
 *         the range (its read_cursor is below the range end; an absent cursor
 *         reads as 0 — the never-seed discipline) → REFUSE the range.
 *       · UNCLASSIFIABLE audience (the fleet's manifest read failed or is
 *         half-succeeded — the extended healthy-snapshot guard, the D1
 *         defense applied to compaction) → REFUSE the range, never guess.
 *       · DEAD audience (session JSONL gone AND the healthy manifest shows no
 *         worker owned by that audience without a terminal stamp) →
 *         deletable.
 *     The conservative direction is always refusal: a stale live console can
 *     block compaction; a wrongly deleted range would be silence.
 *   - Cascade (no dangling references): the message_receipts and wake_facts
 *     rows referencing the deleted message range die in the SAME transaction
 *     as their messages. wake_facts with a NULL msg_seq (file-detected
 *     conditions) reference no row — they survive (suppression is never
 *     destroyed by compaction). read_cursors survive (positions, not
 *     history).
 *   - Audit continuity: every compaction appends a `compaction-marker` event
 *     AFTER the deletion it records (exportedTo, deletedCount, lastDeletedSeq).
 *
 * Dependencies: the driver via ./journal-driver.ts (the family's one driver
 * seam), ./journal-schema.ts (the ONE open+migrate spelling), ./journal.ts
 * (the marker append through the writer protocol), ./journal-retry.ts (the
 * bounded busy-retry), ../manifest-store.ts (readManifest — the ONE manifest
 * reader), node builtins. No herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - total: never throws — every outcome is a structured result (Law 8);
 *   - a refusal (any E_COMPACT_* code) leaves the database byte-untouched;
 *   - the DELETEs run in ONE transaction under the bounded busy-retry.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JournalDb } from "./journal-driver.ts";
import { openMigratedDatabase, JOURNAL_DB_VERSION } from "./journal-schema.ts";
import { createJournalWriter } from "./journal.ts";
import { journalShardPathFor, migrateLegacyJournalDatabase } from "./journal-shards.ts";
import { errorMessage, isBusyError, runWithBusyRetry, type JournalRetryOptions, JOURNAL_RETRY_DEFAULTS } from "./journal-retry.ts";
import { readManifest, type ExchangeManifest } from "../manifest-store.ts";
import { systemClock, type ClockPort } from "../clock.ts";

/** The terminal worker kinds (DP7's all-terminal rule). */
export const COMPACT_TERMINAL_KINDS = ["collect", "retire", "dead-reboot"] as const;

/** Structured refusal/IO codes of the compaction path. */
export type CompactFailureCode =
	| "E_COMPACT_EMPTY"
	| "E_COMPACT_UNTERMINAL"
	| "E_COMPACT_UNCLASSIFIABLE"
	| "E_COMPACT_LIVE_AUDIENCE"
	| "E_COMPACT_VERSION"
	| "E_COMPACT_IO";

export interface CompactFleetOptions {
	/** Single-database override (tests sandbox here). Default: the task's
	 *  SHARD (the per-task layout) — compaction operates within one shard. */
	dbPath?: string;
	/** Shard-root override (tests): the shard resolves under
	 *  `<rootDir>/tasks/`. Ignored when dbPath is set. */
	rootDir?: string;
	/** The fleet's session id (the events.session_id spelling). */
	sessionId: string;
	/** The exchange task name (the events.task spelling). */
	task: string;
	/** The fleet's task dir — the manifest is read from here for the
	 *  healthy-snapshot guard (readManifest, the ONE manifest reader). */
	dir: string;
	/** Export target override. Default: next to the database (NEVER the task
	 *  dir — the exchange dir's file namespace is closed). */
	exportPath?: string;
	/** Clock for the default export name. Default `systemClock`. */
	clock?: ClockPort;
	/** SQLITE_BUSY retry budget. Defaults to `JOURNAL_RETRY_DEFAULTS`. */
	retry?: JournalRetryOptions;
	/** Jitter source for the backoff. Default `Math.random`. */
	rng?: () => number;
}

export interface CompactFleetSuccess {
	ok: true;
	/** The JSONL export the deletion is gated on (written BEFORE the delete). */
	exportedTo: string;
	deletedCount: number;
	firstDeletedSeq: number;
	lastDeletedSeq: number;
	/** The audit marker appended AFTER the deletion; {error} when the marker
	 *  append failed advisably (the deletion itself is durable). */
	marker: { seq: number } | { error: string };
}

export interface CompactFleetFailure {
	ok: false;
	code: CompactFailureCode;
	error: string;
}

export type CompactFleetResult = CompactFleetSuccess | CompactFleetFailure;

interface FleetRow {
	seq: number;
	ts: string;
	kind: string;
	session_id: string;
	task: string;
	worker: string | null;
	payload: string;
}

/** The audience's consumption position (absent row reads as 0 — never seeded). */
function readCursorFor(db: JournalDb, audienceSession: string, task: string): number {
	const row = db.queryOne<{ seq?: number }>(
		"SELECT seq FROM read_cursors WHERE audience_session = ? AND task = ?",
		[audienceSession, task],
	);
	return Number(row?.seq ?? 0);
}

/** Distinct audiences holding side-table rows for the task (C6: every
 *  audience_session with rows in the deleted range is classified — receipts
 *  included; the receipt join runs over the range's message rows because the
 *  receipts table carries no task column). */
function audienceSet(db: JournalDb, task: string, sessionId: string): string[] {
	const wakes = db.queryAll<{ audience_session: string }>(
		"SELECT DISTINCT audience_session FROM wake_facts WHERE task = ?",
		[task],
	);
	const cursors = db.queryAll<{ audience_session: string }>(
		"SELECT DISTINCT audience_session FROM read_cursors WHERE task = ?",
		[task],
	);
	const receipts = db.queryAll<{ audience_session: string }>(
		"SELECT DISTINCT audience_session FROM message_receipts WHERE msg_seq IN " +
			"(SELECT seq FROM events WHERE session_id = ? AND task = ?)",
		[sessionId, task],
	);
	return [...new Set([...wakes, ...cursors, ...receipts].map((r) => r.audience_session))];
}

/** The healthy-snapshot guard (C6): the manifest must read cleanly and carry
 *  a workers array — a failed or half-succeeded read leaves every audience
 *  unclassifiable. */
function healthyManifestSnapshot(dir: string, task: string): ExchangeManifest | null {
	const m = readManifest(dir);
	if (m === null || !Array.isArray(m.workers) || typeof m.task !== "string" || m.task !== task) return null;
	return m;
}

/** True when the healthy manifest still shows the audience owning a worker
 *  without a terminal stamp (collectedAt / retiredAt) — a possibly-live fleet. */
function manifestShowsLiveFleet(m: ExchangeManifest, audienceSession: string): boolean {
	return m.workers.some((w) => {
		const owner = typeof w.orchestratorSessionPath === "string" ? w.orchestratorSessionPath : undefined;
		if (owner !== audienceSession) return false;
		return w.collectedAt === undefined && w.retiredAt === undefined;
	});
}

/** The audience spelling is registered by the healthy manifest at all (any
 *  worker, terminal or not). Only manifest-registered sessions may ever read
 *  as dead; every other spelling (e.g. the interim dir-hash receipt ids) is
 *  unclassifiable. */
function manifestShowsSession(m: ExchangeManifest, audienceSession: string): boolean {
	return m.workers.some(
		(w) => typeof w.orchestratorSessionPath === "string" && w.orchestratorSessionPath === audienceSession,
	);
}

/**
 * Compact one fleet: classify the audiences (C6), export the fleet's rows to
 * JSONL, then delete the rows and their receipts/wake facts in ONE
 * transaction, then append the audit marker.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts — the fleet identity (sessionId, task, dir), paths, injections
 * Output: a structured success (export path, deleted range, marker) or a
 *   coded refusal/IO failure
 * Guarantees:
 *   - a refusal leaves the database untouched (classification precedes every
 *     write; the export precedes the delete);
 *   - the DP7 all-terminal rule and the C6 audience guard both hold or the
 *     range is refused — never guessed;
 *   - receipts + wake_facts of the deleted range die in the same transaction
 *     (no dangling references); NULL-msg_seq wake facts and read cursors
 *     survive;
 *   - total: never throws (Law 8)
 * Raises: never
 */
export async function compactFleet(opts: CompactFleetOptions): Promise<CompactFleetResult> {
	// The dbPath override keeps the pre-shard single-database behavior; the
	// default compacts the task's OWN shard. The production path is a
	// writer-side open of the new layout → the legacy cutover rename runs
	// first (advisory; the renamed legacy rows are inert copies — a fleet
	// whose rows live only in the legacy file compacts to E_COMPACT_EMPTY).
	if (opts.dbPath === undefined) migrateLegacyJournalDatabase(opts.rootDir);
	const dbPath = opts.dbPath ?? journalShardPathFor(opts.task, opts.rootDir);
	const clock = opts.clock ?? systemClock;
	const rng = opts.rng ?? Math.random;
	const retry: Required<JournalRetryOptions> = {
		attempts: opts.retry?.attempts ?? JOURNAL_RETRY_DEFAULTS.attempts,
		baseMs: opts.retry?.baseMs ?? JOURNAL_RETRY_DEFAULTS.baseMs,
		maxMs: opts.retry?.maxMs ?? JOURNAL_RETRY_DEFAULTS.maxMs,
	};

	if (!existsSync(dbPath)) {
		return { ok: false, code: "E_COMPACT_EMPTY", error: `no journal database at ${dbPath}` };
	}
	const opened = openMigratedDatabase(dbPath);
	if ("reason" in opened && opened.reason === "future-version") {
		return {
			ok: false,
			code: "E_COMPACT_VERSION",
			error: `journal database user_version ${opened.found} is ahead of this build's schema version ${JOURNAL_DB_VERSION} — upgrade the extension before compacting`,
		};
	}
	if ("reason" in opened && opened.reason === "unopenable") {
		return { ok: false, code: "E_COMPACT_IO", error: `journal database not openable at ${dbPath}` };
	}
	const db = opened.db;
	try {
		// The fleet's rows = the deletion range (DP7 compacts a WHOLE fleet).
		const rows = db.queryAll<FleetRow>(
			"SELECT seq, ts, kind, session_id, task, worker, payload FROM events WHERE session_id = ? AND task = ? ORDER BY seq ASC",
			[opts.sessionId, opts.task],
		);
		if (rows.length === 0) {
			return { ok: false, code: "E_COMPACT_EMPTY", error: `no journal rows for fleet ${opts.sessionId}/${opts.task}` };
		}
		const lastSeq = Number(rows[rows.length - 1]!.seq);

		// DP7 all-terminal rule — verified from the journal (the audit truth).
		const workers = [...new Set(rows.map((r) => r.worker).filter((w): w is string => w !== null))];
		const terminal = new Set(
			rows.filter((r) => (COMPACT_TERMINAL_KINDS as readonly string[]).includes(r.kind)).map((r) => r.worker),
		);
		const unter = workers.filter((w) => !terminal.has(w));
		if (unter.length > 0) {
			return {
				ok: false,
				code: "E_COMPACT_UNTERMINAL",
				error: `fleet ${opts.sessionId}/${opts.task} has non-terminal workers (${unter.join(", ")}) — the all-terminal rule refuses the range`,
			};
		}

		// C6 — classify EVERY audience with side-table rows for the task.
		const audiences = audienceSet(db, opts.task, opts.sessionId);
		let manifest: ExchangeManifest | null = null;
		if (audiences.length > 0) {
			manifest = healthyManifestSnapshot(opts.dir, opts.task);
			if (manifest === null) {
				return {
					ok: false,
					code: "E_COMPACT_UNCLASSIFIABLE",
					error: `the manifest snapshot for ${opts.task} is absent, corrupt or half-succeeded — audiences ${audiences.join(", ")} are unclassifiable; the range is refused, never guessed`,
				};
			}
			for (const a of audiences) {
				if (existsSync(a)) {
					// LIVE console: refusal unless its cursor proves consumption.
					if (readCursorFor(db, a, opts.task) < lastSeq) {
						return {
							ok: false,
							code: "E_COMPACT_LIVE_AUDIENCE",
							error: `live audience ${a} has unconsumed rows in the range (cursor ${readCursorFor(db, a, opts.task)} < ${lastSeq}) — the range is refused`,
						};
					}
				} else if (manifestShowsLiveFleet(manifest, a)) {
					// Console gone, but the healthy manifest still shows it owning a
					// worker without a terminal stamp — not provably dead.
					return {
						ok: false,
						code: "E_COMPACT_LIVE_AUDIENCE",
						error: `audience ${a} owns a possibly-live fleet in the manifest (no terminal stamp) — the range is refused, never guessed`,
					};
				} else if (!manifestShowsSession(manifest, a)) {
					// The spelling resolves to nothing this task's manifest knows (the
					// interim receipt dir-hash class): UNCLASSIFIABLE, never dead —
					// a misclassified dead audience loses its dedup facts silently.
					return {
						ok: false,
						code: "E_COMPACT_UNCLASSIFIABLE",
						error: `audience ${a} resolves to no JSONL path and no manifest session — unclassifiable; the range is refused, never guessed`,
					};
				}
				// else: DEAD audience (session JSONL gone, no live fleet) — deletable.
			}
		}

		// Export BEFORE the delete (export-then-delete; a refusal above never
		// wrote anything). Payload is emitted losslessly: parsed JSON when the
		// stored text parses, else the raw string.
		const exportedTo =
			opts.exportPath ??
			join(dirname(dbPath), `compaction-${opts.task}-${opts.sessionId.slice(0, 8)}-${new Date(clock.now()).toISOString().replace(/[:.]/g, "-")}.jsonl`);
		const lines = rows.map((r) => {
			let payload: unknown;
			try {
				payload = JSON.parse(r.payload);
			} catch {
				payload = r.payload;
			}
			return JSON.stringify({
				seq: Number(r.seq),
				ts: r.ts,
				kind: r.kind,
				sessionId: r.session_id,
				task: r.task,
				worker: r.worker,
				payload,
			});
		});
		try {
			mkdirSync(dirname(exportedTo), { recursive: true });
			writeFileSync(exportedTo, lines.map((l) => `${l}\n`).join(""), "utf8");
		} catch (e) {
			return { ok: false, code: "E_COMPACT_IO", error: `export not writable at ${exportedTo}: ${errorMessage(e)}` };
		}

		// ONE transaction: the range's receipts and wake facts die with their
		// messages (no dangling references); read_cursors survive.
		const del = await runWithBusyRetry(() => {
			db.exec("BEGIN IMMEDIATE");
			try {
				db.run("DELETE FROM message_receipts WHERE msg_seq IN (SELECT seq FROM events WHERE session_id = ? AND task = ?)", [
					opts.sessionId,
					opts.task,
				]);
				db.run("DELETE FROM wake_facts WHERE task = ? AND msg_seq IN (SELECT seq FROM events WHERE session_id = ? AND task = ?)", [
					opts.task,
					opts.sessionId,
					opts.task,
				]);
				db.run("DELETE FROM events WHERE session_id = ? AND task = ?", [opts.sessionId, opts.task]);
				db.exec("COMMIT");
			} catch (e) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// the transaction may already be closed by the failed COMMIT
				}
				throw e;
			}
		}, { clock, rng, retry });
		if (!del.ok) {
			const busy = isBusyError(del.lastError);
			return {
				ok: false,
				code: "E_COMPACT_IO",
				error: `compaction transaction failed (${busy ? "busy" : "write"}): ${errorMessage(del.lastError)} — the export at ${exportedTo} is intact, nothing was deleted`,
			};
		}

		// Audit continuity: the marker is appended AFTER the deletion it
		// records, through the writer protocol. A marker failure is reported
		// honestly (the deletion itself is durable).
		const markerWriter = createJournalWriter({ dbPath, clock });
		try {
			const marker = await markerWriter.append({
				kind: "compaction-marker",
				sessionId: opts.sessionId,
				task: opts.task,
				worker: null,
				payload: { exportedTo, deletedCount: rows.length, lastDeletedSeq: lastSeq },
			});
			return {
				ok: true,
				exportedTo,
				deletedCount: rows.length,
				firstDeletedSeq: Number(rows[0]!.seq),
				lastDeletedSeq: lastSeq,
				marker: marker.ok ? { seq: marker.seq } : { error: marker.code },
			};
		} finally {
			markerWriter.close();
		}
	} finally {
		try {
			db.close();
		} catch {
			// advisory — a close failure never propagates
		}
	}
}
