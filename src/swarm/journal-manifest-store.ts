/**
 * pi-delegate — src/swarm/journal-manifest-store.ts — the THIRD ManifestStore
 * port implementation (issue #23, ARCHITECTURE §4.1.3: Phase B, journal =
 * truth, files = projection).
 *
 * MODULE_CONTRACT — a ManifestStore whose truth is the append-only journal
 * (./journal.ts): every append/update is folded into journal events FIRST
 * (`spawn` for a new worker entry, per-field `stamp` events for everything a
 * fold changes), and manifest.json is then regenerated as a byte-frozen
 * projection (Law 7 — the exact bytes createFileManifestStore would write:
 * serializeJsonFile via the ONE atomic writer). Reads REPLAY the journal
 * (eventsForTask, seq order) — never the projection — so the journal alone
 * carries the fleet (cutover criterion 2). With `projection: false` no
 * manifest.json is written at all.
 *
 * Event model (§4.1.2 payloads; additive `entry` on spawn):
 *   - spawn {backend, placementRef, briefPath, briefText, depth?, entry} —
 *     `entry` is the full ManifestWorker (additive) so replay rebuilds the
 *     manifest; `briefText` is the brief inline (§4.1.4 step 5 respawn).
 *   - stamp {field, value, entryIndex?} — worker-scoped (entryIndex = the
 *     workers[] position the stamp mutates, so a same-name retry is not
 *     retro-stamped; absent only on legacy rows → name-match fallback) or
 *     fleet-scoped (worker NULL) for description/masterSessionPath/usage/
 *     schemaVersion. A null value clears the field (JSON cannot carry
 *     undefined).
 *   - collect (kind `collect`, worker-scoped) sets collectedAt = event ts on
 *     replay when unset — forward-compat; this store expresses collection as
 *     a collectedAt `stamp` (the collect-kind producer is deferred).
 *
 * Replay semantics mirror the file protocol: workers are append-only and
 * matched by INDEX, seq order. Non-expressible folds (RENAME, shrunk workers
 * array) skip the journal append for that fact, are recorded in `skipped`,
 * and still write the projection (advisory, Law 8; never a throw).
 *
 * Advisory by contract (Law 8 / Law 13): a journal append failure never fails
 * the store operation — the projection is still written and the folded
 * manifest returned. A journal READ failure yields the tolerant-empty plane
 * (read → null, scan → []), exactly the file store's corrupt-file behavior.
 *
 * Fleet scoping: rows are keyed by (sessionId, task) with sessionId from
 * swarmSessionIdFor (./storage.ts — SWARM_SESSION_ID override, else a stable
 * dir hash). scan() bounds the live set to task dirs that EXIST under
 * exchangeRoot() — the journal outlives pruned exchange dirs.
 *
 * Dependencies: node builtins, @earendil-works/pi-coding-agent
 * (withFileMutationQueue), ../exchange.ts (exchangeRoot ONLY),
 * ../manifest-store.ts (port types + the ONE atomic writer + the foreign-
 * backend filter + manifestPath), ../clock.ts (ClockPort), ./journal.ts +
 * ./journal-read.ts (the ONLY sqlite seam), ./serialize.ts, ./storage.ts.
 * No herdr import (Law 4); no sqlite driver import here.
 *
 * Critical invariants:
 *   - the journal is appended BEFORE the projection write; an append failure
 *     is recorded, never propagated;
 *   - projection bytes are serializeJsonFile(next) via atomicWriteFileSync —
 *     byte-identical to updateManifest's writer (pinned by the parity checks);
 *   - read/scan NEVER consult the projection file;
 *   - replay is total and order-deterministic (seq ascending).
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { exchangeRoot } from "../exchange.ts";
import {
	atomicWriteFileSync,
	EXCHANGE_SCHEMA_VERSION,
	filterForeignBackendWorkers,
	manifestPath,
	type ExchangeManifest,
	type ManifestStore,
	type ManifestWorker,
} from "../manifest-store.ts";
import { systemClock, type ClockPort } from "../clock.ts";
import { createJournalWriter, type JournalKind } from "./journal.ts";
import { createJournalReader, type JournalEvent } from "./journal-read.ts";
import { serializeJsonFile } from "./serialize.ts";
import { swarmSessionIdFor, type SwarmStorageConfig } from "./storage.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface JournalManifestStoreOptions {
	/** Database path override (tests sandbox here). Default journalDbPath(). */
	dbPath?: string;
	/** Fleet session id override. Default: SWARM_SESSION_ID env, else the
	 *  stable dir hash (see ./storage.ts). */
	sessionId?: string;
	/** Write the manifest.json projection after each mutation. Default true. */
	projection?: boolean;
	/** Clock injected into the journal writer (tests pin ts). */
	clock?: ClockPort;
	/** Environment for the SWARM_SESSION_ID fallback. Default process.env. */
	env?: NodeJS.ProcessEnv;
}

export interface JournalManifestStore extends ManifestStore {
	/** Close the journal handles (idempotent; the port has no close). */
	close(): void;
}

/** One journal event planned from a manifest diff. */
interface PlannedEvent {
	kind: JournalKind;
	worker: string | null;
	payload: Record<string, unknown>;
}

/** Top-level manifest fields that ride fleet-scoped stamp events. task/dir/
 *  workers are excluded: task/dir are derived from the dir argument, workers
 *  are carried by spawn events + worker-scoped stamps. */
const TOP_LEVEL_STAMP_FIELDS = ["schemaVersion", "description", "masterSessionPath", "usage"] as const;

function jsonEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Tolerant brief read for the spawn payload's briefText (§4.1.4 step 5). */
function readBriefText(briefPath: unknown): string | null {
	if (typeof briefPath !== "string" || briefPath.length === 0) return null;
	try {
		return readFileSync(briefPath, "utf8");
	} catch {
		return null;
	}
}

/** Minimal shape gate for replaying a spawn payload's `entry` (tolerant — a
 *  spawn event from a producer without `entry` is skipped, never a throw). */
function isManifestWorkerish(v: unknown): v is ManifestWorker {
	if (typeof v !== "object" || v === null) return false;
	const w = v as Record<string, unknown>;
	return (
		typeof w.name === "string" &&
		typeof w.placement === "object" &&
		w.placement !== null &&
		typeof w.briefPath === "string" &&
		typeof w.reportPath === "string"
	);
}

/**
 * Replay one fleet's events into the manifest they imply.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: dir — the task's exchange dir; events — the fleet's journal rows
 *   (any seq order; sorted here)
 * Output: the rebuilt ExchangeManifest, or null when no manifest-relevant
 *   event exists (the file store's "absent" plane)
 * Guarantees:
 *   - total: malformed rows/payloads are skipped, never a throw;
 *   - schemaVersion is the writer constant (a projection-format fact, not a
 *     journaled one); task/dir come from the dir argument;
 *   - worker-scoped stamps target the `entryIndex` entry (sequence-scoped — a
 *     same-name retry is not retro-stamped; legacy rows → name match)
 * Raises: never
 */
export function replayManifest(dir: string, events: JournalEvent[]): ExchangeManifest | null {
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	const resolvedDir = resolve(dir);
	let m: ExchangeManifest | null = null;
	// NOTE: m is assigned inside closures, so TS flow-narrows it to `null` —
	// peek() is the un-narrowed read (declared return type), used in the loop.
	const peek = (): ExchangeManifest | null => m;
	const ensure = (): ExchangeManifest => {
		if (m === null) m = { task: basename(resolvedDir), dir: resolvedDir, workers: [] };
		return m;
	};
	for (const ev of sorted) {
		if (ev.kind === "spawn" && typeof ev.worker === "string") {
			const entry = (ev.payload as { entry?: unknown } | null)?.entry;
			if (isManifestWorkerish(entry)) ensure().workers.push(structuredClone(entry));
			continue;
		}
		if (ev.kind === "stamp") {
			const p = ev.payload as { field?: unknown; value?: unknown; entryIndex?: unknown } | null;
			if (typeof p?.field !== "string") continue;
			if (typeof ev.worker === "string") {
				const cur = peek();
				if (cur === null) continue;
				// Sequence-scoped stamp (additive `entryIndex`): a same-name retry
				// spawns a NEW entry at a later index, so a stamp must name the entry
				// it mutates — otherwise a dead same-name entry is retro-stamped too.
				// Legacy rows without `entryIndex` fall back to the name-match fold.
				const idx = p.entryIndex;
				const targets: ManifestWorker[] = [];
				if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < cur.workers.length) {
					const w = cur.workers[idx]!;
					if (w.name === ev.worker) targets.push(w);
				} else {
					for (const w of cur.workers) if (w.name === ev.worker) targets.push(w);
				}
				for (const w of targets) {
					const rec = w as unknown as Record<string, unknown>;
					if (p.value === null || p.value === undefined) delete rec[p.field];
					else rec[p.field] = p.value;
				}
			} else {
				if (p.field === "task" || p.field === "dir" || p.field === "workers") continue;
				const t = ensure() as unknown as Record<string, unknown>;
				if (p.value === null || p.value === undefined) delete t[p.field];
				else t[p.field] = p.value;
			}
			continue;
		}
		if (ev.kind === "collect" && typeof ev.worker === "string") {
			const cur = peek();
			if (cur === null) continue;
			const idx = (ev.payload as { entryIndex?: unknown } | null)?.entryIndex;
			const scoped =
				typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < cur.workers.length
					? [cur.workers[idx]!]
					: cur.workers;
			for (const w of scoped) {
				if (w.name === ev.worker && w.collectedAt === undefined) w.collectedAt = ev.ts;
			}
		}
		// every other kind is not manifest state — ignored by this projection
	}
	const finalM = peek();
	if (finalM === null) return null;
	finalM.schemaVersion = EXCHANGE_SCHEMA_VERSION;
	return finalM;
}

/**
 * Diff a fold's result into journal events. Worker entries are matched by
 * INDEX (the workers array is append-only); new entries become `spawn`
 * events, changed fields become `stamp` events.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: oldM — the replayed current state (null when no manifest exists
 *   yet); next — the fold's result (schemaVersion already stamped)
 * Output: { events, skipped } — events in append order; skipped names the
 *   facts the journal model cannot express (worker rename / workers-array
 *   shrink), which the caller records and bypasses (advisory, Law 8)
 * Guarantees: pure; deterministic order (worker index, then field name);
 *   an identity fold on a FRESH dir still yields the schemaVersion stamp so
 *   the manifest "exists" afterward (file-store parity)
 * Raises: never
 */
export function diffManifestEvents(
	oldM: ExchangeManifest | null,
	next: ExchangeManifest,
): { events: PlannedEvent[]; skipped: string[] } {
	const events: PlannedEvent[] = [];
	const skipped: string[] = [];
	const oldWorkers = oldM?.workers ?? [];
	if (oldWorkers.length > next.workers.length) {
		skipped.push(`workers-array shrink (${oldWorkers.length} → ${next.workers.length}) is not journal-expressible`);
	}
	for (let i = 0; i < next.workers.length; i++) {
		const w = next.workers[i]!;
		if (i >= oldWorkers.length) {
			const placement = w.placement as { backend?: unknown; placementRef?: unknown };
			const payload: Record<string, unknown> = {
				backend: typeof placement.backend === "string" ? placement.backend : null,
				placementRef: typeof placement.placementRef === "string" ? placement.placementRef : null,
				briefPath: w.briefPath,
				briefText: readBriefText(w.briefPath),
				entry: w,
			};
			if (w.depth !== undefined) payload.depth = w.depth;
			events.push({ kind: "spawn", worker: w.name, payload });
			continue;
		}
		const ow = oldWorkers[i]!;
		if (ow.name !== w.name) {
			skipped.push(`worker rename at index ${i} (${ow.name} → ${w.name}) is not journal-expressible`);
			continue;
		}
		const keys = new Set([...Object.keys(ow), ...Object.keys(w)]);
		for (const field of [...keys].sort()) {
			if (field === "name") continue;
			const ov = (ow as unknown as Record<string, unknown>)[field];
			const nv = (w as unknown as Record<string, unknown>)[field];
			if (jsonEq(ov, nv)) continue;
			events.push({
				kind: "stamp",
				worker: w.name,
				payload: { field, value: nv === undefined ? null : nv, entryIndex: i },
			});
		}
	}
	for (const field of TOP_LEVEL_STAMP_FIELDS) {
		const ov = oldM === null ? undefined : (oldM as unknown as Record<string, unknown>)[field];
		const nv = (next as unknown as Record<string, unknown>)[field];
		if (jsonEq(ov, nv)) continue;
		events.push({ kind: "stamp", worker: null, payload: { field, value: nv === undefined ? null : nv } });
	}
	return { events, skipped };
}

/**
 * Create the journal-backed ManifestStore (Phase B, §4.1.3). Truth is the
 * journal; the manifest.json projection is regenerated byte-identically
 * after every mutation unless `projection: false`.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts — dbPath/sessionId/projection/clock/env overrides
 * Output: a ManifestStore (+ close()) backed by the journal
 * Guarantees:
 *   - read/update/append/scan parity with the file store for well-formed
 *     inputs (pinned by test/manifest-store-check.ts for ALL THREE impls plus
 *     test/swarm-parity-check.ts for byte-identity);
 *   - every operation is total on the journal side (Law 8): append failures
 *     are advisory; read failures are the tolerant-empty plane;
 *   - updates are serialized per manifest path via withFileMutationQueue
 *     (the same in-process serialization the file store uses)
 * Raises: per-operation semantics mirror the file store — the PROJECTION
 *   write propagates fs errors exactly like updateManifest does
 */
export function createJournalManifestStore(opts: JournalManifestStoreOptions = {}): JournalManifestStore {
	const writer = createJournalWriter({ dbPath: opts.dbPath, clock: opts.clock ?? systemClock });
	const reader = createJournalReader({ dbPath: opts.dbPath });
	const projection = opts.projection ?? true;
	const env = opts.env ?? process.env;

	function sessionIdFor(dir: string): string {
		const cfg: SwarmStorageConfig = {
			storage: "journal",
			projection,
			sessionId: opts.sessionId ?? (typeof env.SWARM_SESSION_ID === "string" && env.SWARM_SESSION_ID.length > 0 ? env.SWARM_SESSION_ID : undefined),
			warnings: [],
		};
		return swarmSessionIdFor(dir, cfg);
	}

	function replay(dir: string): ExchangeManifest | null {
		return replayManifest(dir, reader.eventsForTask(sessionIdFor(dir), basename(resolve(dir))));
	}

	function writeProjection(dir: string, next: ExchangeManifest): void {
		mkdirSync(dir, { recursive: true });
		atomicWriteFileSync(manifestPath(dir), serializeJsonFile(next));
	}

	async function mutateAndPersist(
		dir: string,
		mutate: (m: ExchangeManifest) => ExchangeManifest,
	): Promise<ExchangeManifest> {
		const path = manifestPath(dir);
		return withFileMutationQueue(path, async () => {
			const current = replay(dir);
			const base: ExchangeManifest = current ?? { task: basename(resolve(dir)), dir: resolve(dir), workers: [] };
			// Law 7: stamp parity with the file writer (every writer stamps v1).
			const next: ExchangeManifest = { ...mutate(structuredClone(base)), schemaVersion: EXCHANGE_SCHEMA_VERSION };
			// Journal FIRST (journal = truth): every append is advisory — a
			// failure is recorded by the writer's own result, never thrown.
			const { events } = diffManifestEvents(current, next);
			for (const ev of events) {
				await writer.append({
					kind: ev.kind,
					sessionId: sessionIdFor(dir),
					task: basename(resolve(dir)),
					worker: ev.worker,
					payload: ev.payload,
				});
			}
			if (projection) writeProjection(dir, next);
			return structuredClone(next);
		});
	}

	const store: JournalManifestStore = {
		read(dir) {
			return replay(dir);
		},
		update(dir, mutate) {
			return mutateAndPersist(dir, mutate);
		},
		append(dir, entry) {
			return mutateAndPersist(dir, (m) => ({ ...m, workers: [...m.workers, entry] }));
		},
		scan(backendName) {
			// The exchange root bounds the LIVE set (the journal outlives pruned
			// task dirs); per surviving dir the truth is the journal replay.
			const root = exchangeRoot();
			let taskNames: string[];
			try {
				taskNames = readdirSync(root, { withFileTypes: true })
					.filter((e) => e.isDirectory())
					.map((e) => e.name);
			} catch {
				return [];
			}
			const manifests: ExchangeManifest[] = [];
			for (const taskName of taskNames) {
				const m = replay(resolve(root, taskName));
				if (m) manifests.push(filterForeignBackendWorkers(m, backendName));
			}
			return manifests;
		},
		close() {
			writer.close();
			reader.close();
		},
	};
	return store;
}
