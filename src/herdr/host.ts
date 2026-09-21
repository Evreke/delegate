/**
 * pi-delegate — src/herdr/host.ts (herdr implementation of the Transport seam).
 *
 * MODULE_CONTRACT — the herdr backend adapter's TRANSPORT layer: HerdrTransport
 * (the Transport implementation — serialized mutating ops with a per-op queue
 * deadline, the W3 socket read-only path, the two-phase settle state machine,
 * the root/sub worktree authority guard) and createHerdrTransport. The
 * adapter's other three responsibilities are separate modules in this
 * directory, extracted verbatim from this file by the ARCHITECTURE.md Law 5
 * decomposition:
 *   - ./cli.ts    — the herdr CLI subprocess runner: platform launch policy,
 *                   the always-settling timeout + SIGTERM→SIGKILL escalation,
 *                   the stdout result-line parse, and the extension's single
 *                   documented raw-throw deviation (Law 8);
 *   - ./socket.ts — the NDJSON-over-unix-socket client (W3 read-only path)
 *                   with its own MODULE_CONTRACT;
 *   - ./map.ts    — the herdr-JSON → seam-type result mappers, the
 *                   placementRef codec, and the adapter-internal read model
 *                   HerdrAgentStatus (herdr ids stop inside src/herdr/, they
 *                   never cross the seam).
 * This file is the adapter's facade: it re-exports the moved symbols, so the
 * adapter keeps exactly ONE import surface (package.json "./herdr" → this
 * file) and the frozen CLI/OS strings still stop at src/herdr/.
 *
 * Dependencies: node builtins (os, path) + ../expaths.ts (isDirUnder) + the
 * seam module ../host.ts + the three herdr modules above. Nothing outside
 * src/herdr/ imports ./cli.ts / ./socket.ts / ./map.ts (test/herdr-split-check.ts);
 * this file is bound ONCE in index.ts (the composition root — the sole
 * sanctioned importer of the adapter; the boundary is module-resolution
 * enforced through the package exports map, static-check T1.1e).
 *
 * Critical invariants that live HERE: serialized-mutations (one mutating op in
 * flight, enqueue) + its per-op queue deadline, listStatuses pile-up de-dup,
 * settle-before-start-race-d3, aged-finish-blind-spot (via sessionHasReply
 * from ../host.ts), abort-detaches-never-kills, worktree-authority
 * (~/.herdr/worktrees root/sub guard, isSubOrchestratorCwd).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { isDirUnder } from "../expaths.ts";
import {
	type AgentStatus,
	type AgentStatusName,
	delegateError,
	delegateErrorWithDetail,
	DelegateErrorImpl,
	type Placement,
	type PlacementReq,
	type PromptReq,
	sessionHasReply,
	type SettleResult,
	type StartReq,
	type StartResult,
	type TeardownReq,
	type TeardownResult,
	type Transport,
	type TransportCapabilities,
} from "../host.ts";
import { parseHerdrResult, runHerdr } from "./cli.ts";
import { HERDR_SOCKET_TRANSPORT_ENV, HerdrSocketClient, HerdrSocketError } from "./socket.ts";
import {
	agentStatusFromResult,
	asString,
	extractAgentName,
	herdrStatusFromResult,
	isRecord,
	paneFromHerdrRef,
	pick,
	placementFromTabResult,
	placementFromWorktreeResult,
	statusFromResult,
	stripToSeamStatuses,
} from "./map.ts";
import type { HerdrAgentStatus } from "./map.ts";

// The adapter keeps ONE import surface: the symbols that moved to ./cli.ts,
// ./socket.ts and ./map.ts stay importable from this module under the same
// names (package.json "./herdr" subpath; tests and index.ts import the facade).
export { parseHerdrResult, runHerdr, SIGKILL_GRACE_MS, winQuoteArg } from "./cli.ts";
export type { HerdrRunResult } from "./cli.ts";
export {
	DEFAULT_HERDR_SOCK,
	HERDR_SOCKET_TRANSPORT_ENV,
	HerdrSocketClient,
	HerdrSocketError,
	SOCKET_CONNECT_TIMEOUT_MS,
	SOCKET_REQUEST_TIMEOUT_MS,
} from "./socket.ts";
export type { HerdrSocketClientOptions } from "./socket.ts";
export {
	placementFromTabResult,
	reconcileTabClose,
} from "./map.ts";
export type { HerdrPlacement } from "./map.ts";

// ============================================================================
// SECTION 2 — src/transport/herdr.ts (verbatim, incl. its review header)
// ============================================================================

/**
 * pi-delegate — herdr transport.
 *
 * Thin implementation of the `Transport` seam on top of the herdr CLI.
 * Every call shells out via `node:child_process.execFile` with array args —
 * never shell strings. All *mutating* herdr ops (place / start / prompt /
 * teardown) are serialized through one internal promise queue so two
 * concurrent delegate calls can never run a mutating herdr op in parallel
 * (ARCHITECTURE.md Law 4: parallel mutating ops hang the pane process group).
 *
 * herdr CLI convention (verified 2026-09-05): commands print a JSON line
 * `{"id":"...","result":{...}}` on stdout; we parse the last line and use
 * `.result`. Non-zero exit → typed DelegateError with the error-code mapping
 * from the E_* taxonomy (host.ts).
 */


/** Worktree checkout dir — sessions cwd'd under (or exactly at) it are sub-orchestrators.
 *  Resolved at RUNTIME via os.homedir(): a hardcoded /root path breaks every
 *  non-root user (boundary checks below would never recognize their
 *  sub-orchestrator sessions). Matches the documented `~/.herdr/worktrees/` convention. */
const WORKTREE_DIR = join(homedir(), ".herdr", "worktrees");

/** Env var carrying the herdr workspace id of the current session's pane. */
const WORKSPACE_ID_ENV = "HERDR_WORKSPACE_ID";

/** Single `agent wait` iteration window (ms) — short, per clock-churn mitigation. */
const WAIT_SLICE_MS = 3_000;

/** Extra budget around a wait slice before we declare the CLI call itself hung. */
const WAIT_EXEC_BUDGET_MS = WAIT_SLICE_MS + 7_000;

/** Sleep between wait iterations (ms). */
const WAIT_SLEEP_MS = 1_000;

/** Statuses that count as "settled" for waitSettle(). */
const SETTLED: readonly AgentStatusName[] = ["idle", "done", "blocked"];

/** Statuses that count as "the agent actually started" for the start-up phase
 *  of waitSettle(): working/blocked/done. `done` also proves
 *  the prompt was consumed — a worker that starts AND finishes within one wait
 *  slice must NOT be misclassified neverStarted (R6 finding, live-reproduced
 *  by transport-contract T2.2e); done additionally means finished, so the
 *  settled phase is entered immediately. */
const STARTED: readonly AgentStatusName[] = ["working", "blocked", "done"];

// ---------------------------------------------------------------------------
// Internal mutation queue — one mutating herdr op in flight at a time
// ---------------------------------------------------------------------------

function isSubOrchestratorCwd(): boolean {
	// EXTERNAL_DEPENDENCY: process.cwd() compared against the fixed herdr
	// worktree placement root (~/.herdr/worktrees, homedir-resolved). A
	// session cwd'd there (or under it) is a sub-orchestrator (root/sub authority).
	const cwd = process.cwd();
	// Directory-boundary compare (Windows-path fix): was a raw
	// startsWith(`${WORKTREE_DIR}/`) — a backslash-shaped cwd on Windows never
	// matched. expaths.isDirUnder compares segment-wise on normalized keys
	// (case/separator-folded on win32; byte-identical on posix).
	return isDirUnder(cwd, WORKTREE_DIR);
}

// ============================================================================
// SECTION — herdr CLI implementation of the seam
// ============================================================================

export class HerdrTransport implements Transport {
	/** Tail of the serialized mutating-op chain. */
	private queueTail: Promise<unknown> = Promise.resolve();

	/** In-flight listStatuses de-dup guard (see listStatuses). */
	private listStatusesInFlight: Promise<AgentStatus[]> | null = null;

	/** Per-op deadline on the mutation queue (see enqueue). Generous headroom
	 *  over the CLI bound (CLI_TIMEOUT_MS 30s + SIGKILL_GRACE_MS 5s): it only
	 *  fires for a never-settling op shape, which the CLI transport can no
	 *  longer produce (W0 SIGKILL escalation) — this is defense-in-depth for
	 *  any future op source that can hang. */
	private static readonly QUEUE_OP_DEADLINE_MS = 45_000;

	/** Lazily-created herdr socket client (W3 read-only path); null when the
	 *  socket transport is disabled via env. */
	private socket: HerdrSocketClient | null | undefined;

	/** Injectable socket path for tests/stubs; undefined → env/default resolution. */
	private readonly socketPath: string | undefined;

	/** Per-op queue deadline (ms) — injectable for tests. */
	private readonly queueOpDeadlineMs: number;

	constructor(opts: { socketPath?: string; queueOpDeadlineMs?: number } = {}) {
		this.socketPath = opts.socketPath;
		this.queueOpDeadlineMs = opts.queueOpDeadlineMs ?? HerdrTransport.QUEUE_OP_DEADLINE_MS;
	}

	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		// BUG_FIX_CONTEXT (W2 pile-up guard, 2026-09-09 herdr incident follow-up):
		// symptom — the serialized-mutations chain is a plain promise chain, so a
		// NEVER-SETTLING op stalls every later mutating op forever (loop-freeze h3:
		// place()/startAgent() still pending at t+35s behind a hung op). Why the
		// plain chain did not work: `queueTail = run.catch(...)` keeps the chain
		// ALIVE after a rejection, but nothing bounds how long an op may run.
		// What was done: every enqueued op races against a one-shot deadline timer
		// (QUEUE_OP_DEADLINE_MS); on deadline the CALLER's promise rejects with a
		// structured E_TIMEOUT DelegateError while `queueTail` moves on — a hung op
		// can delay the queue by at most the deadline, never stall it forever.
		// The raced-away op itself may still settle later (its own caller has
		// already been released); with the W0 SIGKILL escalation the CLI transport
		// always settles, so a late settle cannot reorder real herdr mutations.
		let deadlineFired = false;
		let deadlineTimer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_, reject) => {
			deadlineTimer = setTimeout(() => {
				deadlineFired = true;
				reject(
					new DelegateErrorImpl(
						"E_TIMEOUT",
						`herdr mutating op stalled past the ${this.queueOpDeadlineMs}ms queue deadline`,
						"a herdr mutating op never settled and was raced off the mutation queue — retry the op; if this repeats, the transport op source is hung and needs investigation",
						undefined,
					),
				);
			}, this.queueOpDeadlineMs);
			(deadlineTimer as unknown as { unref?: () => void }).unref?.();
		});
		const run = this.queueTail.then(op, op);
		// Keep the chain alive regardless of op outcome — and let it PROCEED at the
		// deadline even when the op itself never settles (race settles first).
		const raced = Promise.race([run, deadline]) as Promise<T>;
		this.queueTail = raced.catch(() => undefined);
		// One-shot timer: cleared as soon as the op settles (normal path); a fired
		// deadline is a no-op to clear. Promise.race keeps BOTH inputs handled, so
		// neither a late op rejection nor a late deadline rejection is unhandled.
		run.then(
			() => clearTimeout(deadlineTimer),
			() => clearTimeout(deadlineTimer),
		);
		void deadlineFired; // reserved for future op-cancellation plumbing
		return raced;
	}

	capabilities(): TransportCapabilities {
		// Root/sub authority from the session cwd (see isSubOrchestratorCwd).
		// EXTERNAL_DEPENDENCY: process.cwd() vs the herdr worktree root
		// (~/.herdr/worktrees, homedir-resolved).
		const authority = isSubOrchestratorCwd() ? "sub" : "root";
		return { worktrees: authority === "root", authority };
	}

	/** Migration stage 3 (audit step 9): the adapter is the single source of
	 *  the active-backend name — must match the `backend:` spelling place()
	 *  writes into placements (lines below, both placement builders). */
	backendName(): string {
		return "herdr";
	}

	place(req: PlacementReq): Promise<Placement> {
		return this.enqueue(() => this.placeInner(req));
	}

	startAgent(req: StartReq): Promise<StartResult> {
		return this.enqueue(() => this.startAgentInner(req));
	}

	submitPrompt(req: PromptReq): Promise<void> {
		return this.enqueue(() => this.submitPromptInner(req));
	}

	teardown(req: TeardownReq): Promise<TeardownResult> {
		return this.enqueue(() => this.teardownInner(req));
	}

	// -- Read-only ops: not queued -------------------------------------------------

	/** W3: lazily-create the socket client for read-only ops. Returns null when
	 *  the socket transport is disabled via HERDR_SOCKET_TRANSPORT=cli. The
	 *  client is created ONCE per transport and reconnects transparently (the
	 *  server one-shots plain-request connections). */
	private socketForReadOnly(): HerdrSocketClient | null {
		if (this.socket === undefined) {
			const mode = process.env[HERDR_SOCKET_TRANSPORT_ENV] ?? "auto";
			this.socket = mode === "cli" ? null : new HerdrSocketClient({ socketPath: this.socketPath });
		}
		return this.socket;
	}

	/**
	 * FUNCTION_CONTRACT:
	 * Input: name — canonical agent name
	 * Output: AgentStatus, or null when herdr reports the agent unknown/not found
	 * Guarantees:
	 *   - read-only (not queued with mutations); safe to call any time
	 *   - "not found"-shaped failures → null (caller decides what that means):
		 *     socket path maps the structured not_found error code, CLI path the
		 *     legacy message regex — same null contract either way
	 * Raises:
	 *   - DelegateErrorImpl (E_STATUS) for any non-not-found herdr failure
	 * EXTERNAL_DEPENDENCY: herdr socket API `agent.get` (W3 read-only path;
	 *   zero subprocesses), falling back to the `herdr agent get <name>`
	 *   subprocess only when the socket transport is disabled via env.
	 */
	async getStatus(name: string): Promise<AgentStatus | null> {
		const sock = this.socketForReadOnly();
		if (sock) {
			try {
				const result = await sock.request("agent.get", { target: name });
				return agentStatusFromResult(result, name);
			} catch (err) {
				// Live-validated (herdr 0.8.2): the server's agent-not-found error code is
				// agent_not_found; not_found is the generic resource code — map both.
				const code = err instanceof HerdrSocketError ? err.code : "";
				if (code === "agent_not_found" || code === "not_found") return null;
				// Migration stage 1 (audit, errors-defect 1): a status-read failure is
				// its OWN taxonomy entry (E_STATUS), not a borrowed E_START — the code
				// names what failed, not where the throw site happens to sit.
				throw new DelegateErrorImpl(
					"E_STATUS",
					`herdr socket agent.get failed for ${name}: ${(err as Error).message}; worker may have exited`,
					"herdr socket status query failed for worker; worker may have exited — reconcile via `herdr agent list` before retrying.",
					err,
				);
			}
		}
		try {
			const { stdout } = await runHerdr(["agent", "get", name]);
			return agentStatusFromResult(parseHerdrResult(stdout).result, name);
		} catch (err) {
			if (isNotFound(err)) return null;
			// Migration stage 1: E_STATUS — same rationale as the socket path above.
			throw new DelegateErrorImpl(
				"E_STATUS",
				`herdr status query failed for ${name}: ${(err as Error).message}; worker may have exited`,
				"herdr status query failed for worker; worker may have exited — reconcile via `herdr agent list` before retrying.",
				err,
			);
		}
	}

	/**
	 * FUNCTION_CONTRACT:
	 * Input: none
	 * Output: every agent herdr currently knows (name, status, pane/workspace ids)
	 * Guarantees:
	 *   - read-only (not queued); tolerates both list shapes (bare array or
	 *     {agents:[...]}) and entries with missing fields (status "unknown")
	 *   - pile-up guard (W2, 2026-09-09 incident follow-up): while one call is
	 *     in flight, concurrent callers share its result instead of stacking a
	 *     second herdr call — the fleet UI tick (2 s) and the watcher tick (10 s)
	 *     overlap by design, and in a dead-herdr window every overlapping call
		 *     used to spawn one more hung CLI child (the incident's pile-up).
	 *     Calls in DISTINCT time windows each hit herdr (no memoization) and a
	 *     failure is shared as-is (caller degrades — buildWorkerView catches).
	 * Raises:
	 *   - DelegateErrorImpl (E_STATUS) when the herdr call fails
	 * EXTERNAL_DEPENDENCY: herdr socket API `agent.list` (W3 read-only path;
	 *   zero subprocesses) with no CLI fallback — an unreachable server is a
	 *   per-call error, never a spawn and never a hang.
	 */
	async listStatuses(): Promise<AgentStatus[]> {
		if (this.listStatusesInFlight) return this.listStatusesInFlight;
		const flight = this.listStatusesOnce().then(stripToSeamStatuses);
		this.listStatusesInFlight = flight;
		try {
			return await flight;
		} finally {
			if (this.listStatusesInFlight === flight) this.listStatusesInFlight = null;
		}
	}

	private async listStatusesOnce(): Promise<HerdrAgentStatus[]> {
		// W3 read-only path: NDJSON over the herdr unix socket — no subprocess, so
		// a frozen server costs a bounded per-call error instead of hung children.
		// Adapter-INTERNAL shape (HerdrAgentStatus carries the herdr ids the
		// drift guard needs); the public listStatuses() strips to the seam model.
		const sock = this.socketForReadOnly();
		if (sock) {
			try {
				const result = await sock.request("agent.list");
				const list = Array.isArray(result)
					? result
					: isRecord(result) && Array.isArray(result.agents)
						? result.agents
						: [];
				return list.filter(isRecord).map((a) => herdrStatusFromResult(a, String(a.name ?? "")));
			} catch (err) {
				// Migration stage 1: E_STATUS (was a borrowed E_START).
				throw new DelegateErrorImpl(
					"E_STATUS",
					`herdr socket agent.list failed: ${(err as Error).message}; worker statuses unavailable`,
					"herdr unreachable over the socket; worker statuses unavailable — reconcile via `herdr agent list`.",
					err,
				);
			}
		}
		// Socket transport disabled via env — legacy CLI path.
		try {
			const { stdout } = await runHerdr(["agent", "list"]);
			const { result } = parseHerdrResult(stdout);
			const list = Array.isArray(result)
				? result
				: isRecord(result) && Array.isArray(result.agents)
					? result.agents
					: [];
			return list.filter(isRecord).map((a) => herdrStatusFromResult(a, String(a.name ?? "")));
		} catch (err) {
			// Migration stage 1: E_STATUS (was a borrowed E_START).
			throw new DelegateErrorImpl(
				"E_STATUS",
				`herdr status query failed for agent list: ${(err as Error).message}; worker statuses unavailable`,
				"herdr status query failed; worker statuses unavailable — reconcile via `herdr agent list`.",
				err,
			);
		}
	}

	/**
	 * FUNCTION_CONTRACT:
	 * Input:
	 *   - name: canonical agent name; timeoutMs: total wait budget
	 *   - signal: abort detaches the WAIT (never the worker)
	 *   - onPoll: per-slice liveness callback (caller throttles; never throws)
	 *   - proofSettled: caller-owned out-of-band completion proof (the canonical
	 *     report file observed against THIS embodiment's witness — lifecycle.ts,
	 *     content not mtime / session reply) polled in the START-UP phase
	 *   - releaseOnStarted: v1.14 early release once the agent is observed working
	 * Output: SettleResult — the discriminated settle union (migration stage 3,
	 *   audit step 8 — the settle semantics live in the SEAM, the adapter only
	 *   classifies observations):
	 *   normal settle              → {kind:"settled", status};
	 *   never-started timeout      → {kind:"never-started", status:"unknown"};
	 *   aged finish / proof settle → {kind:"finished-before-watch", status:"idle"};
	 *   early release (v1.14)      → {kind:"started-confirmed", status:"working"};
	 *   abort                      → {kind:"detached", status:<last known>};
	 *   budget elapsed after start → {kind:"timeout", status:<last observed>}.
	 * Guarantees:
	 *   - two-phase state machine (START-UP → SETTLED) against the
	 *     settle-before-start race (BUG_FIX_CONTEXT below)
	 *   - abort → immediate return with the last known status, worker untouched
	 *   - a throwing proofSettled counts as "not proven", never blocks the wait
	 * Raises:
	 *   - never for herdr slice hiccups (reconciled via getStatus inside the loop)
	 * EXTERNAL_DEPENDENCY: `herdr agent wait/get` subprocesses (via runHerdr);
	 *   the worker's session JSONL (aged-finish proof, via sessionHasReply).
	 */
	async waitSettle(req: {
		name: string;
		timeoutMs: number;
		signal?: AbortSignal;
		onPoll?: (info: { status: AgentStatusName; started: boolean; elapsedMs: number }) => void;
		/** v1.9: out-of-band settled-proof (the report file observed against the
		 *  caller's embodiment witness — content, not mtime / session reply). */
		proofSettled?: () => Promise<boolean>;
		/** v1.14 (watch.releaseOn=started): release as soon as the agent is
		 *  observed working — the orchestrator hands off to the watcher (§21)
		 *  instead of blocking the rest of the settle gate. Never set for probes. */
		releaseOnStarted?: boolean;
	}): Promise<SettleResult> {
		// BUG_FIX_CONTEXT (D3) — two-phase state machine against
		// the settle-before-start race: the first `agent wait --until idle…` slice
		// can match BEFORE the prompt is consumed (agent still idle) → instant
		// false settle (field report: six fan-out workers all "settled idle" at
		// the same second, then worked for hours). Symptom: workers reported
		// settled the moment they were still idle pre-prompt. Why the old single
		// phase did not work: it treated any idle/wait match as a settle. What was
		// done: a START-UP phase that only accepts working/blocked/done as proof
		// of life before the SETTLED phase may accept idle/done/blocked.
		//
		// Phase START-UP (before the first working/blocked/done observation): only
		// those prove the prompt was consumed; idle/unknown slices keep polling. If
		// the whole timeoutMs elapses without ever observing one of them →
		// {status:"unknown", timedOut:true, neverStarted:true}.
		// Phase SETTLED (after the first such observation): current behavior —
		// idle/done/blocked settle; slices + reconcile; abort → detach.
		//
		// BUG_FIX_CONTEXT (v1.8) — the aged-finish blind spot
		// (live-reproduced; full record: git history — the CHANGELOG starts
		// at v1.11.0, so this fix predates it): herdr ages done→idle within
		// minutes, so a watcher that attaches late — fast flash probes,
		// abort/detach recovery, slow start — can NEVER observe working/done and
		// spins the FULL timeout against a visibly finished worker, then
		// false-reports neverStarted. Why the two-phase fix alone did not work:
		// it still required observing working/blocked/done. What was done: an
		// unexplained idle is checked against the session JSONL — an assistant
		// reply proves the prompt was consumed → settle as finishedBeforeWatch
		// (success, not failure). No reply → never started.
		const startedAt = Date.now();
		const deadline = startedAt + req.timeoutMs;
		let last: AgentStatusName = "unknown";
		let started = false;
		let sessionPath: string | undefined;
		let sessionLookupDone = false;
		while (Date.now() < deadline) {
			if (req.signal?.aborted) {
				// Abort detaches the wait, never the worker.
				const s = await this.getStatus(req.name).catch(() => null);
				return { kind: "detached", status: s?.status ?? last };
			}
			let status: AgentStatusName | undefined;
			try {
				const { stdout } = await runHerdr(
					["agent", "wait", req.name, "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(WAIT_SLICE_MS)],
					WAIT_EXEC_BUDGET_MS,
				);
				const { result } = parseHerdrResult(stdout);
				status = statusFromResult(result);
			} catch {
				// Slice timed out or CLI hiccup — reconcile via a direct status read.
			}
			if (!status) {
				const s = await this.getStatus(req.name).catch(() => null);
				status = s?.status;
			}
			if (status) last = status;
			if (status && STARTED.includes(status)) started = true;
			// v1.8/v1.9: the start-up gate can never open when herdr never reports
			// working/blocked/done for the worker. Two live shapes: herdr ages
			// done→idle within minutes (§19.1b), and current builds never report
			// working for pi workers at all — field 2026-09-05 (m03-search-
			// investigation): three finished fan-out workers (reports on disk) kept
			// their watchers spinning the FULL budget at status=idle/unknown, then
			// false-reported neverStarted. Prove life out-of-band instead:
			//   1. caller-owned completion proof (v1.9, §19.1c) — the report file for
			//      THIS run observed against the embodiment witness (content, not
			//      mtime; migration stage 3, audit step 8) is the completion criterion
			//      (tool contract); the proof is authoritative and exact per worker.
			//   2. session-reply proof (v1.8, §19.1b) — an assistant message in the
			//      worker's session JSONL proves the prompt was consumed.
			// Only reached while started is still false, so a healthy wait never
			// pays for the extra checks.
			if (!started && (status === undefined || !STARTED.includes(status))) {
				if (req.proofSettled) {
					let proven = false;
					try {
						proven = await req.proofSettled();
					} catch {
						proven = false; // a throwing proof never blocks the wait
					}
					if (proven) {
						req.onPoll?.({ status: status ?? "idle", started: true, elapsedMs: Date.now() - startedAt });
						return { kind: "finished-before-watch", status: "idle" };
					}
				}
				if (sessionLookupDone === false) {
					// Resolve once per wait: negative results are stable per herdr build
					// (no agent_session in the result shape), positives are immutable.
					sessionLookupDone = true;
					sessionPath = await this.resolveSessionPath(req.name).catch(() => undefined);
				}
				if (sessionPath && sessionHasReply(sessionPath)) {
					req.onPoll?.({ status: status ?? "idle", started: true, elapsedMs: Date.now() - startedAt });
					return { kind: "finished-before-watch", status: "idle" };
				}
			}
			req.onPoll?.({ status: status ?? "unknown", started, elapsedMs: Date.now() - startedAt });
			if (started && status && SETTLED.includes(status)) return { kind: "settled", status };
			// v1.14 (watch.releaseOn=started): the worker is proven started and
			// actively working — a spawn failure (E_PLACE/E_START/E_NAME) is ruled
			// out, so blocking the rest of the settle gate buys nothing (§21: the
			// watcher owns the wait). Release the orchestrator immediately. Fast
			// finishes are still caught synchronously by the settled check above:
			// a worker that settles before the first working observation (within
			// one wait slice) returns its report inline as before.
			if (req.releaseOnStarted && started && status === "working") {
				return { kind: "started-confirmed", status };
			}
			await sleep(WAIT_SLEEP_MS);
		}
		if (!started) {
			// Never observed working/blocked/done since submission — the prompt was
			// likely never consumed; a settle here would be the false-settle bug.
			// (v1.8: an already-finished worker was ruled out above by the session
			// reply proof, so never-started here is honest.)
			return { kind: "never-started", status: "unknown" };
		}
		return { kind: "timeout", status: last };
	}

	/** v1.8: resolve the agent's session JSONL path from `herdr agent get`
	 *  (result.agent.agent_session.value). Undefined when herdr doesn't expose
	 *  it — callers then fall back to the pre-v1.8 behavior.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: name — canonical agent name
	 * Output: the session JSONL path, or undefined when herdr exposes none
	 * Guarantees:
	 *   - tolerant path extraction (multiple result shapes via pick())
	 * Raises:
	 *   - propagates runHerdr errors (caller catches)
	 * EXTERNAL_DEPENDENCY: `herdr agent get <name>` subprocess — the
	 *   agent.agent_session.value field this herdr build may or may not carry.
	 */
	private async resolveSessionPath(name: string): Promise<string | undefined> {
		const { stdout } = await runHerdr(["agent", "get", name]);
		const { result } = parseHerdrResult(stdout);
		return isRecord(result) ? asString(pick(result, "agent.agent_session.value", "agent_session.value")) : undefined;
	}

	/** Recent console output for a worker (terminal snapshot, few hundred lines tail).
	 *  Optional: probe-verdict from streaming; implementations without console
	 *  readback may reject — callers must fall back to status-based verdicts.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: name — canonical agent name; opts.maxChars — tail size (default 4000)
	 * Output: the LAST maxChars characters of the console's recent output
	 * Guarantees:
	 *   - read-only (not queued with mutations)
	 * Raises:
	 *   - raw subprocess errors propagate (callers treat as readback-unavailable)
	 * EXTERNAL_DEPENDENCY: `herdr agent read <name> --source recent` subprocess.
	 */
	async readConsole(name: string, opts?: { maxChars?: number }): Promise<string> {
		// Read-only: terminal snapshot (recent), NOT queued with mutations.
		const { stdout } = await runHerdr(["agent", "read", name, "--source", "recent"]);
		const out = String(stdout ?? "");
		const max = opts?.maxChars ?? 4000;
		return out.length > max ? out.slice(out.length - max) : out;
	}

	// -- Mutating op bodies (run serialized via enqueue) ----------------------------


	/**
	 * FUNCTION_CONTRACT:
	 * Input: PlacementReq — mode worktree|tab, repoPath, branch (worktree),
	 *   label, optional base ref
	 * Output: Placement (kind, workspaceId, paneId, checkoutPath, branch,
	 *   isLinkedWorktree) extracted from the herdr result
	 * Guarantees:
	 *   - worktree placement is ROOT-only (sub-orchestrator → E_PLACE)
	 *   - shared placement requires a current herdr workspace (env var below)
	 *   - runs serialized on the mutation queue (enqueue)
	 * Raises:
	 *   - DelegateErrorImpl E_PLACE for every failure shape (CLI error,
	 *     sub-orchestrator rejection, missing env var, unparseable output,
	 *     missing workspace/pane ids)
	 * EXTERNAL_DEPENDENCY: `herdr worktree create` / `herdr tab create`
	 *   subprocesses; process.env.HERDR_WORKSPACE_ID — the session's own herdr
	 *   workspace id, REQUIRED for shared placement (herdr tabs open on the
	 *   session's workspace; absent → E_PLACE).
	 */
	private async placeInner(req: PlacementReq): Promise<Placement> {
		const { authority } = this.capabilities();

		if (req.mode === "worktree") {
			if (authority !== "root") {
				throw delegateError(
					"E_PLACE",
					`Worktree placement rejected: this session is a sub-orchestrator (cwd under ${WORKTREE_DIR}/).`,
				);
			}
			const args = [
				"worktree", "create",
				"--cwd", req.repoPath,
				"--branch", req.branch,
				"--label", req.label,
				"--no-focus",
			];
			if (req.base) args.push("--base", req.base);
			try {
				const { stdout } = await runHerdr(args);
				return placementFromWorktreeResult(parseHerdrResult(stdout).result, req, stdout);
			} catch (err) {
				throw delegateError(
					"E_PLACE",
					`herdr worktree create failed: ${(err as Error).message}`,
					err,
				);
			}
		}

		// EXTERNAL_DEPENDENCY: HERDR_WORKSPACE_ID env var (herdr sets it in every
		// pane session) — identifies the workspace the tab is opened on.
		// mode === "tab": open a tab in the CURRENT session workspace.
		const workspaceId = process.env[WORKSPACE_ID_ENV];
		if (!workspaceId) {
			throw delegateError(
				"E_PLACE",
				`Shared placement requires a current herdr workspace: set ${WORKSPACE_ID_ENV} in the session environment (herdr tabs are opened on the session's own workspace).`,
			);
		}
		try {
			const { stdout } = await runHerdr(["tab", "create", "--workspace", workspaceId, "--label", req.label]);
			return placementFromTabResult(parseHerdrResult(stdout).result, workspaceId, stdout);
		} catch (err) {
			throw delegateError(
				"E_PLACE",
				`herdr tab create failed: ${(err as Error).message}`,
				err,
			);
		}
	}

	/**
	 * Starts one pi worker agent in the requested pane via the herdr CLI.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: req — StartReq (worker name, paneId, timeoutMs, provider/model/
	 *   thinking flags, optional extraArgs passed through after "--", optional
	 *   env applied to the `herdr agent start` CLI subprocess — issue #25)
	 * Output: StartResult — the canonical agent name (extractAgentName) plus
	 *   sessionPath when herdr reports agent.agent_session.value
	 * Guarantees:
	 *   - CLI args are built in herdr's `agent start` shape (--kind pi --pane
	 *     --timeout -- <provider/model/thinking + extraArgs>)
	 *   - BOTH name-taken failure shapes (structured `agent_name_taken` and
	 *     plain text "name taken by a live agent (candidates: …)", matched
	 *     case-insensitively) map to E_NAME with the candidate list carried
	 *     into the message
	 * Raises:
	 *   - DelegateErrorImpl E_NAME when the requested name is taken by a live
	 *     agent (either failure shape)
	 *   - DelegateError E_START for any other herdr failure (CLI error,
	 *     unparseable output)
	 */
	private async startAgentInner(req: StartReq): Promise<StartResult> {
		// Workerhost inversion (design §3): StartReq is keyed by the opaque
		// placementRef — the adapter decodes its own ref to the herdr pane id.
		// Legacy raw pane ids (no `herdr:pane:` prefix) decode via the fallback
		// in paneFromHerdrRef, so pre-ref records keep starting.
		const paneId = paneFromHerdrRef(req.placementRef);
		if (!paneId) {
			throw delegateError(
				"E_START",
				`herdr agent start ${req.name}: undecodable placementRef ${JSON.stringify(req.placementRef)}`,
			);
		}
		const args = [
			"agent", "start", req.name,
			"--kind", "pi",
			"--pane", paneId,
			"--timeout", String(req.timeoutMs),
			"--",
			"--provider", req.provider,
			"--model", req.model,
			"--thinking", req.thinking,
			...(req.extraArgs ?? []),
		];
		try {
			// Issue #25 / §4.1.1: the spawn flow's swarm identity env (SWARM_TASK /
			// SWARM_WORKER / SWARM_SCHEMA_DIR) is applied to the `herdr agent start`
			// CLI subprocess. KNOWN GAP (documented, Law 2): herdr's agent-start path
			// types the canonical executable into an EXISTING pane at its shell
			// prompt — the pane's environment is the herdr server's, so this build
			// does NOT guarantee the CLI process env reaches the worker. The rpc
			// backend (direct child spawn) delivers it exactly; herdr workers whose
			// pane env lacks the identity still see the brief's explicit path and the
			// prompt's documented raw-file fallback.
			const { stdout } = await runHerdr(
				args,
				undefined,
				undefined,
				req.env ? { ...process.env, ...req.env } : undefined,
			);
			const { result } = parseHerdrResult(stdout);
			return {
				name: extractAgentName(result, req.name),
				sessionPath: isRecord(result) ? asString(pick(result, "agent.agent_session.value")) : undefined,
			};
		} catch (err) {
			const msg = (err as Error).message ?? "";
			// BUG_FIX_CONTEXT (D4): this herdr build does NOT
			// auto-uniquify. Two failure shapes say the same fact — structured
			// `agent_name_taken` and plain text "…<name>: name taken by a live agent
			// (candidates: …)". Symptom: the plain-text shape surfaced as a generic
			// E_START, sending the orchestrator down a wrong retry path. Why the old
			// mapping did not work: it matched only the structured token. What was
			// done: match BOTH (case-insensitive) and map to E_NAME with the same
			// candidate-list guidance.
			if (/agent_name_taken/i.test(msg) || /name taken by a live agent/i.test(msg)) {
				const candidates = /candidat\w*\s*[:=]?\s*([^\n]+)/i.exec(msg)?.[1]?.trim() ?? "unknown";
				// Migration stage 1 (errors-defect 2): the guidance BASE TEXT is the
				// seam dictionary's (GUIDANCE.E_NAME via delegateErrorWithDetail) —
				// the adapter appends only the backend FACT (the candidate list).
				throw delegateErrorWithDetail(
					"E_NAME",
					`herdr agent start ${req.name}: name taken by a live agent (candidates: ${candidates})`,
					`candidates: ${candidates}`,
					err,
				);
			}
			throw delegateError(
				"E_START",
				`herdr agent start ${req.name} failed: ${msg}`,
				err,
			);
		}
	}

	/**
	 * Submits one prompt to a running agent via the herdr CLI. No --wait:
	 * submit-and-return fast; settle observation is waitSettle()'s job.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: req — PromptReq (agent name, prompt text); req.timeoutMs bounds
	 *   the submit call itself
	 * Output: resolves when herdr accepts the prompt (fire-and-forget
	 *   submission, no settle proof)
	 * Guarantees:
	 *   - every failure shape on this path (agent_prompt_stalled, blocked,
	 *     submit timeout, other herdr errors) maps to the SAME E_PROMPT_STALLED
	 *     code, each with its own message
	 * Raises:
	 *   - DelegateError E_PROMPT_STALLED for a stalled agent, a blocked agent,
	 *     or the submit timeout / any other herdr failure
	 */
	private async submitPromptInner(req: PromptReq): Promise<void> {
		try {
			// No --wait: submit and return fast; settle observation is waitSettle()'s job.
			await runHerdr(["agent", "prompt", req.name, req.text], req.timeoutMs);
		} catch (err) {
			const msg = (err as Error).message ?? "";
			// herdr reports agent_prompt_stalled when no state change is observed
			// within 5s of submission from a non-working state — map explicitly.
			if (/agent_prompt_stalled/i.test(msg)) {
				throw delegateError(
					"E_PROMPT_STALLED",
					`herdr agent prompt ${req.name}: prompt stalled (no state change within 5s)`,
					err,
				);
			}
			if (/agent_blocked|blocked/i.test(msg)) {
				throw delegateError("E_PROMPT_STALLED", `herdr agent prompt ${req.name}: agent blocked`, err);
			}
			// Fallback: the 30s submit timeout itself → same stall code.
			throw delegateError("E_PROMPT_STALLED", `herdr agent prompt ${req.name} failed: ${msg}`, err);
		}
	}

	/**
	 * FUNCTION_CONTRACT:
	 * Input: TeardownReq — name, placement, force (worktree removal flag)
	 * Output: TeardownResult — alreadyGone: true when the placement was ALREADY
	 *   gone (idempotent no-op), false when this call closed something
	 * Guarantees:
	 *   - worktree teardown is ROOT-only (sub-orchestrator → E_PLACE): a
	 *     sub-orchestrator enumerating globally-scanned manifests must never be
	 *     able to remove a root orchestrator's worktrees
	 *   - not_linked_worktree removal errors are tolerated and reconciled via
	 *     closeWorkspaceIfPresent
	 *   - migration stage 1 (extensibility-defect 1): not-found-shaped failures
	 *     (worktree removal OR tab close) resolve with { alreadyGone: true } —
	 *     the structured "already gone" signal; callers read the FIELD, never
	 *     the message text (the old unsynchronized isAlreadyGone regexes at
	 *     every call site are gone)
	 * Raises:
	 *   - DelegateErrorImpl E_TEARDOWN for CLI failures / surviving workspaces /
	 *     failed tab close that is NOT not-found-shaped
	 *   - DelegateErrorImpl E_PLACE for the authority rejection (policy guard,
	 *     mirrors placeInner)
	 * EXTERNAL_DEPENDENCY: `herdr worktree remove`, `herdr workspace list/close`,
	 *   `herdr tab close` subprocesses.
	 */
	private async teardownInner(req: TeardownReq): Promise<TeardownResult> {
		const p = req.placement as Placement & { tabId?: string };

		// Authority guard (mirrors placeInner): worktree teardown is root-only.
		// A sub-orchestrator enumerating globally-scanned manifests must never be
		// able to remove a root orchestrator's worktrees.
		if (req.placement.kind === "worktree" && this.capabilities().authority === "sub") {
			throw new DelegateErrorImpl(
				"E_PLACE",
				`Worktree teardown rejected: this session is a sub-orchestrator (cwd under ${WORKTREE_DIR}/).`,
				"sub-orchestrators cannot remove worktrees — worktree teardown is root-only; close your own tabs instead",
			);
		}

		if (req.placement.kind === "worktree") {
			const workspaceId = req.placement.workspaceId;
			// placementRef-only end state (Law 4, Wave 4): legacy herdr ids are now
			// OPTIONAL on the seam type. This adapter always stamps workspaceId on
			// the placements IT creates, so an absent id means the placement did not
			// come from this adapter — there is no herdr workspace to remove, and
			// the teardown contract ("already-gone → idempotent no-op") applies.
			if (!workspaceId) return { alreadyGone: true };
			try {
				const args = ["worktree", "remove", "--workspace", workspaceId];
				if (req.force !== false) args.push("--force");
				await runHerdr(args);
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (/not_linked_worktree/i.test(msg)) {
					// Orphaned/not-linked workspace — handled by the reconcile below.
				} else if (/not[\s_-]?found/i.test(msg)) {
					// BUG_FIX_CONTEXT (parity pin, workerhost impl 2026-09-10): the seam
					// contract is "teardown of an already-gone placement → idempotent
					// no-op success" (pinned by the fake and the host-parity-check P3).
					// Symptom: the SECOND worktree teardown failed E_PLACE with herdr's
					// `workspace_not_found` — only the tab path was idempotent. Why the
					// old guard did not work: it tolerated only not_linked_worktree.
					// What was done: not-found-shaped removal errors are a no-op success
					// too; migration stage 1 additionally reports it STRUCTURED
					// (alreadyGone: true) so callers no longer regex the message text.
					return { alreadyGone: true };
				} else {
					// Migration stage 1 (audit, errors-defect 1): teardown-operation
					// failures are E_TEARDOWN, not a borrowed E_PLACE. The authority
					// guard ABOVE stays E_PLACE — a policy rejection, symmetric with
					// place()'s guard, not a failed close operation.
					throw delegateError(
						"E_TEARDOWN",
						`herdr worktree remove failed for workspace ${workspaceId}: ${msg}`,
						err,
					);
				}
			}
			// Reconcile (O2): removing the worktree while the worker agent is live
			// can leave a non-linked workspace shell that only `workspace close`
			// removes — verify against `workspace list`, close if still present,
			// and re-verify before reporting success.
			await this.closeWorkspaceIfPresent(workspaceId);
			return { alreadyGone: false };
		}

		// kind === "tab"
		// herdr drift guard: manifests written while placementFromTabResult fell
		// back to the pane id carry tabId === paneId — closing that id always
		// fails tab_not_found while the agent (and its REAL tab) stays alive. The
		// fallback masked this as an idempotent retire (F6 follow-up, 2026-09-10
		// implement-osb field report). Resolve the live tab id from the herdr
		// agent registry when the recorded one carries the broken signature.
		const recordedTabId = p.tabId ?? req.placement.paneId;
		let tabId = recordedTabId;
		if (recordedTabId === req.placement.paneId) {
			const live = await this.resolveLiveTabId(req.name);
			if (live !== null && live !== recordedTabId) {
				tabId = live; // manifest recorded a pane id — close the REAL tab
			}
		}
		// placementRef-only end state (Law 4, Wave 4): legacy herdr ids are now
		// OPTIONAL on the seam type. This adapter always stamps paneId/tabId on
		// the placements IT creates; an absent id means the placement did not
		// come from this adapter — nothing herdr-side to close, and the teardown
		// contract ("already-gone → idempotent no-op") applies. Symmetric with
		// the worktree branch above.
		if (!tabId) return { alreadyGone: true };
		try {
			await runHerdr(["tab", "close", tabId]);
		} catch (err) {
			const msg = (err as Error).message ?? "";
			// Migration stage 1 (extensibility-defect 1): the tab branch used to
			// THROW on not-found (only the worktree branch was idempotent) and the
			// tool layer re-parsed the message text at every call site. Now: a
			// not-found-shaped close is the structured alreadyGone signal — the
			// placement is verifiably absent, an idempotent no-op, not an error.
			if (/not[\s_-]?found/i.test(msg)) return { alreadyGone: true };
			// Genuine close failure → E_TEARDOWN (was a borrowed E_PLACE; fixed in
			// the error-taxonomy cleanup step).
			throw delegateError(
				"E_TEARDOWN",
				`herdr tab close ${tabId} failed: ${msg}`,
				err,
			);
		}
		return { alreadyGone: false };
	}

	/** Resolve the LIVE herdr tab id for a named agent (herdr drift guard):
	 *  the `agent list` registry entry carries the real tab_id even when the
	 *  manifest's recorded placement fell back to a pane id. Read-only socket
	 *  path first (non-queued by contract), CLI fallback; null when the agent
	 *  is gone (the caller then closes the recorded id and lets the not-found
	 *  → idempotent semantics handle it).
	 * <p>
	 * EXTERNAL_DEPENDENCY: herdr socket (HERDR_SOCK env) / `herdr agent list`
	 * subprocess.
	 */
	private async resolveLiveTabId(name: string): Promise<string | null> {
		if (this.socketForReadOnly()) {
			try {
				const statuses = await this.listStatusesOnce(); // adapter-internal shape (tab id needed)
				return statuses.find((s) => s.name === name)?.tabId ?? null;
			} catch {
				return null; // statuses unavailable — fall through to the recorded id
			}
		}
		try {
			const { stdout } = await runHerdr(["agent", "list"]);
			const { result } = parseHerdrResult(stdout);
			const list = Array.isArray(result)
				? result
				: isRecord(result) && Array.isArray(result.agents)
					? result.agents
					: [];
			const entry = list.find(
				(a) => isRecord(a) && String((a as Record<string, unknown>).name ?? (a as Record<string, unknown>).agent_name ?? "") === name,
			);
			return entry ? (asString(pick(entry, "tab_id", "tabId")) ?? null) : null;
		} catch {
			return null; // registry unreachable — fall through to the recorded id
		}
	}

	/** Reconcile a workspace that survived removal (any shape, incl. not_linked shells).
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: workspaceId — the herdr workspace that should be gone
	 * Output: resolves when the workspace is verifiably absent
	 * Guarantees:
	 *   - no-op when the workspace does not exist
	 * Raises:
	 *   - DelegateErrorImpl E_TEARDOWN when the close fails or the workspace
	 *     survives a successful close (caller must reconcile manually)
	 * EXTERNAL_DEPENDENCY: `herdr workspace list` / `herdr workspace close`
	 *   subprocesses.
	 */
	private async closeWorkspaceIfPresent(workspaceId: string): Promise<void> {
		if (!(await this.workspaceExists(workspaceId))) return;
		try {
			await runHerdr(["workspace", "close", workspaceId]);
		} catch (err) {
			// Migration stage 1: E_TEARDOWN (was a borrowed E_PLACE).
			throw delegateError(
				"E_TEARDOWN",
				`herdr workspace close ${workspaceId} failed after worktree remove: ${(err as Error).message}`,
				err,
			);
		}
		if (await this.workspaceExists(workspaceId)) {
			// Migration stage 1: E_TEARDOWN (was a borrowed E_PLACE).
			throw delegateError(
				"E_TEARDOWN",
				`workspace ${workspaceId} still present after herdr workspace close — reconcile via herdr workspace list`,
			);
		}
	}

	private async workspaceExists(workspaceId: string): Promise<boolean> {
		// EXTERNAL_DEPENDENCY: `herdr workspace list` subprocess.
		const { stdout } = await runHerdr(["workspace", "list"]);
		const { result } = parseHerdrResult(stdout);
		const list = Array.isArray(result)
			? result
			: isRecord(result) && Array.isArray(result.workspaces)
				? result.workspaces
				: [];
		return list.some(
			(w) => isRecord(w) && (w.workspace_id === workspaceId || w.id === workspaceId),
		);
	}
}

function isNotFound(err: unknown): boolean {
	return /not found|no such|unknown agent/i.test((err as Error).message ?? "");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default transport instance for the extension entry point. */
export function createHerdrTransport(): Transport {
	return new HerdrTransport();
}
