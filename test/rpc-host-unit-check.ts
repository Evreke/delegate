/**
 * rpc-host-unit-check — deterministic unit checks for the rpc adapter's event
 * pump and waitSettle contract (src/host/rpc.ts), with NO real pi process and
 * NO LLM call.
 *
 * Run with: bun test/rpc-host-unit-check.ts   (from repo root)
 *
 * Mechanism: the adapter is constructed with an INJECTED child-process
 * factory (constructor option spawnProcess — the test seam; the default stays
 * node's real spawn, so createRpcTransport() with no args is unchanged). The
 * fake ChildProcess-like object records every stdin write and lets the test
 * feed JSONL records over the fake stdout — the REAL pump (pumpStdout → the
 * exported pure reducer applyRpcEvent) processes them, so framing, state
 * effects, dialog auto-cancel and command correlation are all exercised
 * verbatim. The pure units (mapAgentStatus / applyRpcEvent / pushConsoleLine)
 * are additionally driven directly for the state shapes the running adapter
 * cannot present externally (e.g. pre-get_state "unknown", a dialog that
 * stays pending because the cancel write failed).
 *
 * The LIVE worker flow (real `pi --mode rpc` child) is the opt-in e2e leg in
 * rpc-host-e2e-check.ts (RPC_E2E=1) and the parity leg in
 * host-parity-check.ts (skip-guarded on `pi --version`, no LLM traffic).
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
	applyRpcEvent,
	createRpcTransport,
	mapAgentStatus,
	type RpcAgentState,
} from "../src/host/rpc.ts";
import { DelegateErrorImpl, type Placement, type Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// Fake child process — the injected seam double
// ---------------------------------------------------------------------------

interface FakeChildOpts {
	/** Scripted responses consumed per `prompt` command, in order. A prompt
	 *  command with no scripted response gets NO response (the caller hangs —
	 *  used only where the test never awaits it). */
	promptResponses?: Array<{ success: boolean; error?: string }>;
	/** When set, stdin.write() throws after this many successful writes
	 *  (simulates a closed stdin — the "stdin gone" paths). */
	failStdinWritesAfter?: number;
}

class FakeChildProcess extends EventEmitter {
	readonly writes: Array<Record<string, unknown>> = [];
	readonly kills: string[] = [];
	private readonly opts: FakeChildOpts;
	private stdinWriteCount = 0;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin: { write: (s: string | Buffer) => boolean };

	constructor(opts: FakeChildOpts = {}) {
		super();
		this.opts = opts;
		this.stdin = {
			write: (s: string | Buffer): boolean => {
				this.stdinWriteCount++;
				if (this.opts.failStdinWritesAfter !== undefined && this.stdinWriteCount > this.opts.failStdinWritesAfter) {
					throw new Error("EPIPE: fake stdin closed");
				}
				const cmd = JSON.parse(String(s)) as Record<string, unknown> & { id?: string };
				this.writes.push(cmd);
				if (cmd.type === "get_state") {
					queueMicrotask(() =>
						this.emitLine({
							type: "response",
							command: "get_state",
							id: cmd.id,
							success: true,
							data: { sessionFile: "/tmp/rpc-unit-fake-session.jsonl" },
						}),
					);
				} else if (cmd.type === "prompt") {
					const scripted = this.opts.promptResponses?.shift();
					if (scripted) {
						queueMicrotask(() =>
							this.emitLine({
								type: "response",
								command: "prompt",
								id: cmd.id,
								success: scripted.success,
								...(scripted.error !== undefined ? { error: scripted.error } : {}),
							}),
						);
					}
				}
				return true;
			},
		};
	}

	kill(signal?: NodeJS.Signals): this {
		this.kills.push(signal ?? "SIGTERM");
		return this;
	}

	/** Test helper: feed one JSON record over the fake stdout (LF-framed). */
	emitLine(obj: unknown): void {
		this.stdout.emit("data", `${JSON.stringify(obj)}\n`);
	}

	/** Test helper: simulate child exit (no real process involved). */
	simulateExit(code: number | null, signal: string | null): void {
		this.emit("exit", code, signal);
	}
}

// ---------------------------------------------------------------------------
// Rig: one adapter + one fake child, driven through the REAL pump
// ---------------------------------------------------------------------------

const WORKTREE_ROOT = join(tmpdir(), `rpc-unit-wt-${process.pid}`);
const repos: string[] = [];

interface Rig {
	host: Transport;
	child: FakeChildProcess;
	name: string;
	placement: Placement;
}

/** Adapter with the fake child injected; agent started (get_state done —
 *  stateKnown true, status "idle"). No real pi process exists. */
async function startWithFakeChild(opts: FakeChildOpts & { name?: string } = {}): Promise<Rig> {
	const child = new FakeChildProcess(opts);
	const host = createRpcTransport({
		worktreeRoot: WORKTREE_ROOT,
		subOrchestrator: false,
		spawnProcess: () => child as unknown as ChildProcess,
	});
	const repo = mkdtempSync(join(tmpdir(), "rpc-unit-repo-"));
	repos.push(repo);
	const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "unit" });
	const name = opts.name ?? "unit-worker";
	const start = await host.startAgent({
		name,
		placementRef: placement.placementRef ?? "",
		provider: "p",
		model: "m",
		thinking: "low",
		timeoutMs: 5_000,
	});
	return { host, child, name: start.name, placement };
}

/** Bare hand-built state for the pure units (shapes the running adapter
 *  cannot present externally). */
function bareState(overrides: Partial<RpcAgentState> = {}): RpcAgentState {
	return {
		name: "bare",
		placement: { kind: "tab", checkoutPath: "/bare", backend: "rpc", placementRef: "rpc:shared:0" },
		child: new FakeChildProcess() as unknown as ChildProcess,
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
		...overrides,
	};
}

function isE(err: unknown, code: string): boolean {
	return err instanceof DelegateErrorImpl && err.code === code;
}

try {
	// --- R1: status mapping -------------------------------------------------
	{
		check("R1.1 pre-get_state (nothing observed) → unknown", mapAgentStatus(bareState()) === "unknown");
		check("R1.2 stateKnown → idle", mapAgentStatus(bareState({ stateKnown: true })) === "idle");
		check("R1.3 settledSeq > 0 → idle", mapAgentStatus(bareState({ settledSeq: 2 })) === "idle");
		const started = bareState();
		applyRpcEvent(started, { type: "agent_start" });
		check("R1.4 agent_start → working (and everStarted flips)", mapAgentStatus(started) === "working" && started.everStarted && started.running);
		applyRpcEvent(started, { type: "agent_settled" });
		check("R1.5 agent_settled after start → idle (running cleared, epoch counted)", mapAgentStatus(started) === "idle" && !started.running && started.settledSeq === 1);
		check("R1.6 pending dialog → blocked", mapAgentStatus(bareState({ dialogPending: true, stateKnown: true })) === "blocked");
		check(
			"R1.7 child exit wins over everything → done",
			mapAgentStatus(bareState({ running: true, dialogPending: true, exited: { code: 0, signal: null } })) === "done",
		);
	}
	// Adapter-level cross-check through the REAL pump (fake stdout → getStatus).
	{
		const rig = await startWithFakeChild();
		check("R1.8 adapter: after get_state only → idle", (await rig.host.getStatus(rig.name))?.status === "idle");
		rig.child.emitLine({ type: "agent_start" });
		check("R1.9 adapter: agent_start over the pump → working", (await rig.host.getStatus(rig.name))?.status === "working");
		rig.child.emitLine({ type: "agent_settled" });
		check("R1.10 adapter: agent_settled over the pump → idle", (await rig.host.getStatus(rig.name))?.status === "idle");
		rig.child.simulateExit(0, null);
		check("R1.11 adapter: child exit over the pump → done", (await rig.host.getStatus(rig.name))?.status === "done");
	}

	// --- R0: JSONL framing through the real pump (LF split, CR strip) -------
	{
		const rig = await startWithFakeChild();
		// Two records in ONE chunk; the second carries a trailing CR.
		rig.child.stdout.emit("data", `${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify({ type: "agent_settled" })}\r\n`);
		rig.child.stdout.emit("data", "this is not json\n");
		check("R0.1 two LF-framed records in one chunk + CR strip + non-JSON tolerated", (await rig.host.getStatus(rig.name))?.status === "idle");
		check("R0.2 non-JSON line landed in the console log", (await rig.host.readConsole?.(rig.name))?.includes("[unparsed stdout] this is not json") === true);
	}

	// --- R2: dialog auto-cancel ---------------------------------------------
	{
		const rig = await startWithFakeChild();
		const before = rig.child.writes.length;
		rig.child.emitLine({ type: "extension_ui_request", id: "ui-1", method: "select" });
		const cancel = rig.child.writes.find((w) => w.type === "extension_ui_response");
		check(
			"R2.1 select dialog → extension_ui_response with cancelled:true, matching id",
			!!cancel && cancel.id === "ui-1" && cancel.cancelled === true && rig.child.writes.length === before + 1,
			JSON.stringify(rig.child.writes.slice(before)),
		);
		check("R2.2 the auto-cancel leaves no dialog pending (never blocked)", (await rig.host.getStatus(rig.name))?.status === "idle");
		for (const method of ["confirm", "input", "editor"]) {
			rig.child.emitLine({ type: "extension_ui_request", id: `ui-${method}`, method });
		}
		check(
			"R2.3 confirm/input/editor auto-cancelled too",
			rig.child.writes.filter((w) => w.type === "extension_ui_response").length === 4,
			JSON.stringify(rig.child.writes),
		);
	}
	{
		// Even when the cancel write fails (stdin gone), dialogPending is cleared
		// synchronously — the headless worker is never externally "blocked". The
		// blocked MAPPING itself is pinned on the pure unit (R1.6).
		const rig = await startWithFakeChild({ failStdinWritesAfter: 1 });
		rig.child.emitLine({ type: "extension_ui_request", id: "ui-x", method: "confirm" });
		check("R2.4 even a failed cancel write clears the dialog (never externally blocked)", (await rig.host.getStatus(rig.name))?.status === "idle");
	}

	// --- R3: fire-and-forget UI methods --------------------------------------
	{
		const rig = await startWithFakeChild();
		const before = rig.child.writes.length;
		for (const method of ["notify", "setWidget", "setTitle", "setStatus", "set_editor_text"]) {
			rig.child.emitLine({ type: "extension_ui_request", id: `ff-${method}`, method });
		}
		check("R3.1 fire-and-forget UI methods produce NO stdin write", rig.child.writes.length === before, JSON.stringify(rig.child.writes.slice(before)));
		check("R3.2 fire-and-forget leaves the agent unblocked", (await rig.host.getStatus(rig.name))?.status === "idle");
	}

	// --- R4: prompt mid-stream fallback ---------------------------------------
	{
		const rig = await startWithFakeChild({
			promptResponses: [
				{ success: false, error: "cannot prompt: agent is streaming" },
				{ success: true },
			],
		});
		await rig.host.submitPrompt({ name: rig.name, text: "hello", timeoutMs: 5_000 });
		const prompts = rig.child.writes.filter((w) => w.type === "prompt");
		check(
			"R4.1 streaming rejection retried with streamingBehavior:'steer'",
			prompts.length === 2 &&
				prompts[0]?.streamingBehavior === undefined &&
				prompts[1]?.streamingBehavior === "steer" &&
				prompts[1]?.message === "hello",
			JSON.stringify(prompts),
		);
		// The accepted prompt opened settle epoch 1 — a subsequent settle satisfies.
		rig.child.emitLine({ type: "agent_settled" });
		const r = await rig.host.waitSettle({ name: rig.name, timeoutMs: 2_000 });
		check("R4.2 the accepted prompt opened settle epoch 1 (settle satisfies)", r.kind === "settled" && r.status === "idle", JSON.stringify(r));
	}
	{
		const rig = await startWithFakeChild({ promptResponses: [{ success: false, error: "denied" }] });
		try {
			await rig.host.submitPrompt({ name: rig.name, text: "x", timeoutMs: 5_000 });
			check("R4.3 non-streaming prompt rejection → E_PROMPT_STALLED", false, "no throw");
		} catch (err) {
			check("R4.3 non-streaming prompt rejection → E_PROMPT_STALLED", isE(err, "E_PROMPT_STALLED"), String(err));
		}
	}
	{
		const rig = await startWithFakeChild({
			promptResponses: [
				{ success: false, error: "agent is streaming" },
				{ success: false, error: "still streaming" },
			],
		});
		try {
			await rig.host.submitPrompt({ name: rig.name, text: "x", timeoutMs: 5_000 });
			check("R4.4 rejected steer → E_PROMPT_STALLED", false, "no throw");
		} catch (err) {
			check("R4.4 rejected steer → E_PROMPT_STALLED", isE(err, "E_PROMPT_STALLED"), String(err));
		}
	}

	// --- R5: settled-epoch keying --------------------------------------------
	{
		// Never-started path: a settle observed BEFORE any prompt is accepted
		// must never satisfy a later waitSettle (epoch 0 → keep waiting).
		const rig = await startWithFakeChild();
		rig.child.emitLine({ type: "agent_settled" });
		const t0 = Date.now();
		const r = await rig.host.waitSettle({ name: rig.name, timeoutMs: 400 });
		check(
			"R5.1 pre-prompt settle never satisfies (wait burns the budget → never-started)",
			r.kind === "never-started" && Date.now() - t0 >= 380,
			JSON.stringify({ r, elapsed: Date.now() - t0 }),
		);
	}
	{
		// A settle observed AFTER submitPrompt (epoch n) satisfies that wait —
		// proven dynamically: the settle arrives while the wait is in flight.
		const rig = await startWithFakeChild({ promptResponses: [{ success: true }] });
		await rig.host.submitPrompt({ name: rig.name, text: "go", timeoutMs: 5_000 });
		const waiting = rig.host.waitSettle({ name: rig.name, timeoutMs: 5_000 });
		setTimeout(() => rig.child.emitLine({ type: "agent_settled" }), 100);
		const r = await waiting;
		check("R5.2 settle observed after submitPrompt (epoch n) satisfies the wait", r.kind === "settled" && r.status === "idle", JSON.stringify(r));
	}
	{
		// Stale settle rejection: settledSeq from an EARLIER epoch does not
		// satisfy a LATER wait (epoch n+1 keeps waiting → budget burned).
		const rig = await startWithFakeChild({ promptResponses: [{ success: true }, { success: true }] });
		await rig.host.submitPrompt({ name: rig.name, text: "first", timeoutMs: 5_000 });
		rig.child.emitLine({ type: "agent_settled" }); // satisfies epoch 1 only
		await rig.host.submitPrompt({ name: rig.name, text: "second", timeoutMs: 5_000 }); // epoch 2
		const t0 = Date.now();
		const r = await rig.host.waitSettle({ name: rig.name, timeoutMs: 400 });
		check(
			"R5.3 stale settle from an earlier epoch does not satisfy a later wait",
			r.kind !== "settled" && Date.now() - t0 >= 380,
			JSON.stringify({ r, elapsed: Date.now() - t0 }),
		);
	}

	// --- R6: exit-before-start ------------------------------------------------
	{
		const rig = await startWithFakeChild();
		rig.child.simulateExit(0, null); // no agent_start ever observed
		const r = await rig.host.waitSettle({ name: rig.name, timeoutMs: 5_000 });
		check("R6.1 exit with no agent_start → settle kind 'settled', status 'done'", r.kind === "settled" && r.status === "done", JSON.stringify(r));
	}

	// --- R7: readConsole --------------------------------------------------------
	{
		const rig = await startWithFakeChild();
		rig.child.emitLine({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
		rig.child.emitLine({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OUTPUT: OK sentinel" }] } });
		const full = (await rig.host.readConsole?.(rig.name)) ?? "";
		check(
			"R7.1 assistant text + tool activity included",
			full.includes("tool: read") && full.includes("assistant: OUTPUT: OK sentinel"),
			full,
		);
		const tail = (await rig.host.readConsole?.(rig.name, { maxChars: 10 })) ?? "";
		check(
			"R7.2 maxChars truncates from the HEAD, keeps the tail",
			tail.length <= 10 && tail === full.slice(full.length - 10),
			`tail=${JSON.stringify(tail)}`,
		);
		// THE regression pin (BUG_FIX_CONTEXT in rpc.ts): spawn.ts extracts
		// readConsole UNBOUND — the extracted function must work standalone.
		const unbound = rig.host.readConsole;
		if (typeof unbound !== "function") {
			check("R7.3 unbound extraction is safe (bound at construction)", false, "readConsole missing");
		} else {
			let unboundOk = false;
			let unboundText = "";
			try {
				unboundText = await unbound(rig.name, { maxChars: 100 });
				unboundOk = unboundText.length > 0;
			} catch (err) {
				unboundOk = false;
				void err;
			}
			check("R7.3 readConsole extracted UNBOUND still works (bound at construction)", unboundOk, unboundText.slice(0, 80));
		}
	}

	// --- R8: waitSettle contract pieces ----------------------------------------
	{
		const rig = await startWithFakeChild();
		const polls: Array<{ status: string; started: boolean; elapsedMs: number }> = [];
		await rig.host.waitSettle({ name: rig.name, timeoutMs: 700, onPoll: (info) => polls.push({ ...info }) });
		check(
			"R8.1 onPoll heartbeat called per slice with growing elapsedMs",
			polls.length >= 2 && polls.every((p, i) => i === 0 || p.elapsedMs >= polls[i - 1]!.elapsedMs) && polls[polls.length - 1]!.elapsedMs > polls[0]!.elapsedMs,
			JSON.stringify(polls),
		);
	}
	{
		const rig = await startWithFakeChild();
		const ac = new AbortController();
		ac.abort();
		const r = await rig.host.waitSettle({ name: rig.name, timeoutMs: 5_000, signal: ac.signal });
		check(
			"R8.2 aborted signal → kind 'detached', the agent is NOT killed",
			r.kind === "detached" && rig.child.kills.length === 0 && (await rig.host.getStatus(rig.name)) !== null,
			JSON.stringify({ r, kills: rig.child.kills }),
		);
	}
	{
		const rig = await startWithFakeChild();
		const waiting = rig.host.waitSettle({ name: rig.name, timeoutMs: 5_000, releaseOnStarted: true });
		setTimeout(() => rig.child.emitLine({ type: "agent_start" }), 100);
		const r = await waiting;
		check("R8.3 releaseOnStarted → 'started-confirmed' once working", r.kind === "started-confirmed" && r.status === "working", JSON.stringify(r));
	}

	// --- R9: StartReq.env reaches the spawned rpc child (issue #25) ------------
	{
		let captured: SpawnOptions | undefined;
		const child = new FakeChildProcess();
		const host = createRpcTransport({
			worktreeRoot: WORKTREE_ROOT,
			subOrchestrator: false,
			spawnProcess: (_cmd, _args, options) => {
				captured = options;
				return child as unknown as ChildProcess;
			},
		});
		const repo = mkdtempSync(join(tmpdir(), "rpc-unit-repo-"));
		repos.push(repo);
		const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "env" });
		const env = { SWARM_TASK: "task-x", SWARM_WORKER: "w1", SWARM_SCHEMA_DIR: "/proj/.pi/delegate-schemas" };
		await host.startAgent({
			name: "env-worker",
			placementRef: placement.placementRef ?? "",
			provider: "p",
			model: "m",
			thinking: "low",
			timeoutMs: 5_000,
			env,
		});
		const spawnedEnv = (captured?.env ?? {}) as Record<string, string | undefined>;
		check(
			"R9.1 StartReq.env reaches the rpc child env (SWARM_* identity exported, issue #25)",
			spawnedEnv.SWARM_TASK === "task-x" && spawnedEnv.SWARM_WORKER === "w1" && spawnedEnv.SWARM_SCHEMA_DIR === "/proj/.pi/delegate-schemas",
			JSON.stringify(spawnedEnv),
		);
		check(
			"R9.2 the child env still inherits the orchestrator environment",
			spawnedEnv.PATH === process.env.PATH,
		);
	}
} finally {
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
	rmSync(WORKTREE_ROOT, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nrpc-host-unit-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-host-unit-check: all green");
process.exit(0);
