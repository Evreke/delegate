/**
 * pi-delegate — src/swarm/verify.ts — the `swarm verify` orchestrator-side
 * read verb (aggregation chain check).
 *
 * MODULE_CONTRACT — machine-checks the ORCHESTRATION CONVENTION that a
 * fleet's final numbers travel verbatim from child reports to parent facts
 * and that parent arithmetic is recomputable: for every task manifest the
 * verb reads each worker's report at its canonical path (./expaths sibling
 * naming) and emits pass/fail lines for FOUR checks:
 *   presence  — the report file exists and parses as JSON;
 *   schema    — the base report validation (src/report-schema.ts, the ONE
 *               validator) accepts it;
 *   chain     — every parent fact k="<childName>_number" equals the child's
 *               fact k="number" (string compare, trimmed); a named child
 *               without a readable report is a fail line, never a silence;
 *   arithmetic— a parent fact k="partial_sum" equals the SUM of that parent's
 *               numeric "<child>_number" facts, and a `partial_sum=<S>`
 *               token in the parent's summary (when present) equals it too.
 * Facts that carry no "<child>_number"/"partial_sum" keys make the chain and
 * arithmetic checks INAPPLICABLE (no lines) — the verb never invents work;
 * degraded data yields degraded verdicts, never a crash (Law 8).
 *
 * PURE READ, ZERO WRITES — the manifest scan reuses the snapshot verb's
 * storage-mode wiring (files mode: read-only file store; journal mode:
 * read-only replay, never the store constructor). The SwarmGraph supplies
 * only task dirs and worker names; report CONTENT is read from disk here.
 *
 * Identity: NONE required (orchestrator-side read, §4.1.1). `--task <id>`
 * filters to one task node.
 *
 * Result contract (Law 8): success = exit 0 + ONE JSON envelope
 * { ok, verb: "verify", verify: { ok, tasks: [...] } } — the envelope's ok
 * means the VERB RAN; the chain verdict travels in verify.ok. Usage failures
 * (stray positionals) fail E_SWARM_USAGE like every read verb.
 *
 * Dependencies: ../report-schema.ts (validateReport), ../expaths.ts
 * (reportPathFor), ./graph.ts (buildSwarmGraph), ./snapshot.ts (the shared
 * storage-mode manifest wiring), ./args.ts (flagStr), ./result.ts,
 * ./storage.ts, ./journal-read.ts, ./journal-copy.ts. No herdr import (Law 4).
 *
 * Critical invariants:
 *   - every emitted line is {task, worker, check, status, detail} — stable
 *     field order, sorted (task, worker, check) for byte-stable output;
 *   - an unreadable/corrupt report is a FAIL line, never a throw;
 *   - exactly one JSON object reaches stdout.
 */

import { readFileSync } from "node:fs";
import { reportPathFor } from "../expaths.ts";
import { validateReport } from "../report-schema.ts";
import { buildSwarmGraph, type SwarmGraph } from "./graph.ts";
import { flagStr, type ParsedArgs } from "./args.ts";
import { activeBackendName, manifestSource } from "./snapshot.ts";
import { emitSuccess, SwarmError } from "./result.ts";
import { resolveSwarmStorage } from "./storage.ts";
import { withJournalCopy } from "./journal-copy.ts";
import type { JournalReader } from "./journal-read.ts";

/** One pass/fail verdict line (the frozen wire shape of the verb). */
export interface VerifyLine {
	task: string;
	worker: string;
	check: "presence" | "schema" | "chain" | "arithmetic";
	status: "pass" | "fail";
	detail: string;
}

/** One task's verdict block. */
export interface VerifyTask {
	task: string;
	ok: boolean;
	lines: VerifyLine[];
}

/** The facts of one parsed report, as a k→v map (non-conforming facts are
 *  skipped — degraded data, degraded verdict). */
function factsMap(report: Record<string, unknown>): Map<string, string> {
	const out = new Map<string, string>();
	const facts = report.facts;
	if (!Array.isArray(facts)) return out;
	for (const f of facts) {
		if (f && typeof f === "object" && !Array.isArray(f)) {
			const k = (f as Record<string, unknown>).k;
			const v = (f as Record<string, unknown>).v;
			if (typeof k === "string" && (typeof v === "string" || typeof v === "number")) {
				out.set(k, String(v).trim());
			}
		}
	}
	return out;
}

/** Read + parse one report file; null when missing or corrupt (the caller
 *  turns that into a fail line — never a throw). */
function readReport(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

const CHILD_NUMBER_SUFFIX = "_number";
const PARTIAL_SUM_KEY = "partial_sum";

/**
 * FUNCTION_CONTRACT — verify one task's workers.
 * Input: taskId, taskDir, worker names (from the manifest projection)
 * Output: pass/fail lines, sorted by (worker, check); every worker yields at
 *   least a presence line; schema/chain/arithmetic lines follow their rules
 * Guarantees: pure over the injected report reader (filesystem reads are
 *   confined to reportPathFor(taskDir, name)); never throws
 * Raises: never
 */
export function verifyTask(taskId: string, taskDir: string, workers: string[]): VerifyLine[] {
	const lines: VerifyLine[] = [];
	const line = (worker: string, check: VerifyLine["check"], status: VerifyLine["status"], detail: string): void => {
		lines.push({ task: taskId, worker, check, status, detail });
	};

	// Pass 1: presence + schema, keep parsed reports for the chain pass.
	const parsed = new Map<string, Record<string, unknown>>();
	for (const name of workers) {
		const path = reportPathFor(taskDir, name);
		const report = readReport(path);
		if (report === null) {
			line(name, "presence", "fail", `no parsable report at ${path}`);
			continue;
		}
		line(name, "presence", "pass", path);
		parsed.set(name, report);
		const validation = validateReport(path, name);
		if (validation.ok) line(name, "schema", "pass", "");
		else line(name, "schema", "fail", validation.error);
	}

	// Pass 2: chain + arithmetic on parents that use the convention.
	for (const [name, report] of parsed) {
		const facts = factsMap(report);
		const childKeys = [...facts.keys()].filter((k) => k.endsWith(CHILD_NUMBER_SUFFIX)).sort();
		let childSum = 0;
		let childSumKnown = true;
		for (const key of childKeys) {
			const child = key.slice(0, -CHILD_NUMBER_SUFFIX.length);
			const claimed = facts.get(key) ?? "";
			const childReport = parsed.get(child);
			if (childReport === undefined) {
				line(name, "chain", "fail", `child "${child}" has no parsable report (see its presence line)`);
				childSumKnown = false;
				continue;
			}
			const actual = factsMap(childReport).get("number");
			if (actual === undefined) {
				line(name, "chain", "fail", `child "${child}" report carries no facts k="number"`);
				childSumKnown = false;
				continue;
			}
			if (actual === claimed) line(name, "chain", "pass", `${key}=${claimed} matches ${child}.number`);
			else line(name, "chain", "fail", `${key}="${claimed}" but ${child}.number="${actual}"`);
			const n = Number(claimed);
			if (!Number.isFinite(n)) childSumKnown = false;
			else childSum += n;
		}
		if (facts.has(PARTIAL_SUM_KEY)) {
			const claimedSum = Number(facts.get(PARTIAL_SUM_KEY));
			if (!childSumKnown || !Number.isFinite(claimedSum)) {
				line(name, "arithmetic", "fail", "cannot recompute: a child number is unreadable or non-numeric");
			} else if (claimedSum === childSum) {
				line(name, "arithmetic", "pass", `partial_sum=${claimedSum} equals the child-number sum`);
			} else {
				line(name, "arithmetic", "fail", `partial_sum=${claimedSum} but the child numbers sum to ${childSum}`);
			}
			const summary = typeof report.summary === "string" ? report.summary : "";
			const token = /partial_sum=(-?\d+)/.exec(summary);
			if (token && Number(token[1]) !== claimedSum) {
				line(name, "arithmetic", "fail", `summary token partial_sum=${token[1]} disagrees with facts ${claimedSum}`);
			}
		}
	}

	const order = { presence: 0, schema: 1, chain: 2, arithmetic: 3 };
	return lines.sort((a, b) =>
		a.worker === b.worker ? order[a.check] - order[b.check] : a.worker < b.worker ? -1 : 1,
	);
}

/** Run `swarm verify`: build the graph read-only, verify every (or one
 *  filtered) task, emit the envelope. Total on the data side (Law 8). */
export async function runVerify(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const taskFilter = flagStr(parsed, "task");
	const cfg = resolveSwarmStorage(env);
	const backendName = activeBackendName();
	const { reader: journal, cleanup } = withJournalCopy(cfg.dbPath);
	try {
		const graph: SwarmGraph = await buildSwarmGraph({
			journal,
			manifests: manifestSource(journal, cfg, backendName),
			backendName,
		});
		const tasks: VerifyTask[] = [];
		for (const node of graph.nodes) {
			if (node.kind !== "task") continue;
			if (taskFilter !== undefined && node.id !== taskFilter) continue;
			if (node.dir === undefined) {
				tasks.push({ task: node.id, ok: false, lines: [{ task: node.id, worker: "*", check: "presence", status: "fail", detail: "manifest named no task dir" }] });
				continue;
			}
			const lines = verifyTask(node.id, node.dir, node.workers.map((w) => w.name));
			tasks.push({ task: node.id, ok: lines.every((l) => l.status === "pass"), lines });
		}
		if (taskFilter !== undefined && tasks.length === 0) {
			throw new SwarmError("E_SWARM_USAGE", `verify: no task named ${JSON.stringify(taskFilter)} in the graph`);
		}
		tasks.sort((a, b) => (a.task < b.task ? -1 : 1));
		emitSuccess("verify", { verify: { ok: tasks.every((t) => t.ok), tasks } });
	} finally {
		cleanup();
	}
}
