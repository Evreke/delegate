/**
 * pi-delegate — src/swarm/journal-copy.ts — temp-copy helper for pure-read
 * CLI verbs (snapshot + events --after).
 *
 * MODULE_CONTRACT — the ONE shared helper (Law 9: one spelling) that keeps
 * the live events.db untouched during CLI reads: copy the database (+ WAL/SHM
 * sidecars when present) into a fresh mkdtemp, open the copy through the
 * journal reader, and return the reader plus a cleanup that closes the reader
 * and removes the temp directory. The live database is never opened by CLI
 * read verbs — only the copy is — so no SQLite connection (not even a
 * read-only one) touches the original file.
 *
 * Why a copy: bun 1.4.2 (CI) opens a WAL-mode database read-only and still
 * triggers a recovery/checkpoint into the main file on open or close, changing
 * its mtime and content hash. A read-only flag alone is insufficient on that
 * runtime; a temp copy sidesteps the WAL behavior entirely.
 *
 * Dependencies: node:fs, node:os, node:path, ./journal-read.ts. No sqlite
 * driver import (the journal family owns that seam); no herdr import (Law 4).
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJournalReader, type JournalReader } from "./journal-read.ts";
import { journalDbPath } from "./journal.ts";

/** WAL-mode sidecar suffixes to copy when present alongside events.db. */
const SIDECAR_SUFFIXES = ["-wal", "-shm"];

/** The result of a snapshot copy: a reader over the temp copy, plus a cleanup
 *  that closes the reader and removes the temp directory. */
export interface JournalCopyHandle {
	reader: JournalReader;
	/** Closes the reader and removes the temp directory (best-effort — a
	 *  cleanup failure is swallowed; the temp dir is in the system tmp and the
	 *  OS will reclaim it eventually). */
	cleanup(): void;
}

/**
 * Copy events.db (+ sidecars if present) into a fresh temp directory, open
 * the copy through the journal reader, and return the handle. The original
 * database file is never opened — `copyFileSync` only reads it, so its mtime
 * and content are untouched.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dbPath — path to the live events.db (string or undefined; falls
 *   back to journalDbPath() — the ONE location resolver — when undefined)
 * Output: { reader, cleanup } where reader is a JournalReader over the temp
 *   copy and cleanup() tears it down
 * Guarantees: never throws on missing sidecars (the DB may be checkpointed);
 *   cleanup() is idempotent and never throws (swallows rm failures — the temp
 *   dir is under the OS tmp and will be reclaimed)
 * Raises: never — a copy failure propagates to the caller who handles it;
 *   cleanup always returns
 */
export function withJournalCopy(dbPath?: string): JournalCopyHandle {
	const resolvedDbPath = dbPath ?? journalDbPath();

	// When the database file is absent (files mode, or journal not yet created),
	// skip the copy and return a reader over the absent path — the reader is
	// total on missing files (returns empty/valid results, never throws; Law 8).
	if (!existsSync(resolvedDbPath)) {
		const reader = createJournalReader({ dbPath: resolvedDbPath });
		return {
			reader,
			cleanup: () => reader.close(),
		};
	}

	const tmpDir = mkdtempSync(join(tmpdir(), "swarm-journal-"));
	const copyPath = join(tmpDir, "events.db");

	// Copy the main database file — copyFileSync only reads the source, so
	// the live events.db mtime and content are untouched.
	copyFileSync(resolvedDbPath, copyPath);

	// Copy WAL-mode sidecars when present — a checkpointed database has none.
	for (const suffix of SIDECAR_SUFFIXES) {
		const src = resolvedDbPath + suffix;
		if (existsSync(src)) {
			try {
				copyFileSync(src, copyPath + suffix);
			} catch {
				// sidecar copy failure is tolerated — the reader will degrade
				// gracefully (the WAL may be stale by milliseconds; the snapshot
				// being point-in-time is a best-effort guarantee)
			}
		}
	}

	const reader = createJournalReader({ dbPath: copyPath });

	return {
		reader,
		cleanup: () => {
			reader.close();
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort — the OS tmp will reclaim it
			}
		},
	};
}