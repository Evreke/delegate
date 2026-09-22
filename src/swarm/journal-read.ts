/**
 * pi-delegate — src/swarm/journal-read.ts — the fleet event journal, READ side.
 *
 * MODULE_CONTRACT — the query half of the journal module family (§4.1.2).
 *
 * Purpose: read the append-only journal written by `./journal.ts` — the cursor
 * reader `eventsAfter(cursor)` (§4.1.2: all rows with `seq > cursor`, ordered
 * by `seq`), per-task and per-worker reads, plus row-count/size visibility for
 * `swarm status`. The watcher (#26) consumes `eventsAfter(cursor)`; `swarm
 * events --after <seq>` (#30) exposes it verbatim.
 *
 * Read-only by construction: this module contains NO INSERT, UPDATE or DELETE
 * statement. It never migrates, never creates a missing database, and never
 * fails a caller — every query is tolerant (Law 7/Law 8/Law 13): a missing
 * file, a future `user_version`, a missing table or a corrupt row payload
 * yields an empty/valid result, never a throw.
 *
 * Dependencies: the sqlite driver via `./journal-driver.ts` (adaptive, Law 1), node builtins, and `./journal.ts` (the
 * ONE location resolver + the Law 7 version gate + the closed kind set). No
 * herdr adapter import (Law 4).
 */

import { openJournalDatabase, type JournalDb } from "./journal-driver.ts";
import { existsSync, statSync } from "node:fs";
import { isJournalKind, journalDbPath, JOURNAL_DB_VERSION, type JournalKind } from "./journal.ts";

/** One journal row with its payload JSON-parsed. `payload` is `null` when the
 *  stored text is not valid JSON (tolerant read — never a throw). */
export interface JournalEvent {
	seq: number;
	ts: string;
	kind: JournalKind;
	sessionId: string;
	task: string;
	worker: string | null;
	payload: unknown;
}

/** Optional narrowing for `eventsAfter`. All filters are AND-combined. */
export interface JournalQuery {
	sessionId?: string;
	task?: string;
	worker?: string;
	/** Row cap; the reader still orders by `seq` ascending. */
	limit?: number;
}

export interface JournalReaderOptions {
	/** Database path override (tests sandbox here). Default `journalDbPath()`. */
	dbPath?: string;
}

export interface JournalReader {
	readonly dbPath: string;
	/** The cursor read: all events with `seq > cursor`, ordered by `seq`. */
	eventsAfter(cursor: number, query?: JournalQuery): JournalEvent[];
	/** All events of one fleet (`sessionId`, `task`), optionally after a cursor. */
	eventsForTask(sessionId: string, task: string, after?: number): JournalEvent[];
	/** All events of one worker within a fleet, optionally after a cursor. */
	eventsForWorker(sessionId: string, task: string, worker: string, after?: number): JournalEvent[];
	/** Total row count (0 when the database is absent/unsupported). */
	count(): number;
	/** Database file size in bytes (0 when absent) — the retention-visibility
	 *  half of §4.1.2. */
	dbSizeBytes(): number;
	/** Close the connection (idempotent). */
	close(): void;
}

interface EventRow {
	seq: number;
	ts: string;
	kind: string;
	session_id: string;
	task: string;
	worker: string | null;
	payload: string;
}

const SELECT_COLUMNS = "seq, ts, kind, session_id, task, worker, payload";

function mapRow(r: EventRow): JournalEvent | null {
	// Tolerant read: a kind outside the closed v1 set (a future row) is skipped,
	// consistent with the reader's empty-but-valid failure mode.
	if (!isJournalKind(r.kind)) return null;
	let payload: unknown = null;
	try {
		payload = JSON.parse(r.payload);
	} catch {
		payload = null;
	}
	return {
		seq: Number(r.seq),
		ts: r.ts,
		kind: r.kind,
		sessionId: r.session_id,
		task: r.task,
		worker: r.worker ?? null,
		payload,
	};
}

/**
 * Open the journal read-only. Returns null when the file is absent, cannot be
 * opened, or carries a FUTURE `user_version` (Law 7 gate → empty result).
 * Uses a true read-only open (bun:sqlite `{ readonly: true }` / node:sqlite
 * `{ readOnly: true }`) so the database file is never touched — no WAL
 * sidecar creation, no checkpoint, no mtime change (Law 13, A8b).
 */
function openReadOnly(dbPath: string): JournalDb | null {
	try {
		if (!existsSync(dbPath)) return null;
		// Open read-only: prevents WAL sidecar touches on the database file —
		// a journal-mode snapshot must be a PURE READ (Law 13, A8b).
		const db = openJournalDatabase(dbPath, { readOnly: true });
		const row = db.queryOne<{ user_version?: number }>("PRAGMA user_version");
		if (Number(row?.user_version ?? 0) > JOURNAL_DB_VERSION) {
			db.close();
			return null;
		}
		const table = db.queryOne("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'");
		if (!table) {
			db.close();
			return null;
		}
		return db;
	} catch {
		return null;
	}
}

/**
 * Create a tolerant journal reader. Total by contract: every method returns an
 * empty/valid value on any failure — the read side is structurally incapable
 * of failing a caller (advisory, Law 8/Law 13).
 */
export function createJournalReader(opts: JournalReaderOptions = {}): JournalReader {
	const dbPath = opts.dbPath ?? journalDbPath();
	const db: JournalDb | null = openReadOnly(dbPath);

	function queryEvents(after: number, q: JournalQuery): JournalEvent[] {
		if (db === null) return [];
		try {
			const cursor = Number.isFinite(after) ? Math.floor(after) : 0;
			let sql = `SELECT ${SELECT_COLUMNS} FROM events WHERE seq > ?`;
			const params: Array<string | number> = [cursor];
			if (q.sessionId !== undefined) {
				sql += " AND session_id = ?";
				params.push(q.sessionId);
			}
			if (q.task !== undefined) {
				sql += " AND task = ?";
				params.push(q.task);
			}
			if (q.worker !== undefined) {
				sql += " AND worker = ?";
				params.push(q.worker);
			}
			sql += " ORDER BY seq ASC";
			if (q.limit !== undefined && Number.isFinite(q.limit)) {
				sql += " LIMIT ?";
				params.push(Math.max(0, Math.floor(q.limit)));
			}
			return (db.queryAll<EventRow>(sql, params))
				.map(mapRow)
				.filter((e): e is JournalEvent => e !== null);
		} catch {
			return [];
		}
	}

	return {
		dbPath,
		eventsAfter(cursor, query = {}) {
			return queryEvents(cursor, query);
		},
		eventsForTask(sessionId, task, after = 0) {
			return queryEvents(after, { sessionId, task });
		},
		eventsForWorker(sessionId, task, worker, after = 0) {
			return queryEvents(after, { sessionId, task, worker });
		},
		count() {
			if (db === null) return 0;
			try {
				const row = db.queryOne<{ c?: number }>("SELECT COUNT(*) AS c FROM events");
				return Number(row?.c ?? 0);
			} catch {
				return 0;
			}
		},
		dbSizeBytes() {
			try {
				return existsSync(dbPath) ? statSync(dbPath).size : 0;
			} catch {
				return 0;
			}
		},
		close() {
			try {
				db?.close();
			} catch {
				// advisory — a close failure never propagates
			}
		},
	};
}
