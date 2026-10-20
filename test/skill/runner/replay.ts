/**
 * pi-delegate — test/skill/runner/replay.ts — the bounded on-demand live-replay
 * driver for the skill scenarios (BM live-replay ticket).
 *
 * MODULE_CONTRACT — owns:
 *   - runReplay(scenario, opts): drive ONE scenario through ONE bounded
 *     agent session and return a TraceDoc in the frozen ./rubric.ts shape.
 *     The session seam (opts.sessionDriver) is INJECTABLE — the default
 *     driver spawns one headless `pi -p` session (REFERENCE.md §1 hint:
 *     `--approve`, narrow tools `read,bash`), instructed to record the
 *     rubric tags it exercises into a tags file (a JSON array of strings).
 *     Every tag is validated against TAG_RE; the FIRST invalid tag is a
 *     fail-fast refusal — no trace is produced.
 *   - The deadline: a replay has a wall-clock budget (opts.deadlineMs,
 *     default DEFAULT_DEADLINE_MS). A session that exceeds it is REFUSED —
 *     the refusal is a normal failure result, never a hang.
 *   - The CLI verb `run`: load the scenario, run the replay, write the
 *     trace, then read it back with loadTrace (the validate → write → read
 *     roundtrip). Exit codes follow ./l2-runner.ts conventions:
 *     0 ok · 1 invalid/refused · 2 usage/IO/parse.
 *
 * Live model calls happen ONLY on explicit CLI invocation — never inside any
 * auto-discovered check. The auto-discovered flat check
 * (test/skill-runner-replay-check.ts) stubs the session driver: zero model
 * calls, zero network. Like ./l2-runner.ts, this runner is NOT wired into
 * test/run-checks.sh (flat test/*.ts glob only) — run it directly.
 *
 * Determinism boundary: the LIBRARY is deterministic given an injectable
 * driver; only the default driver is live. All IO goes to the caller-chosen
 * files or a scratch dir — never the real /tmp/exchange.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadScenario, loadTrace, validateTraceDoc } from "./l2-runner.ts";
import { TAG_RE, type ScenarioDoc, type TraceDoc } from "./rubric.ts";

/** Default wall-clock budget for ONE replay session. */
export const DEFAULT_DEADLINE_MS = 120_000;

// ---------------------------------------------------------------------------
// The injectable session seam
// ---------------------------------------------------------------------------

/** What a session driver gets: the scenario, the tags file to fill, the budget. */
export interface SessionDriverContext {
	scenario: ScenarioDoc;
	/** Absolute path the session must write its exercised tags into:
	 *  a JSON array of tag strings. */
	tagsFile: string;
	/** Wall-clock budget for the session, ms. The driver must respect it. */
	deadlineMs: number;
}

export interface SessionDriverResult {
	ok: boolean;
	/** Present when ok=false: why the session failed (non-zero exit, crash). */
	error?: string;
}

/** The seam: run ONE bounded agent session for the scenario. Injectable. */
export type SessionDriver = (ctx: SessionDriverContext) => Promise<SessionDriverResult>;

/** The prompt the default driver gives the headless session. */
export function buildReplayPrompt(scenario: ScenarioDoc, tagsFile: string): string {
	const expect = scenario.expect.map((e) => e.tag).join(", ") || "(none)";
	const forbid = scenario.forbid.map((e) => e.tag).join(", ") || "(none)";
	const context = scenario.input.context.map((c) => `- ${c}`).join("\n");
	return [
		`You replay one delegate-skill scenario in a bounded session.`,
		`Scenario ${scenario.id}: ${scenario.title}`,
		`Task: ${scenario.input.task}`,
		`Context:`,
		context,
		`Trigger: ${scenario.input.trigger}`,
		``,
		`Do the task the way the delegate skill directs.`,
		`Then record the rubric tags you exercised.`,
		`Write ONE JSON file: an array of tag strings, to exactly this path: ${tagsFile}`,
		`Use only tags from these scenario lists:`,
		`Expect tags (the behaviors the scenario wants): ${expect}`,
		`Forbid tags (the behaviors the scenario bans): ${forbid}`,
		`Write the file with a single bash command, then stop. Write nothing else.`,
	].join("\n");
}

/**
 * The default driver: ONE headless pi session (`pi -p`), narrow tools,
 * ephemeral (no session file). The process is killed at the deadline; the
 * kill timer is unref'd so a refused replay never holds the host process.
 */
export const headlessSessionDriver: SessionDriver = async (ctx) => {
	const prompt = buildReplayPrompt(ctx.scenario, ctx.tagsFile);
	const proc = Bun.spawn(
		["pi", "-p", "--approve", "--no-session", "--tools", "read,bash", prompt],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const killTimer = setTimeout(() => proc.kill(), ctx.deadlineMs);
	killTimer.unref?.();
	let stderr = "";
	const [exitCode] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text().then((t) => {
			stderr = t;
		}),
	]);
	clearTimeout(killTimer);
	if (exitCode !== 0) {
		const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
		return { ok: false, error: `pi exited with code ${exitCode}${tail ? `: ${tail}` : ""}` };
	}
	return { ok: true };
};

// ---------------------------------------------------------------------------
// runReplay — drive, validate, build the trace
// ---------------------------------------------------------------------------

export interface ReplayOptions {
	/** The session seam. Default: headlessSessionDriver (LIVE model calls). */
	sessionDriver?: SessionDriver;
	/** Wall-clock budget, ms. Default: DEFAULT_DEADLINE_MS. */
	deadlineMs?: number;
	/** Override the scratch tags file (default: a mkdtemp scratch dir). */
	tagsFile?: string;
}

export type ReplayResult =
	| { ok: true; trace: TraceDoc; tagsFile: string }
	| { ok: false; reasons: string[]; tagsFile: string };

/** All shape violations of the tags file contents (empty = usable). */
function tagsFileReasons(raw: string): { reasons: string[]; tags: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { reasons: [`tags file is not valid JSON: ${(e as Error).message}`], tags: [] };
	}
	if (!Array.isArray(parsed)) return { reasons: ["tags file must be a JSON array of tag strings"], tags: [] };
	const reasons: string[] = [];
	const tags: string[] = [];
	for (let i = 0; i < parsed.length; i++) {
		const tag = parsed[i];
		if (typeof tag !== "string" || !TAG_RE.test(tag)) {
			// Fail fast: the first invalid tag refuses the whole replay.
			reasons.push(
				`tags[${i}] must match ${TAG_RE} (got ${JSON.stringify(tag)})`,
			);
			break;
		}
		tags.push(tag);
	}
	return { reasons, tags };
}

/**
 * Drive ONE scenario through ONE bounded session. Never throws: every
 * failure shape (driver failure, deadline, invalid tag, missing tags file)
 * comes back as { ok: false, reasons }. No trace leaves this function
 * without passing validateTraceDoc.
 */
export async function runReplay(scenario: ScenarioDoc, opts: ReplayOptions = {}): Promise<ReplayResult> {
	const driver = opts.sessionDriver ?? headlessSessionDriver;
	const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
	let tagsFile = opts.tagsFile;
	let scratch: string | undefined;
	if (tagsFile === undefined) {
		scratch = mkdtempSync(join(tmpdir(), "replay-"));
		tagsFile = join(scratch, "tags.json");
	}

	const ctx: SessionDriverContext = { scenario, tagsFile, deadlineMs };
	const driverPromise = driver(ctx).then(
		(v) => ({ kind: "settled" as const, v }),
		(e) => ({ kind: "threw" as const, e }),
	);
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	// Ref'd on purpose: the deadline must fire even when the driver's promise
	// never settles (an unref'd timer would let the event loop empty first).
	// The clearTimeout below releases it in every settled path.
	const deadlinePromise = new Promise<{ kind: "deadline" }>((res) => {
		deadlineTimer = setTimeout(() => res({ kind: "deadline" }), deadlineMs);
	});
	const raced = await Promise.race([driverPromise, deadlinePromise]);
	clearTimeout(deadlineTimer);

	if (raced.kind === "deadline") {
		return {
			ok: false,
			reasons: [`session exceeded the ${deadlineMs} ms replay deadline — refused`],
			tagsFile,
		};
	}
	if (raced.kind === "threw") {
		return { ok: false, reasons: [`session driver threw: ${(raced.e as Error).message}`], tagsFile };
	}
	if (!raced.v.ok) {
		return { ok: false, reasons: [`session failed: ${raced.v.error ?? "unknown error"}`], tagsFile };
	}

	let raw: string;
	try {
		raw = readFileSync(tagsFile, "utf8");
	} catch (e) {
		return { ok: false, reasons: [`the session wrote no tags file (${tagsFile}): ${(e as Error).message}`], tagsFile };
	}
	const tags = tagsFileReasons(raw);
	if (tags.reasons.length > 0) return { ok: false, reasons: tags.reasons, tagsFile };

	const trace: TraceDoc = {
		version: 1,
		scenario: scenario.id,
		steps: tags.tags.map((tag) => ({ tag })),
	};
	const shape = validateTraceDoc(trace);
	if (shape.length > 0) {
		// Unreachable by construction — the guard keeps the frozen shape honest.
		return { ok: false, reasons: shape, tagsFile };
	}
	return { ok: true, trace, tagsFile };
}

// ---------------------------------------------------------------------------
// CLI — verb `run`; exit codes are contract (see header)
// ---------------------------------------------------------------------------

const USAGE = `usage:
  bun test/skill/runner/replay.ts run --scenario <file> --out <file> [--driver <module>] [--deadline <ms>]

  --driver   path to a module exporting sessionDriver (default: the headless pi driver — LIVE model calls)
  --deadline session wall-clock budget in ms (default: ${DEFAULT_DEADLINE_MS})

exit codes: 0 ok · 1 invalid/refused · 2 usage/IO/parse`;

function fail2(message: string): never {
	console.error(`replay: ${message}`);
	process.exit(2);
}

function requireFlags(args: string[], allowed: string[], required: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith("--")) fail2(`unexpected argument: ${arg}`);
		const eq = arg.indexOf("=");
		const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
		if (!allowed.includes(key)) fail2(`unknown flag: --${key}`);
		if (value === undefined || value === "") fail2(`flag --${key} requires a value`);
		out[key] = value;
		if (eq === -1) i++;
	}
	for (const flag of required) {
		if (!(flag in out)) fail2(`missing required flag: --${flag}`);
	}
	return out;
}

/** Run the CLI verb; returns the process exit code (contract in header). */
export async function runCli(argv: string[]): Promise<number> {
	if (argv[0] !== "run") fail2(argv[0] === undefined ? "missing verb" : `unknown verb: ${argv[0]}`);
	const { scenario, out, driver, deadline } = requireFlags(
		argv.slice(1),
		["scenario", "out", "driver", "deadline"],
		["scenario", "out"],
	);

	const loaded = loadScenario(scenario);
	if (!loaded.ok) fail2(loaded.error);

	let sessionDriver: SessionDriver | undefined;
	if (driver !== undefined) {
		let mod: Record<string, unknown>;
		try {
			mod = (await import(resolve(driver))) as Record<string, unknown>;
		} catch (e) {
			fail2(`cannot load driver module ${driver}: ${(e as Error).message}`);
		}
		if (typeof mod.sessionDriver !== "function") {
			fail2(`driver module ${driver} must export sessionDriver(ctx): Promise<SessionDriverResult>`);
		}
		sessionDriver = mod.sessionDriver as SessionDriver;
	}
	const deadlineMs = deadline !== undefined ? Number(deadline) : undefined;
	if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
		fail2(`--deadline must be a positive number of ms (got ${JSON.stringify(deadline)})`);
	}

	const result = await runReplay(loaded.scenario, { sessionDriver, deadlineMs });
	if (!result.ok) {
		for (const reason of result.reasons) console.error(`replay: ${reason}`);
		return 1;
	}

	// Write, then read back: the roundtrip is part of the contract.
	let written: string;
	try {
		written = join(resolve(out));
		writeFileSync(written, `${JSON.stringify(result.trace, null, "\t")}\n`);
	} catch (e) {
		fail2(`cannot write trace ${out}: ${(e as Error).message}`);
	}
	const readBack = loadTrace(written);
	if (!readBack.ok) {
		console.error(`replay: roundtrip read-back failed: ${readBack.error}`);
		return 1;
	}
	if (JSON.stringify(readBack.trace) !== JSON.stringify(result.trace)) {
		console.error(`replay: roundtrip mismatch between the written and the read-back trace`);
		return 1;
	}
	console.log(`replay: ${result.trace.scenario} — ${result.trace.steps.length} step(s) → ${written}`);
	return 0;
}

if (import.meta.main) {
	runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
