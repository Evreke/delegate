/**
 * MODULE_CONTRACT
 * journal-driver.ts — the ONE place in the journal module family that touches a
 * sqlite driver, and the ONLY module allowed to import one (§4.1.2 confinement;
 * the pin's `journal*.ts` glob covers this file).
 *
 * Why adaptive: pi loads this extension under BOTH runtimes — bun (check suite,
 * `bun run`) and node (the pi RPC/extension runtime). `bun:sqlite` exists only
 * under bun; `node:sqlite` (DatabaseSync) exists under node >= 22.13. Choosing
 * one statically broke extension load under node (incident: 2026-09-22, every
 * rpc worker spawn died with E_START before this fix — the extension import
 * chain crashed the worker pi process itself).
 *
 * Normalized surface (the exact shape journal.ts / journal-read.ts use):
 *   openJournalDatabase(path, { create }) → { exec, run, queryOne, queryAll }
 *   - exec(sql)                 — DDL / pragmas, no params
 *   - run(sql, params?)         — INSERT/UPDATE-shaped, positional array
 *   - queryOne(sql, params?)    — first row or null
 *   - queryAll(sql, params?)    — all rows
 *
 * Prefer bun:sqlite when it exists (the test suite runtime); fall back to
 * node:sqlite. Both are synchronous, WAL-capable, busy_timeout-honoring.
 * Never throws driver-choice errors outward — same failure family as the rest
 * of the journal (advisory, Law 8): the callers already total-failure-wrap.
 */
import { createRequire } from "node:module";

export interface JournalDb {
	exec(sql: string): void;
	/** INSERT/UPDATE-shaped; returns the driver's run result ({ lastInsertRowid, changes }) when available. */
	run(sql: string, params?: unknown[]): { lastInsertRowid?: number | bigint; changes?: number | bigint };
	queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;
	queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
	close(): void;
}

export type JournalDriverName = "bun:sqlite" | "node:sqlite";

let cachedDriver: { name: JournalDriverName; open: (path: string, create: boolean, readOnly: boolean) => JournalDb } | null = null;

function resolveDriver(): { name: JournalDriverName; open: (path: string, create: boolean, readOnly: boolean) => JournalDb } {
	if (cachedDriver) return cachedDriver;
	const req = createRequire(import.meta.url);
	try {
		// bun:sqlite first — the suite runtime; richest API (db.run native array params).
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { Database } = req("bun:sqlite") as { Database: new (p: string, o?: { create?: boolean }) => any };
		cachedDriver = {
			name: "bun:sqlite",
			open: (path, create, readOnly) => {
				// bun:sqlite with `create: false` throws SQLITE_MISUSE on bun 1.3.x —
				// callers gate existence themselves (see journal-read openReadOnly).
				// readonly: true prevents WAL sidecar touches — required for pure-read
				// operations (Law 13, A8b).
				const opts: Record<string, boolean> = {};
				if (create) opts.create = true;
				if (readOnly) opts.readonly = true;
				const db = Object.keys(opts).length > 0 ? new Database(path, opts) : new Database(path);
				return {
					exec: (sql) => db.exec(sql),
					run: (sql, params) => {
						const res = params && params.length > 0 ? db.run(sql, params) : db.run(sql);
						return { lastInsertRowid: res?.lastInsertRowid, changes: res?.changes };
					},
					queryOne: <T>(sql: string, params?: unknown[]) =>
						(params && params.length > 0 ? db.query(sql).get(...params) : db.query(sql).get()) ?? (null as T | null),
					queryAll: <T>(sql: string, params?: unknown[]) =>
						(params && params.length > 0 ? db.query(sql).all(...params) : db.query(sql).all()) as T[],
					close: () => db.close(),
				};
			},
		};
		return cachedDriver;
	} catch {
		// node runtime: node:sqlite (experimental warning is expected, harmless).
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		// NOTE: bun-types declares DatabaseSync with a 1-arg constructor, but node
		// 22's runtime accepts an options bag ({ readOnly: true }). Cast through
		// unknown so the runtime option flows while the 1-arg declaration compiles.
		const { DatabaseSync: DBSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => any };
		const DatabaseSync = DBSync as unknown as new (p: string, o?: { readOnly?: boolean }) => any;
		cachedDriver = {
			name: "node:sqlite",
			open: (path, _create, readOnly) => {
				// node:sqlite DatabaseSync readOnly option prevents any WAL sidecar
				// creation/modification — required for pure-read operations.
				const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
				return {
					exec: (sql) => db.exec(sql),
					run: (sql, params) => {
						const res = params && params.length > 0 ? db.prepare(sql).run(...params) : db.prepare(sql).run();
						return { lastInsertRowid: res?.lastInsertRowid, changes: res?.changes };
					},
					queryOne: <T>(sql: string, params?: unknown[]) =>
						(params && params.length > 0 ? db.prepare(sql).get(...params) : db.prepare(sql).get()) ?? (null as T | null),
					queryAll: <T>(sql: string, params?: unknown[]) =>
						(params && params.length > 0 ? db.prepare(sql).all(...params) : db.prepare(sql).all()) as T[],
					close: () => db.close(),
				};
			},
		};
		return cachedDriver;
	}
}

export function journalDriverName(): JournalDriverName {
	return resolveDriver().name;
}

export interface JournalDbOpenOptions {
	create?: boolean;
	/** Open the database in read-only mode. Both bun:sqlite ({ readonly: true })
	 *  and node:sqlite ({ readOnly: true }) support this — a read-only open
	 *  never creates WAL sidecars, never checkpoints, and never touches the
	 *  database file. Required for pure-read operations like journal-mode
	 *  snapshot (§4.1.1 Law 13/A8b). Default false (RW). */
	readOnly?: boolean;
}

export function openJournalDatabase(path: string, opts?: JournalDbOpenOptions): JournalDb {
	return resolveDriver().open(path, opts?.create ?? false, opts?.readOnly ?? false);
}
