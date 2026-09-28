/**
 * pi-delegate — test/skill/runner/l2-runner.ts — the BM-4 L2 scenario runner
 * (issue #113): library + CLI over the fixed rubric (./rubric.ts).
 *
 * MODULE_CONTRACT — owns:
 *   - Shape validation (validateScenarioDoc / validateTraceDoc): the dictated
 *     scenario/trace file contracts, multi-reason reports, tag grammar
 *     enforcement. Unknown extra keys are TOLERATED (forward-compat with the
 *     sibling scenario set) — only the dictated fields are checked.
 *   - Directory IO (listJsonFiles / validateScenarioDir): sorted,
 *     deterministic listing of `*.json`; a per-file read/parse failure is an
 *     INVALID reason (exit 1), a directory-level failure is an IO error
 *     (exit 2).
 *   - Loading (loadScenario / loadTrace): read + parse + validate in one
 *     step; any failure is an error string (CLI maps to exit 2).
 *   - score-dir pairing (scoreScenarioDir): scenario id ↔ trace `scenario`
 *     field; the FIRST matching trace in sorted-filename order wins;
 *     scenarios without a trace become `{scenario, error}` entries and force
 *     exit 1; unpaired traces (no scenario file) are skipped silently.
 *
 * CLI verbs (exit codes are contract):
 *   validate --dir <dir>           0 all valid · 1 invalid files · 2 usage/IO
 *   score --scenario <f> --trace <f>
 *                                  0 pass/warn · 1 blocker-fail · 2 usage/parse
 *   score-dir --scenarios <dir> --traces <dir>
 *                                  0 ok · 1 blocker-fail or missing trace ·
 *                                  2 usage/parse
 *
 * STABLE SURFACE for future consumers: ScoreResult / ScoreDirResult shapes
 * (from ./rubric.ts) are imported by BM-2 (#111) and BM-6 (#115) — do not
 * reshape without a cross-track decision. Deterministic: no network, no
 * model calls, no randomness, no wall-clock in score outputs; file IO only
 * in the CLI verbs and the exported dir functions. The runner is NOT wired
 * into test/run-checks.sh (flat test/*.ts glob) — that is intended; run the
 * verbs and l2-runner-check.ts directly.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DIMENSIONS,
	round2,
	scoreTrace,
	TAG_RE,
	type ScoreResult,
	type ScenarioDoc,
	type TraceDoc,
} from "./rubric.ts";

// Re-exported so BM-2/BM-6 can import the whole stable surface from the
// runner module; the rubric file remains the single source of truth.
export {
	DIMENSIONS,
	DIMENSION_WEIGHTS,
	PASS_THRESHOLD,
	round2,
	scoreTrace,
	TAG_RE,
	verdictFor,
} from "./rubric.ts";
export type {
	Dimension,
	ExpectItem,
	ScoreResult,
	ScenarioDoc,
	TraceDoc,
	Verdict,
} from "./rubric.ts";

// ---------------------------------------------------------------------------
// Shape validation — the dictated scenario/trace contracts, multi-reason
// ---------------------------------------------------------------------------

const ID_RE = /^S\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateItemList(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) return [`${field} must be an array`];
	const reasons: string[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!isRecord(item)) {
			reasons.push(`${field}[${i}] must be an object`);
			continue;
		}
		if (typeof item.tag !== "string" || !TAG_RE.test(item.tag)) {
			reasons.push(
				`${field}[${i}].tag must match ${TAG_RE} (got ${JSON.stringify(item.tag)})`,
			);
		}
		if (
			typeof item.dimension !== "string" ||
			!(DIMENSIONS as readonly string[]).includes(item.dimension)
		) {
			reasons.push(
				`${field}[${i}].dimension must be one of ${DIMENSIONS.join("|")} (got ${JSON.stringify(item.dimension)})`,
			);
		}
	}
	return reasons;
}

/** All shape violations of a parsed scenario document (empty = valid). */
export function validateScenarioDoc(value: unknown): string[] {
	if (!isRecord(value)) return ["not a JSON object"];
	const reasons: string[] = [];
	if (value.version !== 1) {
		reasons.push(`version must be 1 (got ${JSON.stringify(value.version)})`);
	}
	if (typeof value.id !== "string" || !ID_RE.test(value.id)) {
		reasons.push(`id must match ^S\\d{2}$ (got ${JSON.stringify(value.id)})`);
	}
	if (!isNonEmptyString(value.title)) {
		reasons.push("title must be a non-empty string");
	}
	if (typeof value.blocker !== "boolean") {
		reasons.push(`blocker must be a boolean (got ${JSON.stringify(value.blocker)})`);
	}
	if (!isRecord(value.input)) {
		reasons.push("input must be an object");
	} else {
		if (!isNonEmptyString(value.input.task)) {
			reasons.push("input.task must be a non-empty string");
		}
		if (
			!Array.isArray(value.input.context) ||
			value.input.context.some((c) => typeof c !== "string")
		) {
			reasons.push("input.context must be an array of strings");
		}
		if (!isNonEmptyString(value.input.trigger)) {
			reasons.push("input.trigger must be a non-empty string");
		}
	}
	reasons.push(...validateItemList(value.expect, "expect"));
	reasons.push(...validateItemList(value.forbid, "forbid"));
	return reasons;
}

/** All shape violations of a parsed trace document (empty = valid). */
export function validateTraceDoc(value: unknown): string[] {
	if (!isRecord(value)) return ["not a JSON object"];
	const reasons: string[] = [];
	if (value.version !== 1) {
		reasons.push(`version must be 1 (got ${JSON.stringify(value.version)})`);
	}
	if (!isNonEmptyString(value.scenario)) {
		reasons.push("scenario must be a non-empty string");
	}
	if (!Array.isArray(value.steps)) {
		reasons.push("steps must be an array");
	} else {
		for (let i = 0; i < value.steps.length; i++) {
			const step = value.steps[i];
			if (!isRecord(step)) {
				reasons.push(`steps[${i}] must be an object`);
				continue;
			}
			if (typeof step.tag !== "string" || !TAG_RE.test(step.tag)) {
				reasons.push(
					`steps[${i}].tag must match ${TAG_RE} (got ${JSON.stringify(step.tag)})`,
				);
			}
		}
	}
	return reasons;
}

// ---------------------------------------------------------------------------
// File + directory IO — sorted, deterministic
// ---------------------------------------------------------------------------

export interface FileVerdict {
	file: string;
	ok: boolean;
	reasons: string[];
}

export function listJsonFiles(
	dir: string,
): { ok: true; names: string[] } | { ok: false; error: string } {
	try {
		const names = readdirSync(dir)
			.filter((n) => n.endsWith(".json"))
			.sort();
		return { ok: true, names };
	} catch (e) {
		return { ok: false, error: `cannot read directory ${dir}: ${(e as Error).message}` };
	}
}

function loadJson(
	path: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		return { ok: false, error: `cannot read ${path}: ${(e as Error).message}` };
	}
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch (e) {
		return { ok: false, error: `invalid JSON in ${path}: ${(e as Error).message}` };
	}
}

/** Validate every `*.json` in a scenario dir. Per-file failures are verdicts. */
export function validateScenarioDir(
	dir: string,
): { ok: true; results: FileVerdict[] } | { ok: false; error: string } {
	const listed = listJsonFiles(dir);
	if (!listed.ok) return listed;
	const results: FileVerdict[] = [];
	for (const name of listed.names) {
		const path = join(dir, name);
		const loaded = loadJson(path);
		if (!loaded.ok) {
			results.push({ file: path, ok: false, reasons: [loaded.error] });
			continue;
		}
		const reasons = validateScenarioDoc(loaded.value);
		results.push({ file: path, ok: reasons.length === 0, reasons });
	}
	return { ok: true, results };
}

/** Read + parse + validate a scenario file in one step. */
export function loadScenario(
	path: string,
): { ok: true; scenario: ScenarioDoc } | { ok: false; error: string } {
	const loaded = loadJson(path);
	if (!loaded.ok) return loaded;
	const reasons = validateScenarioDoc(loaded.value);
	if (reasons.length > 0) {
		return { ok: false, error: `invalid scenario ${path}:\n\t- ${reasons.join("\n\t- ")}` };
	}
	return { ok: true, scenario: loaded.value as ScenarioDoc };
}

/** Read + parse + validate a trace file in one step. */
export function loadTrace(
	path: string,
): { ok: true; trace: TraceDoc } | { ok: false; error: string } {
	const loaded = loadJson(path);
	if (!loaded.ok) return loaded;
	const reasons = validateTraceDoc(loaded.value);
	if (reasons.length > 0) {
		return { ok: false, error: `invalid trace ${path}:\n\t- ${reasons.join("\n\t- ")}` };
	}
	return { ok: true, trace: loaded.value as TraceDoc };
}

// ---------------------------------------------------------------------------
// score-dir pairing — scenario id ↔ trace `scenario` field
// ---------------------------------------------------------------------------

/** One scored entry, or the placeholder for a scenario with no trace. */
export type PerScenarioEntry = ScoreResult | { scenario: string; error: string };

/** score-dir output shape — STABLE (consumed by BM-2/BM-6). */
export interface ScoreDirResult {
	/** Arithmetic mean of the scored totals, 2 decimals (0 when none scored). */
	mean: number;
	/** Sorted by scenario id. */
	perScenario: PerScenarioEntry[];
}

export function scoreScenarioDir(
	scenariosDir: string,
	tracesDir: string,
): {
	ok: true;
	result: ScoreDirResult;
	blockerFails: number;
	missingTraces: string[];
} | { ok: false; error: string } {
	const listedScenarios = listJsonFiles(scenariosDir);
	if (!listedScenarios.ok) return listedScenarios;
	const listedTraces = listJsonFiles(tracesDir);
	if (!listedTraces.ok) return listedTraces;

	// Pairing: first trace (sorted filename order) wins per scenario id;
	// unpaired traces (no matching scenario file) are skipped silently.
	const tracesByScenario = new Map<string, TraceDoc>();
	for (const name of listedTraces.names) {
		const loaded = loadTrace(join(tracesDir, name));
		if (!loaded.ok) return loaded;
		if (!tracesByScenario.has(loaded.trace.scenario)) {
			tracesByScenario.set(loaded.trace.scenario, loaded.trace);
		}
	}

	const entries: PerScenarioEntry[] = [];
	const missingTraces: string[] = [];
	let blockerFails = 0;
	let sum = 0;
	let scored = 0;
	for (const name of listedScenarios.names) {
		const loaded = loadScenario(join(scenariosDir, name));
		if (!loaded.ok) return loaded;
		const trace = tracesByScenario.get(loaded.scenario.id);
		if (trace === undefined) {
			missingTraces.push(loaded.scenario.id);
			entries.push({ scenario: loaded.scenario.id, error: "no trace file" });
			continue;
		}
		const result = scoreTrace(loaded.scenario, trace);
		if (result.verdict === "blocker-fail") blockerFails++;
		sum += result.total;
		scored++;
		entries.push(result);
	}
	entries.sort((a, b) => (a.scenario < b.scenario ? -1 : a.scenario > b.scenario ? 1 : 0));
	const mean = scored === 0 ? 0 : round2(sum / scored);
	return { ok: true, result: { mean, perScenario: entries }, blockerFails, missingTraces };
}

// ---------------------------------------------------------------------------
// CLI — verbs and exit codes are contract (see header)
// ---------------------------------------------------------------------------

const USAGE = `usage:
  bun test/skill/runner/l2-runner.ts validate --dir <scenarios-dir>
  bun test/skill/runner/l2-runner.ts score --scenario <file> --trace <file>
  bun test/skill/runner/l2-runner.ts score-dir --scenarios <dir> --traces <dir>

exit codes: 0 ok · 1 invalid/blocker-fail/missing-trace · 2 usage/IO/parse`;

function fail2(message: string): never {
	console.error(`l2-runner: ${message}`);
	process.exit(2);
}

function usageError(message: string): never {
	console.error(`l2-runner: ${message}\n${USAGE}`);
	process.exit(2);
}

function requireFlags(args: string[], flags: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith("--")) usageError(`unexpected argument: ${arg}`);
		const eq = arg.indexOf("=");
		const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
		if (!flags.includes(key)) usageError(`unknown flag: --${key}`);
		if (value === undefined || value === "") usageError(`flag --${key} requires a value`);
		out[key] = value;
		if (eq === -1) i++;
	}
	for (const flag of flags) {
		if (!(flag in out)) usageError(`missing required flag: --${flag}`);
	}
	return out;
}

/** Run one CLI verb; returns the process exit code (contract in header). */
export function runCli(argv: string[]): number {
	const [verb, ...rest] = argv;
	switch (verb) {
		case "validate": {
			const { dir } = requireFlags(rest, ["dir"]);
			const validated = validateScenarioDir(dir);
			if (!validated.ok) fail2(validated.error);
			let ok = 0;
			let bad = 0;
			for (const r of validated.results) {
				if (r.ok) {
					ok++;
					continue;
				}
				bad++;
				console.log(`INVALID ${r.file}: ${r.reasons.join("; ")}`);
			}
			console.log(`scenarios: ${ok} valid, ${bad} invalid (${validated.results.length} files)`);
			return bad > 0 ? 1 : 0;
		}
		case "score": {
			const { scenario, trace } = requireFlags(rest, ["scenario", "trace"]);
			const s = loadScenario(scenario);
			if (!s.ok) fail2(s.error);
			const t = loadTrace(trace);
			if (!t.ok) fail2(t.error);
			const result = scoreTrace(s.scenario, t.trace);
			console.log(JSON.stringify(result, null, "\t"));
			return result.verdict === "blocker-fail" ? 1 : 0;
		}
		case "score-dir": {
			const { scenarios, traces } = requireFlags(rest, ["scenarios", "traces"]);
			const scored = scoreScenarioDir(scenarios, traces);
			if (!scored.ok) fail2(scored.error);
			console.log(JSON.stringify(scored.result, null, "\t"));
			return scored.blockerFails > 0 || scored.missingTraces.length > 0 ? 1 : 0;
		}
		default:
			usageError(verb === undefined ? "missing verb" : `unknown verb: ${verb}`);
	}
}

if (import.meta.main) {
	process.exit(runCli(process.argv.slice(2)));
}
