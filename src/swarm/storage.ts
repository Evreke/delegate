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
 *   - `swarm.messageShadow: boolean` (default true; the 1.19.0-shadow store
 *     core): when true, the MESSAGE-kind verbs (ask/answer/steer/progress)
 *     append their message rows + the sender's `sent` receipt in EVERY
 *     storage mode — in "files" mode as an ADVISORY SHADOW (recorded +
 *     skipped on failure, ENVELOPE-SILENT: the success envelope stays
 *     byte-identical to 1.18, the `journal` field stays absent), in "journal"
 *     mode as the existing journal write plus the receipt. Files stay truth
 *     in files mode. false = the exact 1.18 write surface (no shadow rows,
 *     no receipts). A failed shadow write is VISIBLE (K2): one warn-once
 *     uiLog line, never silent, never a verb failure. The ONE loud exception
 *     is the Law 7 version gate (C5): a FUTURE `user_version` fails the verb
 *     structured E_JOURNAL_VERSION in every mode — never a silent no-op.
 *
 * Precedence: env (SWARM_STORAGE / SWARM_PROJECTION / SWARM_MESSAGE_SHADOW /
 * SWARM_JOURNAL_DB / SWARM_SESSION_ID) beats the config file keys
 * (`swarm.storage` / `swarm.projection` / `swarm.messageShadow` / `swarm.journalDb`
 * in pi-delegate.config.json), which beat the defaults. The env tier exists for
 * tests and scripting (the CLI is a separate bun process; the parity/E2E
 * checks drive it through env). Config read failures (incl. the named-profile
 * E_START throw) degrade to defaults — the storage flag is advisory to the
 * pipeline, never a new failure mode. `swarm.journalDb` is the config spelling
 * of the journal db override: one absolute path runs EVERY fleet on ONE
 * journal database (single-database mode, not the default per-task shards).
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
 *   - appendSwarmEvent is TOTAL except the loud version gate: it returns null
 *     in "files" mode (shadow writes included — envelope-silent) and a
 *     structured result in "journal" mode; it never throws EXCEPT the Law 7
 *     version gate, which throws the structured SwarmError(E_JOURNAL_VERSION)
 *     the verb renders as a LOUD failure (C5 — never a silent no-op against a
 *     newer schema);
 *   - a failed SHADOW write (files-mode message row, or a sent receipt in any
 *     mode) is advisory: recorded with ONE warn-once uiLog line (K2), never a
 *     verb failure, never silent;
 *   - invalid flag values degrade to the default with a recorded warning
 *     (never silently to a non-default mode);
 *   - exactly one session-id spelling per fleet (dir-stable fallback).
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadDelegateConfig } from "../profile.ts";
import { systemClock, type ClockPort } from "../clock.ts";
import { uiLog } from "../ui-log.ts";
import {
	createJournalWriter,
	isJournalMessageKind,
	type JournalKind,
	type JournalAppendResult,
} from "./journal.ts";
import { SwarmError } from "./result.ts";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export type SwarmStorageMode = "files" | "journal";

export interface SwarmStorageConfig {
	/** Truth owner: "files" (Phase A default) or "journal" (Phase B). */
	storage: SwarmStorageMode;
	/** Write the manifest.json file projection in journal mode. Default true. */
	projection: boolean;
	/** The 1.19.0-shadow message writes (rows + sent receipts) in every mode.
	 *  Default true; false = the exact 1.18 write surface. ABSENT also means
	 *  true: hand-built configs (the watcher/server session-id helpers) predate
	 *  the field and never shadow-write — the resolver always sets it. */
	messageShadow?: boolean;
	/** Journal db override (SWARM_JOURNAL_DB, else `swarm.journalDb` — single-database mode). */
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

	let messageShadow = true;
	const rawShadow = env.SWARM_MESSAGE_SHADOW ?? (cfgSection.messageShadow as unknown);
	if (rawShadow !== undefined) {
		const s = parseBool(rawShadow);
		if (s === undefined) warnings.push(`invalid swarm.messageShadow ${JSON.stringify(rawShadow)} — default true applied`);
		else messageShadow = s;
	}

	let dbPath: string | undefined;
	const envDb = typeof env.SWARM_JOURNAL_DB === "string" && env.SWARM_JOURNAL_DB.length > 0 ? env.SWARM_JOURNAL_DB : undefined;
	const rawDb = envDb ?? (cfgSection.journalDb as unknown);
	// Non-empty string wins (trimmed); an empty env value counts as unset;
	// anything else degrades to the per-task-shard default with a warning.
	if (typeof rawDb === "string" && rawDb.trim().length > 0) dbPath = rawDb.trim();
	else if (rawDb !== undefined) warnings.push(`invalid swarm.journalDb ${JSON.stringify(rawDb)} — default per-task shards applied`);
	const sessionId =
		typeof env.SWARM_SESSION_ID === "string" && env.SWARM_SESSION_ID.length > 0 ? env.SWARM_SESSION_ID : undefined;
	return { storage, projection, messageShadow, dbPath, sessionId, warnings };
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
// Verb journal append (advisory, Law 8) + the message-shadow writes
// ---------------------------------------------------------------------------

/** The journal half of a verb write, reported in the success envelope:
 *  {seq} on commit, {error} on an advisory failure. Absent in files mode —
 *  INCLUDING the shadow writes (envelope-silent, the 1.18 byte-identity bar). */
export type SwarmJournalOutcome = { seq: number } | { error: string };

/** The K2 warn-once guard: a failed shadow write surfaces as ONE uiLog line
 *  per process (the CLI is one-shot; the extension process warns once per
 *  session), never silent, never a verb failure. */
let shadowWarned = false;

function warnShadowFailureOnce(line: string): void {
	if (shadowWarned) return;
	shadowWarned = true;
	uiLog(`[pi-delegate swarm] ${line}`);
}

/**
 * The sender's `sent` receipt for a committed message row (the store design
 * §3 write authority: the sender writes its own sends; the receipt's
 * audience_session is the sender's own session). Advisory: a failed receipt
 * can only cost a duplicate delivery, never silence — warn-once (K2), never
 * a verb failure.
 */
async function appendSentReceipt(
	writer: ReturnType<typeof createJournalWriter>,
	sessionId: string,
	msgSeq: number,
	kind: JournalKind,
): Promise<void> {
	const receipt = await writer.appendReceipt({
		msgSeq,
		audienceSession: sessionId,
		receipt: "sent",
		writerSession: sessionId,
	});
	if (!receipt.ok) {
		warnShadowFailureOnce(
			`message receipt not written (kind ${kind}, seq ${msgSeq}): ${receipt.code} — recorded and skipped; a redelivery may repeat, never silence`,
		);
	}
}

/**
 * The FILES-MODE shadow write: append the message row + the sender's `sent`
 * receipt out-of-band (files stay truth). ENVELOPE-SILENT by contract — the
 * caller always returns null, so the success envelope stays byte-identical
 * to 1.18. Advisory: a failed row or receipt is a warn-once uiLog line (K2).
 * The ONE loud exception: the Law 7 version gate (C5) re-throws the
 * SwarmError(E_JOURNAL_VERSION) — the verb fails, never a silent no-op.
 */
async function shadowAppendMessageRow(
	identity: { task: string; worker: string; dir: string },
	kind: JournalKind,
	payload: unknown,
	cfg: SwarmStorageConfig,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const sessionId = swarmSessionIdFor(identity.dir, cfg);
	try {
		const writer = createJournalWriter({ dbPath: cfg.dbPath, clock: verbClock(env) });
		try {
			const res: JournalAppendResult = await writer.append({
				kind,
				sessionId,
				task: identity.task,
				worker: identity.worker,
				payload,
			});
			if (!res.ok) {
				if (res.code === "E_JOURNAL_VERSION") throw new SwarmError(res.code, res.error);
				warnShadowFailureOnce(
					`message shadow write failed (kind ${kind}, task ${identity.task}): ${res.code} — recorded and skipped; the file stays truth`,
				);
				return;
			}
			await appendSentReceipt(writer, sessionId, res.seq, kind);
		} finally {
			writer.close();
		}
	} catch (e) {
		if (e instanceof SwarmError && e.code === "E_JOURNAL_VERSION") throw e;
		warnShadowFailureOnce(
			`message shadow write failed (kind ${kind}, task ${identity.task}): ${(e as Error).message} — recorded and skipped; the file stays truth`,
		);
	}
}

/**
 * Append one worker-verb event to the journal.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - identity: { task, worker, dir } of the resolved verb context
 *   - kind/payload: the journal event (kind-shaped payload, §4.1.2)
 *   - env: process environment (config + test hooks)
 * Output: null in "files" mode UNLESS the shadow wrote (it always returns
 *   null there — envelope-silent); in "journal" mode the structured outcome
 *   for the success envelope
 * Guarantees:
 *   - "files" mode: only MESSAGE kinds under swarm.messageShadow write —
 *     the advisory shadow (row + sent receipt, warn-once on failure); every
 *     other case returns null with no journal touch (the exact 1.18 surface)
 *   - "journal" mode: the row append as in #23, plus the sender's `sent`
 *     receipt for message kinds under swarm.messageShadow (advisory)
 *   - the Law 7 version gate is LOUD (C5): a FUTURE user_version throws the
 *     structured SwarmError(E_JOURNAL_VERSION) — the verb fails in every
 *     mode; every other failure stays advisory (Law 8)
 *   - the writer is opened and closed within the call (the CLI is a one-shot
 *     process; no handle outlives the append)
 * Raises: SwarmError E_JOURNAL_VERSION (the loud Law 7 gate only)
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
	if (cfg.storage !== "journal") {
		// Files mode: the ONLY journal write is the message-kind shadow
		// (swarm.messageShadow, default true) — advisory, envelope-silent.
		if (!isJournalMessageKind(kind) || cfg.messageShadow === false) return null;
		await shadowAppendMessageRow(identity, kind, payload, cfg, env);
		return null;
	}
	const sessionId = swarmSessionIdFor(identity.dir, cfg);
	try {
		const writer = createJournalWriter({ dbPath: cfg.dbPath, clock: verbClock(env) });
		try {
			const res: JournalAppendResult = await writer.append({
				kind,
				sessionId,
				task: identity.task,
				worker: identity.worker,
				payload,
			});
			if (!res.ok) {
				// The loud Law 7 gate (C5): a future user_version fails the verb —
				// never a silent no-op against a newer schema.
				if (res.code === "E_JOURNAL_VERSION") throw new SwarmError(res.code, res.error);
				return { error: res.code };
			}
			if (isJournalMessageKind(kind) && cfg.messageShadow !== false) {
				await appendSentReceipt(writer, sessionId, res.seq, kind);
			}
			return { seq: res.seq };
		} finally {
			writer.close();
		}
	} catch (e) {
		// The loud gate re-throws (C5); every other failure keeps the verb
		// advisory-safe (Law 8): append() is total by contract, and if that
		// contract is ever violated the verb still must not fail.
		if (e instanceof SwarmError && e.code === "E_JOURNAL_VERSION") throw e;
		return { error: "E_JOURNAL_WRITE" };
	}
}
