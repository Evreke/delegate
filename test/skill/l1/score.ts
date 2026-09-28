/**
 * pi-delegate — test/skill/l1/score.ts — the BM-2 L1 alignment scorer (issue
 * #111; scope filter per issue #123): 0–100 score of the skill TEXT against
 * the REAL tool-contract fixture `test/skill/tool-contract.json`.
 *
 * Fixture schema v2 (issue #123 — the scope split): SkillContract below —
 * version 2, claims[] with id/claim/severity/weight/source/keywords plus the
 * NEW required appliesTo: "skill-text" | "tool-only". A claim whose truth the
 * judgment-only skill legitimately restates is "skill-text" (scored); a claim
 * naming pure tool-surface mechanics the skill deliberately never repeats is
 * "tool-only" (documented with source/weight, EXCLUDED from L1/L3 scoring).
 * loadSkillContract enforces: skill-text weights sum to EXACTLY 100 (the
 * renormalization invariant) and every claim carries a non-empty keyword
 * list (v1 left that to the fixture author; v2 pins it).
 *
 * MODULE_CONTRACT — owns:
 *   - loadSkillContract(file) — read + shape-validate a v2 fixture; throws
 *     Error with a pointed message on any violation (CLI maps it to exit 2).
 *   - scoreAlignment(contract, texts) — PURE: zero IO, zero clock. SCOPE
 *     FILTER: only claims with appliesTo === "skill-text" are scored; the
 *     tool-only claims are reported in excludedToolOnly (id + documentation
 *     weight) and contribute NOTHING to score/blockers. Per scored claim:
 *     claim score = matched keywords / total keywords, case-insensitive
 *     substring against the UNION of the supplied texts (SKILL.md +
 *     REFERENCE.md — the skill is the directory, as in L3's snapshot walk).
 *     L1 = Σ weight × claim score, rounded to 2 decimals (skill-text weights
 *     sum 100, so the score is a percentage).
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

/** Fixture v2 scope tag (issue #123): scored vs documented-only claims. */
export type ClaimScope = "skill-text" | "tool-only";

/** Fixture v2 claim: the v1 Claim plus the required scope tag. */
export interface SkillClaim extends Claim {
	appliesTo: ClaimScope;
}

/** Fixture v2 contract shape (test/skill/tool-contract.json). */
export interface SkillContract {
	version: 2;
	claims: SkillClaim[];
}

/**
 * Read + shape-validate a schema-v2 skill fixture. Throws Error (not
 * UsageError — this module owns no CLI class hierarchy) with a pointed
 * message on: wrong version, empty/malformed claims[], bad severity, bad or
 * missing appliesTo, empty keyword lists, empty keyword strings, or a
 * skill-text weight sum ≠ 100 (including zero skill-text claims).
 */
export function loadSkillContract(file: string): SkillContract {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new Error(`contract ${file}: cannot read/parse: ${(e as Error).message}`);
	}
	if (typeof value !== "object" || value === null) {
		throw new Error(`contract ${file}: not a JSON object`);
	}
	const v = value as Record<string, unknown>;
	if (v.version !== 2) throw new Error(`contract ${file}: version must be 2 (schema v1 has no appliesTo)`);
	if (!Array.isArray(v.claims) || v.claims.length === 0) {
		throw new Error(`contract ${file}: claims[] must be non-empty`);
	}
	const scopes: ClaimScope[] = [];
	for (const c of v.claims) {
		if (typeof c !== "object" || c === null) {
			throw new Error(`contract ${file}: claim entry not an object`);
		}
		const claim = c as Record<string, unknown>;
		if (typeof claim.id !== "string" || typeof claim.claim !== "string" ||
			typeof claim.severity !== "string" || typeof claim.source !== "string" ||
			typeof claim.weight !== "number" || !Number.isFinite(claim.weight)) {
			throw new Error(`contract ${file}: bad claim ${JSON.stringify(claim)}`);
		}
		if (!["blocker", "major", "minor"].includes(claim.severity)) {
			throw new Error(`contract ${file}: bad severity on ${claim.id}`);
		}
		if (claim.appliesTo !== "skill-text" && claim.appliesTo !== "tool-only") {
			throw new Error(`contract ${file}: claim ${claim.id}: appliesTo must be "skill-text" | "tool-only"`);
		}
		if (!Array.isArray(claim.keywords) || claim.keywords.length === 0 ||
			claim.keywords.some((k) => typeof k !== "string" || k === "")) {
			throw new Error(`contract ${file}: claim ${claim.id}: keywords must be a non-empty array of non-empty strings`);
		}
		scopes.push(claim.appliesTo);
	}
	const skillTextSum = (v.claims as Array<Record<string, unknown>>)
		.filter((c) => c.appliesTo === "skill-text")
		.reduce((sum, c) => sum + (c.weight as number), 0);
	if (skillTextSum !== 100) {
		throw new Error(`contract ${file}: skill-text weights must sum to exactly 100 (got ${skillTextSum}; tool-only weights are documentation only)`);
	}
	return v as unknown as SkillContract;
}

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

/** A tool-only claim as reported for documentation (never scored). */
export interface ExcludedClaim {
	id: string;
	/** Documentation weight — kept from the fixture, NOT part of any sum. */
	weight: number;
}

export interface L1Result {
	/** Σ weight × claim score over SKILL-TEXT claims, 2 decimals (0–100). */
	score: number;
	threshold: number;
	meetsThreshold: boolean;
	/** True when any weight≥10 claim scored exactly 0. */
	blocked: boolean;
	/** The blocking claims (empty when not blocked). */
	blockerClaims: string[];
	/** Fixture v2 scope filter: tool-only claims, documented not scored. */
	excludedToolOnly: ExcludedClaim[];
	perClaim: L1ClaimResult[];
}

function round2(x: number): number {
	return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Score the skill texts against the tool-contract fixture. Pure and
 * deterministic: same contract + same texts → byte-identical result.
 * Fixture v2 SCOPE FILTER (issue #123): only appliesTo "skill-text" claims
 * are scored — the tool-only claims never match keywords, never block, and
 * are reported verbatim in excludedToolOnly. Scoring logic is otherwise
 * unchanged from the v1 scorer.
 */
export function scoreAlignment(contract: SkillContract, texts: string[]): L1Result {
	const union = texts.join("\n").toLowerCase();
	const excludedToolOnly: ExcludedClaim[] = contract.claims
		.filter((claim) => claim.appliesTo === "tool-only")
		.map((claim) => ({ id: claim.id, weight: claim.weight }));
	const perClaim: L1ClaimResult[] = contract.claims
		.filter((claim) => claim.appliesTo === "skill-text")
		.map((claim) => {
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
		excludedToolOnly,
		perClaim,
	};
}

// ---------------------------------------------------------------------------
// CLI — exit codes: 0 ok · 1 blocker · 2 usage/IO
// ---------------------------------------------------------------------------

const USAGE = `usage:
  bun test/skill/l1/score.ts score --fixture <tool-contract.json> --skill-dir <skills/delegate>

fixture: schema v2 (appliesTo scope split; skill-text weights sum 100)
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
	let contract: SkillContract;
	let texts: string[];
	try {
		contract = loadSkillContract(flags.fixture);
	} catch (e) {
		console.error(`l1-score: ${(e as Error).message}`);
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
