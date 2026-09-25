/**
 * provider-empty-check — regression for issue #74 (observed 2026-09-25).
 *
 * BUG_FIX_CONTEXT: symptom — under a provider burst the model returned EMPTY
 * assistant turns; a worker looped on them, settled idle, and wrote no report.
 * The watcher classified the settle as the generic worker-dead / "settled
 * (idle) with no report", indistinguishable from an agent that gave up or a
 * crash, so the orchestrator had to read raw session JSONL to learn the real
 * cause (empty provider output). Why the old solution did not work: the rpc
 * adapter tracked the LAST assistant text but never whether ANY non-empty
 * assistant output had been seen, so "the provider returned nothing" was not
 * a representable fact and every settle-without-report collapsed into one
 * classification. What was done: a per-worker latch in the rpc stdout pump
 * (assistantTurnSeen / assistantOutputSeen) is surfaced on AgentStatus as the
 * additive advisory `providerEmpty` fact; the watcher's worker-dead branch and
 * the synchronous spawn classification both branch on it and emit the distinct
 * E_PROVIDER_EMPTY signal, while every other settle-without-report cause keeps
 * the generic worker-dead / E_REPORT_MISSING behavior.
 *
 * Run with: bun test/provider-empty-check.ts   (from the repo root)
 *
 * Layers exercised (the brief's TDD red/green):
 *   P1  rpc pump: empty/whitespace assistant turns + settle → providerEmpty
 *   P2  rpc pump: ONE real assistant line → NOT providerEmpty (negative)
 *   P3  rpc pump: no assistant turn at all → NOT providerEmpty (never-started
 *       must never masquerade as an empty provider)
 *   P4  adapter plumbing: getStatus/listStatuses carry the fact over the real
 *       stdout pump with a scripted fake child
 *   P5  watcher: zero-output settle + no report → distinct "provider-empty"
 *       event carrying the E_PROVIDER_EMPTY token
 *   P6  watcher negative: non-empty output + no report → generic worker-dead
 *   P7  watcher compatibility: no latched fact (non-rpc backend) → generic
 *   P8  spawn sync path: zero-output settle + no report → details.code
 *       E_PROVIDER_EMPTY
 *   P9  spawn sync path negative: non-empty output + no report →
 *       details.code E_REPORT_MISSING
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { applyRpcEvent, createRpcTransport, isProviderEmpty, type RpcAgentState } from "../src/host/rpc.ts";
import { detectWorkerEvents, workersFromManifests } from "../src/watch-detect.ts";
import type { ExchangeManifest } from "../src/manifest-store.ts";
import type { ManifestWorker } from "../src/manifest-store.ts";
import { registerDelegateTool } from "../src/spawn.ts";
import type { AgentStatus, Placement, Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// Minimal fake rpc child — only what the stdout pump and get_state need
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kills: string[] = [];
	stdin = {
		write: (s: string | Buffer): boolean => {
			const cmd = JSON.parse(String(s)) as { type?: string; id?: string };
			if (cmd.type === "get_state") {
				queueMicrotask(() =>
					this.emitLine({ type: "response", command: "get_state", id: cmd.id, success: true, data: { sessionFile: "/tmp/provider-empty-session.jsonl" } }),
				);
			} else if (cmd.type === "prompt") {
				queueMicrotask(() => this.emitLine({ type: "response", command: "prompt", id: cmd.id, success: true }));
			}
			return true;
		},
	};
	kill(signal?: NodeJS.Signals): this {
		this.kills.push(signal ?? "SIGTERM");
		return this;
	}
	emitLine(obj: unknown): void {
		this.stdout.emit("data", `${JSON.stringify(obj)}\n`);
	}
}

const repoDirs: string[] = [];
const WT_ROOT = join(tmpdir(), `provider-empty-wt-${process.pid}`);

async function startFakeHost(): Promise<{ host: Transport; child: FakeChild; name: string }> {
	const child = new FakeChild();
	const host = createRpcTransport({
		worktreeRoot: WT_ROOT,
		subOrchestrator: false,
		spawnProcess: () => child as unknown as ChildProcess,
	});
	const repo = mkdtempSync(join(tmpdir(), "provider-empty-repo-"));
	repoDirs.push(repo);
	const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "pe" });
	const start = await host.startAgent({ name: "pe-worker", placementRef: placement.placementRef ?? "", provider: "p", model: "m", thinking: "low", timeoutMs: 5_000 });
	return { host, child, name: start.name };
}

function bareState(over: Partial<RpcAgentState> = {}): RpcAgentState {
	return {
		name: "bare",
		placement: { kind: "tab", checkoutPath: "/bare", backend: "rpc", placementRef: "rpc:shared:0" },
		child: new FakeChild() as unknown as ChildProcess,
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
		...over,
	};
}

const emptyAssistantTurn = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "   \n" }] } };
const realAssistantTurn = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OUTPUT: OK" }] } };

// ---------------------------------------------------------------------------
// P1–P3: the rpc pump latch (pure reducer)
// ---------------------------------------------------------------------------

{
	const s = bareState();
	applyRpcEvent(s, { type: "agent_start" });
	applyRpcEvent(s, emptyAssistantTurn);
	applyRpcEvent(s, { type: "agent_settled" });
	check("P1 empty/whitespace assistant turns + settle → providerEmpty true", isProviderEmpty(s) === true, JSON.stringify({ turns: s.assistantTurnSeen, out: s.assistantOutputSeen }));

	const s2 = bareState();
	applyRpcEvent(s2, { type: "agent_start" });
	applyRpcEvent(s2, realAssistantTurn);
	applyRpcEvent(s2, { type: "agent_settled" });
	check("P2 ONE real assistant line → providerEmpty false (negative)", isProviderEmpty(s2) === false, JSON.stringify({ turns: s2.assistantTurnSeen, out: s2.assistantOutputSeen }));

	const s3 = bareState();
	applyRpcEvent(s3, { type: "agent_settled" });
	check("P3 no assistant turn at all → providerEmpty false (never-started is not an empty provider)", isProviderEmpty(s3) === false, JSON.stringify({ turns: s3.assistantTurnSeen, out: s3.assistantOutputSeen }));
}

// ---------------------------------------------------------------------------
// P4: the fact reaches AgentStatus over the REAL stdout pump
// ---------------------------------------------------------------------------

{
	const { host, child, name } = await startFakeHost();
	check("P4.0 a fresh worker with no turn is NOT providerEmpty", (await host.getStatus(name))?.providerEmpty === false);
	child.emitLine(emptyAssistantTurn);
	child.emitLine(emptyAssistantTurn);
	child.emitLine({ type: "agent_settled" });
	const st = await host.getStatus(name);
	check("P4.1 getStatus carries providerEmpty=true after empty turns + settle", st?.providerEmpty === true, JSON.stringify(st));
	const all = await host.listStatuses();
	check("P4.2 listStatuses carries the same fact (the watcher's read path)", all.find((x) => x.name === name)?.providerEmpty === true, JSON.stringify(all));

	const { host: host2, child: child2, name: name2 } = await startFakeHost();
	child2.emitLine(emptyAssistantTurn);
	child2.emitLine(realAssistantTurn);
	child2.emitLine({ type: "agent_settled" });
	check("P4.3 one real line among empty turns → providerEmpty=false", (await host2.getStatus(name2))?.providerEmpty === false);
}

// ---------------------------------------------------------------------------
// P5–P7: the watcher classification
// ---------------------------------------------------------------------------

const NOW = Date.now();
const DET_SELF = "/tmp/provider-empty-self.jsonl";

function detect(status: AgentStatus): { kinds: string[]; message: string } {
	const dir = mkdtempSync(join(tmpdir(), "provider-empty-task-"));
	const worker: ManifestWorker = {
		name: "pe-dead",
		placement: { kind: "worktree", workspaceId: "w1", paneId: "w1:p1", branch: "delegate/pe-dead", checkoutPath: join(dir, "wt") },
		briefPath: join(dir, "brief-pe-dead.md"),
		reportPath: join(dir, "report-pe-dead.json"),
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: new Date(NOW - 10 * 60_000).toISOString(),
	};
	const manifest: ExchangeManifest = { task: "pe", dir, workers: [worker] };
	const snap = workersFromManifests([manifest], [status], {}, NOW);
	const events = detectWorkerEvents(snap.workers[0]!, { nowMs: NOW, selfSessionFile: DET_SELF, legacyFailOpen: true });
	return { kinds: events.map((e) => e.kind).sort(), message: events.map((e) => e.message).join(" | ") };
}

{
	const out = detect({ name: "pe-dead", status: "idle", providerEmpty: true });
	check("P5.1 zero-output settle + no report → distinct provider-empty event", out.kinds.includes("provider-empty"), JSON.stringify(out));
	check("P5.2 provider-empty is NOT also reported as the generic worker-dead", !out.kinds.includes("worker-dead"), JSON.stringify(out));
	check("P5.3 the message carries the E_PROVIDER_EMPTY token + a provider-switch retry", /E_PROVIDER_EMPTY/.test(out.message) && /provider/i.test(out.message) && /retry/i.test(out.message), out.message);

	const out2 = detect({ name: "pe-dead", status: "idle", providerEmpty: false });
	check("P6 non-empty output + no report → generic worker-dead (negative)", out2.kinds.includes("worker-dead") && !out2.kinds.includes("provider-empty"), JSON.stringify(out2));

	const out3 = detect({ name: "pe-dead", status: "idle" });
	check("P7 absent latch (non-rpc backend) → generic worker-dead (backward compatible)", out3.kinds.includes("worker-dead") && !out3.kinds.includes("provider-empty"), JSON.stringify(out3));
}

// ---------------------------------------------------------------------------
// P8–P9: the synchronous spawn classification (rpc settle observation)
// ---------------------------------------------------------------------------

const EXCHANGE = mkdtempSync(join(tmpdir(), "provider-empty-exchange-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE;

function fakeTransport(providerEmpty: boolean | undefined): Transport {
	const placement: Placement = { kind: "tab", workspaceId: "ws", paneId: "pane", branch: "", checkoutPath: EXCHANGE, backend: "fake", placementRef: "fake:1" };
	const status: AgentStatus = { name: "sync-worker", status: "idle", placementRef: "fake:1", ...(providerEmpty !== undefined ? { providerEmpty } : {}) };
	return {
		backendName: () => "fake",
		place: async () => placement,
		startAgent: async (req) => ({ name: req.name, sessionPath: join(EXCHANGE, "session.jsonl") }),
		submitPrompt: async () => {},
		waitSettle: async () => ({ kind: "settled", status: "idle" }),
		getStatus: async () => status,
		listStatuses: async () => [status],
		readConsole: async () => "",
		teardown: async () => ({ alreadyGone: false }),
		capabilities: () => ({ worktrees: true, authority: "root" }),
	};
}

async function driveSpawn(name: string, providerEmpty: boolean | undefined): Promise<Record<string, unknown>> {
	const dir = join(EXCHANGE, `task-${name}`);
	mkdirSync(dir, { recursive: true });
	const briefPath = join(dir, `brief-${name}.md`);
	writeFileSync(briefPath, `# brief ${name}\n\nDo the thing. OUTPUT: report-${name}.json\n`);
	let tool!: { execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }> };
	registerDelegateTool({ registerTool: (t: never) => (tool = t as never) } as never, fakeTransport(providerEmpty));
	const result = await tool.execute(
		"t1",
		{ name, briefPath, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: EXCHANGE, mode: "tab", releaseOn: "settle" },
		undefined,
		() => {},
		{ cwd: EXCHANGE, hasUI: false },
	);
	return result.details;
}

try {
	const d1 = await driveSpawn("sync-empty", true);
	check("P8 zero-output settle + no report → details.code E_PROVIDER_EMPTY", d1.ok === false && d1.code === "E_PROVIDER_EMPTY", JSON.stringify(d1));
	const d2 = await driveSpawn("sync-real", false);
	check("P9 non-empty output + no report → details.code E_REPORT_MISSING (negative)", d2.ok === false && d2.code === "E_REPORT_MISSING", JSON.stringify(d2));
} finally {
	for (const repo of repoDirs) rmSync(repo, { recursive: true, force: true });
	rmSync(WT_ROOT, { recursive: true, force: true });
	rmSync(EXCHANGE, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nprovider-empty-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nprovider-empty-check: all green");
process.exit(0);
