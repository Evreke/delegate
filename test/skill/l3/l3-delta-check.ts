/**
 * BM-5 (#114) — L3 delta demonstration check: baseline snapshot of the real
 * `skills/delegate` + clean/mutated delta + usage-error paths.
 *
 * Run with: bun test/skill/l3/l3-delta-check.ts   (from repo root)
 * External bound: `timeout 60 bun test/skill/l3/l3-delta-check.ts`; every
 * spawned command is itself bounded (spawnSync timeout: 30_000).
 *
 * Demonstration (the real before/after scoring run is stage 2):
 *   D1  the sample fixture satisfies the dictated contract schema: all seven
 *       minimum ids, blocker weight ≥ 10, and EVERY keyword is a verbatim
 *       (case-insensitive) substring of the CURRENT skill text.
 *   D2  `snapshot` of the real skills/delegate: exit 0, dictated snapshot
 *       shape, sorted .md paths, sha256 spot-check vs node:crypto, and
 *       library-level determinism (content identical except provenance).
 *   D3  clean delta (before vs fresh snapshot): exit 0, blockerRegression
 *       false, empty regressions/warnings, all files unchanged.
 *   D4  mutated COPY of skills/delegate (mkdtemp — the real dir is never
 *       touched): the retry anchors are erased → delta exits 1 with exactly
 *       ONE blocker regression, id "retry-new-name", missingKeywords
 *       non-empty; a second mutation additionally breaks the non-blocker
 *       brief-output-rules claim → warning (not regression).
 *   D5  usage/parse errors exit 2: bad snapshot version, missing flag,
 *       unknown verb.
 *   D6  the real skills/delegate is untouched: git status clean for the path
 *       and file hashes identical before/after every mutation.
 *
 * NOT auto-discovered by test/run-checks.sh (flat test/*.ts glob only) —
 * intentional per the BM-5 brief.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeDelta, loadContract, loadSnapshot, snapshotDir } from "./skill-delta.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI = join(import.meta.dir, "skill-delta.ts");
const SKILL_DIR = "skills/delegate";
const FIXTURE = join(ROOT, "test/skill/__fixtures__/tool-contract.sample.json");
const REQUIRED_IDS = [
	"release-default",
	"completion-report-file",
	"retry-new-name",
	"placement-sub-orchestrator",
	"probe-no-report",
	"timeout-end-turn",
	"brief-output-rules",
];
const dirHashAtStart = dirHash(join(ROOT, SKILL_DIR)); // pre-mutation ground truth for D6

function runCli(args: string[]) {
	return spawnSync("bun", [CLI, ...args], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
}

function dirHash(dir: string): string {
	const files = readdirSync(dir, { recursive: true }).sort();
	return createHash("sha256")
		.update(files.map((f) => readFileSync(join(dir, f as string))).map((b) => b.toString("hex")).join("|"))
		.digest("hex");
}

// Parse a delta CLI run's stdout JSON with failure context on error.
function parseDelta(r: ReturnType<typeof runCli>, label: string) {
	try {
		return { code: r.status ?? -1, out: JSON.parse(r.stdout) as unknown, error: "" };
	} catch {
		return { code: r.status ?? -1, out: null, error: `${label}: unparseable stdout: ${r.stdout.slice(0, 300)} / stderr: ${r.stderr.slice(0, 300)}` };
	}
}

// ---------------------------------------------------------------------------
// D1 — fixture schema + verbatim keywords against the CURRENT skill text
// ---------------------------------------------------------------------------

const contract = loadContract(FIXTURE);
{
	const ids = contract.claims.map((c) => c.id);
	check("D1: fixture version 1 with claims", contract.version === 1 && contract.claims.length > 0);
	check("D1: all seven minimum ids present", REQUIRED_IDS.every((id) => ids.includes(id)), ids.join(","));
	check("D1: ids unique", new Set(ids).size === ids.length);
	check(
		"D1: severity enum + blocker weight ≥ 10 + non-empty keywords",
		contract.claims.every(
			(c) =>
				["blocker", "major", "minor"].includes(c.severity) &&
				(c.severity !== "blocker" || c.weight >= 10) &&
				Array.isArray(c.keywords) && c.keywords.length > 0 && c.keywords.every((k) => k.length > 0),
		),
	);
	const skillTexts = ["SKILL.md", "REFERENCE.md"]
		.map((f) => readFileSync(join(ROOT, SKILL_DIR, f), "utf8").toLowerCase())
		.join("\n");
	const missing = contract.claims.flatMap((c) =>
		c.keywords.filter((k) => !skillTexts.includes(k.toLowerCase())).map((k) => `${c.id}:"${k}"`),
	);
	check("D1: every keyword is a verbatim substring of the current skill text", missing.length === 0, missing.join(", "));
}

// ---------------------------------------------------------------------------
// D2 — snapshot verb over the real skills/delegate
// ---------------------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "l3-delta-check-"));
const snapAPath = join(sandbox, "snap-a.json");
{
	const r = runCli(["snapshot", "--out", snapAPath, "--dir", SKILL_DIR]);
	check("D2: snapshot CLI exits 0", r.status === 0, r.stderr.slice(0, 300));
	const snapA = loadSnapshot(snapAPath);
	check("D2: snapshot shape (version/dir/provenance)", snapA.version === 1 && snapA.dir === SKILL_DIR && snapA.capturedAt.length > 0 && snapA.gitRev.length > 0);
	const paths = snapA.files.map((f) => f.path);
	check("D2: files sorted by relative path, all .md", paths.every((p) => p.endsWith(".md")) && paths.every((p, i) => i === 0 || paths[i - 1] < p));
	const skillEntry = snapA.files.find((f) => f.path === "SKILL.md");
	const realSkill = readFileSync(join(ROOT, SKILL_DIR, "SKILL.md"), "utf8");
	check(
		"D2: SKILL.md sha256/bytes/lines match node:crypto ground truth",
		skillEntry !== undefined &&
			skillEntry.sha256 === createHash("sha256").update(realSkill, "utf8").digest("hex") &&
			skillEntry.bytes === Buffer.byteLength(realSkill) &&
			skillEntry.lines === (realSkill.split("\n").length - (realSkill.endsWith("\n") ? 1 : 0)),
		JSON.stringify(skillEntry),
	);
	// Library-level determinism: same dir → identical content (provenance aside).
	const libA = snapshotDir(SKILL_DIR);
	const libB = snapshotDir(SKILL_DIR);
	check("D2: snapshotDir deterministic except provenance", JSON.stringify(libA.files) === JSON.stringify(libB.files) && JSON.stringify(libA.files) === JSON.stringify(snapA.files));
}

// ---------------------------------------------------------------------------
// D3 — clean delta: fresh snapshot of the same dir must regress nothing
// ---------------------------------------------------------------------------

{
	const snapBPath = join(sandbox, "snap-b.json");
	check("D3: fresh snapshot exits 0", runCli(["snapshot", "--out", snapBPath, "--dir", SKILL_DIR]).status === 0);
	const r = parseDelta(runCli(["delta", "--before", snapAPath, "--after", snapBPath, "--contract", FIXTURE]), "clean delta");
	const out = r.out as { blockerRegression?: boolean; regressions?: unknown[]; warnings?: unknown[]; files?: Record<string, number>; detail?: { status: string }[] } | null;
	check("D3: clean delta exits 0", r.code === 0, r.error || String(r.code));
	check("D3: blockerRegression false, regressions/warnings empty", out !== null && out.blockerRegression === false && out.regressions?.length === 0 && out.warnings?.length === 0, JSON.stringify(out?.regressions));
	check(
		"D3: all files unchanged in counts and detail",
		out !== null && out.files?.changed === 0 && out.files.added === 0 && out.files.removed === 0 &&
			out.files.unchanged === loadSnapshot(snapAPath).files.length &&
			out.detail !== undefined && out.detail.every((d) => d.status === "unchanged"),
	);
}

// ---------------------------------------------------------------------------
// D4 — mutated COPY: erase the retry-new-name anchors (blocker regression)
// ---------------------------------------------------------------------------

const mutatedDir = join(mkdtempSync(join(tmpdir(), "l3-delta-mutated-")), "skill-copy");
{
	cpSync(join(ROOT, SKILL_DIR), mutatedDir, { recursive: true });
	for (const f of readdirSync(mutatedDir)) {
		if (!f.endsWith(".md")) continue;
		const full = join(mutatedDir, f);
		writeFileSync(
			full,
			readFileSync(full, "utf8")
				.replace(/diagnosed retry/gi, "re-brief relaunch")
				.replace(/never retry verbatim/gi, "never resend the original prompt"),
			"utf8",
		);
	}
	const mutatedText = readdirSync(mutatedDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => readFileSync(join(mutatedDir, f), "utf8").toLowerCase())
		.join("\n");
	check(
		"D4: precondition — retry anchors gone from the copy, other claims' anchors intact",
		!mutatedText.includes("diagnosed retry") && !mutatedText.includes("never retry verbatim") &&
			mutatedText.includes("esc detaches") && mutatedText.includes("acceptance criteria only"),
	);

	const snapMPath = join(sandbox, "snap-mutated.json");
	check("D4: mutated snapshot exits 0", runCli(["snapshot", "--out", snapMPath, "--dir", mutatedDir]).status === 0);
	const r = parseDelta(runCli(["delta", "--before", snapAPath, "--after", snapMPath, "--contract", FIXTURE]), "mutated delta");
	const out = r.out as { blockerRegression?: boolean; regressions?: { id: string; missingKeywords: string[] }[]; warnings?: unknown[] } | null;
	check("D4: mutated delta exits 1", r.code === 1, r.error || String(r.code));
	check("D4: blockerRegression true", out !== null && out.blockerRegression === true, JSON.stringify(out?.regressions));
	check(
		"D4: exactly ONE regression, id retry-new-name, missingKeywords non-empty",
		out !== null && out.regressions !== undefined && out.regressions.length === 1 &&
			out.regressions[0].id === "retry-new-name" && out.regressions[0].missingKeywords.length > 0,
		JSON.stringify(out?.regressions),
	);
	check(
		"D4: both retry anchors reported missing",
		out !== null && out.regressions !== undefined && out.regressions.length === 1 &&
			out.regressions[0].missingKeywords.includes("diagnosed retry") === true &&
			out.regressions[0].missingKeywords.includes("Never retry verbatim"),
		JSON.stringify(out?.regressions?.[0]?.missingKeywords),
	);
	check("D4: no non-blocker warnings from the blocker-only mutation", out?.warnings?.length === 0, JSON.stringify(out?.warnings));

	// D4b — second mutation on the same copy: break the major claim too.
	for (const f of readdirSync(mutatedDir)) {
		if (!f.endsWith(".md")) continue;
		const full = join(mutatedDir, f);
		writeFileSync(full, readFileSync(full, "utf8").replace(/acceptance criteria only/gi, "output section rules only"), "utf8");
	}
	const snapM2Path = join(sandbox, "snap-mutated2.json");
	runCli(["snapshot", "--out", snapM2Path, "--dir", mutatedDir]);
	const r2 = parseDelta(runCli(["delta", "--before", snapAPath, "--after", snapM2Path, "--contract", FIXTURE]), "doubly-mutated delta");
	const out2 = r2.out as { blockerRegression?: boolean; regressions?: { id: string }[]; warnings?: { id: string; missingKeywords: string[] }[] } | null;
	check("D4b: doubly-mutated delta still exits 1 with the same single blocker regression", r2.code === 1 && out2 !== null && out2.regressions !== undefined && out2.regressions.length === 1 && out2.regressions[0].id === "retry-new-name", JSON.stringify(out2?.regressions));
	check(
		"D4b: brief-output-rules surfaces as a WARNING, not a regression",
		out2 !== null && out2.warnings !== undefined && out2.warnings.length === 1 &&
			out2.warnings[0].id === "brief-output-rules" && out2.warnings[0].missingKeywords.length > 0,
		JSON.stringify(out2?.warnings),
	);
}

// ---------------------------------------------------------------------------
// D5 — usage/parse errors exit 2
// ---------------------------------------------------------------------------

{
	const badSnapPath = join(sandbox, "snap-v2.json");
	writeFileSync(badSnapPath, JSON.stringify({ ...loadSnapshot(snapAPath), version: 2 }), "utf8");
	check("D5: version-2 snapshot → exit 2", runCli(["delta", "--before", badSnapPath, "--after", snapAPath, "--contract", FIXTURE]).status === 2);
	check("D5: missing --contract → exit 2", runCli(["delta", "--before", snapAPath, "--after", snapAPath]).status === 2);
	check("D5: unknown verb → exit 2", runCli(["rebalance"]).status === 2);
	check("D5: snapshot --out into missing dir → exit 2", runCli(["snapshot", "--out", join(sandbox, "nope", "s.json")]).status === 2);
}

// ---------------------------------------------------------------------------
// D6 — the real skills/delegate untouched by every mutation above
// ---------------------------------------------------------------------------

{
	const git = spawnSync("git", ["status", "--porcelain", "--", SKILL_DIR], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
	check("D6: git status clean for skills/delegate", git.status === 0 && git.stdout.trim() === "", git.stdout.slice(0, 200));
	check(
		"D6: skill file hashes identical to check start",
		dirHash(join(ROOT, SKILL_DIR)) === dirHashAtStart,
	);
}

// Library-level cross-check of the same story without the CLI (shape stability
// for BM-2 #111 / BM-6 #115 consumers).
{
	const result = computeDelta(loadSnapshot(snapAPath), loadSnapshot(snapAPath), contract);
	check(
		"D7: library computeDelta identical-before → clean shape (frozen fields)",
		result.version === 1 && result.blockerRegression === false && result.regressions.length === 0 &&
			result.warnings.length === 0 && result.files.unchanged === result.detail.length,
	);
}

rmSync(sandbox, { recursive: true, force: true });
const mutatedParent = join(mutatedDir, "..");
if (existsSync(mutatedParent)) rmSync(mutatedParent, { recursive: true, force: true });

process.exit(failures === 0 ? 0 : 1);
