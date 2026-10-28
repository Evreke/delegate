/**
 * MODULE_CONTRACT
 * journal-schema.ts — the Law 7 versioning module of the journal module family
 * (`src/swarm/journal*.ts`): the database version constant, the BYTE-PINNED v1
 * events DDL, the v2 side-tables DDL, and the ONE migration spelling shared by
 * the writer open and the compaction path.
 *
 * Why a own file: Law 5 (the 400-line decomposition ledger). The schema is a
 * versioned CONTRACT — keeping it in one module makes the byte-pin reviewable
 * in isolation and lets every family member (writer, compaction) migrate
 * through the same code, never a second spelling.
 *
 * The v1 DDL is byte-pinned by ARCHITECTURE §4.1.2 and MUST NOT change —
 * including its `PRAGMA user_version = 1` line. The v2 DDL (the store design
 * §2 side tables) is applied AFTER it on every open; its trailing pragma
 * re-stamps `user_version` 1→2 because the pinned v1 text still carries the
 * v1 stamp (the pin wins over the stamp). Both DDLs are idempotent
 * (`IF NOT EXISTS`), so the migration is safe to re-run on every open.
 *
 * Dependencies: the driver TYPE only (no driver import — journal-driver.ts
 * stays the family's one driver seam). No herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - JOURNAL_SCHEMA_V1_DDL is byte-stable: any edit to its text is a Law 7
 *     violation (the schema is a versioned contract).
 *   - a FUTURE `user_version` (above JOURNAL_DB_VERSION) is refused by the
 *     CALLERS — the writer fails structured E_JOURNAL_VERSION (the loud C5
 *     gate), the reader yields empty. This module only reads the version.
 */

import type { JournalDb } from "./journal-driver.ts";
import { openJournalDatabase } from "./journal-driver.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Database schema version (Law 7). Absent (0) or 1 migrates to 2; ABOVE
 *  this a future version writers refuse LOUDLY (E_JOURNAL_VERSION), readers
 *  yield empty. */
export const JOURNAL_DB_VERSION = 2;

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

/**
 * The v2 DDL (the store design §2 side tables): applied AFTER the pinned v1
 * DDL on every writer open (idempotent `IF NOT EXISTS`; the trailing pragma
 * re-stamps `user_version` 1→2 because the byte-pinned v1 DDL still carries
 * its own `PRAGMA user_version = 1` line — the pin wins over the stamp).
 * Side tables hold only facts ABOUT messages (receipts, wake dedup, read
 * positions), never message content (Law 9 — the message row IS the events
 * row).
 */
export const JOURNAL_SCHEMA_V2_DDL = `CREATE TABLE IF NOT EXISTS message_receipts (
  msg_seq          INTEGER NOT NULL,  -- the message row (events.seq) this fact is about
  audience_session TEXT NOT NULL,     -- WHICH console/session the fact is about (delivery is per-console)
  receipt          TEXT NOT NULL,     -- closed set: sent | delivered | consumed | failed (additive)
  ts               TEXT NOT NULL,
  writer_session   TEXT NOT NULL,     -- the writing process's own session id; API-enforced = audience_session
  detail           TEXT               -- failure text for failed; transport note otherwise
);
CREATE INDEX IF NOT EXISTS receipts_by_msg ON message_receipts(msg_seq, audience_session);

CREATE TABLE IF NOT EXISTS wake_facts (
  audience_session TEXT NOT NULL,     -- the audience's full session JSONL path (the cursor file's audienceSessionPath spelling)
  task             TEXT NOT NULL,
  worker           TEXT NOT NULL,
  wake_kind        TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,     -- episode fingerprint (D1: fingerprinted kinds keep their key)
  delivered_at     TEXT NOT NULL,
  delivery_mode    TEXT NOT NULL,     -- 'sent' today; additive
  msg_seq          INTEGER,           -- NULL = file-detected condition (no journal row); else the wake's row — never a 0 sentinel
  PRIMARY KEY (audience_session, task, worker, wake_kind, fingerprint)
);

CREATE TABLE IF NOT EXISTS read_cursors (
  audience_session TEXT NOT NULL,
  task             TEXT NOT NULL,
  seq              INTEGER NOT NULL,  -- last journal seq consumed by this audience; monotonic max
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (audience_session, task)
);

PRAGMA user_version = 2;`;

/** Read the database's Law 7 version (0 when absent). Never throws. */
export function readUserVersion(db: JournalDb): number {
	const row = db.queryOne<{ user_version?: number }>("PRAGMA user_version");
	return Number(row?.user_version ?? 0);
}

/** The open outcome: a migrated database, a FUTURE version (the LOUD gate —
 *  the caller must fail structured, never silently no-op), or an unopenable
 *  file (the advisory degrade). */
export type JournalOpenOutcome =
	| { db: JournalDb }
	| { db: null; reason: "future-version"; found: number }
	| { db: null; reason: "unopenable" };

/**
 * Open + migrate the database (the ONE open+migrate spelling, shared by the
 * writer factory and any family-side writer). Returns the `future-version`
 * outcome when the file carries a FUTURE `user_version` (Law 7 gate) — the
 * caller surfaces the structured `E_JOURNAL_VERSION` failure (C5: LOUD, never
 * a silent no-op writer) — and the `unopenable` outcome when the file cannot
 * be opened at all (the caller degrades to the advisory failure path).
 */
export function openMigratedDatabase(dbPath: string, busyTimeoutMs?: number): JournalOpenOutcome {
	try {
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = openJournalDatabase(dbPath, { create: true });
		const found = readUserVersion(db);
		if (found > JOURNAL_DB_VERSION) {
			db.close();
			return { db: null, reason: "future-version", found };
		}
		applyJournalSchema(db);
		if (busyTimeoutMs !== undefined) {
			const ms = Math.max(0, Math.floor(busyTimeoutMs));
			db.run(`PRAGMA busy_timeout = ${ms}`);
		}
		return { db };
	} catch {
		return { db: null, reason: "unopenable" };
	}
}

/**
 * Apply the schema migration (v1 DDL byte-pinned, then the v2 side tables +
 * version stamp). Idempotent; both DDLs run on every open. The ONE migration
 * spelling — shared by the writer open and the compaction path.
 */
export function applyJournalSchema(db: JournalDb): void {
	db.exec(JOURNAL_SCHEMA_V1_DDL);
	db.exec(JOURNAL_SCHEMA_V2_DDL);
}
