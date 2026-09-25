/**
 * swarm-cli-check — issue #18 acceptance: the five worker verbs of the
 * `swarm` CLI, over files, byte-identically to the extension's writers.
 *
 * Run with: bun test/swarm-cli-check.ts   (from repo root)
 *
 * Covers:
 *   1. Each verb against golden fixtures (read-brief, write-report, ask,
 *      poll-answer, write-progress) — behavior + exact file paths.
 *   2. Byte-identity: report/q/progress output bytes equal the extension's
 *      frozen JSON-file serialization (`JSON.stringify(v, null, "\t") + "\n"`,
 *      the convention writeAnswer/writeRelease/updateManifest already write);
 *      the CLI reads what the current a-writer (writeAnswer) wrote; every
 *      output round-trips through the existing readers (validateReport,
 *      readQuestionState, readLastProgress).
 *   3. Invalid reports are rejected with a structured E_REPORT_INVALID code
 *      BEFORE the final path is touched; the brief-declared schema fragment
 *      (inline + library via --schema-dir) is enforced.
 *   4. Static pin: src/swarm builds exchange paths only through src/expaths.ts
 *      (no hand-assembled file names, no hardcoded exchange root, no herdr
 *      import).
 *
 * Exit 0 only if all checks pass. Fail-fast (AGENTS.md command discipline):
 * every child spawn is bounded, plus a top-level watchdog.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { answerPathFor, progressPathFor, questionPathFor, reportPathFor } from "../src/expaths.ts";
import { readQuestionState, writeAnswer } from "../src/mailbox-store.ts";
import { readLastProgress, validateReport } from "../src/exchange.ts";

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("swarm-cli-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 25_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const CLI = join(ROOT, "src", "swarm", "cli.ts");
const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-cli-check-"));
const TASK = "task-cli";
const WORKER = "cli-w1";
const DIR = join(SANDBOX, TASK);
mkdirSync(DIR, { recursive: true });

const BRIEF = `# Brief — ${WORKER}\n\nDo the thing.\n`;
const BRIEF_PATH = join(DIR, `brief-${WORKER}.md`);
writeFileSync(BRIEF_PATH, BRIEF, "utf8");

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	json: Record<string, unknown> | null;
}

/** Spawn the CLI (bounded) with a sandboxed exchange root + identity env. */
function runCli(
	args: string[],
	opts: { input?: string; env?: Record<string, string>; dropEnv?: string[]; cwd?: string } = {},
): RunResult {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	env.PI_DELEGATE_EXCHANGE_ROOT = SANDBOX;
	env.SWARM_TASK = TASK;
	env.SWARM_WORKER = WORKER;
	// Hermetic user-level schema tier: the CLI's getAgentDir() must not pick up
	// any real ~/.pi/agent/pi-delegate-schemas fixture. Also scrub the ambient
	// SWARM_SCHEMA_DIR a delegate worker inherits (the spawn flow exports it):
	// the env tier must be set ONLY by the opts.env a scenario passes, otherwise
	// R4.7's cwd-fallback scenario silently reads the orchestrator's library.
	env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent");
	delete env.SWARM_SCHEMA_DIR;
	Object.assign(env, opts.env);
	for (const key of opts.dropEnv ?? []) delete env[key];
	const res = spawnSync("bun", [CLI, ...args], {
		env,
		input: opts.input,
		encoding: "utf8",
		timeout: 15_000,
		cwd: opts.cwd,
	});
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse((res.stdout ?? "").trim()) as Record<string, unknown>;
	} catch {
		// leave null; the failing check prints stdout
	}
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", json };
}

const errCode = (r: RunResult): unknown =>
	(r.json?.error as { code?: unknown } | undefined)?.code;

// ---------------------------------------------------------------------------
// 1. read-brief — golden fixture text, supplied path and env-only derivation
// ---------------------------------------------------------------------------

{
	const byPath = runCli(["read-brief", BRIEF_PATH]);
	check(
		"R1.1 read-brief <briefPath>: exit 0 + ok JSON + verbatim brief text",
		byPath.status === 0 && byPath.json?.ok === true && byPath.json.verb === "read-brief" &&
			byPath.json.text === BRIEF && byPath.json.briefPath === BRIEF_PATH && byPath.json.task === TASK,
		byPath.stdout,
	);

	const envOnly = runCli(["read-brief"]);
	check(
		"R1.2 read-brief (identity env only): derives brief-<worker>.md and returns it",
		envOnly.status === 0 && envOnly.json?.text === BRIEF && envOnly.json.briefPath === BRIEF_PATH,
		envOnly.stdout,
	);

	const missing = runCli(["read-brief", join(SANDBOX, "nowhere", "brief-x.md")]);
	check("R1.3 read-brief of a foreign path → structured E_BRIEF", missing.status !== 0 && errCode(missing) === "E_BRIEF", missing.stdout);

	const extra = runCli(["read-brief", BRIEF_PATH, "extra-positional"]);
	check("R1.4 read-brief rejects stray extra positionals (fail-fast)", extra.status !== 0 && errCode(extra) === "E_SWARM_USAGE", extra.stdout);
}

// ---------------------------------------------------------------------------
// 2. write-report — valid, golden bytes, and byte-identity with the current
//    JSON-file writer convention
// ---------------------------------------------------------------------------

const REPORT = {
	worker: WORKER,
	status: "pass",
	summary: "golden",
	artifacts: ["a.ts"],
	evidence: [{ claim: "verified", file: "a.ts:1" }],
};
const REPORT_PATH = reportPathFor(DIR, WORKER);
const REPORT_GOLDEN = `${JSON.stringify(REPORT, null, "\t")}\n`;

{
	const r = runCli(["write-report"], { input: JSON.stringify(REPORT) });
	const onDisk = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, "utf8") : "";
	check(
		"R2.1 write-report: exit 0, writes report-<worker>.json at the expaths path",
		r.status === 0 && r.json?.ok === true && r.json.path === REPORT_PATH,
		r.stdout,
	);
	check("R2.2 byte-identity: report bytes === JSON.stringify(v, null, TAB) + \\n (the extension's frozen file convention)", onDisk === REPORT_GOLDEN, JSON.stringify(onDisk.slice(0, 60)));
	check("R2.3 the verb-written report passes the collect-time validator", validateReport(REPORT_PATH, WORKER).ok);
}

// ---------------------------------------------------------------------------
// 3. write-report — invalid rejected BEFORE the final path; no clobbering
// ---------------------------------------------------------------------------

{
	const before = readFileSync(REPORT_PATH, "utf8");
	const bad = runCli(["write-report"], { input: JSON.stringify({ ...REPORT, status: "done" }) });
	check(
		"R3.1 invalid status → non-zero exit + structured E_REPORT_INVALID",
		bad.status !== 0 && errCode(bad) === "E_REPORT_INVALID",
		bad.stdout,
	);
	check("R3.2 a rejected report never touches the previous good report", readFileSync(REPORT_PATH, "utf8") === before);

	const empty = runCli(["write-report"], { input: "" });
	check("R3.3 empty stdin → E_REPORT_INVALID", empty.status !== 0 && errCode(empty) === "E_REPORT_INVALID", empty.stdout);

	const notJson = runCli(["write-report"], { input: "not json" });
	check("R3.4 malformed JSON → E_REPORT_INVALID", notJson.status !== 0 && errCode(notJson) === "E_REPORT_INVALID", notJson.stdout);

	const orphans = readdirSync(DIR).filter((f) => f.includes(".validate-"));
	check("R3.5 a rejected report leaves no validate-temp orphan (try/finally unlink)", orphans.length === 0, JSON.stringify(orphans));
}

// ---------------------------------------------------------------------------
// 4. write-report — the brief-declared report schema (inline + library)
// ---------------------------------------------------------------------------

{
	const TASK_S = "task-schema";
	const DIR_S = join(SANDBOX, TASK_S);
	mkdirSync(DIR_S, { recursive: true });
	writeFileSync(
		join(DIR_S, "brief-cli-w2.md"),
		`---\nreportSchema:\n  type: object\n  required: [result]\n  properties:\n    result:\n      type: object\n      required: [count]\n      properties:\n        count: { type: integer }\n---\n# Brief\n`,
		"utf8",
	);
	const envS = { SWARM_TASK: TASK_S, SWARM_WORKER: "cli-w2" };
	const base = { worker: "cli-w2", status: "pass", summary: "s", artifacts: [], evidence: [] };

	const missing = runCli(["write-report"], { input: JSON.stringify(base), env: envS });
	check(
		"R4.1 brief-declared schema violation → E_REPORT_INVALID before writing",
		missing.status !== 0 && errCode(missing) === "E_REPORT_INVALID",
		missing.stdout,
	);
	check("R4.2 the violating report was not written", !existsSync(reportPathFor(DIR_S, "cli-w2")));

	const ok = runCli(["write-report"], { input: JSON.stringify({ ...base, result: { count: 3 } }), env: envS });
	check(
		"R4.3 schema-satisfying report passes and records provenance",
		ok.status === 0 && JSON.stringify(ok.json?.schemaProvenance) === '["inline"]',
		ok.stdout,
	);

	// Library schema resolved through --schema-dir (the user-level tier seam).
	const libDir = join(SANDBOX, "schemas");
	mkdirSync(libDir, { recursive: true });
	writeFileSync(join(libDir, "impl.json"), JSON.stringify({ type: "object", required: ["implFlag"], properties: { implFlag: { type: "boolean" } } }), "utf8");
	const TASK_L = "task-lib";
	const DIR_L = join(SANDBOX, TASK_L);
	mkdirSync(DIR_L, { recursive: true });
	writeFileSync(join(DIR_L, "brief-cli-w3.md"), `---\nreportSchema: impl\n---\n# Brief\n`, "utf8");
	const envL = { SWARM_TASK: TASK_L, SWARM_WORKER: "cli-w3" };
	const libBase = { worker: "cli-w3", status: "pass", summary: "s", artifacts: [], evidence: [] };
	const libFail = runCli(["write-report", "--schema-dir", libDir], { input: JSON.stringify(libBase), env: envL });
	check("R4.4 named library schema violation → E_REPORT_INVALID", libFail.status !== 0 && errCode(libFail) === "E_REPORT_INVALID", libFail.stdout);
	const libOk = runCli(["write-report", "--schema-dir", libDir], { input: JSON.stringify({ ...libBase, implFlag: true }), env: envL });
	check(
		"R4.5 named library schema resolved via --schema-dir passes",
		libOk.status === 0 && JSON.stringify(libOk.json?.schemaProvenance) === '["impl"]',
		libOk.stdout,
	);

	// Schema-tier precedence regression (fix/cli-schema-tier): SWARM_SCHEMA_DIR
	// (the spawn flow's orchestrator-cwd export) must beat the worker's cwd-derived
	// project tier, and the cwd fallback must still work when the env var is absent.
	const TASK_E = "task-env-schema";
	const DIR_E = join(SANDBOX, TASK_E);
	mkdirSync(DIR_E, { recursive: true });
	writeFileSync(join(DIR_E, "brief-cli-w4.md"), `---\nreportSchema: envs\n---\n# Brief\n`, "utf8");
	const cwdProj = join(SANDBOX, "cwd-proj");
	mkdirSync(join(cwdProj, ".pi", "delegate-schemas"), { recursive: true });
	writeFileSync(join(cwdProj, ".pi", "delegate-schemas", "envs.json"), JSON.stringify({ type: "object", required: ["aField"], properties: { aField: { type: "boolean" } } }), "utf8");
	const envSchemas = join(SANDBOX, "env-schemas");
	mkdirSync(envSchemas, { recursive: true });
	writeFileSync(join(envSchemas, "envs.json"), JSON.stringify({ type: "object", required: ["bField"], properties: { bField: { type: "boolean" } } }), "utf8");
	const baseE = { worker: "cli-w4", status: "pass", summary: "s", artifacts: [], evidence: [] };
	const envE = { SWARM_TASK: TASK_E, SWARM_WORKER: "cli-w4" };
	const envWins = runCli(["write-report"], { input: JSON.stringify({ ...baseE, bField: true }), env: { ...envE, SWARM_SCHEMA_DIR: envSchemas }, cwd: cwdProj });
	check(
		"R4.6 SWARM_SCHEMA_DIR beats the cwd-derived project schema tier (env schema satisfies, cwd schema would reject)",
		envWins.status === 0 && JSON.stringify(envWins.json?.schemaProvenance) === '["envs"]',
		envWins.stdout,
	);
	const cwdFallback = runCli(["write-report"], { input: JSON.stringify({ ...baseE, bField: true }), env: envE, cwd: cwdProj });
	check(
		"R4.7 without SWARM_SCHEMA_DIR the cwd-derived project tier still applies (cwd schema rejects)",
		cwdFallback.status !== 0 && errCode(cwdFallback) === "E_REPORT_INVALID",
		cwdFallback.stdout,
	);
}

// ---------------------------------------------------------------------------
// 5. ask — golden envelope + readQuestionState round trip
// ---------------------------------------------------------------------------

{
	const r = runCli(["ask", "--question", "Which branch?", "--context", "on step 2", "--option", "main", "--options", "dev,staging"]);
	const qPath = questionPathFor(DIR, WORKER);
	const onDisk = readFileSync(qPath, "utf8");
	const parsed = JSON.parse(onDisk) as Record<string, unknown>;
	check("R5.1 ask: exit 0, writes q-<worker>.json at the expaths path", r.status === 0 && r.json?.path === qPath, r.stdout);
	check(
		"R5.2 ask envelope shape (worker/ts/question/context/options)",
		parsed.worker === WORKER && typeof parsed.ts === "string" && parsed.question === "Which branch?" &&
			parsed.context === "on step 2" && JSON.stringify(parsed.options) === '["main","dev","staging"]',
		onDisk,
	);
	check("R5.3 byte-identity: q bytes === JSON.stringify(v, null, TAB) + \\n", onDisk === `${JSON.stringify(parsed, null, "\t")}\n`, onDisk);
	const read = readQuestionState(qPath);
	check("R5.4 the existing mailbox reader reads the verb-written question", read.state === "valid" && read.question.question === "Which branch?");

	const noQ = runCli(["ask"]);
	check("R5.5 ask without --question → E_SWARM_USAGE", noQ.status !== 0 && errCode(noQ) === "E_SWARM_USAGE", noQ.stdout);
}

// ---------------------------------------------------------------------------
// 6. poll-answer — absent, valid (vs the current writeAnswer writer), invalid
// ---------------------------------------------------------------------------

{
	const aPath = answerPathFor(DIR, WORKER);
	const absent = runCli(["poll-answer"]);
	check("R6.1 poll-answer with no answer → state absent, exit 0", absent.status === 0 && absent.json?.state === "absent", absent.stdout);

	// The CURRENT a-writer (writeAnswer, src/mailbox-store.ts) posts the answer.
	await writeAnswer(aPath, "use main");
	const valid = runCli(["poll-answer"]);
	const answer = (valid.json?.answer ?? {}) as Record<string, unknown>;
	check(
		"R6.2 poll-answer reads what the current writer wrote (state valid + text)",
		valid.status === 0 && valid.json?.state === "valid" && answer.answer === "use main",
		valid.stdout,
	);
	// Byte-identity of the a-writer's convention vs the CLI's file convention.
	const aDisk = readFileSync(aPath, "utf8");
	check("R6.3 the current a-writer uses the same tab+\\n file convention", aDisk === `${JSON.stringify(JSON.parse(aDisk), null, "\t")}\n`, aDisk);

	writeFileSync(aPath, "{broken", "utf8");
	const invalid = runCli(["poll-answer"]);
	check("R6.4 corrupt answer → state invalid (a result-plane fact, exit 0)", invalid.status === 0 && invalid.json?.state === "invalid", invalid.stdout);

	rmSync(aPath, { force: true });
	const waited = runCli(["poll-answer", "--wait", "150", "--interval", "30"]);
	check("R6.5 --wait with no answer returns absent after the bounded deadline", waited.status === 0 && waited.json?.state === "absent", waited.stdout);
}

// ---------------------------------------------------------------------------
// 7. write-progress — golden JSONL line + readLastProgress round trip
// ---------------------------------------------------------------------------

{
	const pPath = progressPathFor(DIR, WORKER);
	const r = runCli(["write-progress", "--phase", "implementing", "--pct", "50", "--note", "half"]);
	const lines = readFileSync(pPath, "utf8").split("\n").filter((l) => l.length > 0);
	const first = JSON.parse(lines[0]!) as Record<string, unknown>;
	check("R7.1 write-progress: exit 0, appends p-<worker>.jsonl at the expaths path", r.status === 0 && r.json?.path === pPath, r.stdout);
	check(
		"R7.2 progress line shape (worker/ts/phase/pct/note)",
		first.worker === WORKER && typeof first.ts === "string" && first.phase === "implementing" && first.pct === 50 && first.note === "half",
		lines[0] ?? "",
	);
	check("R7.3 byte-identity: one compact JSON object per line + \\n", lines[0] === JSON.stringify(first), lines[0] ?? "");

	runCli(["write-progress", "--phase", "verifying"]);
	const after = readFileSync(pPath, "utf8").split("\n").filter((l) => l.length > 0);
	check("R7.4 the verb appends (never rewrites): two pings, two lines", after.length === 2, JSON.stringify(after));
	const last = readLastProgress(pPath);
	check("R7.5 the existing reader returns the last ping", last?.phase === "verifying" && last.worker === WORKER);

	const badPct = runCli(["write-progress", "--phase", "x", "--pct", "500"]);
	check("R7.6 out-of-range --pct → E_SWARM_USAGE", badPct.status !== 0 && errCode(badPct) === "E_SWARM_USAGE", badPct.stdout);
}

// ---------------------------------------------------------------------------
// 8. identity + usage errors
// ---------------------------------------------------------------------------

{
	const unknown = runCli(["frobnicate"]);
	check("R8.1 unknown verb → E_SWARM_USAGE", unknown.status !== 0 && errCode(unknown) === "E_SWARM_USAGE", unknown.stdout);

	const noWorker = runCli(["ask", "--question", "x"], { dropEnv: ["SWARM_WORKER"] });
	check("R8.2 missing worker identity → E_SWARM_IDENTITY", noWorker.status !== 0 && errCode(noWorker) === "E_SWARM_IDENTITY", noWorker.stdout);

	const badName = runCli(["ask", "--question", "x"], { env: { SWARM_WORKER: "Bad-Name" } });
	check("R8.3 non-canonical worker name → E_NAME", badName.status !== 0 && errCode(badName) === "E_NAME", badName.stdout);

	const noTask = runCli(["write-progress", "--phase", "x"], { dropEnv: ["SWARM_TASK", "SWARM_WORKER"] });
	check("R8.4 no identity at all → E_SWARM_IDENTITY", noTask.status !== 0 && errCode(noTask) === "E_SWARM_IDENTITY", noTask.stdout);

	const conflict = runCli(["read-brief", "--brief", BRIEF_PATH, "--task", "some-other-task"]);
	check("R8.5 --task conflicting with the brief's task dir → E_SWARM_USAGE", conflict.status !== 0 && errCode(conflict) === "E_SWARM_USAGE", conflict.stdout);
}

// ---------------------------------------------------------------------------
// 9. static pin — src/swarm builds exchange paths only through expaths.ts
// ---------------------------------------------------------------------------

/** Strip block + line comments (path/import scans read code, never prose). */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
}

{
	const swarmDir = join(ROOT, "src", "swarm");
	const files = readdirSync(swarmDir).filter((f) => f.endsWith(".ts")).sort();
	const sources = files.map((f) => ({ file: f, raw: readFileSync(join(swarmDir, f), "utf8") }));

	const importsFromExpaths = sources
		.flatMap((s) => s.raw.match(/import\s*\{[^}]*\}\s*from\s*["']\.\.\/expaths\.ts["']/g) ?? [])
		.flatMap((imp) => (imp.match(/\{([^}]*)\}/)?.[1] ?? "").split(",").map((n) => n.trim()));
	for (const builder of ["reportPathFor", "questionPathFor", "answerPathFor", "progressPathFor"]) {
		check(`R9.1 src/swarm imports the ${builder} builder from src/expaths.ts`, importsFromExpaths.includes(builder), importsFromExpaths.join(","));
	}

	const BANNED: ReadonlyArray<{ kind: string; re: RegExp }> = [
		{ kind: "template path assembly", re: /\$\{[^}\n]+\}\/[A-Za-z_]/ },
		{ kind: "hand-built report- name", re: /["'`]report-/ },
		{ kind: "hand-built q- name", re: /["'`]q-/ },
		{ kind: "hand-built a- name", re: /["'`]a-/ },
		{ kind: "hand-built p- name", re: /["'`]p-/ },
		{ kind: "hardcoded exchange root", re: /\/tmp\/exchange/ },
		{ kind: "herdr import", re: /from\s*["'][^"']*herdr/ },
	];
	const offenders: string[] = [];
	for (const { file, raw } of sources) {
		stripComments(raw).split("\n").forEach((line, i) => {
			for (const { kind, re } of BANNED) {
				if (re.test(line)) offenders.push(`${file}:${i + 1} [${kind}] ${line.trim().slice(0, 100)}`);
			}
		});
	}
	check("R9.2 src/swarm builds no exchange path by hand (expaths builders only)", offenders.length === 0, offenders.join(" | "));

	const briefConvention = sources.filter((s) => /["'`]brief-/.test(stripComments(s.raw))).map((s) => s.file);
	check(
		"R9.3 the brief-name convention lives in exactly ONE module (context.ts)",
		briefConvention.length === 1 && briefConvention[0] === "context.ts",
		briefConvention.join(","),
	);
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL SWARM-CLI CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
