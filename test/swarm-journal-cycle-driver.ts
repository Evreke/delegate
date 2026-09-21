/**
 * swarm-journal-cycle-driver — runs the REAL delegate tool cycle (spawn →
 * settle → collect) in a child bun process under a journal-storage
 * configuration selected by the parent's env, prints ONE JSON line, and
 * exits. Split into a driver process because the manifest-store default is
 * chosen ONCE at module load from the storage config (issue #23, §4.1.3).
 *
 * Env (set by test/swarm-journal-cycle-check.ts):
 *   PI_DELEGATE_EXCHANGE_ROOT  sandbox exchange root
 *   SWARM_STORAGE              "journal"
 *   SWARM_PROJECTION           "true" | "false"
 *   SWARM_JOURNAL_DB           journal db path (or an unopenable path — fault leg)
 *   SWARM_SESSION_ID           fixed fleet session id
 *
 * argv[2]: "fake" (mock Transport) | "rpc" (real pi --mode rpc transport).
 *
 * Output JSON: { ok, code, projectionExists, replayWorkers, journalKinds,
 *                cliExit, cliStderr, cliJournal }
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Transport } from "../src/host.ts";

const TRANSPORT_MODE = process.argv[2] ?? "fake";
const EXCHANGE_ROOT = process.env.PI_DELEGATE_EXCHANGE_ROOT!;
const NAME = `jcy-${process.pid}`;
const ROOT = join(EXCHANGE_ROOT, "task-journal-cycle");
const REPO = mkdtempSync(join(tmpdir(), "jcy-repo-"));
mkdirSync(ROOT, { recursive: true });
const BRIEF = join(ROOT, `brief-${NAME}.md`);
writeFileSync(BRIEF, `# Brief — ${NAME}\n\nDo the thing.\n`);

// The report is produced by the WORKER's verb (the CLI) BEFORE the tool
// executes — the delegate cycle then settles and collects it.
const REPORT = {
	worker: NAME,
	status: "pass",
	summary: "journal cycle",
	artifacts: ["a.ts"],
	evidence: [{ claim: "cycle", file: "a.ts:1" }],
};
const CLI = join(import.meta.dir, "..", "src", "swarm", "cli.ts");
const cliEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) cliEnv[k] = v;
cliEnv.SWARM_TASK = "task-journal-cycle";
cliEnv.SWARM_WORKER = NAME;
const cli = spawnSync("bun", [CLI, "write-report"], {
	env: cliEnv,
	input: JSON.stringify(REPORT),
	encoding: "utf8",
	timeout: 20_000,
});
let cliJson: unknown = null;
try {
	cliJson = JSON.parse((cli.stdout ?? "").trim());
} catch {
	cliJson = null;
}

// Build a git repo when the rpc leg needs a worktree source.
if (TRANSPORT_MODE === "rpc") {
	for (const args of [
		["init"],
		["config", "user.email", "qa@example.com"],
		["config", "user.name", "qa"],
	]) {
		spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", timeout: 15_000 });
	}
	writeFileSync(join(REPO, "seed.txt"), "seed");
	spawnSync("git", ["-C", REPO, "add", "."], { encoding: "utf8", timeout: 15_000 });
	spawnSync("git", ["-C", REPO, "commit", "-m", "seed"], { encoding: "utf8", timeout: 15_000 });
}

let teardownCalls = 0;
const fakeTransport = (): Transport =>
	({
		place: async (req) => ({
			kind: req.mode,
			workspaceId: "ws-1",
			paneId: "pane-1",
			branch: req.branch,
			checkoutPath: join(REPO, "checkout"),
		}),
		startAgent: async (req) => ({ name: req.name }),
		submitPrompt: async () => {},
		waitSettle: async () => ({ kind: "settled", status: "idle" }),
		getStatus: async () => ({ name: NAME, status: "idle" }),
		listStatuses: async () => [],
		teardown: async () => {
			teardownCalls++;
			return { alreadyGone: false };
		},
		capabilities: () => ({ worktrees: true, authority: "root" }),
		backendName: () => "fake",
	}) as Transport;

let transport: Transport;
if (TRANSPORT_MODE === "rpc") {
	const { createRpcTransport } = await import("../src/host/rpc.ts");
	// The delegate tool passes provider/model/thinking from its params; the rpc
	// transport consumes them on startAgent (mirrors rpc-host-e2e-check).
	transport = createRpcTransport({ worktreeRoot: join(tmpdir(), `jcy-wt-${process.pid}`) });
} else {
	transport = fakeTransport();
}

const { registerDelegateTool } = await import("../src/spawn.ts");
const { manifestStore } = await import("../src/manifest-store.ts");
const { createJournalReader } = await import("../src/swarm/journal-read.ts");

let captured!: {
	execute: (
		...a: unknown[]
	) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};
const fakePi = {
	registerTool: (t: never) => {
		captured = t as never;
	},
};
registerDelegateTool(fakePi as never, transport);

const result = await captured.execute(
	"t1",
	{
		name: NAME,
		briefPath: BRIEF,
		provider: process.env.RPC_E2E_PROVIDER ?? (TRANSPORT_MODE === "rpc" ? "beta" : "p"),
		model: process.env.RPC_E2E_MODEL ?? (TRANSPORT_MODE === "rpc" ? "flash" : "m"),
		thinking: process.env.RPC_E2E_THINKING ?? (TRANSPORT_MODE === "rpc" ? "medium" : "low"),
		waitMs: 1000,
		repoPath: REPO,
	},
	undefined,
	() => {},
	{ cwd: REPO, hasUI: false },
);

const replay = manifestStore.read(ROOT);
const reader = createJournalReader({ dbPath: process.env.SWARM_JOURNAL_DB ?? "" });
const kinds = reader.eventsAfter(0).map((e) => e.kind);
reader.close();

const out = {
	ok: result.details.ok === true,
	code: typeof result.details.code === "string" ? result.details.code : "",
	projectionExists: (() => {
		try {
			readFileSync(join(ROOT, "manifest.json"), "utf8");
			return true;
		} catch {
			return false;
		}
	})(),
	replayWorkers: (replay?.workers ?? []).map((w) => ({
		name: w.name,
		collected: typeof w.collectedAt === "string" && w.collectedAt.length > 0,
	})),
	replayUsage: replay?.usage ?? null,
	journalKinds: kinds,
	cliExit: cli.status,
	cliStderr: cli.stderr ?? "",
	cliJournal: cliJson,
};
console.log(JSON.stringify(out));

// Self-cleanup (best effort; the parent removes the sandbox root anyway).
rmSync(ROOT, { recursive: true, force: true });
rmSync(REPO, { recursive: true, force: true });
if (TRANSPORT_MODE === "rpc") {
	// The rpc transport leaves its worktree root behind on some failure paths.
	rmSync(join(tmpdir(), `jcy-wt-${process.pid}`), { recursive: true, force: true });
}
process.exit(0);