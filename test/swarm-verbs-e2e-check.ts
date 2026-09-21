/**
 * swarm-verbs-e2e-check — issue #25 acceptance 1, the OPT-IN live leg: a real
 * `pi --mode rpc` worker runs the spawn→report→collect flow using the `swarm`
 * CLI verbs ONLY, with its identity delivered by the spawn flow's exported
 * environment (StartReq.env: SWARM_TASK / SWARM_WORKER / SWARM_SCHEMA_DIR).
 *
 * OPT-IN: set RPC_E2E=1 to run — it spawns a real pi worker on the configured
 * provider (flash tier by default via RPC_E2E_MODEL, default "flash") and
 * burns a handful of tokens. Default (no env var): SKIP, exit 0, so the
 * deterministic suite never depends on API access.
 *
 * Flow (the seam-level mirror of spawn.ts):
 *   place(worktree) → startAgent(env = the swarm identity) → submitPrompt(the
 *   verb instructions) → waitSettle → the worker's `swarm write-report`
 *   produced report-<worker>.json → the collect-time validator accepts it.
 *
 * Run with: RPC_E2E=1 bun test/swarm-verbs-e2e-check.ts   (from repo root)
 * Skip (deterministic suite): bun test/swarm-verbs-e2e-check.ts
 *
 * Fail-fast: a top-level watchdog bounds the whole check; every child spawn is
 * timeout-bounded.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRpcTransport } from "../src/host/rpc.ts";
import { validateReport } from "../src/exchange.ts";

const execFileP = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "swarm", "cli.ts");

if (process.env.RPC_E2E !== "1") {
	console.log(
		"SKIP swarm-verbs-e2e-check — set RPC_E2E=1 to run the live verb worker flow\n" +
			`      (repro: RPC_E2E=1 RPC_E2E_MODEL=<model> bun test/swarm-verbs-e2e-check.ts from ${ROOT})`,
	);
	process.exit(0);
}

const watchdog = setTimeout(() => {
	console.error("swarm-verbs-e2e-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 300_000);
watchdog.unref();

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

const TASK = "verbs-e2e";
const WORKER = "verbs-w1";
const sandbox = mkdtempSync(join(tmpdir(), "swarm-verbs-e2e-"));
const dir = join(sandbox, TASK);
mkdirSync(dir, { recursive: true });
const briefPath = join(dir, `brief-${WORKER}.md`);
writeFileSync(briefPath, `# Brief — ${WORKER}\n\nWrite the report through the swarm verb.\n`, "utf8");
const reportPath = join(dir, `report-${WORKER}.json`);

const transport = createRpcTransport({ worktreeRoot: join(tmpdir(), `swarm-verbs-e2e-wt-${process.pid}`) });
const repo = mkdtempSync(join(tmpdir(), "swarm-verbs-e2e-repo-"));
type TransportPlacement = Awaited<ReturnType<typeof transport.place>>;
const placements: TransportPlacement[] = [];

try {
	await execFileP("git", ["-C", repo, "init"]);
	await execFileP("git", ["-C", repo, "config", "user.email", "qa@example.com"]);
	await execFileP("git", ["-C", repo, "config", "user.name", "qa"]);
	writeFileSync(join(repo, "seed.txt"), "seed");
	await execFileP("git", ["-C", repo, "add", "."]);
	await execFileP("git", ["-C", repo, "commit", "-m", "seed"]);

	// 1. place + start with the spawn flow's swarm identity env.
	const p = await transport.place({ mode: "worktree", repoPath: repo, branch: "qa/swarm-verbs", label: "verbs" });
	placements.push(p);
	const env = {
		SWARM_TASK: TASK,
		SWARM_WORKER: WORKER,
		SWARM_SCHEMA_DIR: join(sandbox, "schemas"),
		PI_DELEGATE_EXCHANGE_ROOT: sandbox,
	};
	const start = await transport.startAgent({
		name: WORKER,
		placementRef: p.placementRef ?? "",
		provider: PROVIDER,
		model: MODEL,
		thinking: THINKING,
		timeoutMs: 60_000,
		env,
	});
	check("verbs.1 startAgent returns the canonical name with the swarm env", start.name === WORKER, JSON.stringify(start));

	// 2. The verb-only brief, mirroring the shipped briefPrompt: the worker
	//    uses `swarm read-brief` and `swarm write-report` with the explicit
	//    identity flags (the env is exported too, but the flags make the
	//    invocation backend-independent).
	const identity = `--brief ${briefPath} --task ${TASK} --worker ${WORKER}`;
	const prompt = [
		`You are the pi-delegate worker "${WORKER}". Your environment carries SWARM_TASK/SWARM_WORKER/SWARM_SCHEMA_DIR.`,
		"Do exactly this using bash, and nothing else:",
		`1. Run: bun ${CLI} read-brief ${identity}`,
		"2. Run this command exactly (the heredoc pipes the report JSON into the verb):",
		`bun ${CLI} write-report ${identity} <<'SWARMREPORT'`,
		`{"worker":"${WORKER}","status":"pass","summary":"verb e2e","artifacts":["report via swarm write-report"],"evidence":[{"claim":"the verb wrote the report","file":"report-${WORKER}.json"}]}`,
		"SWARMREPORT",
		"Then reply with exactly: OUTPUT: OK",
	].join("\n");
	await transport.submitPrompt({ name: start.name, text: prompt, timeoutMs: 15_000 });
	check("verbs.2 submitPrompt accepted", true);

	const settle = await transport.waitSettle({
		name: start.name,
		timeoutMs: 180_000,
		onPoll: (info) => {
			if (info.elapsedMs % 10_000 < 300) console.log(`  [poll ${info.elapsedMs}ms] status=${info.status} started=${info.started}`);
		},
	});
	check("verbs.3 waitSettle → settled", settle.kind === "settled", JSON.stringify(settle));

	if (!existsSync(reportPath)) {
		const c = (await transport.readConsole?.(start.name, { maxChars: 8000 })) ?? "";
		console.error("--- worker console (report missing) ---\n" + c);
	}

	// 3. The verb-written report exists and passes the SAME collect-time
	//    validator the delegate tool uses.
	check("verbs.4 report file written by `swarm write-report` exists", existsSync(reportPath), reportPath);
	const verdict = validateReport(reportPath, WORKER);
	check("verbs.5 collect-time validator accepts the verb-written report", verdict.ok, JSON.stringify(verdict));

	// 4. teardown.
	const t1 = await transport.teardown({ name: start.name, placement: p, force: true });
	check("verbs.6 teardown closed something real", t1.alreadyGone === false, JSON.stringify(t1));
} finally {
	for (const p of placements) {
		try {
			await transport.teardown({ name: "", placement: p, force: true });
		} catch {
			/* advisory */
		}
	}
	rmSync(repo, { recursive: true, force: true });
	rmSync(sandbox, { recursive: true, force: true });
	try {
		rmSync(join(tmpdir(), `swarm-verbs-e2e-wt-${process.pid}`), { recursive: true, force: true });
	} catch {
		/* advisory */
	}
}

if (failures > 0) {
	console.error(`\nswarm-verbs-e2e-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nswarm-verbs-e2e-check: all green");
process.exit(0);
