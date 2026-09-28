/**
 * pi-delegate — test/skill/quality/constants.ts — the BM-6 constants module
 * (issue #115) and the BM-7 thresholds home (issue #116): the ONE place the
 * skill-quality harness encodes its numbers.
 *
 * MODULE_CONTRACT — owns (single source of truth, Law 9):
 *   - L1_THRESHOLD — the L1 alignment bar (issue #111 demands ≥ 90).
 *   - L4_BUDGETS — the L4 size budgets per skill file (bytes + lines), set
 *     with ~30 % headroom over the v2 rewrite (SKILL 4648 B / 67 lines,
 *     REFERENCE 13695 B / 234 lines at commit 629a030) so the caps catch
 *     drift, not the current text. Changing a budget is a deliberate act
 *     recorded in this file alone.
 *   - Q_WEIGHTS — the composite formula weights, summing to exactly 1:
 *     Q = 0.25·L1 + 0.35·L2 + 0.20·L3_norm + 0.20·L4_norm; L0 fail ⇒ Q = 0.
 *   - Q_BANDS + qBand() — verdict bands: Q ≥ 90 "ship", 80–89.99 "debt",
 *     else "reject" (issue #115).
 *   - normalizeL3 / normalizeL4 — the documented normalization rules:
 *       L3_norm = 0 when the delta shows a blocker regression; otherwise the
 *       fixture-weighted coverage of satisfied contract claims (Σ weight of
 *       satisfied ÷ Σ weight × 100 — weights sum 100 in the real fixture).
 *       L4_norm = 100 × satisfied budget metrics ÷ total metrics.
 *   - L2_PASS_THRESHOLD — re-exported, NOT redefined, from the stage-1
 *     rubric (test/skill/runner/rubric.ts stays the single weight source;
 *     this module only re-exports for one-stop discovery).
 *
 * NOT owned: L0 (binary — violations or none; the pin table is
 * test/skill/l0/pins.ts), the L2 rubric itself (stage-1, frozen surface).
 */

export { PASS_THRESHOLD as L2_PASS_THRESHOLD } from "../runner/rubric.ts";

/** L1 alignment bar — issue #111 requires a constant ≥ 90. */
export const L1_THRESHOLD = 90;

/** L4 size budgets — bytes and lines per skill file (see header rationale). */
export interface SizeBudget {
	file: "SKILL.md" | "REFERENCE.md";
	bytes: number;
	lines: number;
}

export const L4_BUDGETS: readonly SizeBudget[] = [
	{ file: "SKILL.md", bytes: 6144, lines: 90 },
	{ file: "REFERENCE.md", bytes: 16384, lines: 280 },
];

/** Composite Q weights — sum to exactly 1 (issue #115 formula). */
export const Q_WEIGHTS = {
	l1: 0.25,
	l2: 0.35,
	l3: 0.2,
	l4: 0.2,
} as const;

/** Verdict bands: ≥ ship → "ship"; ≥ debt → "debt"; else "reject". */
export const Q_BANDS = { ship: 90, debt: 80 } as const;

export type QBand = "ship" | "debt" | "reject";

function round2(x: number): number {
	return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function qBand(q: number): QBand {
	if (q >= Q_BANDS.ship) return "ship";
	if (q >= Q_BANDS.debt) return "debt";
	return "reject";
}

/** The composite: L0 fail ⇒ Q = 0, else the weighted blend (issue #115). */
export function compositeQ(
	l0Pass: boolean,
	l1: number,
	l2: number,
	l3norm: number,
	l4norm: number,
): number {
	if (!l0Pass) return 0;
	return round2(
		Q_WEIGHTS.l1 * l1 + Q_WEIGHTS.l2 * l2 + Q_WEIGHTS.l3 * l3norm + Q_WEIGHTS.l4 * l4norm,
	);
}

/**
 * L3 normalization (see header): 0 on any blocker regression; otherwise the
 * fixture-weighted share of SATISFIED claims (a claim is satisfied when none
 * of its keywords are missing — the same liveness rule as
 * test/skill/l3/skill-delta.ts computeDelta).
 */
export function normalizeL3(
	blockerRegression: boolean,
	claims: Array<{ weight: number; missingKeywords: string[] }>,
): number {
	if (blockerRegression) return 0;
	const total = claims.reduce((sum, c) => sum + c.weight, 0);
	if (total === 0) return 100;
	const satisfied = claims
		.filter((c) => c.missingKeywords.length === 0)
		.reduce((sum, c) => sum + c.weight, 0);
	return round2((100 * satisfied) / total);
}

/** L4 normalization (see header): the share of satisfied budget metrics. */
export function normalizeL4(metrics: Array<{ pass: boolean }>): number {
	if (metrics.length === 0) return 100;
	return round2((100 * metrics.filter((m) => m.pass).length) / metrics.length);
}
