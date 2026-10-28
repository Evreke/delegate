/**
 * pi-delegate — src/swarm/journal-copy.ts — temp-copy helper for pure-read
 * CLI verbs (snapshot + events --after).
 *
 * MODULE_CONTRACT — the ONE shared helper (Law 9: one spelling) that keeps
 * the live journal databases untouched during CLI reads: copy the served
 * databases (+ WAL/SHM sidecars when present) into a fresh mkdtemp, open the
 * copies through the journal reader, and return the reader plus a cleanup
 * that closes the reader and removes the temp directory. The live databases
 * are never opened by CLI read verbs — only the copies are — so no SQLite
 * connection (not even a read-only one) touches the originals.
 *
 * Why a copy: bun 1.4.2 (CI) opens a WAL-mode database read-only and still
 * triggers a recovery/checkpoint into the main file on open or close, changing
 * its mtime and content hash. A read-only flag alone is insufficient on that
 * runtime; a temp copy sidesteps the WAL behavior entirely.
 *
 * Shard mode (no dbPath override): EVERY shard found by scanning the tasks/
 * directory is copied (basenames preserved) and the reader opens over the
 * copy's shard root — the union semantics match the live reader's. The
 * dbPath override copies that one file (the pre-shard behavior).
 *
 * Dependencies: node:fs, node:os, node:path, ./journal-read.ts,
 * ./journal-shards.ts (the shard-set scan). No sqlite driver import (the
 * journal family owns that seam); no herdr import (Law 4).
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createJournalReader, type JournalReader } from "./journal-read.ts";
import { journalTasksDir, listJournalShardPaths } from "./journal-shards.ts";

/** WAL-mode sidecar suffixes to copy when present alongside a database. */
const SIDECAR_SUFFIXES = ["-wal", "-shm"];

/** The copy options: the reader's location options verbatim (the ONE
 *  spelling — what the reader would open, the copy mirrors). */
export interface JournalCopyOptions {
	/** Single-database override (the pre-shard layout). */
	dbPath?: string;
	/** Shard-root override; shards live at <rootDir>/tasks/*.db. */
	rootDir?: string;
}

/** The result of a snapshot copy: a reader over the temp copy, plus a cleanup
 *  that closes the reader and removes the temp directory. */
export interface JournalCopyHandle {
	reader: JournalReader;
	/** Closes the reader and removes the temp directory (best-effort — a
	 *  cleanup failure is swallowed; the temp dir is in the system tmp and the
	 *  OS will reclaim it eventually). */
	cleanup(): void;
}

/** Copy one database file (+ sidecars when present) into `targetDir` under
 *  its basename. Best-effort on the sidecars; never throws on missing files. */
function copyDatabase(srcPath: string, targetDir: string): void {
	const target = join(targetDir, basename(srcPath));
	copyFileSync(srcPath, target);
	for (const suffix of SIDECAR_SUFFIXES) {
		const src = srcPath + suffix;
		if (existsSync(src)) {
			try {
				copyFileSync(src, target + suffix);
			} catch {
				// sidecar copy failure is tolerated — the reader will degrade
				// gracefully (the WAL may be stale by milliseconds; the snapshot
				// being point-in-time is a best-effort guarantee)
			}
		}
	}
}

/**
 * Copy the served journal databases (+ sidecars if present) into a fresh temp
 * directory, open the copies through the journal reader, and return the
 * handle. The original database files are never opened — `copyFileSync` only
 * reads them, so their mtime and content are untouched.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts — the reader location options (dbPath override or the shard
 *   root; default the production shard layout)
 * Output: { reader, cleanup } where reader is a JournalReader over the temp
 *   copy and cleanup() tears it down
 * Guarantees: never throws on missing sidecars (a checkpointed database has
 *   none) or on an empty shard set (the reader is total on missing files —
 *   Law 8); cleanup() is idempotent and never throws (swallows rm failures —
 *   the temp dir is under the OS tmp and will be reclaimed)
 * Raises: never — a copy failure propagates to the caller who handles it;
 *   cleanup always returns
 */
export function withJournalCopy(opts: JournalCopyOptions = {}): JournalCopyHandle {
	// Single-database override: the pre-shard behavior — one file copied as
	// events.db (the reader's override path), or no copy at all when absent.
	if (opts.dbPath !== undefined) {
		if (!existsSync(opts.dbPath)) {
			const reader = createJournalReader({ dbPath: opts.dbPath });
			return {
				reader,
				cleanup: () => reader.close(),
			};
		}
		const tmpDir = mkdtempSync(join(tmpdir(), "swarm-journal-"));
		copyDatabase(opts.dbPath, tmpDir);
		const reader = createJournalReader({ dbPath: join(tmpDir, "events.db") });
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

	// Shard mode: copy EVERY shard of the current shard set, preserving the
	// tasks/ layout, and open the reader over the copy's shard root.
	const shardPaths = listJournalShardPaths(opts.rootDir);
	const tmpDir = mkdtempSync(join(tmpdir(), "swarm-journal-"));
	if (shardPaths.length > 0) {
		const tmpTasks = journalTasksDir(tmpDir);
		mkdirSync(tmpTasks, { recursive: true });
		for (const shard of shardPaths) copyDatabase(shard, tmpTasks);
	}
	const reader = createJournalReader({ rootDir: tmpDir });
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
