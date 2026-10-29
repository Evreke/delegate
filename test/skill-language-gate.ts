/**
 * pi-delegate — test/skill-language-gate.ts — the L0.5 language gate:
 * the F3.1-F3.7 language graders plus the F3.8 brief-contract grader
 * (EVAL-PLAN-v2.2.md; graders are deterministic python, zero model calls).
 *
 * Auto-discovered by test/run-checks.sh (flat test/*.ts glob).
 *
 * Targets:
 *   - SKILL.md: F3.1-F3.7 (the seven language rubrics)
 *   - BRIEF.md: F3.1-F3.7 + F3.8 in template mode (the template must obey
 *     the rules it preaches and define the B1-B7 skeleton)
 *
 * Run: bun test/skill-language-gate.ts   (from repo root; fail-fast, pure
 * file reads + subprocess python3 — no network, no model).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const GRADERS = resolve(import.meta.dir, "skill/language-graders");

const SKILL = join(ROOT, "skills/delegate/SKILL.md");
const BRIEF = join(ROOT, "skills/delegate/BRIEF.md");

let failures = 0;

function runGrader(script: string, target: string, mode?: string): boolean {
	const args = [join(GRADERS, script), target];
	if (mode) args.push(mode);
	const r = spawnSync("python3", args, { encoding: "utf8" });
	if (r.status === 0) return true;
	process.stderr.write(
		`FAIL  ${script} on ${target.split("/").pop()}${mode ? ` (${mode})` : ""}\n${r.stdout}${r.stderr}`,
	);
	return false;
}

const graderFiles = readdirSync(GRADERS)
	.filter((f) => f.startsWith("f3_") && f.endsWith(".py"))
	.sort();

for (const g of graderFiles) {
	if (!runGrader(g, SKILL)) failures++;
	if (!runGrader(g, BRIEF)) failures++;
}

if (!runGrader("f38_brief_grader.py", BRIEF, "template")) failures++;

// Self-proof: the F3.8 red brief must fail (the pin bites).
const RED = `# Brief: red-probe\n\n## B1 — Goal\n\nTry to make sure the refactor is reasonable.\n\n## B2 — Inputs\n\nThe repo.\n\n## B3 — Acceptance\n\nDone properly.\n\n## B4 — Evidence required\n\nEvidence if possible.\n\n## B7 — Report contract\n\nTool-owned.\n\n## B5 — Out of scope\n\nNothing.\n`;
const tmp = spawnSync("python3", [
	"-c",
	`import tempfile,subprocess,sys,os
f = tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False)
f.write(${JSON.stringify(RED)})
f.close()
sys.exit(subprocess.call(["python3", ${JSON.stringify(join(GRADERS, "f38_brief_grader.py"))}, f.name, "brief"]))`,
]);
if (tmp.status === 1) console.log("PASS  F3.8 red-brief proof: synthetic violation fails the grader");
else {
	failures++;
	console.error(`FAIL  F3.8 red-brief proof: exit ${tmp.status} (expected 1)`);
}

if (failures > 0) {
	console.error(`\n${failures} language-gate check(s) FAILED`);
	process.exit(1);
}
console.log("\nall skill-language-gate checks passed");
