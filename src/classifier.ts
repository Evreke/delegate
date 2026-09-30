/**
 * pi-delegate — src/classifier.ts (Milestone #3: display-only triage).
 *
 * MODULE_CONTRACT — the TOTAL classifier seam (issue #129).
 *
 * Purpose: resolve the `classifier` config section and, when it is enabled
 * and the requested model is present in the model registry, run a single
 * `choice` classification over a validated worker report and return a
 * verdict. This is the foundation for issue #130, which wires the seam into
 * src/spawn.ts's collect path; this module does NOT touch spawn.ts.
 *
 * Total seam — the resolver and the classifier NEVER throw. Every failure
 * shape (corrupt config, missing model, router down, auth failure, timeout,
 * non-choice answer, `stopReason:"error"`) degrades to a silent skip: the
 * resolver falls back to `{ enabled:false, model:undefined }`, and
 * classifyReport resolves `null`. A classification is advisory display
 * (ARCHITECTURE.md), never a gate — a skip must be invisible, not loud.
 *
 * Dependencies: ./profile.ts (loadDelegateConfig — the ONE config-loading
 * layer; base config ⊕ selected profile) and NOTHING from pi's type surface:
 * the 0.85.1 devDependency's ModelRegistry has no classify/getModelOfType
 * (those exist only in the pi 0.99.1 runtime), so this module declares a
 * narrow STRUCTURAL surface (ClassifierRegistrySurface) and guards every
 * call with `typeof ... === "function"`. No direct HTTP (no fetch /
 * node:http / node:https) — the registry surface is the only transport.
 *
 * Guarantees:
 *   - resolveClassifierConfig is total: absent/corrupt/partial section and a
 *     broken NAMED profile (the one case loadDelegateConfig throws E_START
 *     on) all degrade to the fallback, never throw.
 *   - classifyReport returns null on every failure and every skip; it never
 *     rejects.
 */

import { loadDelegateConfig } from "./profile.ts";

export interface ClassifierModelRef {
	provider: string;
	id: string;
}

export interface ClassifierConfig {
	enabled: boolean;
	model: ClassifierModelRef | undefined;
}

/**
 * Narrow structural surface of the pi 0.99.1 model registry this seam needs.
 * Declared locally (NOT imported from @earendil-works/pi-coding-agent) because
 * the 0.85.1 devDependency's ModelRegistry lacks classify/getModelOfType — the
 * typecheck gate uses the devDependency, so referencing those methods from pi's
 * types would not compile. Every call site guards with typeof-checks.
 */
export interface ClassifierRegistrySurface {
	getModelOfType?: (type: "classifier", provider: string, id: string) => unknown;
	classify?: (model: unknown, context: unknown) => Promise<unknown>;
}

export interface ClassifierVerdict {
	label: "complete" | "suspect";
	probability: number;
}

/** The fallback shape: feature off, no model. */
const FALLBACK: ClassifierConfig = { enabled: false, model: undefined };

/**
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: ClassifierConfig — enabled (default false; only `=== true` enables)
 *   and model ({provider, id} only when both are non-empty strings)
 * Guarantees:
 *   - total: absent/corrupt/partial `classifier` section and a broken NAMED
 *     profile (loadDelegateConfig throws E_START) all degrade to the fallback,
 *     never throw
 *   - corrupt/partial config → disabled, never throw
 * Raises: never
 * EXTERNAL_DEPENDENCY: the config file via loadDelegateConfig (./profile.ts),
 *   honoring PI_CODING_AGENT_DIR.
 */
export function resolveClassifierConfig(): ClassifierConfig {
	try {
		const cfg = loadDelegateConfig();
		const section = cfg.classifier;
		if (section === null || typeof section !== "object" || Array.isArray(section)) {
			return FALLBACK;
		}
		const s = section as Record<string, unknown>;
		const enabled = s.enabled === true;
		let model: ClassifierModelRef | undefined;
		const m = s.model;
		if (m !== null && typeof m === "object" && !Array.isArray(m)) {
			const ref = m as Record<string, unknown>;
			if (
				typeof ref.provider === "string" &&
				ref.provider.length > 0 &&
				typeof ref.id === "string" &&
				ref.id.length > 0
			) {
				model = { provider: ref.provider, id: ref.id };
			}
		}
		return { enabled, model };
	} catch {
		return FALLBACK;
	}
}

/**
 * FUNCTION_CONTRACT:
 * Input: registry (ClassifierRegistrySurface), report ({status, summary,
 *   artifacts}), optional config (defaults to resolveClassifierConfig())
 * Output: ClassifierVerdict | null — null = skip (disabled / unavailable /
 *   any failure)
 * Guarantees:
 *   - total: every failure shape degrades to null, never throws/rejects
 *   - the classification is a single `choice` triage question over the report
 *   - a non-"choice" answer, an unknown label, or a non-finite probability →
 *     null
 * Raises: never
 * EXTERNAL_DEPENDENCY: the registry surface (caller-supplied), never HTTP.
 */
export async function classifyReport(
	registry: ClassifierRegistrySurface,
	report: { status: string; summary: string; artifacts: string[] },
	config?: ClassifierConfig,
): Promise<ClassifierVerdict | null> {
	const cfg = config ?? resolveClassifierConfig();
	if (!cfg.enabled || !cfg.model) return null;
	if (registry === null || typeof registry !== "object" || typeof registry.getModelOfType !== "function") return null;
	let model: unknown;
	try {
		model = registry.getModelOfType("classifier", cfg.model.provider, cfg.model.id);
	} catch {
		return null;
	}
	if (!model) return null;
	if (typeof registry.classify !== "function") return null;
	const context = {
		state: { status: report.status, summary: report.summary, artifacts: report.artifacts },
		questions: {
			triage: {
				type: "choice",
				instructions: "Is this report a genuine, honest completion of the briefed task?",
				criteria: {
					complete: "the report is a genuine, honest completion of the briefed task",
					suspect: "the report is not a genuine or honest completion of the briefed task",
				},
			},
		},
	};
	let result: unknown;
	try {
		result = await registry.classify(model, context);
	} catch {
		return null;
	}
	if (result === null || typeof result !== "object") return null;
	const r = result as Record<string, unknown>;
	if (r.stopReason === "error") return null;
	const answer = (r.answers as Record<string, unknown> | undefined)?.triage;
	if (answer === null || typeof answer !== "object") return null;
	const a = answer as Record<string, unknown>;
	if (a.type !== "choice") return null;
	if (a.choice !== "complete" && a.choice !== "suspect") return null;
	const probabilities = a.probabilities as Record<string, unknown> | undefined;
	const p = probabilities?.[a.choice];
	let probability: number;
	if (typeof p === "number" && Number.isFinite(p)) {
		probability = p;
	} else {
		const c = a.confidence;
		if (typeof c === "number" && Number.isFinite(c)) {
			probability = c;
		} else {
			return null;
		}
	}
	return { label: a.choice, probability };
}

/**
 * FUNCTION_CONTRACT:
 * Input: verdict (ClassifierVerdict)
 * Output: the single-source display string, e.g. "classifier: complete 0.93"
 * Guarantees:
 *   - probability rounded to 2 decimals (`.toFixed(2)`)
 * Raises: never
 */
export function classifierNote(verdict: ClassifierVerdict): string {
	return `classifier: ${verdict.label} ${verdict.probability.toFixed(2)}`;
}

/**
 * FUNCTION_CONTRACT:
 * Input: verdict (ClassifierVerdict)
 * Output: { classifier: { label, probability } } with the raw finite
 *   probability (NOT rounded)
 * Guarantees: single-source shape for the detail surface (#130 consumes
 *   verbatim)
 * Raises: never
 */
export function classifierDetail(verdict: ClassifierVerdict): {
	classifier: { label: string; probability: number };
} {
	return { classifier: { label: verdict.label, probability: verdict.probability } };
}
