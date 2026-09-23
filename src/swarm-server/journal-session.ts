/**
 * pi-delegate — src/swarm-server/journal-session.ts — the session's ONE
 * journal reader (issue #50, ARCHITECTURE §4.2).
 *
 * MODULE_CONTRACT — the long-lived read-only journal reader a server session
 * holds: the src/swarm/journal-read.ts openReadOnly precedent (a single
 * reader per session, kept open across requests/polls — NEVER the CLI's
 * per-request temp-copy workaround, which is a one-shot-process affordance).
 *
 * The ONE addition over createJournalReader: the COLD-START REOPEN. A reader
 * opened over an ABSENT database stays empty forever (openReadOnly returns a
 * dead reader — sqlite never reopens), yet a session-hosted server mounts at
 * session_start, BEFORE the first journal write creates events.db in the
 * default files mode. This wrapper detects the absence→presence transition
 * (a stat on each read while cold) and reopens exactly once. Still ONE
 * reader per session: the wrapper is the reader; the reopen is a repair of
 * it, not a second instance. Mid-session deletion of the database is NOT
 * repaired (the reader degrades to empty — the operator compaction path is
 * offline-only in v1).
 *
 * Dependencies: node:fs (stat only), ../swarm/journal-read.ts,
 * ../swarm/journal.ts (journalDbPath — the ONE location resolver). No herdr
 * import (Law 4); no sqlite driver import (the journal module family owns
 * that seam).
 *
 * Critical invariants:
 *   - total: every method returns a valid (possibly empty) result, never
 *     throws (the read side is structurally incapable of failing a caller —
 *     Law 8/Law 13);
 *   - the reopen happens at most once per session (cold flag clears).
 */

import { existsSync } from "node:fs";
import { createJournalReader, type JournalReader } from "../swarm/journal-read.ts";
import { journalDbPath } from "../swarm/journal.ts";

/**
 * Open the session's ONE journal reader (with the cold-start reopen).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dbPath — the resolved db path override (undefined → the ONE
 *   location resolver journalDbPath())
 * Output: a JournalReader whose every read first reopens itself if the
 *   database appeared since the open
 * Guarantees:
 *   - total: never throws; a missing/corrupt database reads empty
 *   - the absence→presence transition reopens exactly once
 * Raises: never
 */
export function openSessionJournal(dbPath: string | undefined): JournalReader {
	const resolved = dbPath ?? journalDbPath();
	let cold = !existsSync(resolved);
	let reader = createJournalReader({ dbPath: resolved });
	const ensureOpen = (): void => {
		if (cold && existsSync(resolved)) {
			reader = createJournalReader({ dbPath: resolved });
			cold = false;
		}
	};
	return {
		dbPath: resolved,
		eventsAfter(cursor, query) {
			ensureOpen();
			return reader.eventsAfter(cursor, query);
		},
		eventsForTask(sessionId, task, after) {
			ensureOpen();
			return reader.eventsForTask(sessionId, task, after);
		},
		eventsForWorker(sessionId, task, worker, after) {
			ensureOpen();
			return reader.eventsForWorker(sessionId, task, worker, after);
		},
		count() {
			ensureOpen();
			return reader.count();
		},
		dbSizeBytes() {
			ensureOpen();
			return reader.dbSizeBytes();
		},
		close() {
			try {
				reader.close();
			} catch {
				// advisory — a close failure never propagates
			}
		},
	};
}
