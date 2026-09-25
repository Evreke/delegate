/**
 * pi-delegate — watch-schedule-persist: the DURABLE schedule store file
 * (issue #12, watcher scheduled wakes, stage C).
 *
 * MODULE_CONTRACT — the on-disk half of the session's scheduled wakes.
 *
 * Purpose: the in-memory schedule store (src/watch-schedule.ts) is a CACHE;
 * this module owns the durable file it is rebuilt from (Law 9). One JSON
 * document per session at the EXCHANGE ROOT, next to the watcher's satellites:
 * `<exchangeRoot>/schedules-<watcherKey>.json` (builder:
 * expaths.scheduleStorePathFor). The session identity is carried twice — in
 * the file name (the shared FNV-1a audience key, src/watch-store.ts) and in
 * the document's `sessionPath` — so a foreign document (a copied file, a hash
 * collision, a shared degraded key) reads as EMPTY with a warning instead of
 * resurrecting a closed session's wakes (Law 3). A schedule is session-scoped,
 * not task-scoped, which is why the file lives at the exchange ROOT: the root
 * is the only location unique per session (the cursor satellite is per TASK
 * dir; a session may own none, one or many).
 *
 * Law 7: every write stamps `schemaVersion` (EXCHANGE_SCHEMA_VERSION); the
 * reader accepts its own version (absent = legacy v1, the shared gate
 * `isSupportedSchemaVersion`) and refuses anything else INERT-WITH-WARNING —
 * never a misparse, never a dead watcher.
 *
 * Advisory by contract (Law 8): a missing/corrupt/unreadable/foreign store
 * reads as an empty state with ONE warning; a failed write is logged and
 * swallowed (the in-memory mutation still happened — the durable fact may be
 * lost, which costs at most one repeat after a restart, never a throw into
 * the tick or a tool call).
 *
 * Delivery records: the document's `delivered` array holds the `id#run` keys
 * the tick committed on a REAL send (src/watch-schedule.ts markDelivered) —
 * the SAME delivery-record mechanism/ordering the event-wake cursor uses
 * (commit only after a successful send; a failed send leaves no record), kept
 * in the schedule store document itself because a schedule has no task dir to
 * hang a cursor file on. No second dedup store is introduced.
 *
 * Single-writer by construction: the file NAME carries the session key, so
 * exactly one session writes one file; writes are atomic (tmp + rename via
 * manifest-store.ts) and idempotent reads are tolerant. The port is SYNC
 * (the store's mutations are sync); the in-process file-mutation queue used
 * by the async satellites is unnecessary for a file with one writer by name.
 *
 * Dependencies: node:fs (read/mkdir), ./manifest-store.ts (the ONE atomic
 * writer + the shared version gate), ./exchange.ts (exchangeRoot),
 * ./expaths.ts (the file path), ./watch-store.ts (the watcherKey convention),
 * ./watch-role.ts (sameSessionPath — the win32-aware identity compare),
 * ./watch-schedule.ts (the state types). No transport, no timers.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync, EXCHANGE_SCHEMA_VERSION, isSupportedSchemaVersion } from "./manifest-store.ts";
import { exchangeRoot } from "./exchange.ts";
import { scheduleStorePathFor } from "./expaths.ts";
import { watcherKeyFor } from "./watch-store.ts";
import { sameSessionPath } from "./watch-role.ts";
import type { PersistedScheduleState, SchedulePersistencePort, WakeSchedule } from "./watch-schedule.ts";

export interface SchedulePersistenceOptions {
	/** THIS session's JSONL path — the identity every write stamps and every
	 *  read checks. Undefined/empty (degraded self-id) → the port is a NO-OP:
	 *  nothing is restored and nothing is written (fail-closed — a shared
	 *  "anon" file could resurrect another session's wakes; the store keeps the
	 *  stage A/B in-memory semantics). */
	sessionPath?: string;
	/** Advisory log sink (the watcher log, wired by index.ts). Default no-op. */
	log?: (msg: string) => void;
}

/** The empty persisted state (fresh object per call — callers must not share a
 *  mutable array). */
function emptyState(): PersistedScheduleState {
	return { schedules: [], delivered: [], seq: 0 };
}

/** Tolerant coercion of ONE persisted schedule entry; null when the entry is
 *  unusable (a torn entry is skipped, the rest of the document stays usable). */
function parseSchedule(v: unknown): WakeSchedule | null {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>;
	const id = typeof o.id === "string" && o.id.length > 0 ? o.id : undefined;
	const kind = o.kind === "once" || o.kind === "periodic" ? o.kind : undefined;
	const text = typeof o.text === "string" ? o.text : undefined;
	const createdAtMs = typeof o.createdAtMs === "number" && Number.isFinite(o.createdAtMs) ? o.createdAtMs : undefined;
	const dueAtMs = typeof o.dueAtMs === "number" && Number.isFinite(o.dueAtMs) ? o.dueAtMs : undefined;
	const run = typeof o.run === "number" && Number.isFinite(o.run) && o.run >= 1 ? Math.floor(o.run) : undefined;
	if (id === undefined || kind === undefined || text === undefined || createdAtMs === undefined || dueAtMs === undefined || run === undefined) {
		return null;
	}
	const schedule: WakeSchedule = { id, kind, text, createdAtMs, dueAtMs, run };
	if (kind === "periodic") {
		const intervalMs = typeof o.intervalMs === "number" && Number.isFinite(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : undefined;
		if (intervalMs === undefined) return null; // a periodic entry without a usable interval is unusable
		schedule.intervalMs = intervalMs;
		if (typeof o.maxRuns === "number" && Number.isFinite(o.maxRuns) && o.maxRuns >= 1) {
			schedule.maxRuns = Math.floor(o.maxRuns);
		}
	}
	return schedule;
}

/**
 * Build the durable persistence port for ONE session.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts.sessionPath (the session identity; absent → no-op port);
 *   opts.log (advisory sink, default no-op)
 * Output: a SchedulePersistencePort:
 *   - read(): the persisted state for THIS session; a missing file reads as
 *     empty WITHOUT a warning (first run), a corrupt/unreadable/wrong-version/
 *     foreign-identity file reads as empty WITH ONE warning; never throws
 *   - write(state): atomic, versioned, identity-stamped write; a failure is
 *     logged and swallowed; never throws
 * Guarantees:
 *   - an unproven session identity disables BOTH halves (fail-closed)
 *   - the returned arrays are fresh on every read (no shared mutable state)
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — schedules-<watcherKey>.json at the
 *   exchange root.
 */
export function createSchedulePersistence(opts: SchedulePersistenceOptions): SchedulePersistencePort {
	const log = opts.log ?? (() => {});
	const sessionPath = typeof opts.sessionPath === "string" && opts.sessionPath.length > 0 ? opts.sessionPath : undefined;
	if (sessionPath === undefined) {
		// Fail-closed: no proven identity → no shared file (see the option doc).
		return { read: () => emptyState(), write: () => {} };
	}
	const path = scheduleStorePathFor(exchangeRoot(), watcherKeyFor(sessionPath));
	const warn = (why: string): void => log(`scheduled-wake store ${path} ${why} — zero schedules restored (advisory, the watcher stays alive)`);

	return {
		read(): PersistedScheduleState {
			let raw: string;
			try {
				raw = readFileSync(path, "utf8");
			} catch (err) {
				// Absent = first run (no warning); any other read failure is an anomaly.
				if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return emptyState();
				warn("could not be read (FAILED)");
				return emptyState();
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				warn("FAILED to parse (corrupt JSON)");
				return emptyState();
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				warn("FAILED the shape check (not a JSON object)");
				return emptyState();
			}
			const doc = parsed as Record<string, unknown>;
			// Law 7: absent = legacy v1; anything else is refused inert.
			if (!isSupportedSchemaVersion(doc.schemaVersion)) {
				warn(`FAILED the schema-version gate (unsupported schemaVersion ${JSON.stringify(doc.schemaVersion)})`);
				return emptyState();
			}
			// Law 3: a foreign session identity never resurrects (stale-identity drop).
			if (typeof doc.sessionPath === "string" && doc.sessionPath.length > 0 && !sameSessionPath(doc.sessionPath, sessionPath)) {
				log(
					`scheduled-wake store ${path} carries a foreign session identity (stale — dropped, fail-closed, Law 3) ` +
						"— zero schedules restored",
				);
				return emptyState();
			}
			const schedules: WakeSchedule[] = [];
			if (Array.isArray(doc.schedules)) {
				for (const entry of doc.schedules) {
					const s = parseSchedule(entry);
					if (s !== null) schedules.push(s);
				}
			}
			const delivered: string[] = [];
			if (Array.isArray(doc.delivered)) {
				for (const key of doc.delivered) {
					if (typeof key === "string" && key.length > 0) delivered.push(key);
				}
			}
			const seq = typeof doc.seq === "number" && Number.isFinite(doc.seq) && doc.seq >= 0 ? Math.floor(doc.seq) : 0;
			return { schedules, delivered, seq };
		},

		write(state: PersistedScheduleState): void {
			try {
				mkdirSync(exchangeRoot(), { recursive: true });
				// Law 7: every writer stamps the current schema version; the session
				// identity travels with the document (the file name carries it too).
				const doc = {
					schemaVersion: EXCHANGE_SCHEMA_VERSION,
					sessionPath,
					schedules: state.schedules,
					delivered: state.delivered,
					seq: state.seq,
				};
				atomicWriteFileSync(path, JSON.stringify(doc, null, "\t") + "\n");
			} catch (err) {
				// Advisory: the in-memory mutation stands; a lost durable fact costs at
				// most one repeat after a restart, never a throw into a tool call.
				log(`scheduled-wake store ${path} could not be written (FAILED: ${String(err)}) — the in-memory schedule stands, a restart may repeat it`);
			}
		},
	};
}

