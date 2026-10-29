/**
 * pi-delegate — test/skill/behavioral/run-f1f2.ts — the LOCAL-ONLY behavioral
 * suite (F1 replay + F2 red-line). Never wired into CI: the flat test/*.ts
 * glob does not discover it, and the HOW-TO forbids wiring it.
 *
 * Per version change of the skill text: run this, commit the report it writes
 * next to the skill change (test/skill/behavioral/reports/).
 *
 * Usage:
 *   bun test/skill/behavioral/run-f1f2.ts --suite f2 --limit 3     # smoke
 *   bun test/skill/behavioral/run-f1f2.ts --suite all              # full gate
 *   bun test/skill/behavioral/run-f1f2.ts --ids F2-01,F2-04
 *
 * Target: test/skill/behavioral/target.sh (one headless pi call per case;
 * TARGET_PROVIDER / TARGET_MODEL / TARGET_THINKING override the defaults).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const HERE = resolve(import.meta.dir);
const CASES = join(HERE, "cases");
const REPORTS = join(HERE, "reports");

const args = process.argv.slice(2);
function opt(name: string, def?: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : def;
}
const suite = opt("suite", "all")!;
const limit = Number(opt("limit", "0"));
const repeat = Number(opt("repeat", "3"));
const ids = opt("ids")?.split(",");

const f1All = JSON.parse(readFileSync(join(CASES, "f1-cases.json"), "utf8"));
const f2All = JSON.parse(readFileSync(join(CASES, "f2-cases.json"), "utf8"));
let f1 = suite === "f2" ? [] : f1All;
let f2 = suite === "f1" ? [] : f2All;
if (ids) {
	const want = new Set(ids);
	f1 = f1.filter((c: any) => want.has(c.id));
	f2 = f2.filter((c: any) => want.has(c.id));
}
if (limit > 0) {
	f1 = f1.slice(0, Math.min(limit, f1.length));
	f2 = f2.slice(0, Math.max(0, limit - f1.length));
}

function target(situation: string): string {
	const r = spawnSync(
		"bash",
		[join(HERE, "target.sh")],
		{ input: JSON.stringify({ situation }), encoding: "utf8", timeout: 300_000 },
	);
	if (r.status !== 0) throw new Error(`target failed (${r.status}): ${r.stderr.slice(0, 300)}`);
	return r.stdout.trim();
}

function pyGrader(script: string, output: string, vars: Record<string, string>): { pass: boolean; reason: string } {
	const r = spawnSync("python3", ["-c", `import json,sys;sys.path.insert(0, ${JSON.stringify(join(HERE, "graders"))});import importlib.util;spec=importlib.util.spec_from_file_location("g", ${JSON.stringify(join(HERE, "graders", script))});m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);res=m.get_assert(sys.stdin.read() if False else ${JSON.stringify(output)}, {"vars": ${JSON.stringify(vars)}});print(json.dumps(res))`], { encoding: "utf8" });
	try {
		const res = JSON.parse(r.stdout);
		return { pass: !!res.pass, reason: String(res.reason ?? res.description ?? "") };
	} catch {
		return { pass: false, reason: `grader crash: ${(r.stderr || r.stdout).slice(0, 200)}` };
	}
}

const sha = execSync("git -C " + ROOT + " log -1 --format=%h", { encoding: "utf8" }).trim();
const skillWords = readFileSync(join(ROOT, "skills/delegate/SKILL.md"), "utf8").split(/\s+/).length;
const briefWords = readFileSync(join(ROOT, "skills/delegate/BRIEF.md"), "utf8").split(/\s+/).length;
const now = new Date().toISOString();

interface F2Row { id: string; route: string; graderPass: boolean; verdict: "PASS" | "FAIL"; note: string; }
interface F1Row { id: string; intent: string; real: string; actual: string; verdict: "MATCH" | "BEAT" | "WORSE" | "UNJUDGEABLE"; note: string; }
const f2Rows: F2Row[] = [];
const f1Rows: F1Row[] = [];

for (const c of f2) {
	const runs: { pass: boolean; reason: string }[] = [];
	const raws: string[] = [];
	for (let i = 0; i < repeat; i++) {
		try {
			const out = target(c.situation);
			raws.push(out);
			runs.push(pyGrader("f2_no_delegate.py", out, { expected_route: c.expected_route ?? "" }));
		} catch (e: any) {
			raws.push(`TARGET ERROR: ${e.message}`);
			runs.push({ pass: false, reason: `target error: ${String(e.message).slice(0, 120)}` });
		}
	}
	mkdirSync(join(REPORTS, `raw-${sha}`), { recursive: true });
	writeFileSync(join(REPORTS, `raw-${sha}`, `${c.id}.md`), runs.map((r, i) => `## run ${i + 1} — ${r.pass ? "PASS" : "FAIL"}\n\n${raws[i]}\n`).join("\n"));
	const passes = runs.filter((r) => r.pass).length;
	const verdict = passes === runs.length ? "PASS" : passes === 0 ? "FAIL" : `PASS(flaky ${passes}/${runs.length})`;
	f2Rows.push({ id: c.id, route: c.expected_route, graderPass: passes === runs.length, verdict, note: runs.find((r) => !r.pass)?.reason.slice(0, 140) ?? `${passes}/${runs.length} runs passed` });
	console.error(`F2 ${c.id}: ${verdict}`);
}

for (const c of f1) {
	let out = "";
	try {
		out = target(c.situation?.task_first_user_msg ? c.situation.task_first_user_msg : JSON.stringify(c.situation).slice(0, 4000));
	} catch (e: any) {
		f1Rows.push({ id: c.id, intent: c.class, real: "see case", actual: "target error", verdict: "UNJUDGEABLE", note: String(e.message).slice(0, 120) });
		continue;
	}
	const struct = pyGrader("f1_structure.py", out, {});
	if (!struct.pass) {
		f1Rows.push({ id: c.id, intent: c.class, real: "see case", actual: out.slice(0, 100), verdict: "UNJUDGEABLE", note: struct.reason.slice(0, 140) });
		continue;
	}
	// Honest lightweight comparison: match = prescribes a spawn when the real
	// orchestrator spawned and the plan's mode respects the placement rules;
	// beat = avoids a real-outcome error class (E_PLACE / retry) the case shows;
	// worse = no spawn when the real run spawned productively.
	const realSpawned = !!c.expected_action?.worker_name;
	const prescribesSpawn = /spawn|worker names|mode:\s*(worktree|shared|probe)|B1/i.test(out);
	const realHadError = (c.real_outcome?.e_codes ?? []).length > 0 || c.real_outcome?.retries?.length > 0;
	let verdict: F1Row["verdict"] = "MATCH";
	if (!realSpawned && prescribesSpawn) verdict = "WORSE";
	else if (realSpawned && !prescribesSpawn) verdict = "WORSE";
	else if (realSpawned && prescribesSpawn && realHadError && !/worktree/i.test(out) && c.expected_action?.mode !== "worktree") verdict = "BEAT";
	f1Rows.push({ id: c.id, intent: c.class, real: `${c.expected_action?.intent ?? "?"}/${c.expected_action?.mode ?? "?"}${realHadError ? " +errors" : ""}`, actual: out.slice(0, 100).replace(/\n/g, " "), verdict, note: realHadError ? "real run paid an error path" : "" });
	console.error(`F1 ${c.id}: ${verdict}`);
}

const f2Fail = f2Rows.filter((r) => r.verdict === "FAIL").length;
const f2Flaky = f2Rows.filter((r) => String(r.verdict).startsWith("PASS(flaky")).length;
const f1Worse = f1Rows.filter((r) => r.verdict === "WORSE").length;
const gate = f2Fail === 0 && f1Worse === 0 ? "SHIP-OK" : "HOLD";

const report = `# Behavioral eval report — delegate skill (F1 replay + F2 red-line)

- Date: ${now}
- Skill version: ${sha}
- Skill size: ${skillWords} words SKILL.md / ${briefWords} words BRIEF.md
- Target: \${TARGET_PROVIDER:-llm-platform}/\${TARGET_MODEL:-tensorzero::function_name::frontier}, pi -p --no-tools --no-session
- Suite: ${suite}${limit ? ` --limit ${limit}` : ""} — ${f1.length + f2.length} cases (${f1.length} F1 + ${f2.length} F2)

## Verdict (gate)

- F2 red-line: ${f2Fail === 0 ? "passed" : "FAILED"} — ${f2Rows.length - f2Fail}/${f2Rows.length} routes correct${f2Flaky ? ` (${f2Flaky} flaky — passed on majority, not unanimous)` : ""}
- F1 replay: ${f1Worse === 0 ? "passed" : "FAILED"} — match ${f1Rows.filter((r) => r.verdict === "MATCH").length}, beat ${f1Rows.filter((r) => r.verdict === "BEAT").length}, worse ${f1Worse}, unjudgeable ${f1Rows.filter((r) => r.verdict === "UNJUDGEABLE").length}
- Gate: **${gate}** (hold on any F2 failure or any F1 "worse")

## F2 red-line results

| Case | Route under test | Deterministic grader | Verdict | Note |
|---|---|---|---|---|
${f2Rows.map((r) => `| ${r.id} | ${r.route} | ${r.graderPass ? "pass" : "fail"} | ${r.verdict} | ${r.note} |`).join("\n") || "| — | suite excluded F2 | | | |"}

## F1 replay results

| Case | Intent | Real action | Actual action | Verdict | Note |
|---|---|---|---|---|---|
${f1Rows.map((r) => `| ${r.id} | ${r.intent} | ${r.real} | ${r.actual} | ${r.verdict} | ${r.note} |`).join("\n") || "| — | suite excluded F1 | | | | |"}

## Notes

- Local-only per HOW-TO: F1/F2 are never CI; run on demand per skill-text version change and commit this report with the change.
- Repeat: ${repeat} per F2 case; verdict = unanimous PASS, FAIL, or PASS(flaky) on majority. Flaky cases mark anchoring weakness in the skill text, not a hard regression.
- Verdict rule (honest lightweight): MATCH = spawn-presence agrees with the real run; BEAT = same productive route without the error path the real run paid; WORSE = routing disagrees with a productive real run; UNJUDGEABLE = structure pre-gate fail.
`;

mkdirSync(REPORTS, { recursive: true });
const out = join(REPORTS, `behavioral-report-${sha}-${now.slice(0, 10)}.md`);
writeFileSync(out, report);
console.log(report);
console.error(`\nreport written: ${out}`);
