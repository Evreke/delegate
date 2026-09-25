/**
 * pi-delegate — src/swarm/storage.ts — swarm storage config + verb journal
 * plumbing (issue #23, ARCHITECTURE §4.1.3).
 *
 * MODULE_CONTRACT — resolves the `swarm.storage` / `swarm.projection`
 * configuration, derives the fleet session id used in journal rows, owns the
 * test clock hook, and appends worker-verb events to the journal.
 *
 * Flag semantics (Phase B gate, default unchanged this release):
 *   - `swarm.storage: "files" | "journal"` (default "files"): "files" is the
 *     Phase A behavior — files are truth, the journal receives no writes.
 *     "journal" makes the journal the truth: verb writes append their journal
 *     event FIRST and then write the byte-frozen file projection (Law 7) in
 *     one logical step; a journal failure is recorded and skipped (advisory
 *     by contract, Law 8 — it can never fail a verb write), a projection
 *     failure still fails the verb (the projection is load-bearing for the
 *     current file-based readers until #26).
 *   - `swarm.projection: boolean` (default true; journal mode only): when
 *     false, the manifest.json projection is NOT written — the journal-backed
 *     ManifestStore serves reads by replay (cutover criterion 2, "the full
 *     delegate cycle works on the journal alone"). Verb artifact files
 *     (report/q-/p-) are always written in this release: their readers
 *     (collect-time validateReport, the mailbox, readLastProgress) are
 *     file-based and outside #23's scope.
 *
 * Precedence: env (SWARM_STORAGE / SWARM_PROJECTION / SWARM_JOURNAL_DB /
 * SWARM_SESSION_ID) beats the config file keys (`swarm.storage` /
 * `swarm.projection` in pi-delegate.config.json), which beat the defaults.
 * The env tier exists for tests and scripting (the CLI is a separate bun
 * process; the parity/E2E checks drive it through env). Config read failures
 * (incl. the named-profile E_START throw) degrade to defaults — the storage
 * flag is advisory to the pipeline, never a new failure mode.
 *
 * Session id (interim, until the spawn flow exports the true SwarmGraph
 * SessionId): SWARM_SESSION_ID when set, else a stable sha256 of the resolved
 * task dir — both the extension-side store and the worker-side CLI compute it
 * from values they already hold, so one fleet gets ONE session_id spelling.
 *
 * Test hook: SWARM_FIXED_TS pins the timestamp the verbs stamp into payloads
 * (and the journal row ts), so the parity check can prove TRUE byte-identity
 * of projections across storage modes instead of normalizing timestamps away.
 *
 * Dependencies: node builtins, ../profile.ts (loadDelegateConfig),
 * ../clock.ts (ClockPort), ./journal.ts (the ONE writer). No herdr adapter
 * import (Law 4); no sqlite driver import (the journal module family owns it).
 *
 * Critical invariants:
 *   - appendSwarmEvent is TOTAL: it returns null in "files" mode and a
 *     structured result in "journal" mode; it never throws (Law 8);
 *   - invalid flag values degrade to the default with a recorded warning
 *     (never silently to a non-default mode);
 *   - exactly one session-id spelling per fleet (dir-stable fallback).
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadDelegateConfig } from "../profile.ts";
import { systemClock, type ClockPort } from "../clock.ts";
import { createJournalWriter, type JournalKind, type JournalAppendResult } from "./journal.ts";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export type SwarmStorageMode = "files" | "journal";

export interface SwarmStorageConfig {
	/** Truth owner: "files" (Phase A default) or "journal" (Phase B). */
	storage: SwarmStorageMode;
	/** Write the manifest.json file projection in journal mode. Default true. */
	projection: boolean;
	/** Journal db override (SWARM_JOURNAL_DB — test sandboxing). */
	dbPath?: string;
	/** Fleet session id override (SWARM_SESSION_ID). */
	sessionId?: string;
	/** Non-fatal degradations applied while resolving (invalid values, unreadable config). */
	warnings: string[];
}

function parseMode(v: unknown): SwarmStorageMode | undefined {
	return v === "files" || v === "journal" ? v : undefined;
}

function parseBool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (typeof v !== "string") return undefined;
	const s = v.trim().toLowerCase();
	if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
	if (s === "0" || s === "false" || s === "off" || s === "no") return false;
	return undefined;
}

/**
 * Resolve the swarm storage configuration.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: env — the process environment (explicit param for tests)
 * Output: the effective { storage, projection, dbPath?, sessionId?, warnings }
 * Guarantees:
 *   - total: a corrupt/throwing config read degrades to defaults + warning
 *   - invalid flag values degrade to the DEFAULT with a warning (never to
 *     the non-default mode)
 *   - env keys beat config keys beat defaults
 * Raises: never
 */
export function resolveSwarmStorage(env: NodeJS.ProcessEnv = process.env): SwarmStorageConfig {
	const warnings: string[] = [];
	let cfgSection: Record<string, unknown> = {};
	try {
		const cfg = loadDelegateConfig() as { swarm?: unknown };
		if (cfg.swarm !== null && typeof cfg.swarm === "object" && !Array.isArray(cfg.swarm)) {
			cfgSection = cfg.swarm as Record<string, unknown>;
		}
	} catch (err) {
		warnings.push(`config unreadable (${(err as Error).message}) — defaults applied`);
	}

	let storage: SwarmStorageMode = "files";
	const rawMode = env.SWARM_STORAGE ?? (cfgSection.storage as string | undefined);
	if (rawMode !== undefined) {
		const mode = parseMode(rawMode);
		if (mode === undefined) warnings.push(`invalid swarm.storage ${JSON.stringify(rawMode)} — default "files" applied`);
		else storage = mode;
	}

	let projection = true;
	const rawProj = env.SWARM_PROJECTION ?? (cfgSection.projection as unknown);
	if (rawProj !== undefined) {
		const p = parseBool(rawProj);
		if (p === undefined) warnings.push(`invalid swarm.projection ${JSON.stringify(rawProj)} — default true applied`);
		else projection = p;
	}

	const dbPath = typeof env.SWARM_JOURNAL_DB === "string" && env.SWARM_JOURNAL_DB.length > 0 ? env.SWARM_JOURNAL_DB : undefined;
	const sessionId =
		typeof env.SWARM_SESSION_ID === "string" && env.SWARM_SESSION_ID.length > 0 ? env.SWARM_SESSION_ID : undefined;
	return { storage, projection, dbPath, sessionId, warnings };
}

/**
 * The fleet session id for journal rows (interim spelling — see MODULE_CONTRACT).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — the task's exchange dir; cfg — the resolved storage config
 * Output: cfg.sessionId when set, else a stable 16-hex sha256 of the resolved dir
 * Guarantees: deterministic per fleet; both sides (extension store, worker
 *   CLI) derive the same value from the same dir; never throws
 * Raises: never
 */
export function swarmSessionIdFor(dir: string, cfg: SwarmStorageConfig): string {
	if (cfg.sessionId !== undefined) return cfg.sessionId;
	return createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Test clock hook (byte-parity evidence)
// ---------------------------------------------------------------------------

/**
 * The timestamp a verb stamps into its payload. SWARM_FIXED_TS (a parseable
 * date string) pins it for the byte-parity check; otherwise wall-clock.
 * Total: an unparseable override is ignored (wall-clock), never a throw.
 */
export function verbTimestamp(env: NodeJS.ProcessEnv = process.env): string {
	const fixed = env.SWARM_FIXED_TS;
	if (typeof fixed === "string" && fixed.length > 0) {
		const ms = Date.parse(fixed);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return new Date().toISOString();
}

/** The ClockPort the CLI's journal writer uses: pinned by SWARM_FIXED_TS when
 *  set (deterministic journal rows in checks), else the system clock. */
export function verbClock(env: NodeJS.ProcessEnv = process.env): ClockPort {
	const fixed = env.SWARM_FIXED_TS;
	if (typeof fixed === "string" && fixed.length > 0) {
		const ms = Date.parse(fixed);
		if (Number.isFinite(ms)) return { now: () => ms, delay: systemClock.delay };
	}
	return systemClock;
}

// ---------------------------------------------------------------------------
// Verb journal append (advisory, Law 8)
// ---------------------------------------------------------------------------

/** The journal half of a verb write, reported in the success envelope:
 *  {seq} on commit, {error} on an advisory failure. Absent in files mode. */
export type SwarmJournalOutcome = { seq: number } | { error: string };

/**
 * Append one worker-verb event to the journal when storage mode is "journal".
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - identity: { task, worker, dir } of the resolved verb context
 *   - kind/payload: the journal event (kind-shaped payload, §4.1.2)
 *   - env: process environment (config + test hooks)
 * Output: null in "files" mode (no journal write happens at all); in
 *   "journal" mode the structured outcome for the success envelope
 * Guarantees:
 *   - TOTAL (Law 8): a journal open/write failure is a structured result,
 *     never a throw — the verb's projection write proceeds regardless
 *   - the writer is opened and closed within the call (the CLI is a one-shot
 *     process; no handle outlives the append). A process-lifetime writer was
 *     considered (rev NIT) and deliberately NOT taken: one CLI process runs
 *     exactly ONE verb append, so reuse buys nothing, while a cached handle
 *     would hold WAL/shm fds for the process lifetime and complicate the
 *     per-call dbPath (tests drive several paths in one process) and the
 *     busy-retry open path. The bounded retry lives in journal.ts per append
 *     either way.
 * Raises: never
 */
export async function appendSwarmEvent(
	identity: { task: string; worker: string; dir: string },
	kind: JournalKind,
	payload: unknown,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SwarmJournalOutcome | null> {
	let cfg: SwarmStorageConfig;
	try {
		cfg = resolveSwarmStorage(env);
	} catch {
		return null; // structurally unreachable (resolver is total) — belt
	}
	if (cfg.storage !== "journal") return null;
	try {
		const writer = createJournalWriter({ dbPath: cfg.dbPath, clock: verbClock(env) });
		try {
			const res: JournalAppendResult = await writer.append({
				kind,
				sessionId: swarmSessionIdFor(identity.dir, cfg),
				task: identity.task,
				worker: identity.worker,
				payload,
			});
			return res.ok ? { seq: res.seq } : { error: res.code };
		} finally {
			writer.close();
		}
	} catch {
		// belt-and-suspenders: append() is total by contract; if that contract
		// is ever violated the verb still must not fail (Law 8).
		return { error: "E_JOURNAL_WRITE" };
	}
}
