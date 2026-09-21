/**
 * pi-delegate — pre-placement: the region of the delegate execute() pipeline
 * that validates the CALL and refuses a doomed re-spawn, extracted verbatim
 * from spawn.ts (Law 5 execution, wave-3 decomposition continuation).
 * <p>
 * MODULE_CONTRACT: two zero-closure-state phases, each a pure function over
 * explicit args whose result is a discriminated union the execute() closure
 * consumes (the TierResolutionInput precedent):
 *   - validateNameAndBrief — the worker-name guard (E_NAME) + the brief →
 *     exchange-dir resolution (E_BRIEF) + the probe-run dir fallback;
 *   - applyGaugeGovernor — the dual-gauge re-spawn governor (E_CONTEXT
 *     primary, E_BUDGET secondary).
 * Both read NOTHING from the execute() closure — none of the seven
 * closure-scoped mutables spawn.ts's MODULE_CONTRACT names as the shared
 * phase state (sessionPath, manifestWarning, reportPath, tierWarning,
 * questionDetected, lastBeat, settleAbort) is read here or accepted as a
 * parameter. The decision logic, E_* codes, error texts and details payloads
 * are byte-identical to the pre-extraction inline region; only the phase
 * boundary became a discriminated result.
 * Dependencies: host.ts (WORKER_NAME_RE + CONTEXT_WARN_PCT), exchange.ts
 * (ensureExchangeDir/exchangeRoot), expaths.ts (the probe-run dir),
 * manifest-store.ts (the governor's prior-embodiment read), usage.ts (the
 * session-JSONL gauges), tool-result.ts (the fail/errText/asDelegateError
 * vocabulary). Never imports spawn.ts — spawn is the root consumer, the DAG
 * holds (dependency rule, ARCHITECTURE.md Law 4).
 * Error modes: never throws past the boundary — every failure comes back as
 * {ok:false, failure} carrying the structured E_NAME / E_BRIEF / E_CONTEXT /
 * E_BUDGET tool result, which the caller returns verbatim.
 */

import { ensureExchangeDir, exchangeRoot } from "./exchange.ts";
import { probeDirPathFor } from "./expaths.ts";
import { CONTEXT_WARN_PCT, WORKER_NAME_RE } from "./host.ts";
import { manifestStore } from "./manifest-store.ts";
import { asDelegateError, errText, fail, type ToolResult } from "./tool-result.ts";
import {
	contextPct,
	overContext,
	overOutputBudget,
	parseSessionUsage,
	resolveContextWindow,
} from "./usage.ts";

/** Exchange dir for probe runs — no brief/task, but placements must stay
 *  teardown- and status-visible (manifestStore.scan() covers every manifest under
 *  the exchange root). Derived from exchangeRoot() so sandboxed tests
 *  ($PI_DELEGATE_EXCHANGE_ROOT) never touch the live /tmp/exchange root. */
function probeExchangeDir(): string {
	return probeDirPathFor(exchangeRoot());
}

/** Explicit inputs of the name + brief validation phase (no closure state). */
export interface NameBriefInput {
	/** The REQUESTED worker name (the canonical name is read back later). */
	name: string;
	/** Resolved brief path (empty for probes). */
	briefPath: string;
	/** Probe runs carry no brief and use the probe exchange dir. */
	isProbe: boolean;
}

/**
 * Worker-name + brief validation as a PURE function (verbatim decision logic
 * from the execute closure — "fail fast, before touching herdr").
 * <p>
 * FUNCTION_CONTRACT:
 * Input: name (requested worker name), briefPath (resolved), isProbe
 * Output: {ok:true, manifestDir} — the dir every later manifest/report write
 *   uses (the brief's task dir, or the probe dir for probes), or
 *   {ok:false, failure} — the E_NAME / E_BRIEF tool result to return verbatim
 * Guarantees:
 *   - the name guard is the frozen WORKER_NAME_RE, unchanged;
 *   - an unusable brief path refuses the spawn with E_BRIEF BEFORE place()
 *     (never wastes a worker); the DelegateError's own guidance wins over the
 *     generic "write the brief first" sentence when the throw carries one;
 *   - probes skip the brief read entirely and land on the probe exchange dir
 *   - pure except ensureExchangeDir's own documented fs mkdir
 * Raises: never (ensureExchangeDir's throws are caught here, per the contract)
 * EXTERNAL_DEPENDENCY: filesystem — the exchange task dir (created on demand)
 *   and <exchange root>/_probe for probe runs.
 */
export function validateNameAndBrief(input: NameBriefInput): { ok: true; manifestDir: string } | {
	ok: false;
	failure: ToolResult;
} {
	const { name, briefPath, isProbe } = input;
	// 1. Validate name + brief (fail fast, before touching herdr).
	if (!WORKER_NAME_RE.test(name)) {
		return {
			ok: false,
			failure: fail(
				"E_NAME",
				`E_NAME — invalid worker name "${name}". ` +
					"Names must match [a-z][a-z0-9_-]{0,31}; use the canonical name (read back at start) when retrying.",
			),
		};
	}

	let exchangeDir: string | null = null;
	if (!isProbe) {
		try {
			exchangeDir = ensureExchangeDir(briefPath).dir;
		} catch (err) {
			const de = asDelegateError(err);
			const guidance =
				de?.guidance ?? `Write the brief file under ${exchangeRoot()}/<task>/ first, then call delegate again.`;
			return {
				ok: false,
				failure: fail("E_BRIEF", `E_BRIEF — ${errText(err)}\n${guidance}`, {
					briefPath,
					name,
				}),
			};
		}
	}
	return { ok: true, manifestDir: exchangeDir ?? probeExchangeDir() };
}

/** Explicit inputs of the dual-gauge governor phase (no closure state). */
export interface GaugeGovernorInput {
	/** The REQUESTED worker name — the governor looks up the prior embodiment. */
	name: string;
	/** The resolved worker model (the context-window gauge is model-scoped). */
	model: string;
	/** The manifest dir whose prior entries are examined. */
	manifestDir: string;
	/** The call's refusal line (params.maxContextPct), default CONTEXT_WARN_PCT. */
	maxContextPct?: number;
	/** The call's OUTPUT-token cap (params.budgetTokens); unset = no budget gauge. */
	budgetTokens?: number;
}

/**
 * The dual-gauge re-spawn governor as a PURE function (verbatim decision
 * logic from the execute closure).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: name, model, manifestDir, maxContextPct?, budgetTokens?
 * Output: {ok:true, maxPct, contextWindow} — the two values every later
 *   gauge/writer in the pipeline needs (the manifest record, the heartbeat,
 *   the terminal gauge line), or {ok:false, failure} — the E_CONTEXT /
 *   E_BUDGET tool result to return verbatim
 * Guarantees:
 *   - refuse to re-spawn a worker whose recorded session tripped EITHER
 *     gauge — context % (primary, pi's own formula) or output budget
 *     (secondary, when set); a prior entry without a sessionPath is not a
 *     gauge subject at all (nothing to measure);
 *   - the governor only READS the manifest — it never writes it;
 *   - pure except the manifest read and parseSessionUsage's documented
 *     session-JSONL read
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — the task manifest + the prior worker's pi
 *   session JSONL (via parseSessionUsage).
 */
export function applyGaugeGovernor(input: GaugeGovernorInput): { ok: true; maxPct: number; contextWindow: number } | {
	ok: false;
	failure: ToolResult;
} {
	const { name, model, manifestDir, budgetTokens } = input;
	// Dual-gauge governor: refuse to re-spawn a worker whose
	// recorded session tripped EITHER gauge — context % (primary, pi's own
	// formula) or output budget (secondary, when set).
	const maxPct = input.maxContextPct ?? CONTEXT_WARN_PCT;
	const contextWindow = resolveContextWindow(model);
	const priorWorker = manifestStore.read(manifestDir)?.workers.find(
		(w) => w.name === name && typeof w.sessionPath === "string" && w.sessionPath.length > 0,
	);
	if (priorWorker?.sessionPath) {
		const priorUsage = parseSessionUsage(priorWorker.sessionPath);
		if (overContext(priorUsage, contextWindow, maxPct)) {
			const pct = contextPct(priorUsage, contextWindow);
			return {
				ok: false,
				failure: fail(
					"E_CONTEXT",
					`E_CONTEXT — worker session near compaction (ctx ${pct}% ≥ ${maxPct}%): its next prompt would compact and lose the brief. ` +
						"Start a NEW worker name (diagnosed retry = new brief + fresh context).",
					{ usage: priorUsage, contextWindow, maxPct, sessionPath: priorWorker.sessionPath, name },
				),
			};
		}
		if (overOutputBudget(priorUsage, budgetTokens)) {
			return {
				ok: false,
				failure: fail(
					"E_BUDGET",
					`E_BUDGET — worker over OUTPUT budget (${priorUsage.output} > ${budgetTokens} tokens). ` +
						"Pick a NEW worker name or pass an explicit higher budgetTokens; budget decline across diagnosed retries is orchestrator policy.",
					{ usage: priorUsage, budget: budgetTokens, sessionPath: priorWorker.sessionPath, name },
				),
			};
		}
	}
	return { ok: true, maxPct, contextWindow };
}
