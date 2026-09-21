/**
 * pi-delegate — src/swarm/reconcile.ts — resume reconciliation (issue #27,
 * ARCHITECTURE §4.1.4).
 *
 * MODULE_CONTRACT — the post-reboot reconciler: on `session_start`, read the
 * durable journal, find the fleets THIS session owns, verify each worker's
 * placement liveness through the Transport seam, and make the loss explicit.
 *
 * Purpose (the five §4.1.4 steps):
 *   1. Journal scan — fleets (`sessionId`, `task`) present in `events.db`.
 *   2. Ownership — the canonical fail-closed verdict of `watch-role.ts`
 *      (`workerAudienceMatch`) over the replayed manifest: a fleet is OURS
 *      only when a worker entry proves this session as its orchestrator.
 *      Foreign fleets and owner-less legacy fleets are untouched.
 *   3. Liveness — `transport.getStatus(name)` answers backend-blind (rpc child
 *      alive? herdr pane exists?); the reconciler never branches on a backend.
 *      A status READ failure is "unknown" and skips the worker (never a
 *      false death).
 *   4. Dead placements with no terminal event (`collect` / `retire` /
 *      `dead-reboot`, or a replayed `collectedAt`) get a `dead-reboot` event —
 *      itself terminal, so a worker is never double-marked.
 *   5. Per affected fleet, ONE `reconcile-summary` event (fleet-scoped)
 *      carrying `{lost, collectedBeforeLoss}`; the watcher renders the frozen
 *      per-fleet summary text (`reconcileSummaryText`) and delivers exactly
 *      one wake. Idempotent across restarts: a second reconciliation finds no
 *      un-terminated workers and appends nothing.
 *
 * Advisory by contract (§4.1.4): a reconciliation failure NEVER blocks
 * session start. `reconcileFleets()` is total (it catches per-fleet and
 * per-worker faults and reports them through the advisory `onError` sink);
 * `reconcileSessionStart()` additionally degrades to "no reconciliation this
 * session" on any setup failure. Nothing here throws past its caller.
 *
 * Phase note (§4.1.3/§4.1.4): reconciliation exists only once the journal
 * carries production writes — `reconcileSessionStart` runs only when
 * `swarm.storage === "journal"`; in the default "files" phase it is a no-op.
 *
 * Dependencies: ./journal.ts + ./journal-read.ts (the ONLY sqlite seam),
 * ./journal-manifest-store.ts (the canonical journal→manifest replay),
 * ../watch-role.ts (the canonical ownership verdict), ../host.ts (the
 * Transport seam type ONLY), ../clock.ts (ClockPort), ./storage.ts (the
 * storage-mode gate). No herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - `reconcileFleets` / `reconcileSessionStart` NEVER throw;
 *   - ownership is fail-closed: only a proven "mine" fleet is touched;
 *   - at most ONE `reconcile-summary` per fleet per run, and none on a run
 *     that marked no worker dead (the idempotency proof).
 */

import { join } from "node:path";
import { exchangeRoot } from "../exchange.ts";
import { systemClock, type ClockPort } from "../clock.ts";
import type { Transport } from "../host.ts";
import { workerAudienceMatch, type SessionIdentity } from "../watch-role.ts";
import { createJournalWriter, type JournalWriter } from "./journal.ts";
import { createJournalReader, type JournalEvent, type JournalReader } from "./journal-read.ts";
import { replayManifest } from "./journal-manifest-store.ts";
import { resolveSwarmStorage } from "./storage.ts";

// ---------------------------------------------------------------------------
// The frozen summary text (§4.1.4 step 4)
// ---------------------------------------------------------------------------

/** The reconcile-summary payload (§4.1.2, additive-only after v1). */
export interface ReconcileSummaryPayload {
	/** Names of the workers newly marked `dead-reboot` in this run. */
	lost: string[];
	/** Reports collected (terminal) in the fleet before the loss. */
	collectedBeforeLoss: number;
}

/**
 * Render the FROZEN per-fleet summary wake text (§4.1.4 step 4). The watcher
 * (the delivery side) renders it from the `reconcile-summary` payload; this
 * is the ONE spelling of the template.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: task — fleet slug; payload — the v1 reconcile-summary payload
 * Output: `fleet <task>: N workers lost to reboot, briefs preserved,
 *   M reports collected before loss`
 * Guarantees: pure; byte-stable template (the string is a frozen contract);
 *   never throws
 * Raises: never
 */
export function reconcileSummaryText(task: string, payload: ReconcileSummaryPayload): string {
	return `fleet ${task}: ${payload.lost.length} workers lost to reboot, briefs preserved, ${payload.collectedBeforeLoss} reports collected before loss`;
}

// ---------------------------------------------------------------------------
// Injected core (testable, total)
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
	/** The injected Transport seam (backend-blind liveness). */
	transport: Transport;
	/** This session's identity (`sessionFile` is the ownership proof). */
	self: SessionIdentity;
	/** Journal reader (all events via `eventsAfter(0)`). */
	reader: JournalReader;
	/** Journal writer (the `dead-reboot` / `reconcile-summary` appends). */
	writer: JournalWriter;
	/** Clock for `detectedAt` (default systemClock). */
	clock?: ClockPort;
	/** Task-dir resolver for the replay (the replay's task/dir fields are
	 *  unused here; default the task slug itself). */
	taskDir?: (task: string) => string;
	/** Legacy "no-owner" rollback — default false (fail-closed). */
	legacyFailOpen?: boolean;
	/** Advisory sink for skipped faults (default no-op). */
	onError?: (message: string) => void;
}

export interface ReconcileResult {
	/** True when the journal was scanned (false: files mode / degraded setup). */
	ran: boolean;
	/** Owned fleets inspected this run. */
	fleets: number;
	/** Workers newly marked `dead-reboot` (all fleets). */
	lost: string[];
	/** `reconcile-summary` events appended this run. */
	summaries: number;
}

const IDLE: ReconcileResult = { ran: false, fleets: 0, lost: [], summaries: 0 };

/** Terminal kinds for a WORKER (§4.1.4 step 2). */
const TERMINAL_WORKER_KINDS: ReadonlySet<string> = new Set(["collect", "retire", "dead-reboot"]);

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** True when the replayed fleet proves THIS session as an owner (fail-closed). */
function fleetIsMine(
	manifest: { workers: Array<{ orchestratorSessionPath?: string }>; masterSessionPath?: string },
	self: SessionIdentity,
	legacyFailOpen: boolean,
): boolean {
	for (const w of manifest.workers) {
		const verdict = workerAudienceMatch(
			{ orchestratorSessionPath: w.orchestratorSessionPath, masterSessionPath: manifest.masterSessionPath },
			self,
			{ legacyFailOpen },
		);
		if (verdict === "mine") return true;
	}
	return false;
}

/**
 * Reconcile every fleet the journal says this session owns. Total: every
 * per-fleet/per-worker fault is reported to `onError` and skipped.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — transport + self + journal handles (+ optional clock/taskDir/
 *   legacyFailOpen/onError)
 * Output: ReconcileResult — fleets inspected, workers newly marked dead,
 *   summaries appended
 * Guarantees:
 *   - never throws;
 *   - only fleets whose replayed manifest proves "mine" ownership are touched;
 *   - a worker is marked dead only when it has no terminal event AND
 *     `transport.getStatus` answers null (a thrown status read is "unknown" —
 *     skipped, never a false death);
 *   - a fleet gets at most one `reconcile-summary` per run, and only when this
 *     run marked at least one worker dead (restart-idempotent).
 * Raises: never
 */
export async function reconcileFleets(deps: ReconcileDeps): Promise<ReconcileResult> {
	const clock = deps.clock ?? systemClock;
	const note = deps.onError ?? (() => {});
	const result: ReconcileResult = { ran: true, fleets: 0, lost: [], summaries: 0 };
	try {
		const all = deps.reader.eventsAfter(0);
		const groups = new Map<string, { sessionId: string; task: string; events: JournalEvent[] }>();
		for (const ev of all) {
			const key = `${ev.sessionId}\u0000${ev.task}`;
			const g = groups.get(key);
			if (g) g.events.push(ev);
			else groups.set(key, { sessionId: ev.sessionId, task: ev.task, events: [ev] });
		}

		for (const { sessionId, task, events } of groups.values()) {
			try {
				const dir = deps.taskDir?.(task) ?? task;
				const manifest = replayManifest(dir, events);
				if (!manifest || manifest.workers.length === 0) continue;
				if (!fleetIsMine(manifest, deps.self, deps.legacyFailOpen ?? false)) continue;
				result.fleets++;
				await reconcileFleet(deps, clock, { sessionId, task, events }, manifest, note, result);
			} catch (err) {
				note(`fleet ${task} skipped: ${errorText(err)}`);
			}
		}
	} catch (err) {
		note(`journal scan failed: ${errorText(err)}`);
		return { ...result, ran: false };
	}
	return result;
}

/** Reconcile ONE owned fleet (see reconcileFleets for the contract). */
async function reconcileFleet(
	deps: ReconcileDeps,
	clock: ClockPort,
	fleet: { sessionId: string; task: string; events: JournalEvent[] },
	manifest: { workers: Array<{ name: string; collectedAt?: string }> },
	note: (message: string) => void,
	result: ReconcileResult,
): Promise<void> {
	const terminal = new Set<string>();
	const lastSeq = new Map<string, number>();
	for (const ev of fleet.events) {
		if (typeof ev.worker === "string") {
			lastSeq.set(ev.worker, Math.max(lastSeq.get(ev.worker) ?? 0, ev.seq));
			if (TERMINAL_WORKER_KINDS.has(ev.kind)) terminal.add(ev.worker);
		}
	}
	const collectedBeforeLoss = manifest.workers.filter((w) => w.collectedAt !== undefined).length;
	const newlyDead: string[] = [];
	for (const w of manifest.workers) {
		if (terminal.has(w.name) || w.collectedAt !== undefined) continue;
		if (await workerIsLive(deps, w.name)) continue;
		const payload = {
			detectedAt: new Date(clock.now()).toISOString(),
			lastSeq: lastSeq.get(w.name) ?? 0,
		};
		const res = await deps.writer.append({
			kind: "dead-reboot",
			sessionId: fleet.sessionId,
			task: fleet.task,
			worker: w.name,
			payload,
		});
		if (!res.ok) {
			note(`dead-reboot append failed for ${fleet.task}/${w.name}: ${res.code}`);
			continue;
		}
		newlyDead.push(w.name);
		result.lost.push(w.name);
	}

	// §4.1.4 step 4: ONE summary per affected fleet, none when nothing died
	// this run (the journal's dead-reboot terminality is the restart dedup).
	if (newlyDead.length === 0) return;
	const summary: ReconcileSummaryPayload = { lost: newlyDead, collectedBeforeLoss };
	const res = await deps.writer.append({
		kind: "reconcile-summary",
		sessionId: fleet.sessionId,
		task: fleet.task,
		worker: null,
		payload: summary,
	});
	if (res.ok) result.summaries++;
	else note(`reconcile-summary append failed for ${fleet.task}: ${res.code}`);
}

/** Backend-blind liveness: null = dead, a status object = live, a throw or a
 *  missing seam answer = unknown (skip — never a false death). */
async function workerIsLive(deps: ReconcileDeps, name: string): Promise<boolean> {
	try {
		const status = await deps.transport.getStatus(name);
		return status !== null;
	} catch {
		return true; // unprovable — treat as still alive (advisory)
	}
}

// ---------------------------------------------------------------------------
// Production entry (config-gated, advisory)
// ---------------------------------------------------------------------------

/**
 * Production `session_start` entry (§4.1.4, after the watcher mount): scan the
 * journal for this session's fleets and reconcile. Advisory by contract — any
 * setup failure degrades to "no reconciliation this session".
 * <p>
 * FUNCTION_CONTRACT:
 * Input: transport — the session's bound Transport; self — the live session
 *   identity; env — process environment (default process.env; tests sandbox)
 * Output: ReconcileResult (ran:false in files mode / on degraded setup)
 * Guarantees:
 *   - runs only when `swarm.storage === "journal"` (the §4.1.4 phase note);
 *   - the reader/writer are opened for the call and closed in a finally;
 *   - this function NEVER throws and NEVER blocks more than its own work.
 * Raises: never
 */
export async function reconcileSessionStart(
	transport: Transport,
	self: SessionIdentity,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ReconcileResult> {
	try {
		const cfg = resolveSwarmStorage(env);
		if (cfg.storage !== "journal") return IDLE;
		const reader = createJournalReader({ dbPath: cfg.dbPath });
		const writer = createJournalWriter({ dbPath: cfg.dbPath });
		try {
			return await reconcileFleets({
				transport,
				self,
				reader,
				writer,
				taskDir: (task) => join(exchangeRoot(), task),
			});
		} finally {
			reader.close();
			writer.close();
		}
	} catch (err) {
		try {
			process.stderr.write(
				`${JSON.stringify({ level: "warn", component: "swarm-reconcile", code: "E_RECONCILE", error: errorText(err) })}\n`,
			);
		} catch {
			// stderr is advisory too
		}
		return IDLE;
	}
}