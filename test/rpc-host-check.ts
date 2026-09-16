/**
 * rpc-host-check — deterministic unit checks for the rpc backend adapter
 * (src/host/rpc.ts) that need NO LLM call and NO pi subprocess.
 *
 * Run with: bun test/rpc-host-check.ts   (from repo root)
 *
 * Covers the seam contracts the fake (host-fake-check.ts) pins for the fake:
 *   - capabilities root/sub authority mapping
 *   - tab placement shape (backend "rpc", opaque placementRef ALONGSIDE
 *     legacy id fields — version-skew rule)
 *   - worktree placement round-trip against a REAL temp git repo
 *     (git worktree add/remove — the rpc backend's placement mechanism)
 *   - teardown idempotency: first close = {alreadyGone:false}, second close
 *     on the same placement = {alreadyGone:true}, no throw
 *   - E_START on unknown placementRef, E_TIMEOUT on unknown-agent waitSettle
 *   - sub-orchestrator worktree rejection (E_PLACE authority guard)
 *
 * The LIVE worker flow (spawn → prompt → settle → readConsole → teardown against
 * a real `pi --mode rpc` child) is the opt-in e2e leg in rpc-host-e2e-check.ts
 * (RPC_E2E=1 — it burns provider tokens and needs API access).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRpcTransport } from "../src/host/rpc.ts";
import { DelegateErrorImpl } from "../src/host.ts";

const execFileP = promisify(execFile);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function isE(err: unknown, code: string): boolean {
	return err instanceof DelegateErrorImpl && err.code === code;
}

const root = createRpcTransport({ worktreeRoot: join(tmpdir(), `rpc-check-wt-${process.pid}`), subOrchestrator: false });
const sub = createRpcTransport({ worktreeRoot: join(tmpdir(), `rpc-check-wt-${process.pid}`), subOrchestrator: true });

// --- capabilities / authority ----------------------------------------------
{
	const caps = root.capabilities();
	check("2.1a root authority: worktrees enabled", caps.worktrees === true && caps.authority === "root");
	const subCaps = sub.capabilities();
	check("2.1b sub authority: worktrees disabled", subCaps.worktrees === false && subCaps.authority === "sub");
	check("2.1c backendName", root.backendName() === "rpc");
}

// --- tab placement shape ------------------------------------------------------
{
	const repo = mkdtempSync(join(tmpdir(), "rpc-check-tab-"));
	const p = await root.place({ mode: "tab", repoPath: repo, branch: "", label: "qa-tab" });
	check(
		"2.2a shared placement shape (wire value tab) (kind/backend/ref)",
		p.kind === "tab" && p.backend === "rpc" && typeof p.placementRef === "string" && p.placementRef.startsWith("rpc:shared:"),
		JSON.stringify(p),
	);
	check(
		"2.2b legacy fields ride alongside the ref (version-skew rule)",
		typeof p.workspaceId === "string" && typeof p.paneId === "string",
		JSON.stringify(p),
	);
	check("2.2c tab checkoutPath = repoPath (shared checkout)", p.checkoutPath === repo);
	rmSync(repo, { recursive: true, force: true });
}

// --- worktree round-trip against a real temp repo -----------------------------
{
	const repo = mkdtempSync(join(tmpdir(), "rpc-check-repo-"));
	await execFileP("git", ["-C", repo, "init"]);
	await execFileP("git", ["-C", repo, "config", "user.email", "qa@example.com"]);
	await execFileP("git", ["-C", repo, "config", "user.name", "qa"]);
	writeFileSync(join(repo, "seed.txt"), "seed");
	await execFileP("git", ["-C", repo, "add", "."]);
	await execFileP("git", ["-C", repo, "commit", "-m", "seed"]);

	const p = await root.place({ mode: "worktree", repoPath: repo, branch: "qa/rpc-wt", label: "qa-wt" });
	check("2.3a worktree placement shape", p.kind === "worktree" && p.backend === "rpc" && p.placementRef?.startsWith("rpc:wt:") === true, JSON.stringify(p));
	check("2.3b branch echoed", p.branch === "qa/rpc-wt");
	check("2.3c checkoutPath created and populated", p.checkoutPath.includes("rpc-check-repo-"));
	check("2.3d worktree checkout contains the seed file", (() => {
		try {
			return readSeed(p.checkoutPath);
		} catch {
			return false;
		}
	})());

	// teardown: real close, then idempotent re-close.
	const t1 = await root.teardown({ name: "nobody", placement: p, force: true });
	check("2.3e teardown of a live worktree → alreadyGone:false", t1.alreadyGone === false, JSON.stringify(t1));
	const t2 = await root.teardown({ name: "nobody", placement: p, force: true });
	check("2.3f re-teardown of the same placement → alreadyGone:true, no throw", t2.alreadyGone === true, JSON.stringify(t2));
	check("2.3g worktree dir actually removed", !exists(p.checkoutPath));

	rmSync(repo, { recursive: true, force: true });
}

// --- error mapping --------------------------------------------------------------
{
	try {
		await root.startAgent({
			name: "ghost",
			placementRef: "rpc:wt:999999",
			provider: "beta",
			model: "flash",
			thinking: "off",
			timeoutMs: 5_000,
		});
		check("2.4a startAgent unknown placement → E_START", false, "no throw");
	} catch (err) {
		check("2.4a startAgent unknown placement → E_START", isE(err, "E_START"), String(err));
	}
	try {
		await root.waitSettle({ name: "ghost", timeoutMs: 1000 });
		check("2.4b waitSettle unknown agent → E_TIMEOUT", false, "no throw");
	} catch (err) {
		check("2.4b waitSettle unknown agent → E_TIMEOUT", isE(err, "E_TIMEOUT"), String(err));
	}
	try {
		await sub.place({ mode: "worktree", repoPath: mkdtempSync(join(tmpdir(), "rpc-check-sub-")), branch: "x", label: "x" });
		check("2.4c sub-orchestrator worktree place → E_PLACE", false, "no throw");
	} catch (err) {
		check("2.4c sub-orchestrator worktree place → E_PLACE", isE(err, "E_PLACE"), String(err));
	}
	check("2.4d status of unknown agent → null (seam contract)", (await root.getStatus("ghost")) === null);
	check("2.4e empty registry lists nothing", (await root.listStatuses()).length === 0);
}

// --- teardown of a worktree that was already removed by hand ---------------------
{
	const repo = mkdtempSync(join(tmpdir(), "rpc-check-repo2-"));
	await execFileP("git", ["-C", repo, "init"]);
	await execFileP("git", ["-C", repo, "config", "user.email", "qa@example.com"]);
	await execFileP("git", ["-C", repo, "config", "user.name", "qa"]);
	writeFileSync(join(repo, "seed.txt"), "seed");
	mkdirSync(join(repo, "d"));
	writeFileSync(join(repo, "d", "f.txt"), "f");
	await execFileP("git", ["-C", repo, "add", "."]);
	await execFileP("git", ["-C", repo, "commit", "-m", "seed"]);
	const p = await root.place({ mode: "worktree", repoPath: repo, branch: "qa/rpc-wt2", label: "qa-wt2" });
	// Remove the worktree OUT OF BAND (as a user would), then teardown must be idempotent.
	rmSync(p.checkoutPath, { recursive: true, force: true });
	await execFileP("git", ["-C", repo, "worktree", "prune"]);
	const t = await root.teardown({ name: "nobody", placement: p, force: true });
	check("2.5 teardown after out-of-band removal → alreadyGone:true, no throw", t.alreadyGone === true, JSON.stringify(t));
	rmSync(repo, { recursive: true, force: true });
}

// cleanup the shared worktree root if empty
try {
	rmSync(join(tmpdir(), `rpc-check-wt-${process.pid}`), { recursive: true, force: true });
} catch { /* advisory */ }

if (failures > 0) {
	console.error(`\nrpc-host-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-host-check: all green");
process.exit(0);

// --- helpers ------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
function readSeed(checkoutPath: string): boolean {
	return existsSync(checkoutPath) && readFileSync(join(checkoutPath, "seed.txt"), "utf8") === "seed";
}
function exists(p: string): boolean {
	return existsSync(p);
}
