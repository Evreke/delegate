/**
 * rpc-classify-check — issue #14: the message_end reducer branch reads the
 * message stopReason + error text, classifies provider errors vs abort
 * artifacts, and the classification reaches the adapter's failure details
 * (readConsole) — all deterministic: pure reducer + fake child, NO real
 * subprocess, NO provider, NO real time.
 *
 * Run with: bun test/rpc-classify-check.ts   (from repo root)
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { applyRpcEvent, createRpcTransport, isAbortArtifactErrorMessage, type RpcAgentState } from "../src/host/rpc.ts";
import type { Placement, Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

class FakeChildProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin: { write: (s: string | Buffer) => boolean };
	constructor() {
		super();
		this.stdin = {
			write: (s: string | Buffer): boolean => {
				const cmd = JSON.parse(String(s)) as { type?: string; id?: string };
				if (cmd.type === "get_state") {
					queueMicrotask(() =>
						this.stdout.emit(
							"data",
							`${JSON.stringify({ type: "response", command: "get_state", id: cmd.id, success: true, data: { sessionFile: "/tmp/rpc-classify-fake-session.jsonl" } })}\n`,
						),
					);
				}
				return true;
			},
		};
	}
	kill(): this {
		return this;
	}
	simulateExit(code: number | null, signal: string | null): void {
		this.emit("exit", code, signal);
	}
}

const WORKTREE_ROOT = join(tmpdir(), `rpc-classify-wt-${process.pid}`);
const repos: string[] = [];

async function startWithFakeChild(): Promise<{ host: Transport; child: FakeChildProcess; name: string }> {
	const child = new FakeChildProcess();
	const host = createRpcTransport({
		worktreeRoot: WORKTREE_ROOT,
		subOrchestrator: false,
		spawnProcess: () => child as unknown as ChildProcess,
	});
	const repo = mkdtempSync(join(tmpdir(), "rpc-classify-repo-"));
	repos.push(repo);
	const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "classify" });
	const name = "classify-worker";
	await host.startAgent({
		name,
		placementRef: placement.placementRef ?? "",
		provider: "p",
		model: "m",
		thinking: "low",
		timeoutMs: 5_000,
	});
	return { host, child, name };
}

/** Bare hand-built state for the pure reducer (mirrors rpc-host-unit-check). */
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

try {
	// --- Slice 4 (issue #14 RED): the reducer classifies message_end -------
	{
		// Fixture 1 — a provider failure: usage limit exhausted (worked example
		// from the issue: "Codex error: The usage limit has been reached").
		const state = bareState();
		applyRpcEvent(state, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial answer" }],
				stopReason: "error",
				errorMessage: "Codex error: The usage limit has been reached",
			},
		});
		check(
			"classify: provider error message_end → stopReason + verbatim error text on tracked state",
			state.lastStopReason === "error" &&
				state.lastErrorMessage === "Codex error: The usage limit has been reached" &&
				state.failureClassification === "provider-error",
			JSON.stringify({
				lastStopReason: state.lastStopReason,
				lastErrorMessage: state.lastErrorMessage,
				failureClassification: state.failureClassification,
			}),
		);

		// Fixture 2 — our OWN teardown abort rides the same error channel; the
		// abort-artifact pattern must classify it as abort-artifact, NOT a
		// provider error.
		const aborted = bareState();
		applyRpcEvent(aborted, {
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" },
		});
		check(
			"classify: abort-artifact error text → abort-artifact, not provider-error",
			aborted.failureClassification === "abort-artifact" && aborted.lastErrorMessage === "This operation was aborted",
			String(aborted.failureClassification),
		);
		check(
			"classify: isAbortArtifactErrorMessage recognizes our teardown aborts only",
			isAbortArtifactErrorMessage("This operation was aborted") === true &&
				isAbortArtifactErrorMessage("request was aborted") === true &&
				isAbortArtifactErrorMessage("Codex error: The usage limit has been reached") === false,
		);

		// Fixture 3 — a clean stop leaves the classification empty.
		const clean = bareState();
		applyRpcEvent(clean, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		});
		check(
			"classify: clean stop → no error text, no classification",
			clean.failureClassification === undefined && clean.lastErrorMessage === undefined && clean.lastStopReason === "stop",
			JSON.stringify({ c: clean.failureClassification, r: clean.lastStopReason }),
		);
	}
	// --- Slice 5 (issue #14 RED): classification in failure details --------
	{
		// Provider failure: the verbatim error text must reach readConsole (the
		// console readback spawn.ts embeds in the orchestrator-visible failure).
		const rig = await startWithFakeChild();
		rig.child.stdout.emit(
			"data",
			`${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Codex error: The usage limit has been reached",
				},
			})}\n`,
		);
		rig.child.simulateExit(1, null);
		const consoleText = await rig.host.readConsole!(rig.name);
		check(
			"surface: provider error reaches readConsole with verbatim text",
			consoleText.includes("provider error: Codex error: The usage limit has been reached"),
			JSON.stringify(consoleText),
		);
		// Abort artifact: surfaced as OUR teardown abort, not a provider error.
		const rig2 = await startWithFakeChild();
		rig2.child.stdout.emit(
			"data",
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" },
			})}\n`,
		);
		rig2.child.simulateExit(0, null);
		const consoleText2 = await rig2.host.readConsole!(rig2.name);
		check(
			"surface: abort artifact reaches readConsole as aborted-by-teardown",
			consoleText2.includes("aborted by teardown: This operation was aborted") &&
				!consoleText2.includes("provider error"),
			JSON.stringify(consoleText2),
		);
	}
} finally {
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
	rmSync(WORKTREE_ROOT, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nrpc-classify-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-classify-check: all green");
process.exit(0);
