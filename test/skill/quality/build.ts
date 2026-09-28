/**
 * pi-delegate — test/skill/quality/build.ts — the BM-6/BM-7 skill-quality
 * report builder (issues #115, #116): runs L0–L4 over the REAL skill texts
 * and the REAL tool-contract fixture, computes the composite Q, and writes
 * the quality-report artifact (JSON + Markdown).
 *
 * CLI (defaults in brackets; run from repo root):
 *   bun test/skill/quality/build.ts \
 *     [--skill-dir skills/delegate] [--fixture test/skill/tool-contract.json] \
 *     [--scenarios test/skill/scenarios] [--before 629a030^] \
 *     [--out-json test/skill/quality-report.json] [--out-md test/skill/quality-report.md]
 *
 * MODULE_CONTRACT — owns:
 *   - buildReport(paths) — the whole pipeline: L0 pins (test/skill/l0), L1
 *     alignment vs the REAL fixture (test/skill/l1), L2 static text
 *     projection over the stage-1 scenario set (./l2-text.ts), L3 before/
 *     after delta (stage-1 ./../l3/skill-delta.ts snapshotDir/computeDelta —
 *     imported, never reshaped) with the before tree materialized from a git
 *     rev via bounded `git ls-tree` + `git show`, L4 size budgets (./constants),
 *     composite Q + band (./constants). Deterministic in every score-bearing
 *     field; `generatedAt`/`gitRev`/snapshot `capturedAt` are provenance only.
 *   - Exit codes: 0 report written (verdicts are DATA, not failures — the CI
 *     gate for skill paths is the L0 flat check) · 2 usage/IO/git errors.
 *   - `--before` accepts a git rev (materialized to a temp dir; the temp dir
 *     is always removed) or an existing snapshot JSON file (passed straight
 *     to loadSnapshot).
 *
 * NOT owned: thresholds/bands (./constants.ts), the pin table (test/skill/
 * l0/pins.ts), the rubric (stage-1, frozen), CI wiring (flat check
 * discovery). The REAL fixture is the only contract this builder accepts —
 * the sample fixture stays confined to stage-1's own self-tests.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runPins } from "../l0/pins.ts";
import { scoreAlignment } from "../l1/score.ts";
import { computeDelta, countLines, loadContract, loadSnapshot, snapshotDir, type Snapshot } from "../l3/skill-delta.ts";
import { readSkillTexts, scoreScenariosAgainstTexts } from "./l2-text.ts";
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
} from "./constants.ts";

export interface BuildPaths {
	skillDir: string;
	fixture: string;
	scenariosDir: string;
	/** git rev or an existing snapshot JSON file. */
	before: string;
}

export interface QualityReport {
	version: 1;
	generatedAt: string;
	gitRev: string;
	inputs: BuildPaths;
	l0: {
		pass: boolean;
		pinsChecked: number;
		violations: ReturnType<typeof runPins>["violations"];
	};
	l1: ReturnType<typeof scoreAlignment>;
	l2: {
		mean: number;
		threshold: number;
		perScenario: Array<{
			scenario: string;
			total: number;
			verdict: string;
			missed: string[];
			forbiddenHits: string[];
		}>;
	};
	l3: ReturnType<typeof computeDelta> & { normalized: number };
	l4: {
		metrics: Array<{ file: string; metric: "bytes" | "lines"; actual: number; budget: number; pass: boolean }>;
		normalized: number;
	};
	q: {
		formula: string;
		weights: typeof Q_WEIGHTS;
		value: number;
		band: ReturnType<typeof qBand>;
		l0GateApplied: boolean;
	};
}

function gitRev(): string {
	try {
		const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
		if (r.status === 0 && r.stdout) return r.stdout.trim();
	} catch {
		// provenance only
	}
	return "unversioned";
}

/** Materialize <rev>:skills/<name>/*.md into a fresh temp dir. Bounded git. */
function materializeBefore(rev: string, skillDir: string): { ok: true; dir: string } | { ok: false; error: string } {
	const prefix = `${skillDir}/`.replaceAll(/\/+/g, "/");
	const ls = spawnSync("git", ["ls-tree", "-r", "--name-only", rev, skillDir], {
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 1024 * 1024,
	});
	if (ls.status !== 0) {
		return { ok: false, error: `git ls-tree ${rev} ${skillDir} failed: ${(ls.stderr || "").trim()}` };
	}
	const mdPaths = ls.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith(prefix) && l.endsWith(".md"));
	if (mdPaths.length === 0) {
		return { ok: false, error: `git rev ${rev} has no .md files under ${skillDir}` };
	}
	const dir = mkdtempSync(join(tmpdir(), "skill-quality-before-"));
	for (const path of mdPaths) {
		const show = spawnSync("git", ["show", `${rev}:${path}`], {
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		if (show.status !== 0) {
			rmSync(dir, { recursive: true, force: true });
			return { ok: false, error: `git show ${rev}:${path} failed: ${(show.stderr || "").trim()}` };
		}
		writeFileSync(join(dir, path.slice(prefix.length)), show.stdout, "utf8");
	}
	return { ok: true, dir };
}

function resolveBefore(before: string, skillDir: string): { ok: true; snapshot: Snapshot; cleanup?: () => void } | { ok: false; error: string } {
	if (existsSync(before) && statSync(before).isFile()) {
		try {
			return { ok: true, snapshot: loadSnapshot(before) };
		} catch (e) {
			return { ok: false, error: `cannot load before snapshot ${before}: ${(e as Error).message}` };
		}
	}
	const materialized = materializeBefore(before, skillDir);
	if (!materialized.ok) return materialized;
	const snapshot = snapshotDir(materialized.dir);
	return {
		ok: true,
		snapshot,
		cleanup: () => rmSync(materialized.dir, { recursive: true, force: true }),
	};
}

/** The full pipeline. Throws only on IO/usage-class failures. */
export function buildReport(paths: BuildPaths): QualityReport {
	const skillDirAbs = resolve(paths.skillDir);
	const texts = readSkillTexts(skillDirAbs);

	// L0 — static pins
	const l0 = runPins(texts[0]!, texts[1]!);

	// L1 — alignment vs the REAL fixture
	let contract;
	try {
		contract = loadContract(resolve(paths.fixture));
	} catch (e) {
		throw new Error(`fixture: ${(e as Error).message}`);
	}
	const l1 = scoreAlignment(contract, texts);

	// L2 — static text projection over the scenario set
	const l2run = scoreScenariosAgainstTexts(resolve(paths.scenariosDir), texts);
	if (!l2run.ok) throw new Error(`scenarios: ${l2run.error}`);

	// L3 — before/after delta with the same REAL contract (git wants the
	// repo-relative skill dir for pathspecs; fs wants the absolute one)
	const before = resolveBefore(paths.before, paths.skillDir);
	if (!before.ok) throw new Error(`before: ${before.error}`);
	try {
		const after = snapshotDir(skillDirAbs);
		const delta = computeDelta(before.snapshot, after, contract);
		// Claim satisfaction is the delta's own verdict (Law 9 — one
		// implementation of the liveness rule): a claim is satisfied iff it
		// appears in neither regressions nor warnings.
		const unsatisfied = new Map(
			[...delta.regressions, ...delta.warnings].map((r) => [r.id, r.missingKeywords]),
		);
		const l3norm = normalizeL3(
			delta.blockerRegression,
			contract.claims.map((c) => ({
				weight: c.weight,
				missingKeywords: unsatisfied.get(c.id) ?? [],
			})),
		);

		// L4 — size budgets
		const metrics = L4_BUDGETS.flatMap((budget) => {
			const full = join(skillDirAbs, budget.file);
			const raw = readFileSync(full, "utf8");
			return [
				{
					file: budget.file,
					metric: "bytes" as const,
					actual: Buffer.byteLength(raw),
					budget: budget.bytes,
					pass: Buffer.byteLength(raw) <= budget.bytes,
				},
				{
					file: budget.file,
					metric: "lines" as const,
					actual: countLines(raw),
					budget: budget.lines,
					pass: countLines(raw) <= budget.lines,
				},
			];
		});
		const l4norm = normalizeL4(metrics);

		const q = compositeQ(l0.verdictPass, l1.score, l2run.result.mean, l3norm, l4norm);

		return {
			version: 1,
			generatedAt: new Date().toISOString(),
			gitRev: gitRev(),
			inputs: { ...paths, skillDir: paths.skillDir },
			l0: {
				pass: l0.verdictPass,
				pinsChecked: l0.pinsChecked,
				violations: l0.violations,
			},
			l1,
			l2: {
				mean: l2run.result.mean,
				threshold: L2_PASS_THRESHOLD,
				perScenario: l2run.result.perScenario.map((s) => ({
					scenario: s.scenario,
					total: s.total,
					verdict: s.verdict,
					missed: s.missed,
					forbiddenHits: s.forbiddenHits,
				})),
			},
			l3: { ...delta, normalized: l3norm },
			l4: { metrics, normalized: l4norm },
			q: {
				formula: "Q = 0.25*L1 + 0.35*L2 + 0.20*L3_norm + 0.20*L4_norm (L0 fail => 0)",
				weights: Q_WEIGHTS,
				value: q,
				band: qBand(q),
				l0GateApplied: !l0.verdictPass,
			},
		};
	} finally {
		before.cleanup?.();
	}
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function renderMarkdown(report: QualityReport): string {
	const lines: string[] = [];
	lines.push("# Skill quality report — skills/delegate");
	lines.push("");
	lines.push(
		`Generated \`${report.generatedAt}\` at \`${report.gitRev}\` by \`bun test/skill/quality/build.ts\` (see test/skill/HOW-TO.md).`,
	);
	lines.push("");
	lines.push(`**Q = ${report.q.value} — band: ${report.q.band.toUpperCase()}** (ship ≥ ${Q_BANDS.ship}, debt ≥ ${Q_BANDS.debt}, else reject)`);
	lines.push("");
	lines.push(`| Layer | Result | Detail |`);
	lines.push(`|---|---|---|`);
	lines.push(`| L0 pins | ${report.l0.pass ? "pass" : "FAIL"} | ${report.l0.pinsChecked} pins, ${report.l0.violations.length} violations |`);
	lines.push(`| L1 alignment | ${report.l1.score} / 100 (bar ${L1_THRESHOLD})${report.l1.blocked ? " — BLOCKED" : ""} | ${report.l1.perClaim.filter((c) => c.missing.length > 0).map((c) => `${c.id} missing: ${c.missing.join(", ")}`).join("; ") || "all keywords present"} |`);
	lines.push(`| L2 projection | ${report.l2.mean} / 100 (bar ${report.l2.threshold}) | ${report.l2.perScenario.filter((s) => s.verdict !== "pass" || s.forbiddenHits.length > 0).map((s) => `${s.scenario} ${s.total} ${s.verdict}`).join("; ") || "all scenarios 100/pass"} |`);
	lines.push(`| L3 delta | ${report.l3.blockerRegression ? "BLOCKER REGRESSION" : "clean"} → norm ${report.l3.normalized} | regressions: ${report.l3.regressions.map((r) => r.id).join(", ") || "none"}; warnings: ${report.l3.warnings.map((w) => w.id).join(", ") || "none"}; files ${report.l3.files.changed}c/${report.l3.files.added}a/${report.l3.files.removed}r |`);
	lines.push(`| L4 budgets | norm ${report.l4.normalized} | ${report.l4.metrics.map((m) => `${m.file} ${m.metric} ${m.actual}/${m.budget}${m.pass ? "" : " OVER"}`).join("; ")} |`);
	lines.push("");
	lines.push(`Composite: ${report.q.formula} with weights ${JSON.stringify(Q_WEIGHTS)}.`);
	lines.push("");
	if (report.l1.blocked || report.l3.blockerRegression || !report.l0.pass) {
		lines.push("## Blockers / findings");
		lines.push("");
		for (const v of report.l0.violations) {
			lines.push(`- L0 ${v.pin} ${v.target}:${v.line} — ${v.description}`);
		}
		for (const id of report.l1.blockerClaims) {
			lines.push(`- L1 blocker claim ${id} (weight ≥ 10, no keyword present)`);
		}
		for (const r of report.l3.regressions) {
			lines.push(`- L3 blocker regression ${r.id} — missing keywords: ${r.missingKeywords.join(", ")}`);
		}
		lines.push("");
	}
	lines.push("## L1 per claim");
	lines.push("");
	lines.push("| claim | severity | weight | score | weighted | missing |");
	lines.push(`|---|---|---|---|---|---|`);
	for (const c of report.l1.perClaim) {
		lines.push(`| ${c.id} | ${c.severity} | ${c.weight} | ${c.score} | ${c.weighted} | ${c.missing.join(", ") || "—"} |`);
	}
	lines.push("");
	lines.push("## L2 per scenario (static text projection)");
	lines.push("");
	lines.push("| scenario | total | verdict | missed | forbidden hits |");
	lines.push(`|---|---|---|---|---|`);
	for (const s of report.l2.perScenario) {
		lines.push(`| ${s.scenario} | ${s.total} | ${s.verdict} | ${s.missed.join(", ") || "—"} | ${s.forbiddenHits.join(", ") || "—"} |`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage:
  bun test/skill/quality/build.ts [--skill-dir <dir>] [--fixture <file>] [--scenarios <dir>] [--before <git-rev|snapshot.json>] [--out-json <file>] [--out-md <file>]

defaults: --skill-dir skills/delegate --fixture test/skill/tool-contract.json --scenarios test/skill/scenarios --before 629a030^ --out-json test/skill/quality-report.json --out-md test/skill/quality-report.md
exit codes: 0 report written (verdicts are data) · 2 usage/IO/git errors`;

export function runCli(argv: string[]): number {
	const defaults: BuildPaths & { outJson: string; outMd: string } = {
		skillDir: "skills/delegate",
		fixture: "test/skill/tool-contract.json",
		scenariosDir: "test/skill/scenarios",
		before: "629a030^",
		outJson: "test/skill/quality-report.json",
		outMd: "test/skill/quality-report.md",
	};
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) {
			console.error(`skill-quality: unexpected argument: ${arg}\n${USAGE}`);
			return 2;
		}
		const key = arg.slice(2);
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) {
			console.error(`skill-quality: flag --${key} requires a value\n${USAGE}`);
			return 2;
		}
		flags[key] = value;
		i++;
	}
	const paths: BuildPaths = {
		skillDir: flags["skill-dir"] ?? defaults.skillDir,
		fixture: flags.fixture ?? defaults.fixture,
		scenariosDir: flags.scenarios ?? defaults.scenariosDir,
		before: flags.before ?? defaults.before,
	};
	const outJson = flags["out-json"] ?? defaults.outJson;
	const outMd = flags["out-md"] ?? defaults.outMd;
	let report: QualityReport;
	try {
		report = buildReport(paths);
	} catch (e) {
		console.error(`skill-quality: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	}
	for (const out of [outJson, outMd]) {
		const parent = dirname(resolve(out));
		if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
	}
	writeFileSync(outJson, `${JSON.stringify(report, null, "\t")}\n`, "utf8");
	writeFileSync(outMd, renderMarkdown(report), "utf8");
	console.log(`skill-quality: Q=${report.q.value} band=${report.q.band} — wrote ${outJson} + ${outMd}`);
	return 0;
}

if (import.meta.main) {
	process.exit(runCli(process.argv.slice(2)));
}
