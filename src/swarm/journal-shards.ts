/**
 * MODULE_CONTRACT
 * journal-shards.ts — the shard LAYOUT module of the journal module family
 * (`src/swarm/journal*.ts`): the per-task database locations, the shard file
 * name spelling, the shard-set discovery scan, and the ONE legacy-global
 * migration (the layout cutover rename).
 *
 * Why sharding (operator decision, store criticism C1 criterion (a)):
 * several concurrent sessions share one agentDir; the former single
 * `events.db` made the whole fleet's history one failure domain — database
 * loss or compaction hit every task, and cross-session compaction
 * interference existed at all. One SQLite database PER TASK shrinks the
 * blast radius to one task and kills the interference by file topology.
 *
 * Shard location (Law 1 discipline — the DURABLE agentDir, never the /tmp
 * exchange dir): `<agentDir>/delegate-journal/tasks/<shard-name>.db`. A shard
 * in the exchange dir would lose messages on reboot (NF1). A shard file IS a
 * complete journal database (the same pinned DDL + Law 7 version gate).
 *
 * Shard name spelling (PINNED — this module's one sanitization decision):
 *   `<safe(task)>-<fnv1a8(task)>.db`
 *   - `safe(task)` keeps [A-Za-z0-9._-], replaces every other character with
 *     "_", strips leading dots (no hidden/dotfile names), truncates to 64
 *     characters.
 *   - `fnv1a8(task)` is FNV-1a 32-bit over the RAW task name, 8 lowercase hex
 *     chars — the same file-safe key discipline the repo already uses for the
 *     watcher satellite keys (`watcherKeyFor`, src/watch-store.ts). The hash
 *     makes the mapping injective in practice (distinct task names map to
 *     distinct shard files even when their safe prefixes collide) and immune
 *     to path traversal; the safe prefix keeps a directory listing readable.
 *   Task names are operator-controlled strings (the exchange task slug); the
 *   spelling is total over ANY string — never throws, never escapes the
 *   tasks/ directory.
 *
 * Task scoping (verified against the DDL + every writer path): every journal
 * row carries a NON-EMPTY task — the DDL pins `task TEXT NOT NULL`, and the
 * CLI identity resolver refuses an empty task before any append
 * (resolveContext, src/swarm/context.ts). There is no empty/unknown-task row
 * class, so NO `_global` shard exists.
 *
 * Legacy migration (the layout cutover): the FIRST writer-side open of the
 * new layout renames the former global `events.db` (+ its -wal/-shm sidecars,
 * best-effort) to `events-legacy-<epochMs>.db` in the journal root. Advisory:
 * a failed rename leaves the file in place and the shards still work. Shards
 * start empty; the legacy rows are inert copies (files are truth — losing
 * them is the noise direction; lifecycle rows re-accumulate). Readers NEVER
 * migrate (the pure-read law): they scan tasks/ only, so the legacy file is
 * naturally invisible to reads.
 *
 * Dependencies: node builtins, pi's getAgentDir(). No driver import (the
 * family's one driver seam stays journal-driver.ts) and no family import (the
 * family imports THIS module — the layout is the graph's leaf; journal.ts
 * re-exports the location constants so the ONE client import surface stays
 * journal.ts). No herdr import (Law 4).
 *
 * Critical invariants:
 *   - journalShardPathFor is total + deterministic: the same task resolves to
 *     the same path on every side (writer, reader, compaction); never throws.
 *   - the discovery scan is tolerant: a missing/unreadable tasks/ dir reads
 *     as an empty shard set.
 *   - the migration never throws and never touches a shard.
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { openJournalDatabase, type JournalDb } from "./journal-driver.ts";
import { JOURNAL_DB_VERSION } from "./journal-schema.ts";

// ---------------------------------------------------------------------------
// Location (Law 1) — one spelling (owned HERE since the shard layout; the
// family re-exports through journal.ts so client imports stay one-surface)
// ---------------------------------------------------------------------------

/** Journal directory name under the pi agent dir. */
export const JOURNAL_DB_DIR_NAME = "delegate-journal";
/** The LEGACY global journal database file name (the migration's source; also
 *  the single-database override default — see journalDbPath). */
export const JOURNAL_DB_FILE_NAME = "events.db";
/** The shard directory name under the journal root. */
export const JOURNAL_TASKS_DIR_NAME = "tasks";

/**
 * The LEGACY global journal location (§4.1.2, Law 1): the former ONE
 * database, now the migration's source file. Resolved live per call through
 * pi's `getAgentDir()` (which honors `PI_CODING_AGENT_DIR`), never hardcoded.
 * Production writes go to per-task shards (journalShardPathFor); this path
 * survives as (a) the single-database override default (tests/scripting) and
 * (b) the file the layout cutover renames.
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

/** The safe-prefix cap of the shard file name (plus "-<8 hex>.db"). */
const SHARD_PREFIX_MAX = 64;

/**
 * The journal ROOT directory: `<agentDir>/delegate-journal` (the ONE root
 * spelling; the legacy global database and the tasks/ shard directory live
 * here).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: absolute path `<agentDir>/delegate-journal`
 * Guarantees: resolved live per call through pi's `getAgentDir()` (which
 *   honors `PI_CODING_AGENT_DIR`); never throws
 * Raises: never
 */
export function journalRootDir(): string {
	return join(getAgentDir(), JOURNAL_DB_DIR_NAME);
}

/**
 * The shard directory: `<agentDir>/delegate-journal/tasks`.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: rootDir — optional journal-root override (tests); default the ONE
 *   root spelling above
 * Output: absolute path of the shard directory
 * Guarantees: pure path assembly; never throws
 * Raises: never
 */
export function journalTasksDir(rootDir?: string): string {
	return join(rootDir ?? journalRootDir(), JOURNAL_TASKS_DIR_NAME);
}

/** FNV-1a 32-bit over a UTF-8 string, 8 lowercase hex chars — the repo's
 *  file-safe key discipline (the watcherKeyFor precedent, src/watch-store.ts;
 *  re-implemented here because a swarm→watch-store import would drag the
 *  satellite-stamp machinery into the journal family for one pure function). */
function fnv1a8(s: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * The shard file name for one task (the PINNED spelling — see
 * MODULE_CONTRACT).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: task — the exchange task name (any string)
 * Output: `<safe(task)>-<fnv1a8(task)>.db`
 * Guarantees: total + deterministic; the name is file-safe on POSIX and
 *   win32 (no separators, no traversal, no dotfile, never exactly a reserved
 *   device name — the hash suffix is always present); distinct task names
 *   map to distinct files in practice (32-bit FNV-1a)
 * Raises: never
 */
export function journalShardFileName(task: string): string {
	const safe = task.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, SHARD_PREFIX_MAX);
	return `${safe.length > 0 ? safe : "_"}-${fnv1a8(task)}.db`;
}

/**
 * The ONE shard location for one task.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: task — the exchange task name; rootDir — optional journal-root
 *   override (tests)
 * Output: absolute path `<root>/tasks/<shard-name>.db`
 * Guarantees: total + deterministic; never throws
 * Raises: never
 */
export function journalShardPathFor(task: string, rootDir?: string): string {
	return join(journalTasksDir(rootDir), journalShardFileName(task));
}

/**
 * Discover the shard set: every `*.db` file in the tasks/ directory, sorted
 * by name (deterministic union order input). Tolerant.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: rootDir — optional journal-root override (tests)
 * Output: absolute shard paths, sorted; [] when the dir is absent/unreadable
 * Guarantees: never throws; sidecars (`-wal`/`-shm`) and non-`.db` files are
 *   never listed
 * Raises: never
 */
export function listJournalShardPaths(rootDir?: string): string[] {
	const dir = journalTasksDir(rootDir);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return []; // no shard dir yet → empty shard set
	}
	return entries
		.filter((f) => f.endsWith(".db"))
		.sort()
		.map((f) => join(dir, f));
}

/**
 * The legacy-global cutover rename (see MODULE_CONTRACT): rename the former
 * global `events.db` (+ sidecars when present) to
 * `events-legacy-<epochMs>.db` in the journal root. Called by WRITER-side
 * opens of the new layout only (the writer factory's shard mode and the
 * compaction path); readers never migrate.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: rootDir — optional journal-root override (tests)
 * Output: the rename target when the legacy file was renamed, else null
 *   (absent file, or an advisory rename failure — the file stays in place)
 * Guarantees: never throws; idempotent (the existsSync gate); a concurrent
 *   racer's losing rename fails harmlessly (the source is already gone);
 *   shards are never touched
 * Raises: never
 */
export function migrateLegacyJournalDatabase(rootDir?: string): string | null {
	const root = rootDir ?? journalRootDir();
	const legacy = join(root, JOURNAL_DB_FILE_NAME);
	if (!existsSync(legacy)) return null;
	const target = join(root, `events-legacy-${Date.now()}.db`);
	try {
		mkdirSync(root, { recursive: true });
		renameSync(legacy, target);
	} catch {
		return null; // advisory — the legacy file stays; shards still work
	}
	for (const suffix of ["-wal", "-shm"]) {
		const sidecar = legacy + suffix;
		if (existsSync(sidecar)) {
			try {
				renameSync(sidecar, target + suffix);
			} catch {
				// best-effort — the main file's rename already succeeded
			}
		}
	}
	return target;
}

// ---------------------------------------------------------------------------
// The shard-set connection manager (the read side's shard plumbing — moved
// from journal-read.ts: the layout module owns the shard SET, the reader owns
// the query surface)
// ---------------------------------------------------------------------------

/**
 * Open one journal database READ-ONLY. Returns null when the file is absent,
 * cannot be opened, or carries a FUTURE `user_version` (Law 7 gate → empty
 * result). Uses a true read-only open (bun:sqlite `{ readonly: true }` /
 * node:sqlite `{ readOnly: true }`) so the database file is never touched —
 * no WAL sidecar creation, no checkpoint, no mtime change (Law 13, A8b).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dbPath — the database file
 * Output: the open read-only handle, or null (absent/unopenable/future)
 * Guarantees: never throws; the file is never modified
 * Raises: never
 */
export function openReadOnlyJournalDb(dbPath: string): JournalDb | null {
	try {
		if (!existsSync(dbPath)) return null;
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

/** The read side's shard-set connection manager: one open handle per shard,
 *  discovered by scanning tasks/. */
export interface JournalShardSet {
	/** The one shard database for a task; null when the shard file is absent,
	 *  unopenable or future-version (the tolerant-empty plane). */
	dbForTask(task: string): JournalDb | null;
	/** Every shard database of the CURRENT shard set: the scan is the truth —
	 *  new shards open on demand, vanished ones are pruned (and closed). */
	allDbs(): JournalDb[];
	/** Close every open handle (idempotent). */
	close(): void;
}

/**
 * Create the shard-set connection manager over one journal root.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: rootDir — optional journal-root override (tests)
 * Output: the JournalShardSet
 * Guarantees: total — every method returns a valid (possibly empty) result,
 *   never throws; absent/unopenable/future-version shards are NOT cached (a
 *   file may appear later — the cold-start edge)
 * Raises: never
 */
export function createJournalShardSet(rootDir?: string): JournalShardSet {
	// Open shard handles, keyed by database path.
	let handles = new Map<string, JournalDb>();
	let closed = false;
	return {
		dbForTask(task: string): JournalDb | null {
			const path = journalShardPathFor(task, rootDir);
			const cached = handles.get(path);
			if (cached) return cached;
			if (closed) return null;
			const db = openReadOnlyJournalDb(path);
			if (db !== null) handles.set(path, db);
			return db;
		},
		allDbs(): JournalDb[] {
			if (closed) return [];
			const paths = listJournalShardPaths(rootDir);
			const live = new Set(paths);
			const kept = new Map<string, JournalDb>();
			for (const [path, db] of handles) {
				if (live.has(path)) {
					kept.set(path, db);
					continue;
				}
				try {
					db.close();
				} catch {
					// advisory — a close failure never propagates
				}
			}
			handles = kept;
			const dbs: JournalDb[] = [];
			for (const path of paths) {
				const cached = handles.get(path);
				if (cached) {
					dbs.push(cached);
					continue;
				}
				const db = openReadOnlyJournalDb(path);
				if (db !== null) {
					handles.set(path, db);
					dbs.push(db);
				}
			}
			return dbs;
		},
		close(): void {
			if (closed) return;
			closed = true;
			for (const db of handles.values()) {
				try {
					db.close();
				} catch {
					// advisory — a close failure never propagates
				}
			}
			handles = new Map();
		},
	};
}
