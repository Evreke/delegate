/**
 * pi-delegate — src/watch-cursor.ts — the watcher's durable journal cursor.
 *
 * MODULE_CONTRACT — the cursor half of the watcher's satellite persistence
 * (ARCHITECTURE §4.1.2/§4.1.3, issue #26).
 *
 * Purpose: replace the retired delivered-facts store (`delivered-<key>.json`)
 * with a per-audience cursor, and rebase the watcher's durable dedup onto the
 * journal (`src/swarm/journal-read.ts`). One cursor file per audience session
 * per task dir — `cursor-<watcherKey>.json` — carrying:
 *   - `seq`: the last journal `seq` this audience consumed. The watcher reads
 *     `eventsAfter(seq)` each tick (the cursor read of §4.1.2); the read is
 *     advisory — a journal read failure skips the tick and can never affect a
 *     spawn or collect (Law 8).
 *   - `records`: the delivered facts (worker, kind, fingerprint) committed
 *     only AFTER a successful wake-up send — the exactly-once durable dedup
 *     that survives a session restart.
 *
 * Migration (the stage-B precedent, CHANGELOG 1.18.0): the first run on a
 * resumed session finds NO cursor file, so `seq` starts at 0 and `records`
 * starts empty — the cursor is never seeded (seeding would guess what was
 * delivered). Result: a single bounded volley of repeated wake-ups on the
 * first post-upgrade session; bounded by the ownership gate and the 24 h
 * lookback. No `delivered-*.json` is ever written again.
 *
 * Single-writer by construction: the file NAME carries the audience key
 * (`watcherKey` = FNV-1a of the audience session JSONL path, the same
 * convention as the retire-stamp satellites), so exactly one session writes
 * one file per task dir; the in-process `withFileMutationQueue` serializes
 * same-process writers. Writes are atomic (tmp + rename) and idempotent;
 * reads are tolerant (missing/corrupt/torn file → empty cursor, never a
 * throw). Records are only ADDED; removal is garbage collection only when a
 * worker really disappears from the manifests.
 *
 * Dependencies: @earendil-works/pi-coding-agent (withFileMutationQueue),
 * node builtins, ./manifest-store.ts (the ONE atomic writer),
 * ./watch-store.ts (the shared watcherKey convention). No sqlite driver
 * import and no swarm-writer import — the cursor only ever READS the journal
 * (through the reader, owned by the watcher loop).
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./manifest-store.ts";

/** Schema version of the cursor file (bump on a breaking change). */
export const WATCH_CURSOR_SCHEMA_VERSION = 1;

/** One committed delivery fact. The task dir and the audience are given by
 *  the FILE's location (per task dir, audience key in the file name) and are
 *  not part of the record key. */
export interface CursorRecord {
	worker: string;
	kind: string;
	/** Canonical fingerprint (episode identifier for gauge/absence kinds —
	 *  never an empty constant). */
	fingerprint: string;
	/** ISO 8601 — when the successful send was committed. */
	deliveredAt: string;
	/** How the wake-up was delivered — currently only "sent". */
	deliveryMode: string;
}

/** The on-disk shape of cursor-<watcherKey>.json. */
export interface WatchCursorFile {
	schemaVersion: number;
	/** Full session JSONL path of the audience this cursor belongs to. */
	audienceSessionPath: string;
	/** Last journal `seq` consumed by this audience (0 when the cursor was
	 *  just created — the documented first-run repeat volley). */
	seq: number;
	/** Record key = JSON.stringify([worker, kind, fingerprint]). */
	records: Record<string, CursorRecord>;
}

/** Canonical delivery-record key: JSON array of the THREE in-file components
 *  (worker, kind, fingerprint) — unambiguous without any delimiter parsing
 *  (the task-dir path and the audience path deliberately stay OUT of the key,
 *  they are the file's identity). */
export function cursorRecordKey(worker: string, kind: string, fingerprint: string): string {
	return JSON.stringify([worker, kind, fingerprint]);
}

/** Conventional path of one audience's cursor file in a task dir. */
export function watchCursorPathFor(dir: string, watcherKey: string): string {
	return join(dir, `cursor-${watcherKey}.json`);
}

/** The empty cursor constant (tolerant read / first-run migration shape). */
export function emptyWatchCursor(audienceSessionPath = ""): WatchCursorFile {
	return {
		schemaVersion: WATCH_CURSOR_SCHEMA_VERSION,
		audienceSessionPath,
		seq: 0,
		records: {},
	};
}

/**
 * Tolerant read of THIS audience's cursor file in a task dir.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the task's exchange dir
 *   - watcherKey: this watcher's audience key (watcherKeyFor(selfSessionFile))
 * Output: the parsed WatchCursorFile; a missing/unreadable/corrupt/torn file
 *   or a wrong schemaVersion reads as an EMPTY cursor (seq 0, no records)
 * Guarantees:
 *   - never throws; a corrupt cursor costs at most one repeated wake-up
 *     (the in-memory `seen` still suppresses within the session) and a bounded
 *     first-run repeat volley after a restart
 *   - `seq` is coerced to a finite non-negative integer
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — cursor-<key>.json in the task dir.
 */
export function readWatchCursor(dir: string, watcherKey: string): WatchCursorFile {
	const empty = emptyWatchCursor();
	let raw: string;
	try {
		raw = readFileSync(watchCursorPathFor(dir, watcherKey), "utf8");
	} catch {
		return empty; // absent/unreadable → empty cursor (first-run migration)
	}
	try {
		const parsed = JSON.parse(raw) as Partial<WatchCursorFile> | null;
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			parsed.schemaVersion !== WATCH_CURSOR_SCHEMA_VERSION ||
			typeof parsed.records !== "object" ||
			parsed.records === null
		) {
			return empty; // unknown schema version / torn shape → empty cursor
		}
		const records: Record<string, CursorRecord> = {};
		for (const [key, v] of Object.entries(parsed.records)) {
			if (typeof v !== "object" || v === null) continue;
			const o = v as unknown as Record<string, unknown>;
			if (
				typeof o.worker !== "string" || o.worker.length === 0 ||
				typeof o.kind !== "string" || o.kind.length === 0 ||
				typeof o.fingerprint !== "string" ||
				typeof o.deliveredAt !== "string" || o.deliveredAt.length === 0 ||
				typeof o.deliveryMode !== "string" || o.deliveryMode.length === 0
			) {
				continue; // a torn record is skipped, the rest stays usable
			}
			records[key] = {
				worker: o.worker,
				kind: o.kind,
				fingerprint: o.fingerprint,
				deliveredAt: o.deliveredAt,
				deliveryMode: o.deliveryMode,
			};
		}
		const seq = Number.isFinite(parsed.seq) ? Math.max(0, Math.floor(Number(parsed.seq))) : 0;
		return {
			schemaVersion: WATCH_CURSOR_SCHEMA_VERSION,
			audienceSessionPath:
				typeof parsed.audienceSessionPath === "string" ? parsed.audienceSessionPath : "",
			seq,
			records,
		};
	} catch {
		return empty; // corrupt JSON → empty cursor, never a throw
	}
}

/**
 * Commit delivery records for one batch (already sent successfully) into
 * THIS audience's cursor file — one atomic merge per task dir. The cursor
 * `seq` advances to `seq` (the journal high-water mark read this tick) and is
 * never moved backwards.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: the task's exchange dir
 *   - watcherKey: this watcher's audience key
 *   - audienceSessionPath: the full session path of this watcher's audience
 *   - entries: {worker, kind, fingerprint} per delivered event
 *   - deliveredAt: ISO stamp for the whole batch
 *   - deliveryMode: e.g. "sent"
 *   - seq: the last journal seq consumed this tick (default 0 — no journal)
 * Output: resolves when the (merged, atomic) write settled
 * Guarantees:
 *   - merge semantics: existing records are kept, new ones added; `seq` is
 *     monotonic (max of current and the argument); the write is skipped
 *     entirely when nothing would change (idempotent)
 *   - serialized per path via withFileMutationQueue; atomic write (tmp+rename);
 *     creates the dir on demand
 * Raises:
 *   - propagates filesystem errors (the watcher treats a failed commit as
 *     "durable fact not written — a repeat is possible after a restart",
 *     never as a failed delivery)
 */
export async function commitWatchCursor(
	dir: string,
	watcherKey: string,
	audienceSessionPath: string,
	entries: ReadonlyArray<{ worker: string; kind: string; fingerprint: string }>,
	deliveredAt: string,
	deliveryMode: string,
	seq = 0,
): Promise<void> {
	const path = watchCursorPathFor(dir, watcherKey);
	await withFileMutationQueue(path, async () => {
		const current = readWatchCursor(dir, watcherKey);
		const nextSeq = Math.max(current.seq, Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0);
		const next: WatchCursorFile = {
			schemaVersion: WATCH_CURSOR_SCHEMA_VERSION,
			audienceSessionPath,
			seq: nextSeq,
			records: { ...current.records },
		};
		for (const e of entries) {
			next.records[cursorRecordKey(e.worker, e.kind, e.fingerprint)] = {
				worker: e.worker,
				kind: e.kind,
				fingerprint: e.fingerprint,
				deliveredAt,
				deliveryMode,
			};
		}
		if (JSON.stringify(current.records) === JSON.stringify(next.records) && current.seq === nextSeq && current.audienceSessionPath === audienceSessionPath) {
			return; // idempotent
		}
		mkdirSync(dir, { recursive: true });
		atomicWriteFileSync(path, JSON.stringify(next, null, "\t") + "\n");
	});
}

/**
 * Garbage collection: remove ALL delivery records of ONE worker from THIS
 * audience's cursor file. Called ONLY when the worker really disappeared from
 * the manifests (an atomic manifest write removed it) — never on a skipped
 * observation or a transient read error.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir, watcherKey, workerName
 * Output: resolves when the (possibly skipped) write settled
 * Guarantees:
 *   - idempotent: no matching records → no write at all
 *   - atomic write; creates the dir on demand
 * Raises:
 *   - propagates filesystem errors (advisory — the watcher retries next tick)
 */
export async function deleteWorkerCursorRecords(
	dir: string,
	watcherKey: string,
	workerName: string,
): Promise<void> {
	const path = watchCursorPathFor(dir, watcherKey);
	await withFileMutationQueue(path, async () => {
		const current = readWatchCursor(dir, watcherKey);
		const next: Record<string, CursorRecord> = {};
		let changed = false;
		for (const [key, rec] of Object.entries(current.records)) {
			if (rec.worker === workerName) {
				changed = true;
				continue;
			}
			next[key] = rec;
		}
		if (!changed) return; // idempotent — no write
		mkdirSync(dir, { recursive: true });
		atomicWriteFileSync(path, JSON.stringify({
			schemaVersion: WATCH_CURSOR_SCHEMA_VERSION,
			audienceSessionPath: current.audienceSessionPath,
			seq: current.seq,
			records: next,
		}, null, "\t") + "\n");
	});
}