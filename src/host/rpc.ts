/**
 * pi-delegate — src/host/rpc.ts (the `pi --mode rpc` backend adapter, PoC).
 *
 * MODULE_CONTRACT — a WorkerHost adapter that runs workers as headless
 * `pi --mode rpc` child processes of the orchestrator, removing the herdr
 * dependency entirely. Implements the Transport seam from src/host.ts:
 *
 *   place()       — worktree: plain `git worktree add` under
 *                   getAgentDir()/worktrees/<repo>-wt-<n>; shared placement
 *                   (wire mode "tab"): the caller's checkout, no isolation.
 *   startAgent()  — spawns `pi --mode rpc --provider P --model M --thinking T
 *                   --name <worker>` with cwd = the placement's checkoutPath
 *                   and, when the caller passes StartReq.env (issue #25:
 *                   SWARM_TASK / SWARM_WORKER / SWARM_SCHEMA_DIR), that env
 *                   merged over the orchestrator's;
 *                   captures the worker's session JSONL path via get_state
 *                   (StartResult.sessionPath — the budget gauges' input).
 *   submitPrompt()— writes {"type":"prompt"} over stdin; when the agent is
 *                   mid-stream, retries with streamingBehavior:"steer"
 *                   (mirrors herdr's prompt-into-console semantics).
 *   waitSettle()  — EVENT-DRIVEN, zero subprocesses: the `agent_settled`
 *                   stdout event is the settle proof. Strictly stronger than
 *                   herdr's status polling — pi's rpc protocol reports
 *                   "fully settled (no retry/compaction/queued continuation
 *                   remains)" directly, so the herdr-era §19.1b/§19.1c sensor
 *                   gaps (herdr builds never report "working" for pi workers;
 *                   done ages into idle) cannot occur on this backend. Full
 *                   seam contract honored: onPoll heartbeat,
 *                   abort-detaches-never-kills, proofSettled,
 *                   releaseOnStarted, settled-epoch keying.
 *   getStatus()   — mapped from tracked events: agent active (agent_start
 *                   seen, not yet settled) → "working", extension-UI dialog
 *                   pending → "blocked", settled → "idle", child exited →
 *                   "done", nothing observed yet → "unknown".
 *   readConsole()    — assembled from captured rpc output: assistant text +
 *                   recent tool calls + UI requests (bounded tail). Serves
 *                   the probe verdict ("OUTPUT: OK" readback).
 *   streamConsole() — OPTIONAL seam method, IMPLEMENTED here (the herdr
 *                   adapter does not have it — callers probe with
 *                   `typeof …streamConsole === "function"` and degrade to
 *                   readConsole polling). The stdout pump (single writer)
 *                   mirrors every parsed rpc record into the per-host
 *                   FidelityStore (src/stream-seam/) as one ConsoleEvent —
 *                   full-fidelity drop-oldest ring capped at STREAM_RING_CAP
 *                   events per worker; historical replay via afterSeq, a
 *                   truncated backlog opens with a gap marker, the
 *                   readConsole last-maxChars snapshot stays the fallback
 *                   beyond the retained window. The iteration stays open
 *                   while the worker lives (a settled worker may still be
 *                   prompted) and ENDS once the child process exits and the
 *                   backlog has drained — the exit handler closes the store
 *                   subscriptions. Zero new data sources.
 *   answerDialog()  — dialog-relay mode ONLY: answers a relayed extension-UI
 *                   dialog via the existing extension_ui_response stdin path
 *                   (adapter-level method — not on the Transport seam).
 *   teardown()    — abort over the child's stdin, then SIGKILL after a grace
 *                   period if the child has not exited on its own; `git
 *                   worktree remove` for worktree placements; idempotent
 *                   (alreadyGone); releases the worker's console ring.
 *
 * RPC protocol notes (verified empirically against pi 0.85.1):
 *   - JSONL framing: records split on LF only, optional trailing CR stripped
 *     (pi docs/rpc.md — generic line readers are non-compliant).
 *   - Responses correlate to commands via the optional `id` field.
 *   - extension_ui_request DIALOGS (select/confirm/input/editor) BLOCK the
 *     agent until a matching extension_ui_response arrives. DEFAULT (the
 *     `dialogRelay` option absent/false): this adapter auto-cancels them
 *     (worker sees undefined/false, same as an Esc) so a headless worker can
 *     never deadlock on a prompt no human will answer. With
 *     `dialogRelay: true` the dialog offer is relayed onto the console
 *     stream (kind "dialog") and stays pending — the consumer answers via
 *     answerDialog(); the auto-cancel write is skipped entirely.
 *   - extension_ui_request fire-and-forget methods (notify/setWidget/…) are
 *     ignored (they are advisory UI state); with dialogRelay on they are
 *     additionally mirrored onto the stream (kind "ui").
 *
 * KNOWN GAP (documented, deliberate PoC scope): rpc workers are children of
 * the orchestrator's pi process. After the orchestrator process exits, the
 * children keep RUNNING (they finish their task and write reports/mailbox
 * files to disk — file-based signals still work), but their stdin is
 * unreachable, so a LATER session cannot nudge them (mailbox answers degrade
 * to guidance-only delivery, exactly the existing nudge-failed path). Reattach
 * via a named-pipe shim is future work, not this adapter.
 *
 * Platform: POSIX-only for now — the adapter spawns a bare `pi` and carries
 * no Windows shim (unlike the herdr adapter's spawnPolicyCommand).
 *
 * Dependencies: node builtins + getAgentDir() from the platform package
 * (Law 1 — no hardcoded .pi/agent joins). Imports the seam (../host.ts)
 * and NOTHING else from src/ — the adapter must never import tool modules.
 */

import { spawn, execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	delegateError,
	delegateErrorWithDetail,
	type AgentStatus,
	type AgentStatusName,
	type ConsoleEvent,
	type ConsoleEventKind,
	type Placement,
	type PlacementReq,
	type PromptReq,
	type SettleResult,
	type StartReq,
	type StartResult,
	type TeardownReq,
	type TeardownResult,
	type Transport,
	type TransportCapabilities,
} from "../host.ts";
import { FidelityStore, DEFAULT_RING_CAP } from "../stream-seam/fidelity-store.ts";
import { RpcJsonlParser, type RpcJsonlRecord } from "./rpc-jsonl.ts";
import { isDirUnder } from "../expaths.ts";

const execFileP = promisify(execFile);

/** Child-process factory type — the test seam. The default is node's real
 *  `spawn`; the deterministic unit check injects a fake. Declared as a plain
 *  single-signature type (not `typeof spawn`, whose overloads fight
 *  assignability) — the call sites pass exactly these three arguments. */
type SpawnProcessFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Settled statuses per the seam contract (waitSettle resolution set). */
const STARTED: readonly AgentStatusName[] = ["working", "blocked", "done"];

/** Poll slice for the waitSettle heartbeat / state re-read (ms). */
const POLL_MS = 250;
/** Grace between SIGTERM and SIGKILL on teardown (ms). */
const KILL_GRACE_MS = 3000;
/** Ring-buffer cap for the readConsole activity log (lines). */
const CONSOLE_LOG_MAX_LINES = 200;

/** Per-worker ring cap for the streamConsole fidelity store (events) —
 *  the prototype-measured bound: ~4.6 MB/worker at realistic payload sizes,
 *  ~11 min of live coverage at 30 events/s/worker (stream-seam contract). */
const STREAM_RING_CAP = DEFAULT_RING_CAP;

/** The slice of the FidelityStore the pure reducer writes through — keeping
 *  it an optional field on RpcAgentState leaves applyRpcEvent fully drivable
 *  without a store (the deterministic unit check's direct pure-unit drives). */
export interface ConsoleSink {
	append(workerName: string, kind: ConsoleEventKind, payload: string): void;
}

/** rpc record type → ConsoleEvent kind. Unlisted types (command responses,
 *  anything unrecognized) mirror as "raw" — verbatim fidelity beats guessing. */
const RPC_RECORD_KINDS: Record<string, ConsoleEventKind> = {
	agent_start: "agent_start",
	agent_end: "agent_end",
	agent_settled: "agent_settled",
	message_start: "message_start",
	message_update: "message_update",
	message_end: "message_end",
	toolcall_start: "toolcall_start",
	toolcall_update: "toolcall_update",
	toolcall_end: "toolcall_end",
	tool_execution_start: "tool_execution_start",
	tool_execution_update: "tool_execution_update",
	tool_execution_end: "tool_execution_end",
	queue_update: "queue_update",
	extension_error: "error",
};

// ---------------------------------------------------------------------------
// RPC wire types (the subset of pi docs/rpc.md this adapter consumes)
// ---------------------------------------------------------------------------

interface RpcResponse {
	type: "response";
	command: string;
	id?: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

interface RpcUiRequest {
	type: "extension_ui_request";
	id: string;
	method:
		| "select"
		| "confirm"
		| "input"
		| "editor"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text";
}

type RpcEvent = { type: string } & Record<string, unknown>;

/** A caller waiting for one command's correlated response. */
interface PendingCall {
	resolve: (resp: RpcResponse) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Tracked agent state
// ---------------------------------------------------------------------------

/** Interior mutable state of one rpc worker, updated exclusively by the
 *  stdout event pump (single writer — the event loop) plus the awaited
 *  lifecycle methods that own the child handle. Exported (with the pure
 *  reducers below) so the deterministic unit check can drive the pump
 *  without spawning real pi processes. */
export interface RpcAgentState {
	name: string;
	placement: Placement;
	child: ChildProcess;
	/** Worker session JSONL path (from get_state after spawn) — budget gauges. */
	sessionPath?: string;
	/** Monotonic counter: prompt submissions ACCEPTED (the settle epoch). */
	promptSeq: number;
	/** Monotonic counter: agent_settled events observed. */
	settledSeq: number;
	/** True between agent_start and agent_settled. */
	running: boolean;
	/** Ever saw agent_start (two-phase never-started discrimination). */
	everStarted: boolean;
	/** True while an extension-UI dialog is pending. */
	dialogPending: boolean;
	/** Child exit info (null while alive). */
	exited: { code: number | null; signal: string | null } | null;
	/** Last assistant text (probe verdict / readConsole body). */
	lastAssistantText: string;
	/** stopReason of the last assistant message_end (issue #14). */
	lastStopReason?: string;
	/** Verbatim provider error text of the last assistant message_end
	 *  (issue #14 — captured, not paraphrased). */
	lastErrorMessage?: string;
	/** Classification of the last assistant message_end (issue #14):
	 *  "provider-error" (the provider itself failed) or "abort-artifact"
	 *  (the error text is OUR teardown abort echoing back). A clean stop
	 *  leaves it undefined. */
	failureClassification?: "provider-error" | "abort-artifact";
	/** Bounded recent-activity log for readConsole (console snapshot substitute). */
	consoleLines: string[];
	/** First get_state round-trip completed (worker provably interactive). */
	stateKnown: boolean;
	/** Pending command calls keyed by their correlation id. */
	pending: Map<string, PendingCall>;
	/** When present, the pump mirrors every rpc record into it as a
	 *  ConsoleEvent (full-fidelity streamConsole). Owned by the adapter
	 *  instance; optional so the pure reducer stays drivable store-free. */
	stream?: ConsoleSink;
	/** Dialog-relay policy flag (adapter option, default FALSE): false →
	 *  blocking extension-UI dialogs are auto-cancelled (legacy behavior) and
	 *  no dialog/ui records reach the console stream; true → dialog offers
	 *  are relayed as kind "dialog" events and stay pending until
	 *  answerDialog() answers them over the existing stdin path. */
	dialogRelay?: boolean;
	/** Correlation id of the dialog currently relayed-pending (relay mode). */
	dialogId?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class RpcWorkerHost implements Transport {
	/** Root dir for this backend's worktrees (mirrors herdr's
	 *  ~/.herdr/worktrees role; sub-orchestrator detection keys off this root). */
	readonly worktreeRoot: string;
	/** Root authority when the session cwd is NOT inside worktreeRoot. */
	private readonly root: boolean;

	/** Live placements keyed by placementRef; the value carries the MAIN repo
	 *  path (PlacementReq.repoPath) — `git worktree remove` must run against
	 *  the repo the worktree is registered in, and Placement does not carry it. */
	private placements = new Map<string, Placement & { repoPath?: string }>();
	/** Live workers keyed by canonical name. */
	private agents = new Map<string, RpcAgentState>();
	/** Live workers keyed by placementRef (teardown lookup from manifests). */
	private agentsByRef = new Map<string, RpcAgentState>();
	private seq = 0;

	/** Child-process factory — the test seam: the deterministic unit check
	 *  injects fake ChildProcess-like objects so the stdout pump is driven
	 *  without spawning real pi processes. Default: node's real spawn. */
	private readonly spawnProcess: SpawnProcessFn;

	/** Dialog-relay policy flag (default FALSE — byte-identical legacy
	 *  behavior): when true, blocking extension-UI dialogs are relayed onto
	 *  the console stream (kind "dialog") and stay pending instead of being
	 *  auto-cancelled; the consumer answers via answerDialog(). */
	private readonly dialogRelay: boolean;

	/** The per-host console fidelity store behind streamConsole() — one
	 *  drop-oldest ring per worker, capped at STREAM_RING_CAP events. The
	 *  stdout pump is its single writer; teardown() forgets the worker's ring. */
	private readonly consoleStore = new FidelityStore({ cap: STREAM_RING_CAP });

	constructor(opts?: {
		worktreeRoot?: string;
		subOrchestrator?: boolean;
		/** Relay extension-UI dialogs onto the console stream instead of
		 *  auto-cancelling them. Default false — legacy behavior, byte-identical. */
		dialogRelay?: boolean;
		/** Test seam: child-process factory (default: the real node spawn).
		 *  createRpcTransport() with no args keeps the real behavior. */
		spawnProcess?: SpawnProcessFn;
	}) {
		this.spawnProcess = opts?.spawnProcess ?? spawn;
		this.dialogRelay = opts?.dialogRelay ?? false;
		this.worktreeRoot = opts?.worktreeRoot ?? join(getAgentDir(), "worktrees");
		// Authority model (mirrors the herdr adapter's isSubOrchestratorCwd):
		// a session cwd INSIDE this backend's worktree root is a
		// sub-orchestrator — tabs only. Explicit override for tests.
		if (opts?.subOrchestrator !== undefined) {
			this.root = !opts.subOrchestrator;
		} else {
			// TZ §3.7: containment checks route through the portable builder.
			this.root = !isDirUnder(process.cwd(), this.worktreeRoot);
		}

		// BUG_FIX_CONTEXT (probe verdict, 2026-09-15): spawn.ts's probe flow
		// extracts readConsole UNBOUND (`const readConsole = transport.readConsole;
		// readConsole(name, …)`) — `this` is undefined at call time. herdr's
		// readConsole survives that (it uses no `this`); this adapter's did not —
		// the call threw a TypeError inside its first template literal, the
		// probe's catch silently degraded to "console readback unavailable", and
		// every probe verdict read FAIL despite a healthy worker. Bound here so
		// unbound extraction is safe on this adapter too.
		this.readConsole = this.readConsole.bind(this);
		// Same unbound-extraction hazard as readConsole above: bind streamConsole
		// so a `const stream = transport.streamConsole` extraction stays safe.
		this.streamConsole = this.streamConsole.bind(this);
		// Same hazard for the steer seam method (TUI round): the UI extracts it
		// for the rpc-first steering router.
		this.steer = this.steer.bind(this);
	}

	backendName(): string {
		return "rpc";
	}

	capabilities(): TransportCapabilities {
		return { worktrees: this.root, authority: this.root ? "root" : "sub" };
	}

	// -- place ---------------------------------------------------------------

	async place(req: PlacementReq): Promise<Placement> {
		if (req.mode === "worktree") {
			if (!this.root) {
				// Authority model: sub-orchestrators never get worktree placement.
				throw delegateError(
					"E_PLACE",
					`rpc host: worktree placement rejected — session cwd is inside ${this.worktreeRoot} (sub-orchestrator)`,
				);
			}
			const n = ++this.seq;
			const dir = join(this.worktreeRoot, `${basename(req.repoPath)}-wt-${n}`);
			mkdirSync(this.worktreeRoot, { recursive: true });
			try {
				const args = ["-C", req.repoPath, "worktree", "add"];
				if (req.branch) args.push("-b", req.branch);
				args.push(dir);
				if (req.base) args.push(req.base);
				await execFileP("git", args, { timeout: 30_000 });
			} catch (err) {
				throw delegateError(
					"E_PLACE",
					`rpc host: git worktree add failed for ${req.repoPath} → ${dir}: ${(err as Error).message}`,
					err,
				);
			}
			const placementRef = `rpc:wt:${n}`;
			const placement: Placement & { repoPath?: string } = {
				repoPath: req.repoPath, // adapter-internal: the worktree's main repo
				kind: "worktree",
				checkoutPath: dir,
				branch: req.branch || undefined,
				backend: "rpc",
				placementRef,
				// Version-skew rule (design §4): legacy fields ride ALONGSIDE the ref.
				workspaceId: `rpc-ws-${n}`,
				paneId: `rpc:p${n}`,
				isLinkedWorktree: true,
			};
			this.placements.set(placementRef, placement);
			return placement;
		}
		// Shared: shared checkout, no isolation (shared-checkout semantics; the canonical wire value stays "tab").
		const n = ++this.seq;
		const placementRef = `rpc:shared:${n}`;
		const placement: Placement = {
			kind: "tab",
			checkoutPath: req.repoPath,
			backend: "rpc",
			placementRef,
			workspaceId: `rpc-ws-${n}`,
			paneId: `rpc:p${n}`,
		};
		this.placements.set(placementRef, placement);
		return placement;
	}

	// -- startAgent ----------------------------------------------------------

	async startAgent(req: StartReq): Promise<StartResult> {
		const placement = this.placements.get(req.placementRef);
		if (!placement) {
			throw delegateError(
				"E_START",
				`rpc host: unknown placement ${JSON.stringify(req.placementRef)} — place first, then start`,
			);
		}
		if (this.agents.has(req.name)) {
			throw delegateErrorWithDetail(
				"E_NAME",
				`rpc host: agent name ${req.name} already taken`,
				`existing agent: ${req.name}`,
			);
		}
		const args = [
			"--mode", "rpc",
			"--provider", req.provider,
			"--model", req.model,
			"--thinking", req.thinking,
			"--name", req.name,
			...(req.extraArgs ?? []),
		];
		let child: ChildProcess;
		try {
			child = this.spawnProcess("pi", args, {
				cwd: placement.checkoutPath,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				// Issue #25 / §4.1.1: the spawn flow's swarm identity env
				// (SWARM_TASK / SWARM_WORKER / SWARM_SCHEMA_DIR) reaches the worker
				// process here; absent → the orchestrator environment is inherited.
				...(req.env ? { env: { ...process.env, ...req.env } } : {}),
			});
		} catch (err) {
			throw delegateError("E_START", `rpc host: spawn pi --mode rpc failed: ${(err as Error).message}`, err);
		}
		const state: RpcAgentState = {
			name: req.name,
			placement,
			child,
			promptSeq: 0,
			settledSeq: 0,
			running: false,
			everStarted: false,
			dialogPending: false,
			exited: null,
			lastAssistantText: "",
			consoleLines: [],
			stateKnown: false,
			pending: new Map(),
			stream: this.consoleStore,
			dialogRelay: this.dialogRelay,
		};
		this.agents.set(req.name, state);
		this.agentsByRef.set(placement.placementRef ?? req.name, state);

		child.on("exit", (code, signal) => {
			state.exited = { code, signal };
			state.running = false;
			const exitLine = `[process exited code=${code} signal=${signal}]`;
			pushConsoleLine(state, exitLine);
			state.stream?.append(state.name, "raw", exitLine);
			// Fail any still-pending command — the worker is gone.
			for (const [id, call] of state.pending) {
				clearTimeout(call.timer);
				call.reject(new Error(`worker exited (code=${code}) before responding (cmd id=${id})`));
				state.pending.delete(id);
			}
			// Worker-termination path for the console stream: end every live
			// subscription after its buffered backlog drains — a for-await
			// consumer completes instead of hanging on events that can never
			// come. A merely SETTLED worker (agent_settled, still alive) keeps
			// the stream open — more prompts may follow.
			this.consoleStore.close(state.name);
		});
		child.on("error", (err) => {
			const errLine = `[process error: ${err.message}]`;
			pushConsoleLine(state, errLine);
			state.stream?.append(state.name, "raw", errLine);
		});

		this.pumpStdout(state);
		this.pumpStderr(state);

		// Readiness + session capture: one get_state round-trip, bounded by the
		// seam's interactive-readiness timeout. The session path is REQUIRED
		// downstream (budget gauges parse it), so a missing state response is an
		// E_START, not a degraded start.
		try {
			const resp = await this.rpcCommand(state, { type: "get_state" }, req.timeoutMs);
			if (!resp.success) throw new Error(`get_state failed: ${resp.error ?? "unknown error"}`);
			const data = resp.data as { sessionFile?: string } | undefined;
			if (typeof data?.sessionFile === "string" && data.sessionFile.length > 0) {
				state.sessionPath = data.sessionFile;
			}
			state.stateKnown = true;
		} catch (err) {
			// Roll back the registry entry (spawn.ts keeps the manifest entry; the
			// phantom-entry cleanup there keys off sessionPath, which stays unset).
			this.agents.delete(req.name);
			this.agentsByRef.delete(placement.placementRef ?? req.name);
			try { child.kill("SIGKILL"); } catch { /* already dead */ }
			throw delegateError(
				"E_START",
				`rpc host: worker ${req.name} not ready within ${req.timeoutMs}ms: ${(err as Error).message}`,
				err,
			);
		}
		return { name: req.name, sessionPath: state.sessionPath };
	}

	// -- submitPrompt ----------------------------------------------------------

	async submitPrompt(req: PromptReq): Promise<void> {
		const state = this.agents.get(req.name);
		if (!state) {
			throw delegateError("E_PROMPT_STALLED", `rpc host: no live agent ${req.name}`);
		}
		if (state.exited) {
			throw delegateError("E_PROMPT_STALLED", `rpc host: agent ${req.name} has exited (code=${state.exited.code})`);
		}
		const attempt = async (cmd: Record<string, unknown>): Promise<RpcResponse> => {
			try {
				return await this.rpcCommand(state, cmd, req.timeoutMs);
			} catch (err) {
				throw delegateError("E_PROMPT_STALLED", `rpc host: prompt to ${req.name} failed: ${(err as Error).message}`, err);
			}
		};
		const base: Record<string, unknown> = { type: "prompt", message: req.text };
		const resp = await attempt(base);
		// Mid-stream prompt without streamingBehavior is rejected by pi —
		// mirror herdr's prompt-into-console semantics by steering instead.
		if (!resp.success && /streaming/i.test(resp.error ?? "")) {
			const retry = await attempt({ ...base, streamingBehavior: "steer" });
			if (!retry.success) {
				throw delegateError("E_PROMPT_STALLED", `rpc host: steer to ${req.name} rejected: ${retry.error ?? "unknown"}`);
			}
		} else if (!resp.success) {
			throw delegateError("E_PROMPT_STALLED", `rpc host: prompt to ${req.name} rejected: ${resp.error ?? "unknown"}`);
		}
		state.promptSeq += 1; // accepted → new settle epoch
	}

	// -- waitSettle ----------------------------------------------------------

	async waitSettle(req: {
		name: string;
		timeoutMs: number;
		signal?: AbortSignal;
		onPoll?: (info: { status: AgentStatusName; started: boolean; elapsedMs: number }) => void;
		proofSettled?: () => Promise<boolean>;
		releaseOnStarted?: boolean;
	}): Promise<SettleResult> {
		const state = this.agents.get(req.name);
		if (!state) {
			throw delegateError("E_TIMEOUT", `rpc host: no agent ${req.name} — poll delegate_status`);
		}
		// Settle-epoch baseline: an agent_settled observed for an epoch >= the
		// one this wait is keyed to proves the CURRENT work settled. Stale
		// settles from earlier epochs never satisfy a later wait.
		const epoch = state.promptSeq;
		const t0 = Date.now();
		let lastStatus: AgentStatusName = "unknown";
		for (;;) {
			if (req.signal?.aborted) {
				return { kind: "detached", status: lastStatus }; // abort detaches the wait, never the worker
			}
			const status = mapAgentStatus(state);
			if (status !== "unknown") lastStatus = status;
			const started = state.everStarted || STARTED.includes(status);
			req.onPoll?.({ status, started, elapsedMs: Date.now() - t0 });

			// Settle proof 1 — the rpc event itself (authoritative): the agent
			// settled an epoch this wait covers. epoch 0 = no prompt accepted
			// yet (spawn.ts always submits before waiting) → keep waiting.
			if (epoch > 0 && state.settledSeq >= epoch) {
				return { kind: "settled", status };
			}
			// Settle proof 2 — the child exited without any agent activity:
			// a crashed/failed spawn. The report file (the real completion
			// criterion) decides whether the run produced value.
			if (state.exited && !state.everStarted) {
				return { kind: "settled", status: "done" };
			}
			// Caller-owned completion proof (aged-finish / out-of-band evidence).
			if (!started && req.proofSettled) {
				let proven = false;
				try {
					proven = await req.proofSettled();
				} catch {
					proven = false; // throwing proof counts as "not proven"
				}
				if (proven) return { kind: "finished-before-watch", status: "idle" };
			}
			// Early release (watch.releaseOn=started): hand off to the watcher.
			if (req.releaseOnStarted && status === "working") {
				return { kind: "started-confirmed", status };
			}
			if (Date.now() - t0 >= req.timeoutMs) {
				return started
					? { kind: "timeout", status: lastStatus }
					: { kind: "never-started", status: "unknown" };
			}
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
	}

	// -- status / readConsole -----------------------------------------------------

	async getStatus(name: string): Promise<AgentStatus | null> {
		const state = this.agents.get(name);
		if (!state) return null; // "not found → null" is a seam contract
		return {
			name,
			status: mapAgentStatus(state),
			placementRef: state.placement.placementRef,
		};
	}

	async listStatuses(): Promise<AgentStatus[]> {
		const out: AgentStatus[] = [];
		for (const state of this.agents.values()) {
			out.push({
				name: state.name,
				status: mapAgentStatus(state),
				placementRef: state.placement.placementRef,
			});
		}
		return out;
	}

	async readConsole(name: string, opts?: { maxChars?: number }): Promise<string> {
		const state = this.agents.get(name);
		if (!state) throw delegateError("E_STATUS", `rpc host: no live agent ${name} — console read impossible`);
		const max = opts?.maxChars ?? 4000;
		const body = [
			...state.consoleLines,
			state.lastAssistantText ? `assistant: ${state.lastAssistantText}` : "",
		]
			.filter((l) => l.length > 0)
			.join("\n");
		return body.length <= max ? body : body.slice(body.length - max);
	}

	/** OPTIONAL Transport seam method (implemented — see the interface contract
	 *  in src/host.ts): the per-worker FidelityStore subscription. Backlog
	 *  (seq > afterSeq) first, then live; a backlog truncated by ring eviction
	 *  opens with a gap marker; the store's ring cap is STREAM_RING_CAP. */
	streamConsole(name: string, opts?: { afterSeq?: number }): AsyncIterable<ConsoleEvent> & { unsubscribe?(): void } {
		if (!this.agents.has(name)) {
			throw delegateError("E_STATUS", `rpc host: no live agent ${name} — console stream impossible`);
		}
		return this.consoleStore.subscribe(name, { fromCursor: opts?.afterSeq ?? 0 });
	}

	/** Dialog-relay mode only: answer a pending extension-UI dialog that was
	 *  relayed as a kind "dialog" ConsoleEvent (the offer's payload JSON
	 *  carries the dialog id). Writes the extension_ui_response command RAW
	 *  over the worker's stdin — the SAME write the auto-cancel default makes
	 *  (the rpcCommand wrapper would clobber the dialog's wire `id` with a
	 *  command-correlation id) — and clears the blocked state immediately, so
	 *  the answer behaves exactly like the auto-cancel write from the
	 *  consumer's side. Not on the Transport seam (adapter-level affordance;
	 *  dashboard integration is a later round). */
	async answerDialog(req: { name: string; id: string; value?: unknown; cancelled?: boolean }): Promise<void> {
		const state = this.agents.get(req.name);
		if (!state) throw delegateError("E_PROMPT_STALLED", `rpc host: no live agent ${req.name}`);
		if (state.exited) {
			throw delegateError("E_PROMPT_STALLED", `rpc host: agent ${req.name} has exited (code=${state.exited.code})`);
		}
		const response: Record<string, unknown> = { type: "extension_ui_response", id: req.id };
		if (req.cancelled) response.cancelled = true;
		else response.value = req.value;
		try {
			state.child.stdin?.write(`${JSON.stringify(response)}\n`);
		} catch (err) {
			throw delegateError("E_PROMPT_STALLED", `rpc host: dialog answer to ${req.name} failed: ${(err as Error).message}`, err);
		}
		if (state.dialogId === req.id) {
			state.dialogPending = false;
			state.dialogId = undefined;
		}
	}

	/** OPTIONAL Transport seam method (implemented — see the interface contract
	 *  in src/host.ts): mid-run steering. The rpc child's stdin IS the live
	 *  console: a steer is a prompt written onto that stdin — exactly the
	 *  submitPrompt write path (plain prompt first, automatic
	 *  streamingBehavior:"steer" retry when the worker is mid-stream). So a
	 *  steer reaches the child's stdin exactly when the worker is alive, and
	 *  an unknown/exited/dead-stdin worker throws the structured
	 *  E_PROMPT_STALLED — the caller's signal to fall back to the mailbox. */
	async steer(req: { name: string; text: string; timeoutMs?: number }): Promise<void> {
		await this.submitPrompt({
			name: req.name,
			text: req.text,
			timeoutMs: req.timeoutMs ?? 30_000,
		});
	}

	// -- teardown ---------------------------------------------------------------

	async teardown(req: TeardownReq): Promise<TeardownResult> {
		// placementRef ONLY — this adapter is unreleased, so every placement it
		// ever wrote carries the ref; there is no legacy cohort to fall back for
		// (T4.3: legacy alternate ids are compat-only).
		const ref = req.placement.placementRef ?? "";
		const state = this.agentsByRef.get(ref) ?? this.agents.get(req.name);
		// matched = this call closed something REAL: killed a live worker or
		// removed a live worktree. Registry bookkeeping alone does not count —
		// "the placement was already gone" must surface as alreadyGone:true
		// (the seam's idempotent-teardown semantics).
		let matched = false;

		if (state) {
			if (!state.exited) {
				matched = true;
				// Abort any in-flight run, then make sure the child is dead: if it
				// has not exited on its own within the grace period, SIGKILL it
				// (the abort write is the graceful path; there is no SIGTERM step).
				try {
					state.child.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
				} catch { /* stdin gone */ }
				await new Promise<void>((resolve) => {
					const killTimer = setTimeout(() => {
						try { state.child.kill("SIGKILL"); } catch { /* already dead */ }
						resolve();
					}, KILL_GRACE_MS);
					state.child.once("exit", () => {
						clearTimeout(killTimer);
						resolve();
					});
				});
			}
			this.agents.delete(state.name);
			this.agentsByRef.delete(state.placement.placementRef ?? state.name);
			// Release the worker's console ring (the store is per-host and would
			// otherwise retain every torn-down worker's window forever).
			this.consoleStore.forget(state.name);
		}

		this.placements.delete(ref); // registry cleanup regardless

		// Worktree removal (root placements only; tolerate already-gone).
		// Run against the MAIN repo — the worktree is registered there, not in
		// the orchestrator's cwd.
		if (req.placement.kind === "worktree" && req.placement.checkoutPath) {
			const mainRepo = (req.placement as Placement & { repoPath?: string }).repoPath;
			try {
				await execFileP(
					"git",
					["-C", mainRepo ?? req.placement.checkoutPath, "worktree", "remove", ...(req.force ? ["--force"] : []), req.placement.checkoutPath],
					{ timeout: 30_000 },
				);
				matched = true;
			} catch (err) {
				const msg = (err as Error).message ?? "";
				if (!RPC_ALREADY_GONE_RE.test(msg)) {
					throw delegateError(
						"E_TEARDOWN",
						`rpc host: git worktree remove failed for ${req.placement.checkoutPath}: ${msg}`,
						err,
					);
				}
			}
		}
		return { alreadyGone: !matched };
	}

	// -- internals ------------------------------------------------------------

	/** The single stdout event pump: parses JSONL through the strict
	 *  byte-buffer parser (src/host/rpc-jsonl.ts — raw-byte accumulation, LF
	 *  framing, one CR strip; a multi-byte character split across chunks
	 *  decodes exactly once, at the record boundary) and feeds each parsed
	 *  record to the pure event reducer (applyRpcEvent). Single writer —
	 *  everything else only reads. */
	private pumpStdout(state: RpcAgentState): void {
		const parser = new RpcJsonlParser({
			onMalformed: (raw, index) => {
				void index;
				// Bounded malformed budget exceeded → protocol failure escalation
				// (exactly once — the console line is the orchestrator-visible signal).
				if (parser.exceededMalformedThreshold && !escalated) {
					escalated = true;
					pushConsoleLine(state, `[protocol] malformed record threshold exceeded (${parser.malformedRecords} malformed records)`);
					state.stream?.append(state.name, "raw", "[protocol] malformed record threshold exceeded");
				}
			},
		});
		let escalated = false;
		const accept = (record: RpcJsonlRecord): void => {
			const trimmed = record.raw.toString("utf8");
			if (!trimmed.trim()) return; // blank line — framing noise, not a record
			if (record.malformed || record.parsed === null || typeof record.parsed !== "object") {
				const rawLine = `[unparsed stdout] ${trimmed.slice(0, 200)}`;
				pushConsoleLine(state, rawLine);
				state.stream?.append(state.name, "raw", trimmed);
				return;
			}
			applyRpcEvent(state, record.parsed as RpcEvent);
		};
		state.child.stdout?.on("data", (chunk: Buffer | string) => {
			for (const record of parser.feed(chunk)) accept(record);
		});
		state.child.stdout?.on("end", () => {
			for (const record of parser.close()) accept(record);
		});
	}

	private pumpStderr(state: RpcAgentState): void {
		let tail = "";
		state.child.stderr?.on("data", (chunk: Buffer | string) => {
			tail += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			const lines = tail.split("\n");
			tail = lines.pop() ?? "";
			for (const l of lines) {
				if (!l.trim()) continue;
				const errLine = `[stderr] ${l.slice(0, 300)}`;
				pushConsoleLine(state, errLine);
				state.stream?.append(state.name, "raw", l);
			}
		});
	}

	/** Write one command over stdin and wait (bounded) for its correlated
	 *  response (resolved by the event pump's "response" branch). */
	private rpcCommand(state: RpcAgentState, cmd: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
		const id = `rpc-${++RpcWorkerHost.cmdSeq}`;
		const wired = { ...cmd, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				state.pending.delete(id);
				reject(new Error(`rpc command ${String(cmd.type)} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			state.pending.set(id, { resolve, reject, timer });
			try {
				state.child.stdin?.write(`${JSON.stringify(wired)}\n`);
			} catch (err) {
				clearTimeout(timer);
				state.pending.delete(id);
				reject(err as Error);
			}
		});
	}

	static cmdSeq = 0;
}

/** "Already gone" shapes for `git worktree remove` — idempotent-teardown seam
 *  semantics: these resolve { alreadyGone: true } instead of throwing. */
const RPC_ALREADY_GONE_RE = /not a working tree|does not exist|is not a working tree|not registered/i;

// ---------------------------------------------------------------------------
// exported pure units (driven directly by test/rpc-host-unit-check.ts —
// the deterministic unit check exercises these WITHOUT spawning real pi
// processes; the adapter methods above are thin wrappers over them)
// ---------------------------------------------------------------------------

/** Pure status mapper over the tracked agent state (the pump is the single
 *  writer; this only reads). Order is the contract: exit wins, then a pending
 *  dialog, then activity, then any settled/known observation. */
export function mapAgentStatus(state: RpcAgentState): AgentStatusName {
	if (state.exited) return "done";
	if (state.dialogPending) return "blocked";
	if (state.running) return "working";
	if (state.settledSeq > 0 || state.stateKnown) return "idle";
	return "unknown";
}

/** Append one bounded line to the readConsole activity ring buffer. */
export function pushConsoleLine(state: RpcAgentState, line: string): void {
	state.consoleLines.push(line);
	if (state.consoleLines.length > CONSOLE_LOG_MAX_LINES) state.consoleLines.shift();
}

/** The pure event reducer — ONE copy of the rpc protocol's state effects.
 *  Updates tracked state, mirrors every parsed record into the worker's
 *  console fidelity store (when one is wired — full-fidelity streamConsole;
 *  dialog/UI offers are gated by the dialogRelay flag, see the
 *  extension_ui_request branch), auto-cancels UI dialogs unless relaying,
 *  resolves pending command calls. Called only from the stdout pump (single
 *  writer — the event loop). */
export function applyRpcEvent(state: RpcAgentState, ev: RpcEvent): void {
	// Full-fidelity mirror: every parsed rpc record except dialog/UI offers
	// lands in the console store as one ConsoleEvent, payload = the record's
	// JSON — zero new data sources, the stream the pump already receives.
	if (ev.type !== "extension_ui_request") {
		state.stream?.append(state.name, RPC_RECORD_KINDS[ev.type] ?? "raw", JSON.stringify(ev));
	}
	switch (ev.type) {
		case "response": {
			const resp = ev as unknown as RpcResponse;
			const id = resp.id ?? "";
			const call = id ? state.pending.get(id) : undefined;
			if (call) {
				state.pending.delete(id);
				clearTimeout(call.timer);
				call.resolve(resp);
			}
			break;
		}
		case "agent_start":
			state.running = true;
			state.everStarted = true;
			break;
		case "agent_settled":
			state.running = false;
			state.settledSeq += 1;
			break;
		case "message_end": {
			const msg = ev.message as
				| { role?: string; content?: unknown; stopReason?: unknown; errorMessage?: unknown }
				| undefined;
			if (msg?.role === "assistant") {
				const text = extractText(msg.content);
				if (text) {
					state.lastAssistantText = text;
					pushConsoleLine(state, `assistant: ${text.slice(0, 500)}`);
				}
				// Issue #14: the provider's own stop reason + error text ride on
				// message_end — capture verbatim and classify. An error text that
				// matches OUR abort artifacts (teardown) is not a provider failure.
				if (typeof msg.stopReason === "string") state.lastStopReason = msg.stopReason;
				if (typeof msg.errorMessage === "string" && msg.errorMessage.length > 0) {
					state.lastErrorMessage = msg.errorMessage;
					state.failureClassification = isAbortArtifactErrorMessage(msg.errorMessage)
						? "abort-artifact"
						: "provider-error";
					// Orchestrator-visible failure detail (readConsole / console
					// stream): WHY the worker stopped, verbatim — issue #14.
					const classificationLine =
						state.failureClassification === "abort-artifact"
							? `aborted by teardown: ${msg.errorMessage}`
							: `provider error: ${msg.errorMessage}`;
					pushConsoleLine(state, classificationLine);
					state.stream?.append(state.name, "raw", classificationLine);
				} else if (typeof msg.stopReason === "string" && msg.stopReason !== "error") {
					// A clean stop clears any stale classification from earlier turns.
					state.lastErrorMessage = undefined;
					state.failureClassification = undefined;
				}
			}
			break;
		}
		case "tool_execution_start": {
			pushConsoleLine(state, `tool: ${String(ev.toolName)} ${JSON.stringify(ev.args ?? {}).slice(0, 200)}`);
			break;
		}
		case "tool_execution_end": {
			pushConsoleLine(state, `tool done: ${String(ev.toolName)} isError=${String(ev.isError)}`);
			break;
		}
		case "extension_ui_request": {
			const ui = ev as unknown as RpcUiRequest;
			const dialog =
				ui.method === "select" || ui.method === "confirm" || ui.method === "input" || ui.method === "editor";
			if (dialog) {
				if (state.dialogRelay) {
					// Relay: the offer reaches the stream as kind "dialog" and STAYS
					// pending — the consumer answers via answerDialog() (the
					// extension_ui_response stdin path). No auto-cancel write.
					state.dialogPending = true;
					state.dialogId = ui.id;
					state.stream?.append(state.name, "dialog", JSON.stringify(ev));
					break;
				}
				// Auto-cancel: the worker extension receives undefined/false —
				// identical to a human pressing Esc. A headless worker must
				// never deadlock on a dialog no human will answer.
				state.dialogPending = true;
				try {
					state.child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: ui.id, cancelled: true })}\n`);
				} catch { /* stdin gone */ }
				state.dialogPending = false;
				pushConsoleLine(state, `[ui dialog auto-cancelled: ${ui.method}]`);
			} else {
				if (state.dialogRelay) state.stream?.append(state.name, "ui", JSON.stringify(ev));
				pushConsoleLine(state, `[ui ${ui.method}]`);
			}
			break;
		}
		case "extension_error": {
			pushConsoleLine(state, `[extension_error ${String(ev.event)}] ${String(ev.error).slice(0, 200)}`);
			break;
		}
		default:
			break; // streaming deltas etc. — status tracking covers what we need
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => (b as { type?: string }).type === "text")
			.map((b) => String((b as { text?: string }).text ?? ""))
			.join("");
	}
	return "";
}

/** Issue #14: provider-error artifacts produced by OUR own abort/teardown,
 *  not by the provider — the child echoes the abort back over message_end.
 *  A verbatim match against these patterns classifies as "abort-artifact";
 *  everything else on the error channel is a genuine provider error. */
export function isAbortArtifactErrorMessage(message: string): boolean {
	return /this operation was aborted|request was aborted|operation aborted/i.test(message);
}

/** Composition-root factory (index.ts binds this for host:"rpc"). */
export function createRpcTransport(opts?: {
	worktreeRoot?: string;
	subOrchestrator?: boolean;
	/** Relay extension-UI dialogs onto the console stream instead of
	 *  auto-cancelling them. Default false — legacy behavior, byte-identical. */
	dialogRelay?: boolean;
	/** Test seam — see the RpcWorkerHost constructor. */
	spawnProcess?: SpawnProcessFn;
}): Transport {
	return new RpcWorkerHost(opts);
}
