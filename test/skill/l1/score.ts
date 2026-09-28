/**
 * pi-delegate — test/skill/l1/score.ts — the BM-2 L1 alignment scorer (issue
 * #111): 0–100 score of the skill TEXT against the REAL tool-contract
 * fixture `test/skill/tool-contract.json` (schema: ToolContract from
 * ../l3/skill-delta.ts — version 1, claims[] with id/claim/severity/weight/
 * source/keywords, weights sum 100).
 *
 * MODULE_CONTRACT — owns:
 *   - scoreAlignment(contract, texts) — PURE: zero IO, zero clock. Per claim:
 *     claim score = matched keywords / total keywords, case-insensitive
 *     substring against the UNION of the supplied texts (SKILL.md +
 *     REFERENCE.md — the skill is the directory, as in L3's snapshot walk).
 *     L1 = Σ weight × claim score, rounded to 2 decimals (weights sum 100,
 *     so the score is a percentage). A keyword list must be non-empty
 *     (fixture schema enforces it downstream of loadContract).
 *   - The BLOCKER rule (issue #111): a claim with weight ≥ 10 whose score is
 *     exactly 0 (not a single keyword present) is a blocker — the alignment
 *     layer fails hard regardless of the weighted total. `blockerClaims`
 *     lists them; `blocked` is true when non-empty.
 *   - The THRESHOLD verdict: L1_THRESHOLD (≥ 90, from ../quality/constants.ts
 *     — the one thresholds module, BM-7) — `meetsThreshold` compares the
 *     rounded score. Below-threshold is a REPORTED verdict, not a blocker:
 *     the ship/debt/reject decision is the composite Q's job (BM-6).
 *   - CLI: `score --fixture <f> --skill-dir <dir>` reads <dir>/SKILL.md +
 *     <dir>/REFERENCE.md, prints the result JSON, exit 0 ok · 1 blocker ·
 *     2 usage/IO.
 *
 * STABLE SURFACE: L1Result and L1ClaimResult shapes are consumed by the
 * quality-report builder (BM-6/BM-7); extend, never reshape.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim, ToolContract } from "../l3/skill-delta.ts";
import { L1_THRESHOLD } from "../quality/constants.ts";

export interface L1ClaimResult {
	id: string;
	severity: Claim["severity"];
	weight: number;
	/** Keywords found (case-insensitive substring) in the union text. */
	matched: string[];
	/** Keywords absent from the union text. */
	missing: string[];
	/** matched / total keywords, 2 decimals. */
	score: number;
	/** weight × score, 2 decimals. */
	weighted: number;
	/** weight ≥ 10 AND score === 0 — the issue #111 blocker rule. */
	blocker: boolean;
}

export interface L1Result {
	/** Σ weight × claim score over all claims, 2 decimals (0–100). */
	score: number;
	threshold: number;
	meetsThreshold: boolean;
	/** True when any weight≥10 claim scored exactly 0. */
	blocked: boolean;
	/** The blocking claims (empty when not blocked). */
	blockerClaims: string[];
	perClaim: L1ClaimResult[];
}

function round2(x: number): number {
	return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Score the skill texts against the tool-contract fixture. Pure and
 * deterministic: same contract + same texts → byte-identical result.
 */
export function scoreAlignment(contract: ToolContract, texts: string[]): L1Result {
	const union = texts.join("\n").toLowerCase();
	const perClaim: L1ClaimResult[] = contract.claims.map((claim) => {
		const matched: string[] = [];
		const missing: string[] = [];
		for (const keyword of claim.keywords) {
			(union.includes(keyword.toLowerCase()) ? matched : missing).push(keyword);
		}
		const ratio = claim.keywords.length === 0 ? 0 : matched.length / claim.keywords.length;
		const score = round2(ratio);
		return {
			id: claim.id,
			severity: claim.severity,
			weight: claim.weight,
			matched,
			missing,
			score,
			weighted: round2(claim.weight * ratio),
			blocker: claim.weight >= 10 && score === 0,
		};
	});
	const score = round2(perClaim.reduce((sum, c) => sum + c.weighted, 0));
	const blockerClaims = perClaim.filter((c) => c.blocker).map((c) => c.id);
	return {
		score,
		threshold: L1_THRESHOLD,
		meetsThreshold: score >= L1_THRESHOLD,
		blocked: blockerClaims.length > 0,
		blockerClaims,
		perClaim,
	};
}

// ---------------------------------------------------------------------------
// CLI — exit codes: 0 ok · 1 blocker · 2 usage/IO
// ---------------------------------------------------------------------------

const USAGE = `usage:
  bun test/skill/l1/score.ts score --fixture <tool-contract.json> --skill-dir <skills/delegate>

exit codes: 0 ok (score printed, verdict may be below-threshold) · 1 blocker (weight>=10 claim at 0) · 2 usage/IO`;

function readTexts(skillDir: string): string[] {
	const names = ["SKILL.md", "REFERENCE.md"];
	return names.map((name) => readFileSync(join(skillDir, name), "utf8"));
}

export function runCli(argv: string[]): number {
	const [verb, ...rest] = argv;
	if (verb !== "score") {
		console.error(`l1-score: unknown verb: ${verb ?? "(none)"}\n${USAGE}`);
		return 2;
	}
	const flags: Record<string, string> = {};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (!arg.startsWith("--")) {
			console.error(`l1-score: unexpected argument: ${arg}\n${USAGE}`);
			return 2;
		}
		const key = arg.slice(2);
		const value = rest[i + 1];
		if (value === undefined || value === "") {
			console.error(`l1-score: flag --${key} requires a value\n${USAGE}`);
			return 2;
		}
		flags[key] = value;
		i++;
	}
	if (flags.fixture === undefined || flags["skill-dir"] === undefined) {
		console.error(`l1-score: --fixture and --skill-dir are required\n${USAGE}`);
		return 2;
	}
	let contract: ToolContract;
	let texts: string[];
	try {
		contract = JSON.parse(readFileSync(flags.fixture, "utf8")) as ToolContract;
	} catch (e) {
		console.error(`l1-score: cannot read/parse fixture ${flags.fixture}: ${(e as Error).message}`);
		return 2;
	}
	if (contract.version !== 1 || !Array.isArray(contract.claims) || contract.claims.length === 0) {
		console.error(`l1-score: fixture ${flags.fixture}: version must be 1 with a non-empty claims[]`);
		return 2;
	}
	try {
		texts = readTexts(flags["skill-dir"]);
	} catch (e) {
		console.error(`l1-score: cannot read skill dir ${flags["skill-dir"]}: ${(e as Error).message}`);
		return 2;
	}
	const result = scoreAlignment(contract, texts);
	console.log(JSON.stringify(result, null, "\t"));
	return result.blocked ? 1 : 0;
}

if (import.meta.main) {
	process.exit(runCli(process.argv.slice(2)));
}
