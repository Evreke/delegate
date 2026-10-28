/**
 * pi-delegate — src/swarm/journal-read.ts — the fleet event journal, READ side.
 *
 * MODULE_CONTRACT — the query half of the journal module family (§4.1.2).
 *
 * Purpose: read the append-only journal written by `./journal.ts` — the cursor
 * reader `eventsAfter(cursor)` (§4.1.2: all rows with `seq > cursor`, ordered
 * by `seq`), per-task and per-worker reads, plus row-count/size visibility for
 * `swarm status`. The watcher (#26) consumes the per-task cursor read;
 * `swarm events --after <seq>` (#30) exposes the reader verbatim.
 *
 * Shard model (the per-task layout, `./journal-shards.ts`): in the DEFAULT
 * (shard) mode every task owns one SQLite database under
 * `<agentDir>/delegate-journal/tasks/` —
 *   - a FLEET-SCOPED read (a `task` filter present) opens EXACTLY ONE shard
 *     (the task's own; a missing shard file reads empty and is never
 *     created);
 *   - a GLOBAL read (no `task` filter: unscoped `eventsAfter`, `count()`,
 *     `dbSizeBytes()`, `kindStats()` without tasks) is a UNION over the
 *     shards found by scanning the `tasks/` directory. `seq` is PER SHARD,
 *     so the unscoped cursor applies per shard (rows with `seq > cursor` in
 *     every shard) and the union orders by `(ts, seq, shardPath)` — within
 *     one shard `ts` is monotone with `seq` (the injected clock); cross-shard
 *     paging precision is the task-scoped route's job. `count()` sums,
 *     `dbSizeBytes()` sums the file sizes, `kindStats()` merges per kind
 *     (counts summed, oldest ts = the lexicographic MIN). The `dbPath`
 *     override keeps the pre-shard single-database behavior (tests and
 *     scripting): every read opens that one file.
 *
 * Read-only by construction: this module contains NO INSERT, UPDATE or DELETE
 * statement. It never migrates, never creates a missing database, and never
 * fails a caller — every query is tolerant (Law 7/Law 8/Law 13): a missing
 * file, a future `user_version`, a missing table or a corrupt row payload
 * yields an empty/valid result, never a throw.
 *
 * Dependencies: the sqlite driver via `./journal-driver.ts` (adaptive, Law 1),
 * node builtins, `./journal.ts` (the Law 7 version gate + the closed kind
 * set) and `./journal-shards.ts` (the shard layout). No herdr adapter import
 * (Law 4).
 */

import type { JournalDb } from "./journal-driver.ts";
import { existsSync, statSync } from "node:fs";
import { isJournalKind, journalDbPath, type JournalKind } from "./journal.ts";
import {
	createJournalShardSet,
	journalShardPathFor,
	journalTasksDir,
	listJournalShardPaths,
	openReadOnlyJournalDb,
} from "./journal-shards.ts";

// Re-export the ONE location resolver through the READER surface (Law 13/
// §4.2, pinned by T1.15): read-API clients (src/swarm-server/) may import
// the journal ONLY through this module — the writer half (./journal.ts) is
// not a door. Pure name, zero behavior.
export { journalDbPath };

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

/** Optional narrowing for `eventsAfter`. All filters are AND-combined. A
 *  `task` filter makes the read FLEET-SCOPED (exactly one shard). */
export interface JournalQuery {
	sessionId?: string;
	task?: string;
	worker?: string;
	/** Row cap; the reader still orders by `seq` ascending (per shard; the
	 *  global union applies the cap after the global order). */
	limit?: number;
}

/** One per-kind visibility row (the §4 retention-visibility extension): the
 *  kind's row count and its OLDEST row ts (ISO-8601 UTC; lexicographic MIN —
 *  chronological for the injected-clock spelling). `kind` is the raw stored
 *  string: visibility counts EVERY row (an unknown future kind is still disk
 *  growth an operator must see), unlike the row reads which skip it. */
export interface JournalKindStat {
	kind: string;
	count: number;
	oldestTs: string | null;
}

/** The explicit cursor-read page size of the HTTP/WS read API (issue #88): one
 *  events response or WS frame never carries more than this many rows; a caller
 *  pages with `after=<lastSeq>`. The reader itself applies a limit only when a
 *  caller passes one — the read API is the caller that must. */
export const JOURNAL_EVENTS_PAGE_LIMIT = 500;

export interface JournalReaderOptions {
	/** Single-database override (tests sandbox here): the pre-shard layout —
	 *  every read opens this one file. Default: SHARD MODE. */
	dbPath?: string;
	/** Shard-root override (tests): shards resolve under `<rootDir>/tasks/`.
	 *  Ignored when dbPath is set. */
	rootDir?: string;
}

export interface JournalReader {
	/** The database location this reader serves: the single-db override path
	 *  in override mode, the shard DIRECTORY in shard mode. */
	readonly dbPath: string;
	/** The cursor read: all events with `seq > cursor`, ordered by `seq`
	 *  (per shard); a task-scoped query reads exactly that task's shard, an
	 *  unscoped query is the union (see MODULE_CONTRACT for the union order). */
	eventsAfter(cursor: number, query?: JournalQuery): JournalEvent[];
	/** All events of one fleet (`sessionId`, `task`), optionally after a cursor. */
	eventsForTask(sessionId: string, task: string, after?: number): JournalEvent[];
	/** All events of one worker within a fleet, optionally after a cursor. */
	eventsForWorker(sessionId: string, task: string, worker: string, after?: number): JournalEvent[];
	/** Total row count (0 when the databases are absent/unsupported). */
	count(): number;
	/** Per-kind row counts + oldest-row ts, ordered by kind (the §4 retention
	 *  visibility extension; [] when the databases are absent/unsupported).
	 *  With `tasks`, the stats scope to those tasks' shards only (the fleet-
	 *  scoped routes — attention never crosses fleets). */
	kindStats(tasks?: ReadonlySet<string>): JournalKindStat[];
	/** Database file size in bytes, summed over the served shards (0 when
	 *  absent) — the retention-visibility half of §4.1.2. */
	dbSizeBytes(): number;
	/** Close the connection(s) (idempotent). */
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

/** The union order: chronological (ts), then per-shard seq; equal ts+seq
 *  across shards → 0 — Array.sort is stable, so the scan order (sorted shard
 *  paths) is the deterministic final tiebreak. */
function unionOrder(a: JournalEvent, b: JournalEvent): number {
	if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
	if (a.seq !== b.seq) return a.seq - b.seq;
	return 0;
}

/** Merge per-kind stat rows across shards: counts sum, oldest ts is the
 *  lexicographic MIN (ISO-8601 UTC — chronological for the injected clock). */
function mergeKindStats(perShard: JournalKindStat[][]): JournalKindStat[] {
	const merged = new Map<string, JournalKindStat>();
	for (const rows of perShard) {
		for (const r of rows) {
			const cur = merged.get(r.kind);
			if (cur === undefined) merged.set(r.kind, { ...r });
			else {
				cur.count += r.count;
				if (r.oldestTs !== null && (cur.oldestTs === null || r.oldestTs < cur.oldestTs)) cur.oldestTs = r.oldestTs;
			}
		}
	}
	return [...merged.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/**
 * Create a tolerant journal reader. Total by contract: every method returns an
 * empty/valid value on any failure — the read side is structurally incapable
 * of failing a caller (advisory, Law 8/Law 13).
 */
export function createJournalReader(opts: JournalReaderOptions = {}): JournalReader {
	const singleDbPath = opts.dbPath ?? null;
	const shardMode = singleDbPath === null;
	const dbPath = shardMode ? journalTasksDir(opts.rootDir) : singleDbPath;
	// The shard-set connection manager (journal-shards.ts) owns the open
	// handles: per-task opens, the dynamic scan/prune, the tolerant read-only
	// open with the per-shard Law 7 gate.
	const shardSet = createJournalShardSet(opts.rootDir);
	let singleDb: JournalDb | null = shardMode ? null : openReadOnlyJournalDb(singleDbPath as string);

	/** The databases one query touches: exactly one (fleet-scoped, or the
	 *  override file) or the whole shard set (the union). */
	function dbsFor(query: JournalQuery): JournalDb[] {
		if (!shardMode) return singleDb === null ? [] : [singleDb];
		if (query.task !== undefined) {
			const db = shardSet.dbForTask(query.task);
			return db === null ? [] : [db];
		}
		return shardSet.allDbs();
	}

	function queryOneDb(db: JournalDb, after: number, q: JournalQuery): JournalEvent[] {
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
			return db.queryAll<EventRow>(sql, params).map(mapRow).filter((e): e is JournalEvent => e !== null);
		} catch {
			return [];
		}
	}

	function queryEvents(after: number, q: JournalQuery): JournalEvent[] {
		const dbs = dbsFor(q);
		if (dbs.length === 0) return [];
		if (dbs.length === 1) return queryOneDb(dbs[0] as JournalDb, after, q);
		// The global union: per-shard cursor + cap, then the global order.
		const rows = dbs.flatMap((db) => queryOneDb(db, after, q));
		rows.sort((a, b) => unionOrder(a, b));
		return q.limit !== undefined && Number.isFinite(q.limit) ? rows.slice(0, Math.max(0, Math.floor(q.limit))) : rows;
	}

	function kindStatsOfDb(db: JournalDb, tasks: ReadonlySet<string> | undefined): JournalKindStat[] {
		try {
			const scoped = tasks !== undefined && tasks.size > 0;
			const rows = scoped
				? db.queryAll<{ kind: string; c: number; oldest: string | null }>(
						`SELECT kind, COUNT(*) AS c, MIN(ts) AS oldest FROM events WHERE task IN (${[...tasks].map(() => "?").join(",")}) GROUP BY kind ORDER BY kind ASC`,
						[...tasks],
					)
				: db.queryAll<{ kind: string; c: number; oldest: string | null }>(
						"SELECT kind, COUNT(*) AS c, MIN(ts) AS oldest FROM events GROUP BY kind ORDER BY kind ASC",
					);
			return rows.map((r) => ({
				kind: String(r.kind),
				count: Number(r.c),
				oldestTs: r.oldest === null || r.oldest === undefined ? null : String(r.oldest),
			}));
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
			return dbsFor({}).reduce((sum, db) => {
				try {
					const row = db.queryOne<{ c?: number }>("SELECT COUNT(*) AS c FROM events");
					return sum + Number(row?.c ?? 0);
				} catch {
					return sum;
				}
			}, 0);
		},
		kindStats(tasks?) {
			if (shardMode && tasks !== undefined && tasks.size > 0) {
				// Fleet-scoped: exactly one shard per named task (deduped — the
				// override mode's single database carries the IN filter instead).
				const perShard: JournalKindStat[][] = [];
				for (const task of tasks) {
					const db = shardSet.dbForTask(task);
					if (db !== null) perShard.push(kindStatsOfDb(db, new Set([task])));
				}
				return mergeKindStats(perShard);
			}
			return mergeKindStats(dbsFor({}).map((db) => kindStatsOfDb(db, tasks)));
		},
		dbSizeBytes() {
			const paths = shardMode ? listJournalShardPaths(opts.rootDir) : [dbPath];
			return paths.reduce((sum, p) => {
				try {
					return sum + (existsSync(p) ? statSync(p).size : 0);
				} catch {
					return sum;
				}
			}, 0);
		},
		close() {
			try {
				singleDb?.close();
			} catch {
				// advisory — a close failure never propagates
			}
			singleDb = null;
			shardSet.close();
		},
	};
}
