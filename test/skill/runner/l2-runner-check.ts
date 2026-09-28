/**
 * pi-delegate — test/skill/runner/l2-runner-check.ts — BM-4 L2 runner
 * self-check (issue #113): the deterministic rubric + CLI.
 *
 * Run with: bun test/skill/runner/l2-runner-check.ts   (from repo root)
 *
 * NOT auto-discovered by test/run-checks.sh (it globs flat test/*.ts only) —
 * intentional per the BM-4 brief; run this file directly.
 *
 * Covers:
 *   R1  rubric constants — six fixed weights (issue #113 table, sum 100),
 *       threshold 70, tag grammar.
 *   R2  pass edge — S10-shaped blocker mirror + clean trace → 100/pass,
 *       every dimension 100; duplicate trace tags collapse; extra opaque
 *       tags are ignored.
 *   R3  blocker edge — violating trace containing the forbidden tag
 *       (retry:verbatim) → 65/blocker-fail; recovery + no-forbidden zeroed;
 *       forbiddenHits/missed recorded.
 *   R4  dimension zeroing — a forbid hit poisons `no-forbidden` AND its own
 *       dimension even when that dimension's expects matched.
 *   R5  vacuous dimensions — dimensions with no expect items score 1.0;
 *       empty expect/forbid → 100/pass.
 *   R6  boundary — total exactly 70 → pass (blocker AND non-blocker);
 *       total 55 → warn (non-blocker) vs blocker-fail (blocker).
 *   R7  rounding — non-terminating fractions round to 2 decimals.
 *   R8  determinism — repeated scoring byte-identical; fixed 7-key shape.
 *   F1  committed fixtures — scenario/trace fixtures validate clean; the
 *       invalid fixtures each fail with the expected reason; unknown extra
 *       keys tolerated; loaded fixture docs score identically to the inline
 *       twins (parse→validate→score integration).
 *   C1  CLI exit codes via subprocess (real exit codes): validate 0/1/2,
 *       score 0/1/2, score-dir 0/1/2, unknown verb 2; score-dir pairing
 *       (first sorted trace wins) and the missing-trace exit-1 path.
 *
 * Deterministic: no network, no model calls, no randomness; the only IO is
 * the committed fixtures, mkdtemp scratch dirs, and bounded subprocesses.
 * Exit 0 only if all checks pass.
 */

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DIMENSION_WEIGHTS,
	DIMENSIONS,
	PASS_THRESHOLD,
	scoreTrace,
	TAG_RE,
	verdictFor,
	type ScoreResult,
	type ScenarioDoc,
	type TraceDoc,
} from "./rubric.ts";
import {
	loadScenario,
	loadTrace,
	validateScenarioDir,
	validateScenarioDoc,
	validateTraceDoc,
} from "./l2-runner.ts";

const RUNNER_DIR = import.meta.dir;
const FIXTURES = join(RUNNER_DIR, "fixtures");
const SCENARIOS = join(FIXTURES, "scenarios");
const TRACES = join(FIXTURES, "traces");
const INVALID = join(FIXTURES, "invalid");
const CLI = join(RUNNER_DIR, "l2-runner.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
}
function runCliSub(args: string[]): CliRun {
	const res = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		timeout: 20_000,
		cwd: RUNNER_DIR,
	});
	return {
		code: res.status ?? -1,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

// ---------------------------------------------------------------------------
// Inline twins of the committed fixtures (pure-function edges)
// ---------------------------------------------------------------------------

const S10: ScenarioDoc = {
	version: 1,
	id: "S10",
	title: "blocker mirror — verbatim retry is forbidden",
	blocker: true,
	input: { task: "t", context: [], trigger: "t" },
	expect: [
		{ tag: "plan:read-issue", dimension: "load-skip" },
		{ tag: "tool:spawn-worker", dimension: "tool-choice" },
		{ tag: "brief:write-report-contract", dimension: "brief-rules" },
		{ tag: "retry:diagnosed", dimension: "recovery" },
		{ tag: "topology:owned-dir-only", dimension: "topology" },
	],
	forbid: [{ tag: "retry:verbatim", dimension: "recovery" }],
};

const CLEAN: TraceDoc = {
	version: 1,
	scenario: "S10",
	steps: [
		{ tag: "plan:read-issue" },
		{ tag: "tool:spawn-worker" },
		{ tag: "brief:write-report-contract" },
		{ tag: "retry:diagnosed" },
		{ tag: "retry:diagnosed" },
		{ tag: "topology:owned-dir-only" },
		{ tag: "report:write" },
	],
};

const VIOLATING: TraceDoc = {
	version: 1,
	scenario: "S10",
	steps: [
		{ tag: "plan:read-issue" },
		{ tag: "tool:spawn-worker" },
		{ tag: "brief:write-report-contract" },
		{ tag: "retry:verbatim" },
		{ tag: "topology:owned-dir-only" },
	],
};

const ALL_DIMS: Array<{ tag: string; dimension: (typeof DIMENSIONS)[number] }> =
	[
		{ tag: "d:load", dimension: "load-skip" },
		{ tag: "d:tool", dimension: "tool-choice" },
		{ tag: "d:noforb", dimension: "no-forbidden" },
		{ tag: "d:brief", dimension: "brief-rules" },
		{ tag: "d:recovery", dimension: "recovery" },
		{ tag: "d:topology", dimension: "topology" },
	];

function docWith(
	blocker: boolean,
	expect: ScenarioDoc["expect"],
	forbid: ScenarioDoc["forbid"] = [],
): ScenarioDoc {
	return {
		version: 1,
		id: "S42",
		title: "synthetic",
		blocker,
		input: { task: "t", context: [], trigger: "t" },
		expect,
		forbid,
	};
}

function traceWith(...tags: string[]): TraceDoc {
	return { version: 1, scenario: "S42", steps: tags.map((tag) => ({ tag })) };
}

// ---------------------------------------------------------------------------
// R1 — rubric constants
// ---------------------------------------------------------------------------

check(
	"R1: six dimensions in the canonical order",
	DIMENSIONS.length === 6 &&
		DIMENSIONS.join(",") ===
			"load-skip,tool-choice,no-forbidden,brief-rules,recovery,topology",
	DIMENSIONS.join(","),
);
check(
	"R1: fixed weights match the issue #113 table",
	DIMENSION_WEIGHTS["load-skip"] === 15 &&
		DIMENSION_WEIGHTS["tool-choice"] === 20 &&
		DIMENSION_WEIGHTS["no-forbidden"] === 20 &&
		DIMENSION_WEIGHTS["brief-rules"] === 15 &&
		DIMENSION_WEIGHTS.recovery === 15 &&
		DIMENSION_WEIGHTS.topology === 15,
	JSON.stringify(DIMENSION_WEIGHTS),
);
check(
	"R1: weights sum to exactly 100",
	DIMENSIONS.reduce((sum, d) => sum + DIMENSION_WEIGHTS[d], 0) === 100,
);
check("R1: blocker threshold is 70", PASS_THRESHOLD === 70);
check(
	"R1: tag grammar accepts kebab segments and rejects malformed tags",
	TAG_RE.test("plan") &&
		TAG_RE.test("retry:diagnosed") &&
		TAG_RE.test("topology:owned-dir-only") &&
		!TAG_RE.test("Retry:Diagnosed") &&
		!TAG_RE.test("1abc") &&
		!TAG_RE.test("a:") &&
		!TAG_RE.test("") &&
		!TAG_RE.test("a b"),
);

// ---------------------------------------------------------------------------
// R2/R3 — the S10 blocker mirror: pass edge and blocker edge
// ---------------------------------------------------------------------------

const cleanScore = scoreTrace(S10, CLEAN);
check(
	"R2: clean trace → total 100, verdict pass",
	cleanScore.total === 100 && cleanScore.verdict === "pass",
	JSON.stringify(cleanScore),
);
check(
	"R2: clean trace → every dimension 100",
	DIMENSIONS.every((d) => cleanScore.dimensions[d] === 100),
	JSON.stringify(cleanScore.dimensions),
);
check(
	"R2: duplicate trace tags collapse; extra opaque tags ignored",
	cleanScore.matched.length === 5 &&
		cleanScore.missed.length === 0 &&
		cleanScore.forbiddenHits.length === 0,
	JSON.stringify(cleanScore),
);

const violatingScore = scoreTrace(S10, VIOLATING);
check(
	"R3: violating trace → total 65 < 70, verdict blocker-fail",
	violatingScore.total === 65 && violatingScore.verdict === "blocker-fail",
	JSON.stringify(violatingScore),
);
check(
	"R3: forbid hit zeroes recovery AND no-forbidden",
	violatingScore.dimensions.recovery === 0 &&
		violatingScore.dimensions["no-forbidden"] === 0,
	JSON.stringify(violatingScore.dimensions),
);
check(
	"R3: forbiddenHits/missed recorded exactly",
	JSON.stringify(violatingScore.forbiddenHits) ===
		JSON.stringify(["retry:verbatim"]) &&
		JSON.stringify(violatingScore.missed) ===
			JSON.stringify(["retry:diagnosed"]),
	JSON.stringify(violatingScore),
);

// ---------------------------------------------------------------------------
// R4 — cross-dimension forbid poisoning
// ---------------------------------------------------------------------------

{
	const doc = docWith(
		false,
		[
			{ tag: "d:load", dimension: "load-skip" },
			{ tag: "d:recovery", dimension: "recovery" },
		],
		[{ tag: "forb:tool", dimension: "tool-choice" }],
	);
	const s = scoreTrace(doc, traceWith("d:load", "d:recovery", "forb:tool"));
	check(
		"R4: hit forbid poisons its own dimension and no-forbidden, matched dims stay credited except those two",
		s.dimensions["tool-choice"] === 0 &&
			s.dimensions["no-forbidden"] === 0 &&
			s.dimensions["load-skip"] === 100 &&
			s.dimensions.recovery === 100,
		JSON.stringify(s.dimensions),
	);
	check(
		"R4: same poisoning arithmetic → total 60 (15+0+0+15+15+15), warn",
		s.total === 60 && s.verdict === "warn",
		`total=${s.total} verdict=${s.verdict}`,
	);
}

// ---------------------------------------------------------------------------
// R5 — vacuous dimensions
// ---------------------------------------------------------------------------

{
	const s = scoreTrace(
		docWith(false, [{ tag: "d:recovery", dimension: "recovery" }]),
		traceWith("d:recovery"),
	);
	check(
		"R5: dimensions with no expect items score 100 (vacuous = 1.0)",
		DIMENSIONS.every((d) => s.dimensions[d] === 100) &&
			s.total === 100 &&
			s.verdict === "pass",
		JSON.stringify(s),
	);
	const empty = scoreTrace(docWith(true, [], []), traceWith());
	check(
		"R5: empty expect/forbid → 100/pass even for a blocker scenario",
		empty.total === 100 && empty.verdict === "pass",
		JSON.stringify(empty),
	);
}

// ---------------------------------------------------------------------------
// R6 — the 70 boundary and blocker/non-blocker divergence
// ---------------------------------------------------------------------------

{
	// One expect per dimension; matching 4 of 6 → 15+20+20+15 = 70 exactly.
	const four = ["d:load", "d:tool", "d:noforb", "d:recovery"];
	const s70 = scoreTrace(docWith(false, ALL_DIMS), traceWith(...four));
	const s70b = scoreTrace(docWith(true, ALL_DIMS), traceWith(...four));
	check(
		"R6: total exactly 70 → pass for BOTH blocker and non-blocker",
		s70.total === 70 &&
			s70.verdict === "pass" &&
			s70b.total === 70 &&
			s70b.verdict === "pass",
		`nb=${s70.verdict} b=${s70b.verdict}`,
	);
	// Matching 3 of 6 → 55: warn diverges from blocker-fail.
	const three = ["d:load", "d:tool", "d:noforb"];
	const s55 = scoreTrace(docWith(false, ALL_DIMS), traceWith(...three));
	const s55b = scoreTrace(docWith(true, ALL_DIMS), traceWith(...three));
	check(
		"R6: total 55 → warn (non-blocker) vs blocker-fail (blocker)",
		s55.total === 55 &&
			s55.verdict === "warn" &&
			s55b.total === 55 &&
			s55b.verdict === "blocker-fail",
		`nb=${s55.verdict} b=${s55b.verdict}`,
	);
	check(
		"R6: verdictFor boundary — 70 passes, 69.99 blocker-fails",
		verdictFor(true, 70) === "pass" &&
			verdictFor(false, 70) === "pass" &&
			verdictFor(true, 69.99) === "blocker-fail" &&
			verdictFor(false, 69.99) === "warn",
	);
}

// ---------------------------------------------------------------------------
// R7 — rounding
// ---------------------------------------------------------------------------

{
	const doc = docWith(false, [
		{ tag: "t:1", dimension: "tool-choice" },
		{ tag: "t:2", dimension: "tool-choice" },
		{ tag: "t:3", dimension: "tool-choice" },
	]);
	const s = scoreTrace(doc, traceWith("t:1"));
	check(
		"R7: non-terminating fractions round to 2 decimals (100/3 → 33.33; total 86.67 with the rest vacuous)",
		s.total === 86.67 && s.dimensions["tool-choice"] === 33.33,
		`total=${s.total} dim=${s.dimensions["tool-choice"]}`,
	);
}

// ---------------------------------------------------------------------------
// R8 — determinism + fixed shape
// ---------------------------------------------------------------------------

{
	const a = JSON.stringify(scoreTrace(S10, CLEAN));
	const b = JSON.stringify(scoreTrace(S10, CLEAN));
	check("R8: repeated scoring is byte-identical", a === b);
	const keys = Object.keys(scoreTrace(S10, CLEAN)).sort().join(",");
	check(
		"R8: ScoreResult carries exactly the 7 contract keys",
		keys ===
			"dimensions,forbiddenHits,matched,missed,scenario,total,verdict",
		keys,
	);
}

// ---------------------------------------------------------------------------
// F1 — committed fixtures: validators + parse→score integration
// ---------------------------------------------------------------------------

{
	const dirValidation = validateScenarioDir(SCENARIOS);
	check(
		"F1: all three committed scenario fixtures validate clean",
		dirValidation.ok &&
			dirValidation.results.length === 3 &&
			dirValidation.results.every((r) => r.ok),
		JSON.stringify(dirValidation),
	);

	const s10Doc = loadScenario(join(SCENARIOS, "S10-blocker-mirror.json"));
	const cleanTrace = loadTrace(
		join(TRACES, "S10-blocker-mirror.clean.json"),
	);
	const integrated =
		s10Doc.ok && cleanTrace.ok ? scoreTrace(s10Doc.scenario, cleanTrace.trace) : null;
	check(
		"F1: loaded fixture docs score identically to the inline twins (100/pass)",
		integrated !== null &&
			integrated.total === 100 &&
			integrated.verdict === "pass" &&
			JSON.stringify(integrated) === JSON.stringify(cleanScore),
		JSON.stringify(integrated),
	);

	const violations = validateScenarioDir(INVALID);
	const byFile = new Map<string, string[]>();
	if (violations.ok) {
		for (const r of violations.results) {
			byFile.set(r.file.split("/").pop()!, r.reasons);
		}
	}
	const expectInvalid: Array<[string, RegExp]> = [
		["bad-id.json", /id/],
		["bad-tag.json", /tag/],
		["bad-dimension.json", /dimension/],
		["bad-version.json", /version/],
		["bad-input.json", /input\.task/],
		["bad-blocker.json", /blocker/],
		["broken-json.json", /invalid JSON/i],
	];
	check(
		"F1: all seven invalid fixtures rejected",
		violations.ok &&
			violations.results.length === 7 &&
			violations.results.every((r) => !r.ok),
		JSON.stringify(violations.ok ? violations.results.map((r) => r.file) : violations),
	);
	for (const [name, re] of expectInvalid) {
		const reasons = byFile.get(name) ?? [];
		check(
			`F1: ${name} fails with the expected reason`,
			reasons.some((r) => re.test(r)),
			reasons.join("; "),
		);
	}

	const tolerant = validateScenarioDoc({
		version: 1,
		id: "S13",
		title: "extra keys tolerated",
		blocker: false,
		input: { task: "t", context: [], trigger: "t", note: "extra" },
		expect: [],
		forbid: [],
		hints: ["unknown top-level key"],
	});
	check(
		"F1: unknown extra keys are tolerated (forward-compat)",
		tolerant.length === 0,
		tolerant.join("; "),
	);
	const badTrace = validateTraceDoc({ version: 1, scenario: "S10", steps: [{ tag: "ok:tag" }, { tag: "BAD TAG" }] });
	check(
		"F1: trace validator flags only the malformed step",
		badTrace.length === 1 && /steps\[1\]\.tag/.test(badTrace[0]!),
		badTrace.join("; "),
	);
}

// ---------------------------------------------------------------------------
// C1 — CLI verbs via subprocess: real exit codes are the contract
// ---------------------------------------------------------------------------

{
	const v0 = runCliSub(["validate", "--dir", SCENARIOS]);
	check(
		"C1: validate valid dir → exit 0, '3 valid'",
		v0.code === 0 && /3 valid/.test(v0.stdout),
		`code=${v0.code} out=${v0.stdout}`,
	);

	const v1 = runCliSub(["validate", "--dir", INVALID]);
	const listed = ["bad-id", "bad-tag", "bad-dimension", "bad-version", "bad-input", "bad-blocker", "broken-json"];
	check(
		"C1: validate invalid dir → exit 1, every bad file listed",
		v1.code === 1 && listed.every((n) => v1.stdout.includes(n)),
		`code=${v1.code} out=${v1.stdout}`,
	);

	const v2io = runCliSub(["validate", "--dir", join(tmpdir(), "l2-runner-check-nope")]);
	check("C1: validate nonexistent dir → exit 2", v2io.code === 2, `code=${v2io.code}`);
	const v2usage = runCliSub(["validate"]);
	check(
		"C1: validate without --dir → exit 2 + usage on stderr",
		v2usage.code === 2 && v2usage.stderr.includes("usage:"),
		`code=${v2usage.code} err=${v2usage.stderr}`,
	);

	const s0 = runCliSub([
		"score",
		"--scenario",
		join(SCENARIOS, "S10-blocker-mirror.json"),
		"--trace",
		join(TRACES, "S10-blocker-mirror.clean.json"),
	]);
	let s0Json: ScoreResult | null = null;
	try {
		s0Json = JSON.parse(s0.stdout) as ScoreResult;
	} catch {
		s0Json = null;
	}
	check(
		"C1: score clean → exit 0, printed score JSON 100/pass",
		s0.code === 0 && s0Json !== null && s0Json.total === 100 && s0Json.verdict === "pass",
		`code=${s0.code} out=${s0.stdout.slice(0, 120)}`,
	);

	const s1 = runCliSub([
		"score",
		"--scenario",
		join(SCENARIOS, "S10-blocker-mirror.json"),
		"--trace",
		join(TRACES, "S10-blocker-mirror.violating.json"),
	]);
	let s1Json: ScoreResult | null = null;
	try {
		s1Json = JSON.parse(s1.stdout) as ScoreResult;
	} catch {
		s1Json = null;
	}
	check(
		"C1: BLOCKER ENFORCEMENT via CLI — violating trace → exit 1, 65/blocker-fail",
		s1.code === 1 &&
			s1Json !== null &&
			s1Json.total === 65 &&
			s1Json.verdict === "blocker-fail",
		`code=${s1.code} out=${s1.stdout.slice(0, 120)}`,
	);

	const sWarn = runCliSub([
		"score",
		"--scenario",
		join(SCENARIOS, "S07-warn.json"),
		"--trace",
		join(TRACES, "S07-warn.json"),
	]);
	let sWarnJson: ScoreResult | null = null;
	try {
		sWarnJson = JSON.parse(sWarn.stdout) as ScoreResult;
	} catch {
		sWarnJson = null;
	}
	check(
		"C1: score partial → exit 0, warn at 67.5",
		sWarn.code === 0 &&
			sWarnJson !== null &&
			sWarnJson.total === 67.5 &&
			sWarnJson.verdict === "warn",
		`code=${sWarn.code} out=${sWarn.stdout.slice(0, 120)}`,
	);

	const s2flag = runCliSub(["score", "--scenario", join(SCENARIOS, "S07-warn.json")]);
	check("C1: score missing --trace → exit 2", s2flag.code === 2, `code=${s2flag.code}`);
	const s2file = runCliSub([
		"score",
		"--scenario",
		join(tmpdir(), "no-such-scenario.json"),
		"--trace",
		join(TRACES, "S07-warn.json"),
	]);
	check("C1: score nonexistent scenario file → exit 2", s2file.code === 2, `code=${s2file.code}`);

	const scratch = mkdtempSync(join(tmpdir(), "l2-runner-check-"));
	const badTracePath = join(scratch, "bad-trace.json");
	writeFileSync(badTracePath, "{ nope\n", "utf8");
	const s2parse = runCliSub([
		"score",
		"--scenario",
		join(SCENARIOS, "S07-warn.json"),
		"--trace",
		badTracePath,
	]);
	check("C1: score malformed trace JSON → exit 2", s2parse.code === 2, `code=${s2parse.code}`);

	const d0 = runCliSub(["score-dir", "--scenarios", SCENARIOS, "--traces", TRACES]);
	let d0Json: { mean: number; perScenario: Array<{ scenario: string }> } | null = null;
	try {
		d0Json = JSON.parse(d0.stdout) as { mean: number; perScenario: Array<{ scenario: string }> };
	} catch {
		d0Json = null;
	}
	check(
		"C1: score-dir full set → exit 0, mean 79.17, three scenarios, S10 scored with the clean trace",
		d0.code === 0 &&
			d0Json !== null &&
			d0Json.mean === 79.17 &&
			d0Json.perScenario.length === 3 &&
			(d0Json.perScenario.find((e) => e.scenario === "S10") as { verdict?: string })
				?.verdict === "pass",
		`code=${d0.code} out=${d0.stdout.slice(0, 200)}`,
	);

	// Missing-trace path: a traces dir without the S07 trace forces exit 1.
	const tracesPartial = join(scratch, "traces-partial");
	mkdirSync(tracesPartial, { recursive: true });
	for (const name of ["S01-boundary.json", "S10-blocker-mirror.clean.json"]) {
		writeFileSync(
			join(tracesPartial, name),
			readFixture(join(TRACES, name)),
			"utf8",
		);
	}
	const d1 = runCliSub(["score-dir", "--scenarios", SCENARIOS, "--traces", tracesPartial]);
	let d1Json: { mean: number; perScenario: Array<Record<string, unknown>> } | null = null;
	try {
		d1Json = JSON.parse(d1.stdout) as {
			mean: number;
			perScenario: Array<Record<string, unknown>>;
		};
	} catch {
		d1Json = null;
	}
	const s07Entry = d1Json?.perScenario.find((e) => e.scenario === "S07");
	check(
		"C1: score-dir with missing trace → exit 1, S07 error entry, mean over the 2 scored",
		d1.code === 1 &&
			d1Json !== null &&
			d1Json.mean === 85 &&
			s07Entry !== undefined &&
			typeof s07Entry.error === "string",
		`code=${d1.code} out=${d1.stdout.slice(0, 300)}`,
	);

	const d2flag = runCliSub(["score-dir", "--scenarios", SCENARIOS]);
	check("C1: score-dir missing --traces → exit 2", d2flag.code === 2, `code=${d2flag.code}`);
	const d2io = runCliSub([
		"score-dir",
		"--scenarios",
		SCENARIOS,
		"--traces",
		join(tmpdir(), "l2-runner-check-nope"),
	]);
	check("C1: score-dir nonexistent traces dir → exit 2", d2io.code === 2, `code=${d2io.code}`);

	const verb2 = runCliSub(["frobnicate"]);
	check("C1: unknown verb → exit 2", verb2.code === 2, `code=${verb2.code}`);

	const det1 = runCliSub([
		"score",
		"--scenario",
		join(SCENARIOS, "S10-blocker-mirror.json"),
		"--trace",
		join(TRACES, "S10-blocker-mirror.clean.json"),
	]);
	const det2 = runCliSub([
		"score",
		"--scenario",
		join(SCENARIOS, "S10-blocker-mirror.json"),
		"--trace",
		join(TRACES, "S10-blocker-mirror.clean.json"),
	]);
	check(
		"C1: CLI output is deterministic across runs (byte-identical stdout)",
		det1.stdout === det2.stdout && det1.stdout.length > 0,
	);
}

/** Read a committed fixture for copying into scratch dirs. */
function readFixture(path: string): string {
	return readFileSync(path, "utf8");
}

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall l2-runner checks passed");
