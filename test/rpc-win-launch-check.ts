/**
 * rpc-win-launch-check — the rpc adapter's OS launch policy on Windows.
 *
 * Run with: bun test/rpc-win-launch-check.ts   (from repo root)
 *
 * Why this file exists: src/host/rpc.ts spawned a bare `pi` and killed with
 * child.kill("SIGKILL"), and said so in its header ("POSIX-only for now"). On
 * Windows a bare `pi` does not resolve (npm installs `pi.cmd`), and
 * TerminateProcess of the direct child only — under the cmd.exe launch policy
 * that kills cmd.exe and ORPHANS the pi process (and its children). The herdr
 * adapter already carried the portable policy (spawnPolicyCommand +
 * taskkill /T /F tree-kill); this check pins that the rpc adapter runs on the
 * SAME policy module, and that POSIX stays byte-identical.
 *
 * Mechanism: two injectable seams, no real pi, no network, no LLM traffic.
 *   - `platform` (constructor) — the policy target, so the win32 branch is
 *     exercised on a POSIX host and vice versa;
 *   - `spawnProcess` (existing constructor seam) — records EVERY spawn the
 *     adapter makes (the worker launch and the tree-kill alike) and returns a
 *     fake ChildProcess-like object, exactly as rpc-host-unit-check.ts does.
 *
 * Groups:
 *   P  the policy module's pure units (POSIX identity, win32 shape, quoting,
 *      tree-kill shape, POSIX tree-kill is "no policy — signals own it")
 *   L  the adapter's launch shape (win32 policy vs POSIX byte-identity)
 *   K  the teardown kill (win32 tree-kill vs POSIX SIGKILL)
 *   R  the failed-start rollback kill (same two branches)
 *   W  the teardown ORDERING — the kill is asynchronous, and the caller removes
 *      the placement right after (a live worker locks its worktree on Windows)
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnPolicyCommand, treeKillCommand, winQuoteArg } from "../src/spawn-policy.ts";
import { createRpcTransport } from "../src/host/rpc.ts";
import type { Placement, Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// P — the policy module's pure units
// ---------------------------------------------------------------------------

{
	const posix = spawnPolicyCommand("pi", ["--mode", "rpc"], "linux");
	check("P1 POSIX launch policy returns command+args UNCHANGED", posix.command === "pi" && posix.args.join("\u0000") === ["--mode", "rpc"].join("\u0000"), JSON.stringify(posix));

	const win = spawnPolicyCommand("pi", ["--mode", "rpc"], "win32");
	check(
		"P2 win32 launch policy is cmd.exe /d /s /c + the per-arg-quoted argv",
		win.command === "cmd.exe" && JSON.stringify(win.args) === JSON.stringify(["/d", "/s", "/c", "pi", "--mode", "rpc"]),
		JSON.stringify(win),
	);

	const quoted = spawnPolicyCommand("pi", ["--name", "hello world"], "win32");
	check('P3 win32 policy quotes an argv element with a space ("hello world")', quoted.args.includes('"hello world"'), JSON.stringify(quoted.args));
	check("P4 winQuoteArg keeps a space-free element bare", winQuoteArg("pi") === "pi" && winQuoteArg("") === "");

	const kill = treeKillCommand(4242, "win32");
	check(
		"P5 win32 tree-kill is taskkill /pid <pid> /T /F through the same policy",
		kill !== undefined && kill.command === "cmd.exe" && JSON.stringify(kill.args) === JSON.stringify(["/d", "/s", "/c", "taskkill", "/pid", "4242", "/T", "/F"]),
		JSON.stringify(kill),
	);
	check("P6 POSIX tree-kill is NO policy at all (signals own the escalation)", treeKillCommand(4242, "linux") === undefined && treeKillCommand(4242, "darwin") === undefined);
}

// ---------------------------------------------------------------------------
// The fake child + the recording spawn seam
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
	readonly kills: Array<string | number | undefined> = [];
	pid = 4242;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin: { write: (s: string | Buffer) => boolean };
	/** When true, get_state is never answered (the failed-start path). */
	private readonly silent: boolean;
	constructor(silent = false) {
		super();
		this.silent = silent;
		this.stdout.on("data", () => {});
		this.stdin = {
			write: (s: string | Buffer): boolean => {
				for (const line of String(s).split("\n")) if (line.trim()) this.noteWrite(line);
				return true;
			},
		};
	}
	/** Answer one command record the way pi does (the adapter writes JSONL to
	 *  stdin; the fake reads the write back and replies on stdout). */
	noteWrite(line: string): void {
		const cmd = JSON.parse(line) as { id?: string; type?: string };
		if (this.silent || cmd.type !== "get_state") return;
		queueMicrotask(() => {
			this.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "response", command: "get_state", id: cmd.id, success: true, data: { sessionFile: "/tmp/rpc-win-fake-session.jsonl" } })}\n`));
		});
	}
	kill(signal?: string | number): boolean {
		this.kills.push(signal);
		return true;
	}
}

interface Spawned {
	command: string;
	args: readonly string[];
	options: SpawnOptions;
	child: FakeChild;
}

const WORKTREE_ROOT = mkdtempSync(join(tmpdir(), "rpc-win-root-"));
const repos: string[] = [];

/** Adapter on the given policy target with every spawn recorded. */
function rig(platform: NodeJS.Platform, opts: { silent?: boolean } = {}): { host: Transport; spawns: Spawned[]; repo: string } {
	const spawns: Spawned[] = [];
	const host = createRpcTransport({
		worktreeRoot: WORKTREE_ROOT,
		subOrchestrator: false,
		platform,
		spawnProcess: (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
			const child = new FakeChild(opts.silent ?? false);
			spawns.push({ command, args, options, child });
			return child as unknown as ChildProcess;
		},
	});
	const repo = mkdtempSync(join(tmpdir(), "rpc-win-repo-"));
	repos.push(repo);
	return { host, spawns, repo };
}

async function placeAndStart(host: Transport, repo: string, name: string, timeoutMs: number): Promise<Placement> {
	const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "win-launch" });
	await host.startAgent({ name, placementRef: placement.placementRef ?? "", provider: "p", model: "m", thinking: "low", timeoutMs });
	return placement;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// L — the launch shape
// ---------------------------------------------------------------------------

{
	// win32: the worker launch goes through the OS launch policy.
	const { host, spawns, repo } = rig("win32");
	try {
		await placeAndStart(host, repo, "win-worker", 5_000);
		const launch = spawns[0];
		check("L1 win32: the worker spawns through cmd.exe /d /s /c (a bare `pi` never resolves — npm ships pi.cmd)", launch?.command === "cmd.exe", launch?.command ?? "no spawn recorded");
		check(
			"L2 win32: argv keeps its array shape after the policy (pi --mode rpc …)",
			launch !== undefined && JSON.stringify(launch.args) === JSON.stringify(["/d", "/s", "/c", "pi", "--mode", "rpc", "--provider", "p", "--model", "m", "--thinking", "low", "--name", "win-worker"]),
			JSON.stringify(launch?.args),
		);
		check(
			"L3 win32: cwd/stdio/windowsHide of the launch are unchanged by the policy",
			launch?.options.cwd === repo && JSON.stringify(launch?.options.stdio) === JSON.stringify(["pipe", "pipe", "pipe"]) && launch?.options.windowsHide === true,
			JSON.stringify({ cwd: launch?.options.cwd, stdio: launch?.options.stdio, windowsHide: launch?.options.windowsHide }),
		);
	} catch (err) {
		check("L1-L3 win32 launch shape", false, String(err));
	}

	// POSIX: the same adapter on the POSIX policy target is byte-identical to
	// the pre-fix launch (a bare `pi`, argv untouched).
	const posix = rig("linux");
	try {
		await placeAndStart(posix.host, posix.repo, "posix-worker", 5_000);
		const launch = posix.spawns[0];
		check(
			"L4 POSIX: launch stays a bare `pi` with untouched argv (byte-identical to the pre-1.18 shape)",
			launch?.command === "pi" && JSON.stringify(launch.args) === JSON.stringify(["--mode", "rpc", "--provider", "p", "--model", "m", "--thinking", "low", "--name", "posix-worker"]),
			JSON.stringify({ command: launch?.command, args: launch?.args }),
		);
		check("L5 POSIX: no cmd.exe anywhere in the POSIX launch", !posix.spawns.some((s) => s.command === "cmd.exe"));
	} catch (err) {
		check("L4-L5 POSIX launch shape", false, String(err));
	}
}

// ---------------------------------------------------------------------------
// K — the teardown kill
// ---------------------------------------------------------------------------

{
	// win32: child.kill("SIGKILL") would TerminateProcess the DIRECT child —
	// under cmd.exe that is the wrapper, and pi survives as an orphan. The
	// tree-kill is what must land.
	const { host, spawns, repo } = rig("win32");
	try {
		const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "k" });
		await host.startAgent({ name: "kill-win", placementRef: placement.placementRef ?? "", provider: "p", model: "m", thinking: "low", timeoutMs: 5_000 });
		const worker = spawns[0].child;
		await host.teardown({ name: "kill-win", placement });
		await sleep(3_600); // KILL_GRACE_MS = 3000 in src/host/rpc.ts
		const killer = spawns.find((s) => s.args.includes("/T") && s.args.includes("/F"));
		check("K1 win32 teardown: the tree-kill fires (taskkill /T /F), not a direct-child kill", killer !== undefined, `spawns=${spawns.map((s) => s.command).join(",")}`);
		check("K2 win32 teardown: no SIGKILL on the child (it would kill only the cmd.exe wrapper and orphan pi)", !worker.kills.includes("SIGKILL"), JSON.stringify(worker.kills));
		check("K3 win32 teardown: the tree-kill spawn is hidden and fire-and-forget (stdio ignore, windowsHide)", killer?.options.stdio === "ignore" && killer?.options.windowsHide === true, JSON.stringify(killer?.options));
	} catch (err) {
		check("K1-K3 win32 teardown kill", false, String(err));
	}

	// POSIX: the signal escalation is unchanged.
	const posix = rig("linux");
	try {
		const placement = await posix.host.place({ mode: "tab", repoPath: posix.repo, branch: "", label: "k" });
		await posix.host.startAgent({ name: "kill-posix", placementRef: placement.placementRef ?? "", provider: "p", model: "m", thinking: "low", timeoutMs: 5_000 });
		const worker = posix.spawns[0].child;
		await posix.host.teardown({ name: "kill-posix", placement });
		await sleep(3_600);
		check("K4 POSIX teardown: SIGKILL on the child stays (byte-identical escalation)", worker.kills.includes("SIGKILL"), JSON.stringify(worker.kills));
		check("K5 POSIX teardown: no taskkill anywhere", !posix.spawns.some((s) => s.args.includes("/T")), JSON.stringify(posix.spawns.map((s) => s.command)));
	} catch (err) {
		check("K4-K5 POSIX teardown kill", false, String(err));
	}
}

// ---------------------------------------------------------------------------
// R — the failed-start rollback kill
// ---------------------------------------------------------------------------

{
	// get_state never answered → the start rolls back. The rolled-back child
	// must be tree-killed on win32 for the same orphan reason as teardown.
	const { host, spawns, repo } = rig("win32", { silent: true });
	try {
		const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "r" });
		let threw = "";
		try {
			await host.startAgent({ name: "rb-win", placementRef: placement.placementRef ?? "", provider: "p", model: "m", thinking: "low", timeoutMs: 300 });
		} catch (err) {
			threw = String((err as Error).message);
		}
		const worker = spawns[0].child;
		const killer = spawns.find((s) => s.args.includes("/T") && s.args.includes("/F"));
		check("R1 win32 rollback: the start failed as E_START (the path under test really ran)", threw.includes("not ready within"), threw.slice(0, 80));
		check("R2 win32 rollback: the abandoned child is tree-killed (no orphan pi behind cmd.exe)", killer !== undefined && !worker.kills.includes("SIGKILL"), JSON.stringify({ spawns: spawns.map((s) => s.command), kills: worker.kills }));
	} catch (err) {
		check("R1-R2 win32 rollback kill", false, String(err));
	}

	const posix = rig("linux", { silent: true });
	try {
		const placement = await posix.host.place({ mode: "tab", repoPath: posix.repo, branch: "", label: "r" });
		try {
			await posix.host.startAgent({ name: "rb-posix", placementRef: placement.placementRef ?? "", provider: "p", model: "m", thinking: "low", timeoutMs: 300 });
		} catch { /* expected */ }
		const worker = posix.spawns[0].child;
		check("R3 POSIX rollback: SIGKILL stays on the abandoned child", worker.kills.includes("SIGKILL"), JSON.stringify(worker.kills));
		check("R4 POSIX rollback: no cmd.exe/taskkill on the rollback path", !posix.spawns.some((s) => s.command === "cmd.exe"), JSON.stringify(posix.spawns.map((s) => s.command)));
	} catch (err) {
		check("R3-R4 POSIX rollback kill", false, String(err));
	}
}

// ---------------------------------------------------------------------------
// W — teardown must not return while the worker is still alive (win32)
// ---------------------------------------------------------------------------

{
	// FIELD PROOF (live pi on Windows, rpc-host-e2e leg): the tree-kill is
	// fire-and-forget, the worker's cwd IS the worktree, and teardown's caller
	// removes that worktree immediately after — Windows refuses to delete a
	// directory a live process still holds, and `git worktree remove --force`
	// dies with EPERM. So the win32 teardown must await the child's real exit
	// (bounded). POSIX keeps its shape: resolve right after SIGKILL.
	const spawns: Spawned[] = [];
	let exitSeenAt = 0;
	const host = createRpcTransport({
		worktreeRoot: WORKTREE_ROOT,
		subOrchestrator: false,
		platform: "win32",
		spawnProcess: (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
			const child = new FakeChild(false);
			spawns.push({ command, args, options, child });
			if (args.includes("/T")) {
				// The OS kills the tree a moment AFTER taskkill was launched — the
				// exact asynchronous shape that produced the EPERM in the field.
				setTimeout(() => {
					exitSeenAt = Date.now();
					spawns[0].child.emit("exit", null, 0);
				}, 250);
			}
			return child as unknown as ChildProcess;
		},
	});
	try {
		const repo = mkdtempSync(join(tmpdir(), "rpc-win-repo-"));
		repos.push(repo);
		const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "w" });
		await host.startAgent({ name: "order-win", placementRef: placement.placementRef ?? "", provider: "p", model: "m", thinking: "low", timeoutMs: 5_000 });
		let resolvedAt = 0;
		await host.teardown({ name: "order-win", placement }).then(() => {
			resolvedAt = Date.now();
		});
		check("W1 win32 teardown: the tree-kill is what kills the worker", spawns.some((s) => s.args.includes("/T") && s.args.includes("/F")), JSON.stringify(spawns.map((s) => s.command)));
		check(
			"W2 win32 teardown: does NOT return while the worker process is still alive (its cwd locks the worktree — `git worktree remove` would EPERM)",
			exitSeenAt > 0 && resolvedAt >= exitSeenAt,
			JSON.stringify({ exitSeenAt, resolvedAt, deltaMs: resolvedAt - exitSeenAt }),
		);
		check("W3 win32 teardown: the exit wait is bounded (a worker that never dies cannot hang teardown)", resolvedAt > 0, "teardown never returned");
	} catch (err) {
		check("W1-W3 win32 teardown ordering", false, String(err));
	}

	// POSIX timing is unchanged: SIGKILL, then return — no exit wait, no killer.
	const posix = rig("linux");
	try {
		const placement = await posix.host.place({ mode: "tab", repoPath: posix.repo, branch: "", label: "w" });
		await posix.host.startAgent({ name: "order-posix", placementRef: placement.placementRef ?? "", provider: "p", model: "m", thinking: "low", timeoutMs: 5_000 });
		const t0 = Date.now();
		await posix.host.teardown({ name: "order-posix", placement });
		const took = Date.now() - t0;
		const worker = posix.spawns[0].child;
		check("W4 POSIX teardown: resolves right after SIGKILL, never waits for an exit it did not ask for", worker.kills.includes("SIGKILL") && took < 3_600 && posix.spawns.length === 1, JSON.stringify({ took, kills: worker.kills, spawns: posix.spawns.length }));
	} catch (err) {
		check("W4 POSIX teardown timing", false, String(err));
	}
}

rmSync(WORKTREE_ROOT, { recursive: true, force: true });
for (const repo of repos) rmSync(repo, { recursive: true, force: true });

console.log(failures === 0 ? "\nrpc-win-launch-check: all checks passed" : `\nrpc-win-launch-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
