/**
 * pi-delegate — test/skill/runner/rubric.ts — the BM-4 L2 rubric (issue #113).
 *
 * MODULE_CONTRACT — single source of truth for the Benchmarks-track L2
 * rubric: the six fixed dimensions and weights, the blocker threshold, the
 * tag grammar, and the pure score/verdict functions over STRUCTURED TAG
 * TRACES. Deterministic by construction: zero model calls, zero IO, zero
 * clock, zero randomness.
 *
 * STABLE SURFACE — BM-2 (fixture scorer, #111) and BM-6 (composite question,
 * #115) import these shapes; do not rename or reshape Dimension /
 * ScoreResult / the weights without a cross-track decision.
 *
 * Scoring rules (deterministic, pure):
 *   - Trace tag set = set of steps[].tag (duplicates collapse).
 *   - matched(expect item) = item.tag ∈ trace tag set; same for forbid hits.
 *   - Per dimension d: score_d = matched_d / n_d over EXPECT items tagged d;
 *     1.0 when n_d = 0 (vacuous — nothing demanded).
 *   - Forbid hits: ANY hit sets the `no-forbidden` score to 0; if the hit
 *     forbid item's own dimension ≠ `no-forbidden`, that dimension's score
 *     is ALSO set to 0 (a forbidden behavior poisons the dimension it
 *     belongs to).
 *   - total = Σ weight_d × score_d, clamped 0..100, rounded to 2 decimals.
 *   - Verdict: blocker && total < PASS_THRESHOLD → "blocker-fail";
 *     total >= PASS_THRESHOLD → "pass"; otherwise "warn".
 *
 * Tags are OPAQUE strings to the runner — semantics live in scenario data,
 * never in tag-name parsing inside the runner. The only structure the rubric
 * sees is the tag GRAMMAR (TAG_RE), shared with the validators in
 * ./l2-runner.ts.
 */

/** The six fixed rubric dimensions, in canonical (output) order. */
export const DIMENSIONS = [
	"load-skip",
	"tool-choice",
	"no-forbidden",
	"brief-rules",
	"recovery",
	"topology",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** Fixed rubric weights (issue #113) — sum to exactly 100. */
export const DIMENSION_WEIGHTS: Readonly<Record<Dimension, number>> = {
	"load-skip": 15,
	"tool-choice": 20,
	"no-forbidden": 20,
	"brief-rules": 15,
	recovery: 15,
	topology: 15,
};

/** The ≥70 gate: below this a blocker scenario fails hard ("blocker-fail"). */
export const PASS_THRESHOLD = 70;

/**
 * Tag grammar: lowercase kebab segments, colon-separated, at least one
 * segment. Examples: `plan`, `retry:diagnosed`, `topology:owned-dir-only`.
 */
export const TAG_RE = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)*$/;

export type Verdict = "pass" | "warn" | "blocker-fail";

/** One expect/forbid entry — the tag is opaque; the dimension does the work. */
export interface ExpectItem {
	tag: string;
	dimension: Dimension;
}

export interface ScenarioInput {
	task: string;
	context: string[];
	trigger: string;
}

/** Scenario file contract (BM track v1). Shape-validated in ./l2-runner.ts. */
export interface ScenarioDoc {
	version: 1;
	id: string;
	title: string;
	blocker: boolean;
	input: ScenarioInput;
	expect: ExpectItem[];
	forbid: ExpectItem[];
}

/** One recorded step of a replay trace. */
export interface TraceStep {
	tag: string;
}

/** Trace file contract — what a replay harness records. */
export interface TraceDoc {
	version: 1;
	scenario: string;
	steps: TraceStep[];
}

/** Score shape — STABLE (imported by BM-2 #111 and BM-6 #115). */
export interface ScoreResult {
	scenario: string;
	total: number;
	verdict: Verdict;
	/** Per-dimension percentage 0..100 (2 decimals). */
	dimensions: Record<Dimension, number>;
	/** Expect tags present in the trace, in scenario expect order. */
	matched: string[];
	/** Expect tags absent from the trace, in scenario expect order. */
	missed: string[];
	/** Forbid tags present in the trace, in scenario forbid order. */
	forbiddenHits: string[];
}

/** Round to 2 decimals, deterministically (no locale, no clock). */
export function round2(x: number): number {
	return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** The verdict rule, isolated for direct boundary testing. */
export function verdictFor(blocker: boolean, total: number): Verdict {
	if (blocker && total < PASS_THRESHOLD) return "blocker-fail";
	return total >= PASS_THRESHOLD ? "pass" : "warn";
}

/**
 * Score a validated trace against a validated scenario. Pure — trusts the
 * documents' shapes (enforced by ./l2-runner.ts validators) and performs no
 * IO. All rubric rules in the header apply verbatim.
 */
export function scoreTrace(scenario: ScenarioDoc, trace: TraceDoc): ScoreResult {
	const traceTags = new Set(trace.steps.map((s) => s.tag));

	const matched: string[] = [];
	const missed: string[] = [];
	for (const item of scenario.expect) {
		(traceTags.has(item.tag) ? matched : missed).push(item.tag);
	}
	const forbiddenHits = scenario.forbid
		.filter((f) => traceTags.has(f.tag))
		.map((f) => f.tag);

	// Per-dimension ratio over EXPECT items; vacuous dimensions score 1.0.
	const scores = {} as Record<Dimension, number>;
	for (const d of DIMENSIONS) {
		const items = scenario.expect.filter((e) => e.dimension === d);
		scores[d] =
			items.length === 0
				? 1
				: items.filter((e) => traceTags.has(e.tag)).length / items.length;
	}

	// Forbid poisoning: any hit zeroes `no-forbidden` and, for a hit whose
	// own dimension differs, that dimension too.
	const hits = scenario.forbid.filter((f) => traceTags.has(f.tag));
	if (hits.length > 0) {
		scores["no-forbidden"] = 0;
		for (const hit of hits) {
			if (hit.dimension !== "no-forbidden") scores[hit.dimension] = 0;
		}
	}

	const dimensions = {} as Record<Dimension, number>;
	let weighted = 0;
	for (const d of DIMENSIONS) {
		dimensions[d] = round2(scores[d] * 100);
		weighted += DIMENSION_WEIGHTS[d] * scores[d];
	}
	const total = round2(Math.min(100, Math.max(0, weighted)));

	return {
		scenario: scenario.id,
		total,
		verdict: verdictFor(scenario.blocker, total),
		dimensions,
		matched,
		missed,
		forbiddenHits,
	};
}
