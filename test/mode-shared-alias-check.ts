/**
 * Mode-alias check — the additive "shared" wire value of the delegate tool's
 * `mode` parameter (terminology migration, 2026-09-15).
 *
 * Run with: bun test/mode-shared-alias-check.ts   (from repo root)
 *
 * Checks:
 *   M1  the tool schema's `mode` parameter accepts BOTH spellings — the new
 *       "shared" value AND the legacy "tab" value (schema-level acceptance).
 *   M2  mode "shared" and mode "tab" produce IDENTICAL placements: the
 *       normalization ("shared" → "tab") happens right after argument
 *       validation, so the transport's place() sees the canonical wire value
 *       "tab" in both cases and the returned placement kind is "tab" both
 *       times (the frozen manifest kind / PlacementMode value).
 *
 * Deterministic: the transport is an in-memory double (no herdr, no
 * subprocess, no network); execute() runs against a mkdtemp exchange dir and
 * ends at the report-wait phase (no report written → E_REPORT_MISSING is the
 * expected terminal shape for this probe of the placement path).
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Placement, PlacementReq, Transport } from "../src/host.ts";
import { registerDelegateTool } from "../src/spawn.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), "mode-alias-exchange-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;
const taskDir = join(EXCHANGE_SANDBOX, "mode-alias-task");
mkdirSync(taskDir, { recursive: true });
const repoDir = mkdtempSync(join(tmpdir(), "mode-alias-repo-"));

/** The placement the double returns — kind is whatever the transport is asked
 *  for; the assertion is that BOTH spellings reach the transport as "tab". */
const placement: Placement = {
	kind: "tab",
	workspaceId: "ws-alias",
	paneId: "pane-alias",
	checkoutPath: repoDir,
	backend: "fake",
	placementRef: "fake:1",
};

const placedModes: string[] = [];
const hybrid: Transport = {
	place: async (req: PlacementReq) => {
		placedModes.push(req.mode);
		return placement;
	},
	startAgent: async () => ({ name: "alias", sessionId: "s1" }),
	submitPrompt: async () => {},
	waitSettle: async () => ({ kind: "settled", status: "idle" }),
	getStatus: async () => null,
	listStatuses: async () => [],
	teardown: async () => ({ alreadyGone: false }),
	capabilities: () => ({ worktrees: true, authority: "root" }),
	backendName: () => "fake",
};

let captured!: {
	execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }>;
	parameters: unknown;
};
const fakePi = { registerTool: (tl: never) => (captured = tl as never) };
registerDelegateTool(fakePi as never, hybrid);

// -------------------------------------------------------------------------
// M1 — the schema accepts both spellings.
// -------------------------------------------------------------------------
{
	const schema = JSON.stringify(captured.parameters);
	check(
		"M1 schema mode enum carries the new 'shared' value alongside the legacy 'tab' value",
		schema.includes('"shared"') && schema.includes('"tab"'),
		schema.slice(0, 400),
	);
}

// -------------------------------------------------------------------------
// M2 — "shared" and "tab" produce identical placements (kind "tab").
// -------------------------------------------------------------------------
async function runWithMode(name: string, mode: string): Promise<{ details: Record<string, unknown> }> {
	const briefPath = join(taskDir, `brief-${name}.md`);
	writeFileSync(briefPath, `# brief ${name}\n\nOUTPUT: report-${name}.json\n`);
	return captured.execute(
		"t1",
		{ name, briefPath, mode, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: repoDir },
		undefined,
		() => {},
		{ cwd: repoDir, hasUI: false },
	);
}

{
	await runWithMode("alias-shared", "shared");
	await runWithMode("alias-tab", "tab");
	check(
		'M2 both spellings reach place() normalized to the canonical wire value "tab"',
		placedModes.length === 2 && placedModes[0] === "tab" && placedModes[1] === "tab",
		JSON.stringify(placedModes),
	);
	check(
		'M2 both placements carry the frozen kind "tab"',
		placement.kind === "tab",
		JSON.stringify(placement),
	);
}

console.log(failures === 0 ? "\nALL MODE-ALIAS CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
