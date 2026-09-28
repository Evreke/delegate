/**
 * pi-delegate — test/skill-quality-check.ts — the BM-2/BM-6/BM-7 mechanics
 * check (issues #111, #115, #116): the L1 scorer, the L4 budgets, the
 * composite Q, the L2 text projection and the report builder.
 *
 * Auto-discovered by test/run-checks.sh (flat test/*.ts glob). This check
 * pins the MECHANICS with synthetic inputs plus the DETERMINISM of the real
 * pipeline — it deliberately does NOT gate on the current skill's verdicts
 * (those are data in the committed quality-report artifact; the CI gate for
 * skill paths is the L0 flat check, per issue #116's "L0 at least on CI").
 * The one real-text invariant it DOES enforce is the anchor-table tripwire:
 * every expect-role anchor fires on the current texts and every forbid-role
 * anchor stays silent — a skill edit that drops an anchor phrase must
 * re-derive the anchor table in the same commit (HOW-TO documents this).
 *
 * Run with: bun test/skill-quality-check.ts   (from repo root)
 * External bound: `timeout 30 bun test/skill-quality-check.ts`; the only
 * subprocesses are the bounded git calls inside the builder (15 s caps).
 *
 * Covers:
 *   Q1  constants — L1 threshold ≥ 90; Q weights sum to exactly 1; bands
 *       90/80; budgets cover both files with positive caps.
 *   Q2  L1 scorer — synthetic contracts: full match → 100/meets/no blocker;
 *       fractional keyword match weighted exactly; weight ≥ 10 at score 0 →
 *       blocker; weight < 10 at 0 → reported but not blocking;
 *       case-insensitive matching; determinism (byte-identical reruns).
 *   Q3  L2 projection — anchor tripwire on the REAL texts (every expect
 *       anchor fires, every forbid anchor silent, scenario mean 100); every
 *       non-dead-zone forbid anchor fires on its synthetic bad text; guard
 *       phrasings never fire; dead-zone forbid tags never fire even when
 *       their expect-side anchor phrase is present.
 *   Q4  L4 + Q math — normalizeL4/normalizeL3 edges; compositeQ L0-fail ⇒ 0;
 *       band boundaries 90/89.99/80/79.99.
 *   Q5  report builder — two real runs produce byte-identical score-bearing
 *       output (provenance aside); dictated shape (version 1, five layers,
 *       band enum, L2 threshold from the rubric); markdown render carries
 *       the Q line and per-claim/per-scenario tables.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scoreAlignment } from "./skill/l1/score.ts";
import type { ToolContract } from "./skill/l3/skill-delta.ts";
import {
	firedTag,
	scoreScenariosAgainstTexts,
	readSkillTexts,
	type Anchor,
	ANCHORS,
} from "./skill/quality/l2-text.ts";
import {
	buildReport,
	renderMarkdown,
	type QualityReport,
} from "./skill/quality/build.ts";
import {
	compositeQ,
	L1_THRESHOLD,
	L2_PASS_THRESHOLD,
	L4_BUDGETS,
	normalizeL3,
	normalizeL4,
	qBand,
	Q_BANDS,
	Q_WEIGHTS,
} from "./skill/quality/constants.ts";
import { scoreTrace } from "./skill/runner/rubric.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(import.meta.dir, "..");
const SKILL_DIR = join(ROOT, "skills/delegate");
const REAL_TEXTS = readSkillTexts(SKILL_DIR);

// ---------------------------------------------------------------------------
// Q1 — constants
// ---------------------------------------------------------------------------

check("Q1: L1 threshold is a constant ≥ 90", L1_THRESHOLD >= 90, String(L1_THRESHOLD));
check(
	"Q1: Q weights sum to exactly 1",
	Q_WEIGHTS.l1 + Q_WEIGHTS.l2 + Q_WEIGHTS.l3 + Q_WEIGHTS.l4 === 1,
	JSON.stringify(Q_WEIGHTS),
);
check("Q1: bands are ship ≥ 90, debt ≥ 80", Q_BANDS.ship === 90 && Q_BANDS.debt === 80);
check(
	"Q1: budgets cover both skill files with positive caps",
	L4_BUDGETS.length === 2 &&
		L4_BUDGETS.every((b) => b.bytes > 0 && b.lines > 0 && (b.file === "SKILL.md" || b.file === "REFERENCE.md")),
);
check("Q1: L2 threshold re-exported from the stage-1 rubric is 70", L2_PASS_THRESHOLD === 70);

// ---------------------------------------------------------------------------
// Q2 — L1 scorer on synthetic contracts
// ---------------------------------------------------------------------------

function contractOf(claims: Array<{ id: string; weight: number; keywords: string[] }>): ToolContract {
	return {
		version: 1,
		claims: claims.map((c) => ({
			id: c.id,
			claim: `synthetic ${c.id}`,
			severity: "blocker",
			weight: c.weight,
			source: "synthetic",
			keywords: c.keywords,
		})),
	};
}

{
	const texts = ["alpha beta gamma delta"];
	const full = scoreAlignment(
		contractOf([
			{ id: "a", weight: 60, keywords: ["alpha", "beta"] },
			{ id: "b", weight: 40, keywords: ["gamma", "delta"] },
		]),
		texts,
	);
	check("Q2: full match → 100, meets threshold, no blocker", full.score === 100 && full.meetsThreshold && !full.blocked, JSON.stringify(full.score));

	const frac = scoreAlignment(
		contractOf([
			{ id: "a", weight: 20, keywords: ["alpha", "zeta"] }, // 1/2 → 10
			{ id: "b", weight: 80, keywords: ["gamma", "delta"] },
		]),
		texts,
	);
	check("Q2: fractional claim weighted exactly (20 × 1/2 = 10 → total 90)", frac.score === 90, JSON.stringify(frac.score));
	check(
		"Q2: missing keywords listed exactly",
		frac.perClaim[0]?.missing.join(",") === "zeta" && frac.perClaim[0]?.matched.join(",") === "alpha",
		JSON.stringify(frac.perClaim[0]),
	);

	const blocked = scoreAlignment(
		contractOf([
			{ id: "heavy", weight: 30, keywords: ["nope", "nada"] }, // 0 → blocker
			{ id: "light", weight: 70, keywords: ["alpha"] },
		]),
		texts,
	);
	check(
		"Q2: weight ≥ 10 at score 0 → blocker + blockerClaims",
		blocked.blocked && blocked.blockerClaims.join(",") === "heavy" && blocked.score === 70,
		JSON.stringify({ blocked: blocked.blocked, claims: blocked.blockerClaims, score: blocked.score }),
	);

	const lightZero = scoreAlignment(
		contractOf([
			{ id: "light", weight: 5, keywords: ["zeta"] }, // 0 but weight < 10
			{ id: "rest", weight: 95, keywords: ["alpha"] },
		]),
		texts,
	);
	check(
		"Q2: weight < 10 at score 0 → reported, NOT a blocker",
		!lightZero.blocked && lightZero.perClaim[0]?.score === 0 && lightZero.score === 95,
		JSON.stringify(lightZero),
	);

	const ci = scoreAlignment(
		contractOf([{ id: "ci", weight: 100, keywords: ["ALPHA", "Beta"] }]),
		["alpha beta"],
	);
	check("Q2: keyword matching is case-insensitive", ci.score === 100, JSON.stringify(ci.score));

	const a = JSON.stringify(scoreAlignment(contractOf([{ id: "x", weight: 100, keywords: ["alpha"] }]), texts));
	const b = JSON.stringify(scoreAlignment(contractOf([{ id: "x", weight: 100, keywords: ["alpha"] }]), texts));
	check("Q2: determinism — repeated scoring byte-identical", a === b);
}

// ---------------------------------------------------------------------------
// Q3 — L2 projection: tripwire + red/green anchors
// ---------------------------------------------------------------------------

{
	const fired = ANCHORS.filter((a) => a.role === "expect").filter((a) => !firedTag(a.tag, "expect", REAL_TEXTS));
	check(
		"Q3: tripwire — every expect-role anchor fires on the REAL texts",
		fired.length === 0,
		fired.map((a) => a.tag).join(", "),
	);
	const loud = ANCHORS.filter((a) => a.role === "forbid" && a.fire.length > 0).filter((a) => firedTag(a.tag, "forbid", REAL_TEXTS));
	check(
		"Q3: tripwire — every real forbid-role anchor is silent on the REAL texts",
		loud.length === 0,
		loud.map((a) => a.tag).join(", "),
	);
	const dead = ANCHORS.filter((a) => a.role === "forbid" && a.fire.length === 0);
	check(
		"Q3: the four contextual dead zones exist (tool:delegate, mode:worktree, mode:shared, topology:fan-out)",
		["tool:delegate", "mode:worktree", "mode:shared", "topology:fan-out"].every((t) =>
			dead.some((a) => a.tag === t),
		) && dead.length === 4,
		dead.map((a) => a.tag).join(", "),
	);

	const l2 = scoreScenariosAgainstTexts(join(ROOT, "test/skill/scenarios"), REAL_TEXTS);
	check(
		"Q3: static L2 over the real scenario set → mean 100, every scenario pass",
		l2.ok && l2.result.mean === 100 && l2.result.perScenario.every((s) => s.verdict === "pass" && s.total === 100),
		l2.ok ? JSON.stringify(l2.result.mean) : l2.error,
	);

	// Red proof: each non-dead-zone forbid anchor fires on synthetic bad text.
	const BAD: Record<string, string> = {
		"wait:sleep": "Wait for the worker: sleep 120, then look again.",
		"wait:delegate-rewait": "Just re-call the delegate tool to keep waiting for the report.",
		"wait:status-poll-loop": "Poll status repeatedly in a loop until the report appears.",
		"retry:verbatim": "A verbatim retry is the move when a worker fails.",
		"retry:same-name": "Retry under the same worker name to preserve history.",
		"retry:respawn": "Respawn the worker from scratch to get a new answer.",
		"turn:escalate-tool-error": "Treat a status-fail report as a tool error and escalate.",
		"turn:end-idle": "When bored, end your turn idle and wait for the user.",
	};
	for (const anchor of ANCHORS) {
		if (anchor.role !== "forbid" || anchor.fire.length === 0) continue;
		const bad = BAD[anchor.tag];
		if (bad === undefined) {
			failures++;
			console.error(`FAIL  Q3: no synthetic bad text for forbid anchor ${anchor.tag}`);
			continue;
		}
		check(`Q3: ${anchor.tag} fires on its synthetic bad text`, firedTag(anchor.tag, "forbid", [bad]), bad);
	}

	// Guard phrasings (the good text's negations) never fire a forbid anchor.
	const GUARD_TEXTS = [
		"Diagnosed retry, never verbatim — under a NEW worker name (the settled agent keeps the old one).",
		"`status: \"fail\"` in a valid report is an honest completion: read it as a result, not a tool error.",
		"Never bash-sleep and never re-call the tool to wait; status polling is the look-now alternative.",
		"And never end a turn having taken zero actions.",
	];
	for (const anchor of ANCHORS) {
		if (anchor.role !== "forbid" || anchor.fire.length === 0) continue;
		check(
			`Q3: ${anchor.tag} silent on guard/negation phrasings`,
			!firedTag(anchor.tag, "forbid", GUARD_TEXTS),
		);
	}

	// Dead zones never fire, even when the expect-side phrase is present.
	check(
		"Q3: dead-zone mode:worktree stays silent next to its positive anchor",
		!firedTag("mode:worktree", "forbid", ["only a root orchestrator gets worktree isolation"]) &&
			firedTag("mode:worktree", "expect", ["worktree isolation"]),
	);
}

// ---------------------------------------------------------------------------
// Q4 — L4 + Q math
// ---------------------------------------------------------------------------

{
	check("Q4: normalizeL4 — all pass → 100, none → 0, half → 50", normalizeL4([{ pass: true }, { pass: true }]) === 100 && normalizeL4([{ pass: false }]) === 0 && normalizeL4([{ pass: true }, { pass: false }]) === 50);
	check("Q4: normalizeL3 — blocker regression forces 0", normalizeL3(true, [{ weight: 100, missingKeywords: [] }]) === 0);
	check(
		"Q4: normalizeL3 — weighted coverage of satisfied claims (70/100 → 70)",
		normalizeL3(false, [
			{ weight: 70, missingKeywords: [] },
			{ weight: 30, missingKeywords: ["x"] },
		]) === 70,
	);
	check("Q4: normalizeL3 — empty claims → 100", normalizeL3(false, []) === 100);
	check(
		"Q4: compositeQ — L0 fail ⇒ 0 regardless of layers",
		compositeQ(false, 100, 100, 100, 100) === 0,
	);
	check(
		"Q4: compositeQ — exact blend (0.25·78.75 + 0.35·100 + 0.20·0 + 0.20·100 = 74.69)",
		compositeQ(true, 78.75, 100, 0, 100) === 74.69,
		String(compositeQ(true, 78.75, 100, 0, 100)),
	);
	check(
		"Q4: bands — 90 ship, 89.99 debt, 80 debt, 79.99 reject",
		qBand(90) === "ship" && qBand(89.99) === "debt" && qBand(80) === "debt" && qBand(79.99) === "reject",
	);
}

// ---------------------------------------------------------------------------
// Q5 — the real report builder: determinism + dictated shape
// ---------------------------------------------------------------------------

function scoreBearing(report: QualityReport): string {
	const clone: Record<string, unknown> = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
	delete clone.generatedAt;
	delete clone.gitRev;
	return JSON.stringify(clone);
}

{
	const inputs = {
		skillDir: "skills/delegate",
		fixture: "test/skill/tool-contract.json",
		scenariosDir: "test/skill/scenarios",
		before: "629a030^",
	};
	let a: QualityReport;
	let b: QualityReport;
	try {
		a = buildReport(inputs);
		b = buildReport(inputs);
	} catch (e) {
		failures++;
		console.error(`FAIL  Q5: buildReport threw: ${e instanceof Error ? e.message : String(e)}`);
		a = b = undefined as unknown as QualityReport;
	}
	if (a !== undefined) {
		check(
			"Q5: two real runs byte-identical on score-bearing fields (provenance aside)",
			scoreBearing(a) === scoreBearing(b),
		);
		check(
			"Q5: dictated shape — version 1, five layers, band enum, rubric L2 threshold",
			a.version === 1 &&
				a.l0.pinsChecked > 0 &&
				typeof a.l1.score === "number" &&
				a.l2.threshold === L2_PASS_THRESHOLD &&
				typeof a.l3.normalized === "number" &&
				a.l4.metrics.length === 4 &&
				["ship", "debt", "reject"].includes(a.q.band),
			JSON.stringify({ l0: a.l0.pinsChecked, l1: a.l1.score, l2: a.l2.threshold, l3: a.l3.normalized, l4: a.l4.metrics.length, band: a.q.band }),
		);
		check(
			"Q5: L1 + L2 + Q arithmetic is internally consistent (Q = blend, L0 gate off)",
			a.q.value === compositeQ(a.l0.pass, a.l1.score, a.l2.mean, a.l3.normalized, a.l4.normalized),
		);
		const md = renderMarkdown(a);
		check(
			"Q5: markdown carries the Q line, bands and both per-layer tables",
			md.includes(`Q = ${a.q.value}`) &&
				md.includes("## L1 per claim") &&
				md.includes("## L2 per scenario"),
		);
	}
}

// Cross-layer smoke: the stage-1 rubric scores a projected trace like any
// other trace (the projection produces ordinary TraceDoc shapes).
{
	const trace = { version: 1 as const, scenario: "S42", steps: [{ tag: "tool:delegate" }, { tag: "turn:end" }] };
	const scenario = {
		version: 1 as const,
		id: "S42",
		title: "synthetic",
		blocker: false,
		input: { task: "t", context: [], trigger: "t" },
		expect: [
			{ tag: "tool:delegate", dimension: "tool-choice" as const },
			{ tag: "turn:end", dimension: "recovery" as const },
		],
		forbid: [],
	};
	const s = scoreTrace(scenario, trace);
	check("Q5: projected traces are ordinary rubric inputs (100/pass)", s.total === 100 && s.verdict === "pass");
}

if (failures > 0) {
	console.error(`\n${failures} skill-quality check(s) FAILED`);
	process.exit(1);
}
console.log("\nall skill-quality checks passed");
