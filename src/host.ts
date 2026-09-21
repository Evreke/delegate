/**
 * pi-delegate — src/host.ts (WorkerHost seam, extracted from src/transport.ts).
 *
 * MODULE_CONTRACT — the backend-neutral worker-host seam: Transport interface
 * + req/result types, the E_* error taxonomy (incl. DelegateErrorImpl/GUIDANCE),
 * the report/mailbox envelope contracts and their guards, the worker-name rule,
 * briefPrompt, the budget/context gauge constants, sessionHasReply (the
 * aged-finish session-JSONL proof — backend-neutral: it reads the worker's
 * pi session JSONL, never the host backend), and the worker console event
 * envelope (ConsoleEvent/ConsoleEventKind) with the OPTIONAL streamConsole
 * seam method (full-fidelity live console streaming; implementations without
 * an event store omit it and callers degrade to readConsole polling).
 *
 * Dependencies: node builtins (fs, path) + pi's getAgentDir()/CONFIG_DIR_NAME
 * from @earendil-works/pi-coding-agent (the platform package — Law 1: import,
 * never reimplement). Depends on NO other src/ module — bottom of the import
 * graph (the old src/transport.ts SECTION 1 + the backend-neutral
 * sessionHasReply/Errors blocks, byte-verbatim).
 *
 * The herdr IMPLEMENTATION lives in src/herdr/host.ts (SECTION 2 verbatim);
 * it is bound ONCE in index.ts (workerhost migration steps 5–6 — the old
 * src/transport.ts re-export shim is deleted). Tool modules (spawn/observe/
 * fleet) import the seam from ./host.ts and must NEVER import
 * ./herdr/host.ts directly (pinned by static-check T1.1/T1.1c /
 * watcher-check W1.1).
 *
 * I/O: the seam performs no I/O of its own, with ONE documented exception —
 * sessionHasReply() reads the caller-supplied session JSONL with readFileSync
 * (the aged-finish proof; backend-neutral by construction since the path is
 * an argument, see its FUNCTION_CONTRACT below). This is the audit's
 * acknowledged deviation, stated here per Law 2.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ============================================================================
// SECTION 1 — src/transport/types.ts (verbatim, incl. its review header)
// ============================================================================

/**
 * pi-delegate — transport seam and shared contracts.
 *
 * OWNERSHIP: this file is authored by the tech lead and is the review artifact
 * for the whole extension. Implementation workers must NOT edit it; they code
 * against it. If a contract here is wrong, escalate to the orchestrator —
 * do not patch around it locally.
 *
 * Dependency rule: spawn.ts (tools) and index.ts (commands, absorbed in W5)
 * may import transport.ts and exchange.ts only. They must NEVER import the
 * herdr IMPLEMENTATION directly — createHerdrTransport is bound once in
 * index.ts (pinned by static-check T1.1/T1.1b).
 *
 * MODULE_CONTRACT (ZCS, ported from the bundle's types.ts header): pure
 * types, constants and tiny pure helpers — no I/O of its own. Critical
 * invariants: DelegateErrorCode is the FIXED E_* list (the transport maps
 * every herdr failure into exactly one of them — never raw throws past the
 * tool boundary); WorkerReport is the schema BOTH the delegate tool
 * (validateReport) and the watcher validate reports against — changing it
 * breaks both sides at once; Transport implementations must serialize
 * mutating ops internally (ARCHITECTURE.md Law 4); REPORT_EXAMPLE is the canonical
 * report shape embedded into every worker prompt; CONTEXT_WINDOWS mirrors
 * pi's model catalog values and must be kept in sync with it manually.
 */

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** How a worker is isolated. `worktree` = own checkout+branch; `tab` = shared
 *  placement without isolation (frozen internal/wire value; the delegate
 *  tool additionally accepts the spelling "shared" and normalizes it here). */
export type PlacementMode = "worktree" | "tab";

/** Root orchestrators may create/remove worktrees; sub-orchestrators (cwd under
 *  ~/.herdr/worktrees/) may only open shared placements in their own workspace. */
export type AuthorityMode = "root" | "sub";

export interface PlacementReq {
	mode: PlacementMode;
	/** Repo the worktree/shared placement is based on. Absolute path. */
	repoPath: string;
	/** Branch name for worktree placement. Ignored for shared placement. */
	branch: string;
	/** Human label for the shared placement/workspace. */
	label: string;
	/** Base ref for worktree placement (default HEAD). */
	base?: string;
}

export interface Placement {
	kind: PlacementMode;
	/** Legacy herdr workspace id. OPTIONAL since the placementRef-only end
	 *  state (Law 4): `placementRef` is the only required handle — a second
	 *  backend (tmux) must not fake herdr-shaped ids. herdr adapter keeps
	 *  populating both alongside placementRef (version-skew rule: never delete
	 *  legacy fields while any 1.15.x cohort reads). Consumers must treat both
	 *  as possibly-absent and prefer `placementRef ?? paneId`. */
	workspaceId?: string;
	/** Legacy alternate id (herdr-shaped) — see workspaceId above. */
	paneId?: string;
	/** Branch created (worktree mode only). */
	branch?: string;
	/** Absolute checkout path the agent will run in. */
	checkoutPath: string;
	/** True when herdr reported a linked worktree workspace. */
	isLinkedWorktree?: boolean;
	/** Opaque placement reference — adapter-defined, unique per live placement
	 *  (workerhost inversion, design §2/§4: the adapter decodes its own ref;
	 *  the seam only ever does opaque equality matching). The fake synthesizes
	 *  "fake:<n>"; the herdr adapter "herdr:pane:<paneId>" and always writes
	 *  the legacy id fields ALONGSIDE it (version-skew rule, design §4:
	 *  never delete legacy fields while any 1.15.x cohort reads). A placement
	 *  WITHOUT the legacy fields is fully valid from Wave 4 on — every seam
	 *  consumer keys off placementRef (Law 4). */
	placementRef?: string;
	/** Backend that created this placement ("herdr" | "fake" | …). Written into
	 *  manifest records ALONGSIDE the legacy id fields (version-skew rule,
	 *  design §4: never delete legacy fields while any 1.15.x cohort reads). */
	backend?: string;
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

export type AgentStatusName = "idle" | "working" | "blocked" | "done" | "unknown";

export interface StartReq {
	/** Requested worker name. herdr (observed 0.8.x) REJECTS collisions with
	 *  error `agent_name_taken` — implementations must map that to E_NAME with
	 *  candidate guidance; no auto-uniquification exists. Implementations MUST
	 *  still read back the effective name from the response. */
	name: string;
	/** Opaque placement reference from the Placement that place() returned —
	 *  the adapter decodes its own ref (workerhost inversion, design §3:
	 *  legacy alternate ids never cross the seam). Callers pass
	 *  `placement.placementRef ?? placement.paneId` so a legacy placement
	 *  record (no ref) still works. */
	placementRef: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra args appended after `--` (e.g. ["--session", path]). */
	extraArgs?: string[];
	/** Extra environment variables for the WORKER process (backend-neutral).
	 *  Issue #25 / ARCHITECTURE.md §4.1.1: the spawn flow exports the swarm
	 *  identity here (SWARM_TASK / SWARM_WORKER / SWARM_SCHEMA_DIR) so a worker
	 *  interacts through the `swarm` verbs without path flags. Adapters apply
	 *  it as their backend allows (rpc: the child process env; herdr: the CLI
	 *  subprocess env — see the adapter's FUNCTION_CONTRACT for the documented
	 *  propagation caveat); absent → the backend's own inherited environment. */
	env?: Record<string, string>;
	/** Interactive-readiness timeout in ms (skill: 60_000–180_000). */
	timeoutMs: number;
}

export interface StartResult {
	/** Canonical name as reported by herdr — use this, never the requested name. */
	name: string;
	/** Worker session JSONL path, when the transport can capture it (herdr:
	 *  result.agent.agent_session.value). Budget accounting uses this. */
	sessionPath?: string;
}

export interface PromptReq {
	name: string;
	text: string;
	/** Max ms to wait for the submission itself to be accepted (not for settle). */
	timeoutMs: number;
}

/**
 * Outcome of a settle observation. NOT a completion criterion — report files
 * are (migration stage 3, audit step 8).
 * <p>
 * The settle result is a DISCRIMINATED UNION — one variant per outcome —
 * instead of the old set of boolean flags (timedOut / neverStarted /
 * finishedBeforeWatch / startedConfirmed). Before this the flags encoded a
 * hidden state machine: impossible combinations were representable
 * (timedOut+startedConfirmed, neverStarted+finishedBeforeWatch) and every
 * consumer re-derived the outcome by reading flags in the right order. The
 * variants (audit §3.2, the settle semantics lifted OUT of the adapters into
 * the seam):
 *   - "settled"               — осел: the agent was observed starting and then
 *                               reached idle/done/blocked within the budget;
 *   - "timeout"               — the budget elapsed after a proven start; the
 *                               carried status is the LAST OBSERVED state and
 *                               is an advisory reading only;
 *   - "never-started"         — не стартовал: the budget elapsed WITHOUT any
 *                               working/blocked/done observation — the prompt
 *                               was likely never consumed (D3);
 *   - "finished-before-watch" — завершился до наблюдения: the watcher attached
 *                               late (herdr ages done→idle within minutes and
 *                               current builds never report working for pi
 *                               workers, §19.1b/§19.1c); life was proven
 *                               OUT-OF-BAND (the caller's completion proof or
 *                               an assistant reply in the session JSONL) —
 *                               a success, not a failure;
 *   - "started-confirmed"     — освобождён по подтверждённому старту (v1.14,
 *                               watch.releaseOn=started): the worker was
 *                               observed working and the wait released EARLY —
 *                               the orchestrator hands off to the background
 *                               watcher; not a timeout, not a failure;
 *   - "detached"              — отсоединён: the abort signal fired (abort
 *                               detaches the WAIT, never the worker); the
 *                               carried status is the last known one.
 * Every variant carries `status` — the last observed backend state, present in
 * ALL variants so consumers can render it; per audit step 8 the backend status
 * is an ADVISORY sensor, never the completion criterion.
 */
export type SettleResult =
	| { kind: "settled"; status: AgentStatusName }
	| { kind: "timeout"; status: AgentStatusName }
	| { kind: "never-started"; status: AgentStatusName }
	| { kind: "finished-before-watch"; status: AgentStatusName }
	| { kind: "started-confirmed"; status: AgentStatusName }
	| { kind: "detached"; status: AgentStatusName };

export interface AgentStatus {
	name: string;
	status: AgentStatusName;
	/** Opaque placement reference (workerhost inversion, design §3) — the
	 *  adapter's own ref for the agent's placement; the watcher/retire gate
	 *  proxies on this (with a legacy paneId fallback from the manifest
	 *  record, which stays outside the read model). Backend ids (paneId/
	 *  tabId/workspaceId) live ONLY in the adapter's own types. */
	placementRef?: string;
}

export interface TeardownReq {
	name: string;
	placement: Placement;
	/** Force worktree removal. */
	force?: boolean;
}

/** Result of a teardown operation (migration stage 1, audit extensibility
 *  defect 1): "teardown of an already-gone placement" is NOT an error — it is
 *  an idempotent success the CALLER can see.
 *  Before this the seam had no way to say it: the herdr adapter swallowed
 *  not-found on the worktree branch but threw on the shared-placement branch, and the
 *  tool layer re-parsed "not found" out of the error MESSAGE text at every
 *  call site (three unsynchronized copies of the same regex).
 *  alreadyGone is optional-in-type so older test doubles (which return
 *  undefined) keep working; both real adapters always set it. */
export interface TeardownResult {
	/** True when the placement was ALREADY gone (herdr dropped it, another
	 *  session closed it, the user closed the console) — the close was a no-op.
	 *  False when this call actually closed something. */
	alreadyGone?: boolean;
}

export interface TransportCapabilities {
	/** False in sub-orchestrator mode: place() must reject worktree requests. */
	worktrees: boolean;
	authority: AuthorityMode;
}

// ---------------------------------------------------------------------------
// Worker console event stream (additive, vNext) — the full-fidelity envelope
// ---------------------------------------------------------------------------

/** Kind of one worker console event. The `*_start/_update/_end`,
 *  `agent_*` and `queue_update` spellings mirror the rpc stdout stream's own
 *  event types (pi docs/rpc.md) — the rpc adapter forwards them 1:1. The
 *  adapter-specific additions: `dialog` = a blocking extension-UI dialog
 *  offer relayed instead of auto-cancelled (rpc dialog-relay flag), `ui` = a
 *  fire-and-forget extension-UI record (setWidget/notify/…) mirrored on the
 *  stream, `error` = an extension_error record, `raw` = any other stdout
 *  record or console line kept verbatim (command responses, stderr, exit
 *  notices), `gap` = a subscriber-local marker (see ConsoleEvent) — it is
 *  NEVER stored in the fidelity store itself. */
export type ConsoleEventKind =
	| "agent_start"
	| "message_start"
	| "message_update"
	| "message_end"
	| "toolcall_start"
	| "toolcall_update"
	| "toolcall_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "agent_end"
	| "agent_settled"
	| "queue_update"
	| "dialog"
	| "ui"
	| "error"
	| "raw"
	| "gap";

/** One full-fidelity worker console event — the envelope every
 *  streamConsole() delivery carries. Payloads stay RAW TEXT (the JSONL
 *  fragment or text chunk exactly as the backend produced it) so that
 *  char-based snapshot semantics (last maxChars of console text) match the
 *  existing readConsole fallback without any re-encoding. */
export interface ConsoleEvent {
	/** Worker this event belongs to. */
	workerName: string;
	/** Monotonic per-worker sequence number starting at 1. Gap markers carry
	 *  the seq of the LAST dropped event, so the events after a gap are
	 *  contiguous from seq + 1. */
	seq: number;
	/** Wall-clock milliseconds since epoch (as observed by the adapter). */
	timestamp: number;
	kind: ConsoleEventKind;
	/** Raw event text: text deltas verbatim, structured records as their JSON
	 *  fragment, console lines verbatim. */
	payload: string;
}

/**
 * The seam. Every herdr verb the tools need is reachable through these calls.
 * Implementations must serialize mutating operations internally (one mutating
 * herdr op in flight at a time) — ARCHITECTURE.md Law 4.
 */
export interface Transport {
	/** The backend name this adapter serves — the exact `placement.backend`
	 *  spelling its place() writes into manifests. Migration stage 3 (audit
	 *  step 9): the ONE source of the active-backend name — the manifest-scan
	 *  foreign-backend filter reads it from here (composition-root bound via
	 *  index.ts), the old exchange.ts ACTIVE_HOST constant is gone. */
	backendName(): string;
	place(req: PlacementReq): Promise<Placement>;
	startAgent(req: StartReq): Promise<StartResult>;
	/** Submit a prompt. Returns after submission is accepted, without waiting
	 *  for settle — settle observation is prompt()/waitSettle()'s job. */
	submitPrompt(req: PromptReq): Promise<void>;
	/** Poll/observe until the agent settles (idle|done|blocked) or timeout. */
	waitSettle(req: {
		name: string;
		timeoutMs: number;
		signal?: AbortSignal;
		/** v1.8 heartbeat: called once per poll slice with the last observed state,
		 *  so a long blocking wait can stream liveness via onUpdate instead of
		 *  looking frozen. Throttling is the caller's job; never throws. */
		onPoll?: (info: { status: AgentStatusName; started: boolean; elapsedMs: number }) => void;
		/** v1.9: caller-owned completion proof, polled in the
		 *  start-up phase on every slice whose observation cannot prove life
		 *  (idle/unknown/unresolved — herdr builds that never report working for
		 *  pi workers would otherwise spin the full budget against a finished
		 *  worker). True → settle kind "finished-before-watch" (status "idle").
		 *  Must be cheap, side-effect-free, and answer from evidence written
		 *  AFTER this spawn, so a stale artifact can never false-settle a fresh
		 *  worker. Throws are treated as false. */
		proofSettled?: () => Promise<boolean>;
		/** v1.14 (watch.releaseOn=started): release the wait as soon as the agent
		 *  is observed working — the orchestrator hands off to the background
		 *  watcher instead of blocking the rest of the settle gate. Never set for
		 *  probes (their full window IS the verdict). */
		releaseOnStarted?: boolean;
	}): Promise<SettleResult>;
	getStatus(name: string): Promise<AgentStatus | null>;
	/** Recent console output for a worker (terminal snapshot, few hundred lines tail).
	 *  Optional: probe-verdict from streaming; implementations without console
	 *  readback may reject — callers must fall back to status-based verdicts. */
	readConsole?(name: string, opts?: { maxChars?: number }): Promise<string>;
	/** Full-fidelity LIVE STREAM of one worker's console events (vNext,
	 *  additive — same optionality pattern as readConsole): a pull-based
	 *  async-iterable of ConsoleEvents. Historical events with seq > afterSeq
	 *  (omit or 0 for the whole retained history) are delivered first, then
	 *  live events as the worker produces them. Retention is bounded: an
	 *  implementation may keep only a capped recent window per worker — when
	 *  afterSeq points before the retained window, the iteration OPENS with a
	 *  `gap` ConsoleEvent naming the first retained seq, and the events after
	 *  it are contiguous. ITERATION LIFETIME: while the worker lives the
	 *  iteration stays open — even after a settle (agent_settled/idle), more
	 *  prompts may follow; once the worker's process has terminated, the
	 *  iteration ENDS (done) after the buffered backlog drains, so a for-await
	 *  consumer always completes and never hangs on events that can never
	 *  come. Callers without the method MUST degrade to
	 *  readConsole polling (same probe pattern as readConsole: a
	 *  `typeof transport.streamConsole === "function"` check). The fallback
	 *  for anything older than the retained window is readConsole's
	 *  last-maxChars snapshot semantics. Unknown worker → structured E_STATUS
	 *  throw (Law 8), same as readConsole. */
	streamConsole?(name: string, opts?: { afterSeq?: number }): AsyncIterable<ConsoleEvent> & {
		/** Explicit teardown of the live subscription (present on adapters
		 *  backed by a real subscriber registry — the rpc fidelity store).
		 *  Consumers that stop consuming EARLY (a closed detail pane) MUST call
		 *  it when present: a bare for-await break does NOT unregister the
		 *  subscriber (the iterator has no return() step) and leaks it into the
		 *  adapter's subscriber set (Law 3: per-session mounts, torn down
		 *  cleanly). After unsubscribe() the buffered backlog stays pullable;
		 *  live delivery stops. */
		unsubscribe?(): void;
	};
	listStatuses(): Promise<AgentStatus[]>;
	/** Mid-run steering: deliver guidance to the worker's LIVE console (its
	 *  stdin) while the worker is alive. OPTIONAL — same optionality pattern
	 *  as readConsole/streamConsole: adapters without a live-stdin write path
	 *  OMIT it (herdr steers mailbox-only by contract; the in-memory fake
	 *  omits it so the mailbox fallback stays exercisable) and callers fall
	 *  back to the file mailbox (a-<name>.json via the mailbox-store posting
	 *  core). Structured errors (Law 8): an unknown or already-exited worker
	 *  throws E_PROMPT_STALLED — never a raw Error; a thrown steer is the
	 *  CALLER'S signal to fall back, never a silent loss. Implemented by the
	 *  rpc adapter as a prompt onto the child's stdin with the mid-stream
	 *  streamingBehavior:"steer" fallback (see src/host/rpc.ts). */
	steer?(req: { name: string; text: string; timeoutMs?: number }): Promise<void>;
	/** Close the placement (worktree removal + workspace reconcile, or tab
	 *  close). Idempotent by seam semantics: an ALREADY-GONE placement resolves
	 *  with { alreadyGone: true } instead of throwing — callers read the field,
	 *  never the message text. Genuine close failures still throw (E_TEARDOWN). */
	teardown(req: TeardownReq): Promise<TeardownResult>;
	capabilities(): TransportCapabilities;
}

// ---------------------------------------------------------------------------
// Error taxonomy (ARCHITECTURE.md Law 8) — tool results, never raw throws past the tool
// ---------------------------------------------------------------------------

export type DelegateErrorCode =
	| "E_BRIEF"
	| "E_NAME"
	| "E_TIER"
	| "E_PLACE"
	| "E_START"
	| "E_PROMPT_STALLED"
	| "E_TIMEOUT"
	| "E_TEARDOWN"
	| "E_STATUS"
	| "E_REPORT_MISSING"
	| "E_REPORT_INVALID"
	| "E_BUDGET"
	| "E_CONTEXT";

/** Named worker tier from the config's `tiers` table (v1.9.2): a
 *  provider/model/thinking combination. Any key may be absent — unresolved
 *  keys fall through to the config's `defaults` section. There is NO built-in
 *  tier: environments without config fail fast with E_TIER. */
export interface SpawnTier {
	provider?: string;
	model?: string;
	thinking?: string;
}

export interface DelegateError extends Error {
	code: DelegateErrorCode;
	/** Guidance embedded for the orchestrator model (the GUIDANCE table below). */
	guidance: string;
	cause?: unknown;
}

// ---------------------------------------------------------------------------
// Budget governor — enforced, config defaults, per-session
// ---------------------------------------------------------------------------

export interface SessionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	/** Context size AS THE MODEL SAW IT at the last assistant response
	 *  (usage.totalTokens of the final assistant message) — pi's own
	 *  getContextUsage() basis. Null right after compaction / in old sessions. */
	lastTotalTokens: number | null;
}

/** The ONE spelling of the operator's 80% threshold (Law 9 — one artifact,
 *  one source of truth): every 80% gauge (percent or fraction) derives from
 *  this constant. Fraction of budget above which terminal results carry a
 *  burn warning. */
export const BUDGET_WARN_FRACTION = 0.8;

/** Context-gauge thresholds — the operator's restart line.
 *  Derived ×100 from BUDGET_WARN_FRACTION (exact in IEEE-754: 0.8*100 === 80). */
export const CONTEXT_WARN_PCT = BUDGET_WARN_FRACTION * 100;
export const CONTEXT_CRITICAL_PCT = 90;
/** Turns tripwire: assistant-message count above which a session is warned. */
export const CONTEXT_TURNS_WARN = 40;

/** Model context windows (tokens) — pi model catalog values. */
export const CONTEXT_WINDOWS: Record<string, number> = {
	"glm-5.3-flash": 524_300,
};
export const DEFAULT_CONTEXT_WINDOW = 250_100;

/** Default when no config file and no per-call budgetTokens (skill: execution
 *  tier ≤ ~150k output... conservative total-token default; operators override). */
export const DEFAULT_BUDGET_TOKENS = 150_000;

/** Config file location: ~/.pi/agent/pi-delegate.config.json,
 *  shape {"contextWindow": number, "defaults": {"tier": string,
 *  "budgetTokens": number, "provider": string, "model": string,
 *  "thinking": string}, "tiers": {"<name>": SpawnTier}}.
 *  Missing/corrupt → fallbacks (per key); an unconfigured environment has NO
 *  built-in worker tier — delegate refuses with E_TIER.
 * <p>
 * FUNCTION_CONTRACT (constant):
 * Input: none (resolved once at module load via pi's getAgentDir(), which
 *   honors PI_CODING_AGENT_DIR and defaults to ~/.pi/agent)
 * Output: the ABSOLUTE config path — the single source every config reader
 *   takes the path from (usage.ts resolvers, observe.ts watch config,
 *   index.ts host binding). Was a dead relative suffix before — the six
 *   live readers each rebuilt the path by hand.
 * Guarantees:
 *   - homedir() is cached per process by bun (documented in test/usage-check.ts),
 *     so module-load resolution is equivalent to per-call resolution there;
 *     in node (production pi) the home cannot change mid-session either.
 * Raises: never */
export const BUDGET_CONFIG_PATH = join(getAgentDir(), "pi-delegate.config.json");

// ---------------------------------------------------------------------------
// Report contract — strict, fixed schema
// ---------------------------------------------------------------------------

export interface ReportEvidence {
	claim: string;
	/** "path:line" reference. */
	file: string;
	note?: string;
}

export interface WorkerReport {
	worker: string;
	status: "pass" | "fail";
	summary: string;
	artifacts: string[];
	evidence: ReportEvidence[];
}

/** Name rules from the delegate skill: [a-z][a-z0-9_-]{0,31}, unique among live agents. */
export const WORKER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Canonical example report — the single source of truth for the
 *  base report shape. Embedded into every worker prompt via briefPrompt. Since
 *  v1.2 a brief MAY carry a reportSchema fragment; when
 *  present, briefPrompt echoes it on top of this base canon. "worker" is a
 *  placeholder; callers substitute the canonical name. Canon = minimum, not a
 *  whitelist: extra fields stay allowed. */
export const REPORT_EXAMPLE: WorkerReport = {
	worker: "<your assigned worker name>",
	status: "pass",
	summary: "one-paragraph outcome",
	artifacts: ["path/to/artifact"],
	evidence: [{ claim: "what was verified", file: "path/to/file.ts:42" }],
};

/**
 * Options for the worker-prompt phrasing (issue #25).
 * <p>
 * `verbsFallback` mirrors the config key `swarm.verbsFallback` (default true):
 * true appends the documented RAW-FILE fallback paragraph (the pre-#25
 * phrasing survives one release behind the flag); false drops it, leaving the
 * verb invocation as the only instruction. The verb phrasing is ALWAYS the
 * primary instruction — the flag controls the fallback's availability, not
 * which instruction leads.
 */
export interface BriefPromptOptions {
	verbsFallback?: boolean;
}

/** Absolute path of the `swarm` CLI entry shipped with this extension — the
 *  resolvable invocation target embedded in every worker prompt (#25: invoke
 *  as `bun <path>/src/swarm/cli.ts <verb>`; bin registration is deferred).
 *  Resolved from THIS module's own location (the package ships `src/` and
 *  `src/swarm/` together), never from a hardcoded repository path. Pure — no
 *  filesystem access; a runtime without import.meta.url keeps the relative
 *  fallback. */
export const SWARM_CLI_PATH: string = (() => {
	try {
		return join(dirname(fileURLToPath(import.meta.url)), "swarm", "cli.ts");
	} catch {
		return join("src", "swarm", "cli.ts");
	}
})();

/**
 * Fixed prompt template — the one line sent to the worker console.
 *  Explicit tool-use instruction: flash-class models may otherwise treat
	 *  "reply with the file path" as the whole task and never read the brief.
	 *  Carries the canonical worker name so briefs can stay name-agnostic
	 *  (demo run 2: brief/manifest name mismatch caused a false collect miss).
	 *  Issue #25: worker interaction is phrased over the `swarm` CLI verbs
	 *  (read-brief / ask / poll-answer / write-progress / write-report) with
	 *  the resolvable invocation path; the raw-file phrasing survives one
	 *  release as the documented fallback behind BriefPromptOptions.verbsFallback.
	 *  Report contract: required fields + canonical example (REPORT_EXAMPLE,
	 *  worker name substituted). Since v1.2 a brief MAY declare a reportSchema
	 *  fragment; when the caller passes one, it is echoed
	 *  verbatim after the base contract so the worker sees the exact schema its
	 *  report will be validated against at settle. */
export function briefPrompt(
	briefPath: string,
	workerName: string,
	briefSchema?: Record<string, unknown> | null,
	options?: BriefPromptOptions,
): string {
	const schemaEcho =
		briefSchema !== null && briefSchema !== undefined
			? ` Task-specific report schema (this brief declares reportSchema): on top of the base contract above, the report MUST also satisfy this JSON schema: ${JSON.stringify(briefSchema)}. Extra fields still allowed unless the fragment says otherwise.`
			: "";
	// Issue #25: verbs are the PRIMARY instruction; the flag only decides
	// whether the one-release raw-file fallback paragraph is present.
	// The explicit --brief/--task/--worker flags ride in every example: the
	// brief name is NOT guaranteed to be brief-<worker>.md, and the identity env
	// cannot be assumed on a backend whose pane env is not ours (herdr) — so the
	// examples must be self-sufficient. The env vars stay the canonical
	// mechanism when present.
	const task = basename(dirname(briefPath));
	const identityFlags = `--task ${task} --worker ${workerName}`;
	const verbsFallback = options?.verbsFallback ?? true;
	const fallbackText = verbsFallback
		? ` Fallback (only if the swarm CLI cannot run in your environment): write the raw exchange files directly — your question to q-${workerName}.json next to the brief (the answer appears at a-${workerName}.json), progress pings to p-${workerName}.jsonl, and your final report to report-${workerName}.json. These are the same files the verbs write; the verbs' serialization is the byte-exact reference, so a raw write must follow the extension's on-disk JSON convention (tab-indented JSON plus a trailing newline).`
		: "";
	return `Use your read tool to read ${briefPath}, then carry out the task it describes exactly, including its OUTPUT section. Your assigned worker name is "${workerName}": wherever the brief names the worker, use "${workerName}" instead of any name written in the brief. Interact with the orchestrator ONLY through the \`swarm\` CLI — run it from bash as \`bun ${SWARM_CLI_PATH} <verb>\`. The orchestrator exports SWARM_TASK / SWARM_WORKER / SWARM_SCHEMA_DIR into your environment when the backend supports it; rely on that when present, and pass the explicit --brief/--task/--worker flags shown in every example below so the invocation works regardless. Verbs: \`read-brief\` (bun ${SWARM_CLI_PATH} read-brief --brief ${briefPath} ${identityFlags}) reads your brief; \`ask\` (bun ${SWARM_CLI_PATH} ask --question "<text>" ${identityFlags}) posts a question — then go idle and use \`poll-answer\` (bun ${SWARM_CLI_PATH} poll-answer ${identityFlags}) to fetch the answer, polling again between steps when the brief says steering is expected; \`write-progress\` (bun ${SWARM_CLI_PATH} write-progress --phase "<label>" [--pct <0-100>] ${identityFlags}) records a liveness ping; and \`write-report\` (bun ${SWARM_CLI_PATH} write-report --brief ${briefPath} ${identityFlags}, report JSON on stdin) writes your final report. Never hand-write report, mailbox, or progress files — the verbs own those paths and formats.${fallbackText} When the task is complete, write your report with \`write-report\` and reply with only the file path. Report contract — this contract ALWAYS overrides the brief on report format/shape: if the brief's OUTPUT section specifies a different report shape, keep ALL required contract fields anyway and put the brief-specific data in extra fields. Required fields: "worker" must be exactly "${workerName}"; "status" strictly "pass" or "fail" (never "done"/"ok"/"success" — a report with any other status is rejected at collect and wakes your orchestrator); "summary" a non-empty string; "artifacts" an array of strings; "evidence" an array of objects, each with non-empty string "claim" and "file". Extra fields allowed. Canonical example (write the report as JSON in exactly this shape): ${JSON.stringify({ ...REPORT_EXAMPLE, worker: workerName })}.${schemaEcho}`;
}

// ---------------------------------------------------------------------------
// Mailbox envelopes — file-based two-way channel
// ---------------------------------------------------------------------------

/** Worker → orchestrator question (q-<name>.json). */
export interface QuestionEnvelope {
	worker: string;
	/** ISO 8601 timestamp. */
	ts: string;
	question: string;
	context?: string;
	/** Optional concrete options the orchestrator can pick from. */
	options?: string[];
}

/** Orchestrator → worker answer/steering (a-<name>.json). */
export interface AnswerEnvelope {
	/** Law 7 (Wave 4 item 3): format version, stamped by the writer; absent
	 *  = legacy v1 on read. */
	schemaVersion?: number;
	from: "orchestrator";
	ts: string;
	/** The answer text, or mid-run steering instruction. */
	answer: string;
}

/** Validate a question envelope read from the mailbox (lenient on context/options). */
export function isQuestionEnvelope(v: unknown): v is QuestionEnvelope {
	if (typeof v !== "object" || v === null) return false;
	const q = v as Record<string, unknown>;
	return typeof q.worker === "string" && typeof q.ts === "string" && typeof q.question === "string";
}

// ---------------------------------------------------------------------------
// Progress pings — worker → orchestrator liveness events
// ---------------------------------------------------------------------------

/** One progress ping line in p-<name>.jsonl (append-only). */
export interface ProgressEvent {
	worker: string;
	/** ISO 8601 timestamp. */
	ts: string;
	/** Free-form phase label ("researching", "implementing", "verifying"…). */
	phase: string;
	/** Optional 0–100 completion estimate. */
	pct?: number;
	note?: string;
}

export function isProgressEvent(v: unknown): v is ProgressEvent {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Record<string, unknown>;
	return (
		typeof p.worker === "string" &&
		typeof p.ts === "string" &&
		typeof p.phase === "string" &&
		(p.pct === undefined || typeof p.pct === "number") &&
		(p.note === undefined || typeof p.note === "string")
	);
}

/** v1.8: true when the session JSONL contains at least one
 *  assistant message — proof the prompt was consumed and the agent replied.
 *  Used to distinguish "idle because never started" from "idle because already
 *  finished" when a watcher attaches after herdr aged done→idle (observed
 *  aging: minutes). Tolerant: missing/unreadable/corrupt file → false, never
 *  throws. Exported for tests.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: sessionPath — the worker's pi session JSONL path
 * Output: true iff at least one line carries an assistant message
 * Guarantees:
 *   - scans line-by-line with a cheap `"assistant"` prefilter, so a large
 *     session costs one pass without JSON-parsing most lines
 *   - partial/corrupt lines are skipped; missing file → false
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — the worker's session JSONL file written
 *   by pi (path supplied by the caller from herdr/pi session storage).
 */
export function sessionHasReply(sessionPath: string): boolean {
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf8");
	} catch {
		return false;
	}
	for (const line of raw.split("\n")) {
		if (!line.includes('"assistant"')) continue; // cheap prefilter
		try {
			const e = JSON.parse(line) as { message?: { role?: unknown } };
			if (e.message?.role === "assistant") return true;
		} catch {
			// partial/corrupt line — skip
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DelegateErrorImpl extends Error implements DelegateError {
	readonly code: DelegateErrorCode;
	readonly guidance: string;
	override cause?: unknown;

	constructor(code: DelegateErrorCode, message: string, guidance: string, cause?: unknown) {
		super(message);
		this.name = "DelegateError";
		this.code = code;
		this.guidance = guidance;
		if (cause !== undefined) this.cause = cause;
	}
}

/** Maps a failure into the E_* taxonomy with the §7 guidance attached.
 *  Exported for the backend adapters (src/herdr/host.ts) — was module-private
 *  in the merged src/transport.ts. */
export function delegateError(code: DelegateErrorCode, message: string, cause?: unknown): DelegateErrorImpl {
	return new DelegateErrorImpl(code, message, GUIDANCE[code], cause);
}

/**
 * Migration stage 1 (audit, errors-defect 2): the guidance TEXT has ONE
 * writer — the central §7 dictionary (GUIDANCE). Adapters never write their
 * own hint phrasing: they append a backend FACT (candidate names, existing
 * agent, stderr detail) to the dictionary's base text via this helper.
 * Before this, three sources phrased the same "name taken" advice three
 * different ways (seam: "use the canonical name", herdr: "choose a different
 * name", fake: a third variant).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: code — taxonomy entry; message — the error message (facts, may
 *   name the backend); detail — the adapter's fact clause (or empty)
 * Output: DelegateErrorImpl whose guidance = GUIDANCE[code], optionally
 *   followed by the detail clause in parentheses
 * Guarantees:
 *   - the base phrasing of every hint is byte-identical across adapters
 *   - empty/absent detail → guidance is exactly GUIDANCE[code]
 * Raises: never
 */
export function delegateErrorWithDetail(
	code: DelegateErrorCode,
	message: string,
	detail?: string,
	cause?: unknown,
): DelegateErrorImpl {
	return new DelegateErrorImpl(
		code,
		message,
		detail ? `${GUIDANCE[code]} (${detail})` : GUIDANCE[code],
		cause,
	);
}

/** Guidance text — embedded in every typed error.
 *  Migration stage 1: EXPORTED as the single writer of the base hint text —
 *  adapters may only append a detail clause (delegateErrorWithDetail); the
 *  single-source pin in test/error-code-check.ts asserts the base phrasing
 *  exists nowhere else. */
export const GUIDANCE: Record<DelegateErrorCode, string> = {
	E_BRIEF: "Write the brief file first, then retry the delegate call.",
	E_NAME:
		"Name collision: the requested worker name is taken by a live agent — choose a different name.",
	E_TIER:
		"Add tiers/defaults to ~/.pi/agent/pi-delegate.config.json or pass provider/model/thinking explicitly on the delegate call.",
	E_PLACE:
		"Placement failed; backend stderr is attached. Reconcile via /delegate-teardown (or the host workspace listing) before retrying.",
	E_START: "Check console readiness (the console must sit at an interactive shell prompt); retry is a new delegate call.",
	E_PROMPT_STALLED: "Worker console not at prompt; inspect via delegate_status.",
	E_TIMEOUT: "Worker still running; poll delegate_status.",
	E_TEARDOWN:
		"Teardown (worktree remove / tab close / workspace reconcile) failed; backend stderr is attached — reconcile manually via /delegate-teardown or the host workspace listing, then retry the close.",
	E_STATUS:
		"Status read from the backend failed (worker may have exited or the backend is unreachable) — reconcile via the host's status listing before trusting any lifecycle decision.",
	E_REPORT_MISSING: "Settled but no report file — treat as failed spawn; diagnosed retry is the orchestrator's move.",
	E_REPORT_INVALID: "Report exists but fails the JSON schema; attach validator output; treated identically to missing.",
	E_BUDGET:
		"Worker over output budget — pick a NEW worker name or pass an explicit higher budgetTokens; budget decline across diagnosed retries is orchestrator policy.",
	E_CONTEXT:
		"Worker session near context-window compaction — start a NEW worker name; this session's next prompt would compact and lose the brief.",
};
