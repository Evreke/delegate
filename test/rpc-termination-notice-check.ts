/**
 * rpc-termination-notice-check — issue #15: the bounded termination-notice
 * handoff on the rpc teardown path (src/host/rpc.ts).
 *
 * Run with: bun test/rpc-termination-notice-check.ts   (from repo root)
 *
 * Mechanism: the adapter is constructed with an INJECTED child-process
 * factory (constructor option spawnProcess — the test seam; the default stays
 * node's real spawn, so createRpcTransport() with no args is unchanged). The
 * fake ChildProcess-like object records every stdin write and lets the test
 * feed JSONL records over the fake stdout — the REAL pump (pumpStdout → the
 * exported pure reducer applyRpcEvent) processes them. No real pi process, no
 * LLM call; the notice window and the SIGKILL grace are constructor-shortened.
 *
 * Scenarios (the issue's acceptance list):
 *   A. a live child on teardown receives the notice BEFORE the abort write;
 *      a child that answers within the window has its answer captured as a
 *      partial report on disk, referenced from the teardown result;
 *   B. a child that stays silent is killed after the config-bounded window
 *      and yields no partial report;
 *   C. teardown stays idempotent (second close = alreadyGone, no new notice);
 *   D. a notice send failure never fails the teardown (advisory by contract);
 *   E. a mid-stream child gets the notice with streamingBehavior "steer";
 *   F. the captured partial report path is stamped onto the worker's manifest
 *      entry (additive optional field, existing convention).
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { createRpcTransport } from "../src/host/rpc.ts";
import { updateManifest, readManifest } from "../src/manifest-store.ts";
import type { Placement, Transport } from "../src/host.ts";

// The two additions of issue #15 are imported DYNAMICALLY so the RED run
// reports each missing behavior instead of dying at module load.
const expathsMod = (await import("../src/expaths.ts")) as unknown as {
	partialReportPathFor?: (dir: string, name: string) => string;
};
function partialPathFor(dir: string, name: string): string {
	return expathsMod.partialReportPathFor ? expathsMod.partialReportPathFor(dir, name) : join(dir, `partial-${name}.json`);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const NOTICE = "TERMINATION NOTICE: state what is done, what remains, and the last check status — answer without tools";
const WORKTREE_ROOT = join(tmpdir(), `rpc-notice-wt-${process.pid}`);
const repos: string[] = [];

// ---------------------------------------------------------------------------
// Fake child process — the injected seam double
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
	readonly writes: Array<Record<string, unknown>> = [];
	readonly kills: string[] = [];
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	/** When set, stdin.write() throws after this many successful writes. */
	failStdinWritesAfter: number | undefined;
	/** Invoked for every accepted prompt command (the notice). */
	onPrompt: ((cmd: Record<string, unknown>) => void) | undefined;
	private stdinWriteCount = 0;
	stdin: { write: (s: string | Buffer) => boolean };

	constructor() {
		super();
		this.stdin = {
			write: (s: string | Buffer): boolean => {
				this.stdinWriteCount++;
				if (this.failStdinWritesAfter !== undefined && this.stdinWriteCount > this.failStdinWritesAfter) {
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
							data: { sessionFile: "/tmp/rpc-notice-fake-session.jsonl" },
						}),
					);
				} else if (cmd.type === "prompt") {
					this.onPrompt?.(cmd);
					queueMicrotask(() =>
						this.emitLine({ type: "response", command: "prompt", id: cmd.id, success: true }),
					);
				}
				return true;
			},
		};
	}

	kill(signal?: NodeJS.Signals): this {
		this.kills.push(signal ?? "SIGTERM");
		queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
		return this;
	}

	/** Test helper: feed one JSON record over the fake stdout (LF-framed). */
	emitLine(obj: unknown): void {
		this.stdout.emit("data", `${JSON.stringify(obj)}\n`);
	}
}

interface Rig {
	host: Transport;
	child: FakeChildProcess;
	name: string;
	placement: Placement;
}

async function startRig(opts: {
	name: string;
	noticeMs?: number;
	killGraceMs?: number;
	onPrompt?: (cmd: Record<string, unknown>) => void;
	failStdinWritesAfter?: number;
}): Promise<Rig> {
	const child = new FakeChildProcess();
	child.onPrompt = opts.onPrompt;
	child.failStdinWritesAfter = opts.failStdinWritesAfter;
	const host = createRpcTransport({
		worktreeRoot: WORKTREE_ROOT,
		subOrchestrator: false,
		spawnProcess: () => child as unknown as ChildProcess,
		terminationNoticeMs: opts.noticeMs ?? 60,
		terminationNoticeText: NOTICE,
		killGraceMs: opts.killGraceMs ?? 30,
	});
	const repo = mkdtempSync(join(tmpdir(), "rpc-notice-repo-"));
	repos.push(repo);
	const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "notice" });
	await host.startAgent({
		name: opts.name,
		placementRef: placement.placementRef ?? "",
		provider: "p",
		model: "m",
		thinking: "off",
		timeoutMs: 5_000,
	});
	return { host, child, name: opts.name, placement };
}

const answerText = "DONE: notice handling. REMAINS: manifest stamp. LAST CHECK: green.";

// ---------------------------------------------------------------------------
// A — notice sent before abort; an answer within the window is captured
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "rpc-notice-dir-"));
	const partialPath = partialPathFor(dir, "notice-a");
	const rig = await startRig({
		name: "notice-a",
		onPrompt: (cmd) => {
			rig.child.emitLine({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: answerText }] },
			});
			void cmd;
		},
	});
	let res: { alreadyGone?: boolean; partialReportPath?: string } | undefined;
	let threw: unknown;
	try {
		res = await rig.host.teardown({ name: rig.name, placement: rig.placement, force: true, partialReportPath: partialPath });
	} catch (err) {
		threw = err;
	}
	const kinds = rig.child.writes.map((w) => w.type);
	check("A1 teardown of a live child resolved", threw === undefined, String(threw));
	check("A2 the child received the notice prompt", rig.child.writes.some((w) => w.type === "prompt" && w.message === NOTICE), JSON.stringify(rig.child.writes));
	check(
		"A3 the notice rides BEFORE the abort write",
		kinds.indexOf("prompt") >= 0 && kinds.indexOf("abort") > kinds.indexOf("prompt"),
		JSON.stringify(kinds),
	);
	check("A4 the answer is captured and referenced from the result", res?.partialReportPath === partialPath, JSON.stringify(res));
	check("A5 the partial report lands on disk", existsSync(partialPath));
	let partial: { worker?: string; reason?: string; text?: string } = {};
	try {
		partial = JSON.parse(readFileSync(partialPath, "utf8")) as typeof partial;
	} catch { /* checked by A6 */ }
	check("A6 the partial report carries the verbatim answer", partial.text === answerText, JSON.stringify(partial));
	check("A7 the partial report names the worker and the reason", partial.worker === "notice-a" && partial.reason === "termination-notice", JSON.stringify(partial));
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// B — a silent child is killed after the bounded window, no partial report
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "rpc-notice-dir-b-"));
	const partialPath = partialPathFor(dir, "notice-b");
	const rig = await startRig({ name: "notice-b" }); // no onPrompt → never answers
	const t0 = Date.now();
	const res = await rig.host.teardown({ name: rig.name, placement: rig.placement, force: true, partialReportPath: partialPath });
	const elapsed = Date.now() - t0;
	check("B1 the notice was still sent to the silent child", rig.child.writes.some((w) => w.type === "prompt"), JSON.stringify(rig.child.writes));
	check("B2 no partial report was captured", res?.partialReportPath === undefined, JSON.stringify(res));
	check("B3 no partial report file was written", !existsSync(partialPath));
	check("B4 the silent child was SIGKILLed", rig.child.kills.includes("SIGKILL"), JSON.stringify(rig.child.kills));
	check("B5 the wait was bounded by the configured window", elapsed >= 55 && elapsed < 2_000, `elapsed=${elapsed}ms`);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// C — teardown stays idempotent
// ---------------------------------------------------------------------------
{
	const rig = await startRig({ name: "notice-c" });
	const p1 = await rig.host.teardown({ name: rig.name, placement: rig.placement, force: true });
	const writesAfterFirst = rig.child.writes.length;
	const p2 = await rig.host.teardown({ name: rig.name, placement: rig.placement, force: true });
	check("C1 first close = alreadyGone false", p1?.alreadyGone === false, JSON.stringify(p1));
	check("C2 second close = alreadyGone true", p2?.alreadyGone === true, JSON.stringify(p2));
	check("C3 no second notice on the idempotent re-close", rig.child.writes.length === writesAfterFirst, `${writesAfterFirst} → ${rig.child.writes.length}`);
}

// ---------------------------------------------------------------------------
// D — a notice send failure never fails teardown (advisory by contract)
// ---------------------------------------------------------------------------
{
	// write #1 = get_state; write #2 = the notice → throws.
	const rig = await startRig({ name: "notice-d", failStdinWritesAfter: 1 });
	let threw: unknown;
	let res: { alreadyGone?: boolean } | undefined;
	try {
		res = await rig.host.teardown({ name: rig.name, placement: rig.placement, force: true });
	} catch (err) {
		threw = err;
	}
	check("D1 a failed notice send does not fail teardown", threw === undefined, String(threw));
	check("D2 the teardown still closed the worker", res?.alreadyGone === false, JSON.stringify(res));
	check("D3 the silent child was still killed", rig.child.kills.includes("SIGKILL"), JSON.stringify(rig.child.kills));
}

// ---------------------------------------------------------------------------
// E — a mid-stream child gets the notice as a steer
// ---------------------------------------------------------------------------
{
	const seen: Array<Record<string, unknown>> = [];
	const rig = await startRig({
		name: "notice-e",
		onPrompt: (cmd) => {
			seen.push(cmd);
			rig.child.emitLine({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "mid-stream answer" }] },
			});
		},
	});
	rig.child.emitLine({ type: "agent_start" }); // the worker is mid-stream
	await rig.host.teardown({ name: rig.name, placement: rig.placement, force: true });
	check("E1 a mid-stream notice carries streamingBehavior steer", seen.some((c) => c.streamingBehavior === "steer"), JSON.stringify(seen));
}

// ---------------------------------------------------------------------------
// F — the captured path is stamped onto the worker's manifest entry
// ---------------------------------------------------------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "rpc-notice-manifest-"));
	const partialPath = partialPathFor(dir, "notice-f");
	await updateManifest(dir, (m) => ({
		...m,
		workers: [
			{
				name: "notice-f",
				placement: { kind: "tab", checkoutPath: dir, backend: "rpc", placementRef: "rpc:shared:99" },
				briefPath: join(dir, "brief.md"),
				reportPath: join(dir, "report-notice-f.json"),
				provider: "p",
				model: "m",
				thinking: "off",
				startedAt: new Date().toISOString(),
			},
		],
	}));
	const mod = (await import("../src/manifest-store.ts")) as unknown as {
		stampPartialReportPath?: (dir: string, name: string, placementRef: string | undefined, path: string) => Promise<boolean>;
	};
	check("F1 the manifest store exposes the partial-report stamp", typeof mod.stampPartialReportPath === "function", typeof mod.stampPartialReportPath);
	if (typeof mod.stampPartialReportPath === "function") {
		const stamped = await mod.stampPartialReportPath(dir, "notice-f", "rpc:shared:99", partialPath);
		check("F2 the stamp reports a matched entry", stamped === true, String(stamped));
		const m = readManifest(dir);
		check("F3 the manifest entry references the partial report path", m?.workers[0]?.partialReportPath === partialPath, JSON.stringify(m?.workers[0]));
	}
	rmSync(dir, { recursive: true, force: true });
}

// cleanup
for (const r of repos) {
	try { rmSync(r, { recursive: true, force: true }); } catch { /* advisory */ }
}
try { rmSync(WORKTREE_ROOT, { recursive: true, force: true }); } catch { /* advisory */ }

if (failures > 0) {
	console.error(`\nrpc-termination-notice-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-termination-notice-check: all green");
process.exit(0);
