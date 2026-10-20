/**
 * pi-delegate — test/skill-runner-replay-check.ts — the replay-driver check
 * (BM live-replay ticket): the bounded on-demand live-replay driver
 * (test/skill/runner/replay.ts) with a STUBBED session driver.
 *
 * Auto-discovered by test/run-checks.sh (flat test/*.ts glob). Deterministic
 * by construction: zero model calls, zero network — the session seam is
 * injected from fixture stubs (test/skill/runner/fixtures/replay/). All IO
 * goes to mkdtemp scratch dirs — never the real /tmp/exchange.
 *
 * The runner itself (test/skill/runner/replay.ts) is NOT auto-discovered
 * (nested path) — its LIVE default driver runs only on explicit CLI
 * invocation, one smoke per ticket, never in CI.
 *
 * Fail-fast (AGENTS.md command discipline): a top-level watchdog exits
 * non-zero no matter what; every subprocess is bounded by spawnSync timeout.
 *
 * Covers:
 *   R1  library seam — runReplay with an injected stub driver produces the
 *       canned TraceDoc; the result shape is the frozen rubric shape.
 *   R2  CLI roundtrip — validate → write → read back with loadTrace equals
 *       the canned trace; exit 0.
 *   R3  TAG_RE enforcement — a stub that records an invalid tag exits 1,
 *       names the tag, and writes NO trace file.
 *   R4  deadline refusal — a stub that never settles within the deadline
 *       exits 1 with the refusal message (never a hang).
 *   R5  usage/IO conventions — missing flag and missing scenario file exit 2
 *       (./l2-runner.ts exit-code conventions).
 *
 * Exit 0 only if all checks pass.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTrace } from "./skill/runner/l2-runner.ts";
import { runReplay, type ReplayResult } from "./skill/runner/replay.ts";
import { type TraceDoc } from "./skill/runner/rubric.ts";
import { sessionDriver as stubValid } from "./skill/runner/fixtures/replay/stub-valid.ts";

const watchdog = setTimeout(() => {
	console.error("REPLAY CHECK WATCHDOG FIRED (a step hung)");
	process.exit(1);
}, 20_000);
watchdog.unref();

const ROOT = resolve(import.meta.dir, "..");
const REPLAY = join(ROOT, "test/skill/runner/replay.ts");
const FIXTURES = join(ROOT, "test/skill/runner/fixtures/replay");
const SCENARIO = join(FIXTURES, "scenario-canned.json");
const CANNED_TRACE = join(FIXTURES, "canned-trace.json");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const scratch = mkdtempSync(join(tmpdir(), "replay-check-"));
const loadedCanned = loadTrace(CANNED_TRACE);
if (!loadedCanned.ok) {
	console.error(`FAIL  fixture load: ${loadedCanned.error}`);
	process.exit(1);
}
const canned: TraceDoc = loadedCanned.trace;

function runCli(args: string[], timeoutMs = 15_000) {
	const r = spawnSync("bun", [REPLAY, ...args], { cwd: ROOT, timeout: timeoutMs, encoding: "utf8" });
	return {
		code: r.status ?? -1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		timedOut: r.signal === "SIGTERM" || r.signal === "SIGKILL",
	};
}

// ---------------------------------------------------------------------------
// R1 — library seam: runReplay with an injected stub driver
// ---------------------------------------------------------------------------
{
	const result: ReplayResult = await runReplay(
		JSON.parse(readFileSync(SCENARIO, "utf8")) as Parameters<typeof runReplay>[0],
		{ sessionDriver: stubValid },
	);
	check(
		"R1: runReplay with the injected stub produces the canned TraceDoc (injectable seam proven from the library side)",
		result.ok &&
			JSON.stringify((result as { trace: TraceDoc }).trace) === JSON.stringify(canned),
		JSON.stringify(result),
	);
}

// ---------------------------------------------------------------------------
// R2 — CLI roundtrip: validate → write → read back equals the canned trace
// ---------------------------------------------------------------------------
{
	const out = join(scratch, "roundtrip-trace.json");
	const r = runCli([
		"run",
		"--scenario",
		SCENARIO,
		"--out",
		out,
		"--driver",
		join(FIXTURES, "stub-valid.ts"),
	]);
	const readBack = loadTrace(out);
	check(
		"R2: CLI run — stub driver, exit 0, the written trace reads back with loadTrace and equals the canned trace",
		r.code === 0 &&
			!r.timedOut &&
			readBack.ok &&
			JSON.stringify(readBack.trace) === JSON.stringify(canned),
		`exit=${r.code} stderr=${r.stderr.trim().slice(0, 200)}`,
	);
}

// ---------------------------------------------------------------------------
// R3 — TAG_RE enforcement: an invalid tag exits 1, names the tag, no trace
// ---------------------------------------------------------------------------
{
	const out = join(scratch, "bad-tag-trace.json");
	const r = runCli([
		"run",
		"--scenario",
		SCENARIO,
		"--out",
		out,
		"--driver",
		join(FIXTURES, "stub-bad-tag.ts"),
	]);
	check(
		"R3: an invalid tag fails fast — exit 1, the tag is named, no trace file is written",
		r.code === 1 && !r.timedOut && r.stderr.includes("Not A Valid Tag!") && !existsSync(out),
		`exit=${r.code} stderr=${r.stderr.trim().slice(0, 200)}`,
	);
}

// ---------------------------------------------------------------------------
// R4 — deadline refusal: a never-settling stub exits 1, never hangs
// ---------------------------------------------------------------------------
{
	const out = join(scratch, "slow-trace.json");
	const r = runCli(
		[
			"run",
			"--scenario",
			SCENARIO,
			"--out",
			out,
			"--driver",
			join(FIXTURES, "stub-slow.ts"),
			"--deadline",
			"50",
		],
		15_000,
	);
	check(
		"R4: a session that exceeds the deadline is refused — exit 1, the message names the deadline, no hang",
		r.code === 1 && !r.timedOut && r.stderr.includes("deadline") && !existsSync(out),
		`exit=${r.code} timedOut=${r.timedOut} stderr=${r.stderr.trim().slice(0, 200)}`,
	);
}

// ---------------------------------------------------------------------------
// R5 — usage/IO conventions: exit 2 for usage and IO failures
// ---------------------------------------------------------------------------
{
	const r1 = runCli(["run", "--scenario", SCENARIO]); // --out missing
	const r2 = runCli(["run", "--scenario", join(scratch, "nope.json"), "--out", join(scratch, "x.json")]);
	const r3 = runCli(["frobnicate"]);
	check(
		"R5: usage/IO failures exit 2 (missing flag, missing scenario file, unknown verb)",
		r1.code === 2 && r2.code === 2 && r3.code === 2,
		`exit codes: ${r1.code}/${r2.code}/${r3.code}`,
	);
}

rmSync(scratch, { recursive: true, force: true });
clearTimeout(watchdog);
console.log(failures === 0 ? "\nall replay-driver checks passed" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
