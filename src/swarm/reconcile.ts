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
 *      (`workerAudienceMatch`) is applied PER WORKER over the replayed
 *      manifest: only rows that prove this session as their orchestrator are
 *      reconciled. A mixed-ownership task (a foreign sub-orchestrator's row
 *      sharing a task name) reconciles its owned rows only; foreign rows and
 *      owner-less legacy fleets are untouched and ride the summary's additive
 *      `skipped` field, never `lost`.
 *   3. Liveness — `transport.getStatus(name)` answers backend-blind (rpc child
 *      alive? herdr pane exists?); the reconciler never branches on a backend.
 *      The read is bounded by `statusTimeoutMs` (default 5000); a status READ
 *      failure OR a deadline is "unknown" and skips the worker (never a false
 *      death).
 *   4. Dead placements with no terminal event (`collect` / `retire` /
 *      `dead-reboot`, or a replayed `collectedAt`) get a `dead-reboot` event —
 *      itself terminal, so a worker is never double-marked. Immediately before
 *      each append the worker's journal rows are re-read for terminal events
 *      (TOCTOU mitigation).
 *   5. Per affected fleet, ONE `reconcile-summary` event (fleet-scoped)
 *      carrying `{lost, collectedBeforeLoss, skipped?}`; the watcher renders
 *      the frozen per-fleet summary text (`reconcileSummaryText`) and delivers
 *      exactly one wake. Idempotent across restarts: a second reconciliation
 *      finds no un-terminated workers and appends nothing.
 *
 * Residual TOCTOU race (honest, documented): the journal API exposes no
 * cross-process transaction, so two concurrent reconciliation runs over the
 * same (sessionId, task) cannot be fully serialized. The re-read before the
 * append narrows the window; what makes the residue acceptable is pi's
 * invariant that ONE session file is live in ONE process at a time, so a
 * second reconciler for the same fleet is not a supported state. Even if the
 * window is hit, the outcome is a duplicate `dead-reboot`/summary for a fleet
 * the operator already sees as lost — never a false death (liveness is only
 * marked on a positive `null` answer).
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
 *   - ownership is fail-closed PER WORKER: only a proven "mine" row is touched;
 *   - a liveness read is bounded (throw/deadline = unknown → skip);
 *   - at most ONE `reconcile-summary` per fleet per run, and none on a run
 *     that marked no worker dead (the idempotency proof).
 */

import { join } from "node:path";
import { exchangeRoot } from "../exchange.ts";
import { systemClock, type ClockPort } from "../clock.ts";
import type { Transport } from "../host.ts";
import { workerAudienceMatch, type AudienceVerdict, type SessionIdentity } from "../watch-role.ts";
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
	/** ADDITIVE v1 field: owned workers the fleet skipped (foreign/no-owner
	 *  rows in a mixed-ownership task). The frozen summary TEXT still renders
	 *  only `lost`/`collectedBeforeLoss`; this field makes the skip auditable. */
	skipped?: string[];
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
	/** Deadline for ONE `transport.getStatus` liveness read, ms (default 5000).
	 *  On deadline the worker is "unknown" — skipped, never a false death. */
	statusTimeoutMs?: number;
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

/** Default liveness-read deadline (ms) — see ReconcileDeps.statusTimeoutMs. */
const DEFAULT_STATUS_TIMEOUT_MS = 5000;

/** Terminal kinds for a WORKER (§4.1.4 step 2). */
const TERMINAL_WORKER_KINDS: ReadonlySet<string> = new Set(["collect", "retire", "dead-reboot"]);

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** The canonical fail-closed ownership verdict for ONE worker (watch-role). */
function workerVerdict(
	manifest: { masterSessionPath?: string },
	worker: { orchestratorSessionPath?: string },
	self: SessionIdentity,
	legacyFailOpen: boolean,
): AudienceVerdict {
	return workerAudienceMatch(
		{ orchestratorSessionPath: worker.orchestratorSessionPath, masterSessionPath: manifest.masterSessionPath },
		self,
		{ legacyFailOpen },
	);
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
 *   - ownership is gated PER WORKER (fail-closed at worker granularity): a
 *     fleet with a mix of owned and foreign/no-owner rows reconciles ONLY its
 *     owned rows; foreign rows are never touched and are reported in the
 *     summary's additive `skipped` list, never as `lost`;
 *   - a worker is marked dead only when it has no terminal event AND
 *     `transport.getStatus` answers null within `statusTimeoutMs` (a throw or
 *     a deadline is "unknown" — skipped, never a false death);
 *   - immediately before each `dead-reboot` append the worker's journal rows
 *     are RE-READ for terminal events (TOCTOU mitigation — see the module
 *     contract's residual-race note);
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
				const legacyFailOpen = deps.legacyFailOpen ?? false;
				const owned = manifest.workers.filter(
					(w) => workerVerdict(manifest, w, deps.self, legacyFailOpen) === "mine",
				);
				if (owned.length === 0) continue; // fail-closed at worker granularity
				const skipped = manifest.workers.filter((w) => !owned.includes(w)).map((w) => w.name);
				result.fleets++;
				await reconcileFleet(deps, clock, { sessionId, task, events }, owned, skipped, note, result);
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
	owned: Array<{ name: string; collectedAt?: string }>,
	skipped: string[],
	note: (message: string) => void,
	result: ReconcileResult,
): Promise<void> {
	const timeoutMs = deps.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
	const terminal = new Set<string>();
	const lastSeq = new Map<string, number>();
	for (const ev of fleet.events) {
		if (typeof ev.worker === "string") {
			lastSeq.set(ev.worker, Math.max(lastSeq.get(ev.worker) ?? 0, ev.seq));
			if (TERMINAL_WORKER_KINDS.has(ev.kind)) terminal.add(ev.worker);
		}
	}
	// "Reports collected before loss" counts OWNED terminal workers only.
	const collectedBeforeLoss = owned.filter((w) => w.collectedAt !== undefined).length;
	const newlyDead: string[] = [];
	for (const w of owned) {
		if (terminal.has(w.name) || w.collectedAt !== undefined) continue;
		if (await workerIsLive(deps, w.name, timeoutMs)) continue;
		// TOCTOU mitigation (§4.1.4 step 3): re-read the worker's rows right
		// before the append; if a terminal event landed since the fleet scan,
		// skip — the journal API offers no cross-process transaction.
		if (hasTerminalEvent(deps, fleet, w.name)) continue;
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
	if (skipped.length > 0) summary.skipped = skipped;
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

/** The TOCTOU re-scan: true when the worker already has a terminal row. */
function hasTerminalEvent(
	deps: ReconcileDeps,
	fleet: { sessionId: string; task: string },
	name: string,
): boolean {
	try {
		return deps.reader
			.eventsForWorker(fleet.sessionId, fleet.task, name)
			.some((ev) => TERMINAL_WORKER_KINDS.has(ev.kind));
	} catch {
		return true; // unreadable proof — fail-closed, skip the mark
	}
}

/** Backend-blind liveness, bounded by `timeoutMs`: null = dead, a status
 *  object = live, a throw/deadline = unknown (skip — never a false death). */
async function workerIsLive(deps: ReconcileDeps, name: string, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
		timer.unref?.();
	});
	try {
		const read = deps.transport.getStatus(name).catch(() => "error" as const);
		const outcome = await Promise.race([read, deadline]);
		if (outcome === "timeout" || outcome === "error") return true;
		return outcome !== null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
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