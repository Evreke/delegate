/**
 * rpc-place-probe-check — issue #73: `place()` must allocate a path that is
 * guaranteed FREE.
 *
 * BUG_FIX_CONTEXT (field trial of the issues-squad fleet, 2026-09-25): the rpc
 * adapter's worktree allocator used a per-instance monotonic counter without
 * probing the filesystem, so a directory already held by a previous/parallel
 * host session collided with `git worktree add`
 * (`fatal: '<dir>' already exists` → E_PLACE).
 *
 * Scenario (the issue's own acceptance):
 *   P1 — a TEMP worktreeRoot pre-seeded with `delegate-wt-1` and
 *        `delegate-wt-2` forces `place()` to land on `delegate-wt-3`, and the
 *        FINAL chosen n flows into placementRef / workspaceId / paneId.
 *   P2 — a fresh empty worktreeRoot still lands on `delegate-wt-1`.
 *
 * Run with: bun test/rpc-place-probe-check.ts   (from repo root)
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRpcTransport } from "../src/host/rpc.ts";
import type { Placement } from "../src/host.ts";

const execFileP = promisify(execFile);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

/** A scratch base dir holding a seed git repo whose basename is exactly
 *  "delegate" (so the allocator builds `delegate-wt-<n>` paths). */
async function makeBase(): Promise<{ base: string; repo: string }> {
	const base = mkdtempSync(join(tmpdir(), "rpc-place-probe-"));
	const repo = join(base, "delegate");
	mkdirSync(repo);
	await execFileP("git", ["-C", repo, "init"]);
	await execFileP("git", ["-C", repo, "config", "user.email", "qa@example.com"]);
	await execFileP("git", ["-C", repo, "config", "user.name", "qa"]);
	writeFileSync(join(repo, "seed.txt"), "seed");
	await execFileP("git", ["-C", repo, "add", "."]);
	await execFileP("git", ["-C", repo, "commit", "-m", "seed"]);
	return { base, repo };
}

function seedPresent(p: Placement): boolean {
	try {
		return existsSync(p.checkoutPath) && readFileSync(join(p.checkoutPath, "seed.txt"), "utf8") === "seed";
	} catch {
		return false;
	}
}

// --- P1: occupied dirs are skipped, final n flows into every id ---------------
{
	const { base, repo } = await makeBase();
	const root = join(base, "wts");
	mkdirSync(join(root, "delegate-wt-1"), { recursive: true });
	mkdirSync(join(root, "delegate-wt-2"), { recursive: true });

	const t = createRpcTransport({ worktreeRoot: root, subOrchestrator: false });
	const p = await t.place({ mode: "worktree", repoPath: repo, branch: "qa/probe-collision", label: "probe" });

	check("P1.1 occupied -wt-1/-wt-2 skipped → checkoutPath is delegate-wt-3", p.checkoutPath === join(root, "delegate-wt-3"), p.checkoutPath);
	check("P1.2 placementRef carries the FINAL n (rpc:wt:3)", p.placementRef === "rpc:wt:3", String(p.placementRef));
	check("P1.3 workspaceId carries the FINAL n (rpc-ws-3)", p.workspaceId === "rpc-ws-3", String(p.workspaceId));
	check("P1.4 paneId carries the FINAL n (rpc:p3)", p.paneId === "rpc:p3", String(p.paneId));
	check("P1.5 worktree actually created and populated", seedPresent(p), p.checkoutPath);
	check("P1.6 pre-existing foreign dirs left untouched", existsSync(join(root, "delegate-wt-1")) && existsSync(join(root, "delegate-wt-2")));

	await t.teardown({ name: "probe", placement: p, force: true });
	rmSync(base, { recursive: true, force: true });
}

// --- P2: a fresh empty root still lands on -wt-1 ------------------------------
{
	const { base, repo } = await makeBase();
	const root = join(base, "wts");
	mkdirSync(root, { recursive: true });

	const t = createRpcTransport({ worktreeRoot: root, subOrchestrator: false });
	const p = await t.place({ mode: "worktree", repoPath: repo, branch: "qa/probe-fresh", label: "probe" });

	check("P2.1 fresh empty root → delegate-wt-1", p.checkoutPath === join(root, "delegate-wt-1"), p.checkoutPath);
	check("P2.2 ids match the first path", p.placementRef === "rpc:wt:1" && p.workspaceId === "rpc-ws-1" && p.paneId === "rpc:p1", `${p.placementRef} ${p.workspaceId} ${p.paneId}`);
	check("P2.3 worktree actually created and populated", seedPresent(p), p.checkoutPath);

	await t.teardown({ name: "probe", placement: p, force: true });
	rmSync(base, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nrpc-place-probe-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-place-probe-check: all green");
process.exit(0);
