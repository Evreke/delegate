/**
 * Manifest depth check — swarm-core-v1 issue #28.
 *
 * A worker spawned by the ROOT orchestrator records `depth: 0`; a worker
 * spawned by a SUB-orchestrator records `depth: 1` (parent+1 under the
 * two-level authority model). The write happens at the ONE manifest-append
 * site in src/spawn.ts, driven by the bound transport's
 * capabilities().authority — so a transport double with authority:"sub" is
 * enough to prove criterion 3 without herdr.
 *
 * Run with: bun test/manifest-depth-check.ts   (from repo root)
 *
 * Checks:
 *   D1  authority "sub" → the appended manifest entry carries depth 1.
 *   D2  authority "root" → the appended manifest entry carries depth 0.
 *
 * Deterministic: an in-memory transport double (no herdr, no subprocess); the
 * spawn ends at the report-wait phase (no report → E_REPORT_MISSING) after
 * the manifest append, which is all this check inspects.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorityMode, Placement, PlacementReq, Transport } from "../src/host.ts";
import { readManifest } from "../src/manifest-store.ts";
import { registerDelegateTool } from "../src/spawn.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), "manifest-depth-exchange-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;
const taskDir = join(EXCHANGE_SANDBOX, "depth-task");
mkdirSync(taskDir, { recursive: true });
const repoDir = mkdtempSync(join(tmpdir(), "manifest-depth-repo-"));

/** Mutable authority the transport double reports for the NEXT spawn. */
let authority: AuthorityMode = "root";
let seq = 0;

const hybrid: Transport = {
	place: async (_req: PlacementReq): Promise<Placement> => {
		const n = ++seq;
		return {
			kind: "tab",
			workspaceId: `ws-${n}`,
			paneId: `pane-${n}`,
			checkoutPath: repoDir,
			backend: "fake",
			placementRef: `fake:${n}`,
		};
	},
	startAgent: async (req) => ({ name: req.name, sessionId: "s1" }),
	submitPrompt: async () => {},
	waitSettle: async () => ({ kind: "settled", status: "idle" }),
	getStatus: async () => null,
	listStatuses: async () => [],
	teardown: async () => ({ alreadyGone: false }),
	capabilities: () => ({ worktrees: true, authority }),
	backendName: () => "fake",
};

let captured!: {
	execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }>;
	parameters: unknown;
};
const fakePi = { registerTool: (tl: never) => (captured = tl as never) };
registerDelegateTool(fakePi as never, hybrid);

async function runSpawn(name: string): Promise<void> {
	const briefPath = join(taskDir, `brief-${name}.md`);
	writeFileSync(briefPath, `# brief ${name}\n\nOUTPUT: report-${name}.json\n`);
	await captured.execute(
		"t1",
		{ name, briefPath, mode: "shared", provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: repoDir },
		undefined,
		() => {},
		{ cwd: repoDir, hasUI: false },
	);
}

// -------------------------------------------------------------------------
// D1 — a sub-orchestrator's child records depth 1.
// -------------------------------------------------------------------------
{
	authority = "sub";
	await runSpawn("sub-child");
	const entry = readManifest(taskDir)?.workers.find((w) => w.name === "sub-child");
	check(
		"D1 sub-orchestrator spawn → manifest entry carries depth 1",
		entry?.depth === 1,
		JSON.stringify(entry),
	);
}

// -------------------------------------------------------------------------
// D2 — a root orchestrator's worker records depth 0.
// -------------------------------------------------------------------------
{
	authority = "root";
	await runSpawn("root-child");
	const entry = readManifest(taskDir)?.workers.find((w) => w.name === "root-child");
	check(
		"D2 root orchestrator spawn → manifest entry carries depth 0",
		entry?.depth === 0,
		JSON.stringify(entry),
	);
}

console.log(failures === 0 ? "\nALL MANIFEST-DEPTH CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);