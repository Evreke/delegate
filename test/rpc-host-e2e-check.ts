/**
 * rpc-host-e2e-check — LIVE worker flow against a real `pi --mode rpc`
 * child process (the rpc backend's transport-contract analogue).
 *
 * OPT-IN: set RPC_E2E=1 to run — it spawns a real pi worker on the configured
 * provider (flash tier by default via RPC_E2E_MODEL, default "flash") and
 * burns a handful of tokens. Default (no env var): SKIP, exit 0, so the
 * deterministic suite never depends on API access.
 *
 * Flow (mirrors the probe path of spawn.ts at the seam level):
 *   place(worktree, real temp repo) → startAgent → submitPrompt(probe prompt)
 *   → waitSettle (event-driven agent_settled) → readConsole contains the probe
 *   sentinel → sessionPath written by pi (budget-gauge input) → getStatus
 *   after settle → teardown kills the child → worktree gone.
 *
 * Run with: RPC_E2E=1 bun test/rpc-host-e2e-check.ts   (from repo root)
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRpcTransport } from "../src/host/rpc.ts";
import { sessionHasReply, type Transport } from "../src/host.ts";

const execFileP = promisify(execFile);

if (process.env.RPC_E2E !== "1") {
	console.log("SKIP rpc-host-e2e-check — set RPC_E2E=1 to run the live worker flow");
	process.exit(0);
}

const MODEL = process.env.RPC_E2E_MODEL ?? "flash";
const PROVIDER = process.env.RPC_E2E_PROVIDER ?? "beta";
// NOTE: thinking "off" makes this flash model return EMPTY assistant content
// (observed 2026-09-15) — "medium" is the known-good smoke default.
const THINKING = process.env.RPC_E2E_THINKING ?? "medium";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const transport = createRpcTransport({ worktreeRoot: join(tmpdir(), `rpc-e2e-wt-${process.pid}`) });
const repo = mkdtempSync(join(tmpdir(), "rpc-e2e-repo-"));
type TransportPlacement = Awaited<ReturnType<Transport["place"]>>;
const placements: TransportPlacement[] = [];

try {
	await execFileP("git", ["-C", repo, "init"]);
	await execFileP("git", ["-C", repo, "config", "user.email", "qa@example.com"]);
	await execFileP("git", ["-C", repo, "config", "user.name", "qa"]);
	writeFileSync(join(repo, "seed.txt"), "seed");
	await execFileP("git", ["-C", repo, "add", "."]);
	await execFileP("git", ["-C", repo, "commit", "-m", "seed"]);

	// 1. place + start
	const p = await transport.place({ mode: "worktree", repoPath: repo, branch: "qa/rpc-e2e", label: "e2e" });
	placements.push(p);
	const start = await transport.startAgent({
		name: "rpc-e2e-worker",
		placementRef: p.placementRef ?? "",
		provider: PROVIDER,
		model: MODEL,
		thinking: THINKING,
		timeoutMs: 60_000,
	});
	check("e2e.1 startAgent returns canonical name", start.name === "rpc-e2e-worker", JSON.stringify(start));
	// pi reports the session path BEFORE creating the file (materialized on the
	// first prompt — e2e.6 proves it exists after the run; the gauges tolerate
	// a not-yet-created file).
	check(
		"e2e.2 sessionPath reported (budget-gauge input)",
		typeof start.sessionPath === "string" && !!start.sessionPath && start.sessionPath!.endsWith(".jsonl"),
		String(start.sessionPath),
	);

	// 2. probe-style prompt + event-driven settle
	const t0 = Date.now();
	await transport.submitPrompt({ name: start.name, text: "Reply with exactly: OUTPUT: OK", timeoutMs: 15_000 });
	check("e2e.3 submitPrompt accepted", true);

	const settle = await transport.waitSettle({
		name: start.name,
		timeoutMs: 120_000,
		onPoll: (info) => {
			if (info.elapsedMs % 5000 < 300) console.log(`  [poll ${info.elapsedMs}ms] status=${info.status} started=${info.started}`);
		},
	});
	check("e2e.4 waitSettle → settled (agent_settled event proof)", settle.kind === "settled", JSON.stringify(settle));
	console.log(`  settle took ${((Date.now() - t0) / 1000).toFixed(1)}s, status=${settle.status}`);

	// 3. probe verdict via readConsole (the no-report smoke gate) — the adapter
	// binds readConsole at construction, so even an unbound extraction is safe;
	// the optional chaining is the seam's optionality, not this adapter's.
	check("e2e.5a readConsole available on the rpc adapter", typeof transport.readConsole === "function");
	const consoleText = (await transport.readConsole?.(start.name, { maxChars: 4000 })) ?? "";
	check("e2e.5 readConsole contains the probe sentinel OUTPUT: OK", consoleText.includes("OUTPUT: OK"), consoleText.slice(-300));

	// 4. session JSONL has an assistant reply (sessionHasReply proof)
	check("e2e.6 sessionHasReply(sessionPath) === true", start.sessionPath ? sessionHasReply(start.sessionPath) : false);

	// 5. status after settle
	const st = await transport.getStatus(start.name);
	check("e2e.7 status after settle is idle/done", st !== null && (st.status === "idle" || st.status === "done"), JSON.stringify(st));

	// 6. teardown kills the child + removes the worktree
	const t1 = await transport.teardown({ name: start.name, placement: p, force: true });
	check("e2e.8 teardown closed something real", t1.alreadyGone === false, JSON.stringify(t1));
	check("e2e.9 worker gone from listStatuses", !(await transport.listStatuses()).some((s) => s.name === start.name));
	check("e2e.10 worktree directory removed", !existsSync(p.checkoutPath));
} finally {
	// Sweep any surviving placement even on failure.
	for (const p of placements) {
		try {
			await transport.teardown({ name: "", placement: p, force: true });
		} catch { /* advisory */ }
	}
	rmSync(repo, { recursive: true, force: true });
	try {
		rmSync(join(tmpdir(), `rpc-e2e-wt-${process.pid}`), { recursive: true, force: true });
	} catch { /* advisory */ }
}

if (failures > 0) {
	console.error(`\nrpc-host-e2e-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-host-e2e-check: all green");
process.exit(0);
