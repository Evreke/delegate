/**
 * pi-delegate — spawn-phases: the pure execute() phases of the delegate
 * tool's spawn pipeline, extracted verbatim from spawn.ts (Law 5 execution,
 * the wave-3 continuation of the src/pre-placement.ts precedent).
 * <p>
 * MODULE_CONTRACT: five zero-closure-state phases, each a pure function over
 * explicit args whose discriminated result (or advisory output) the
 * execute() closure in spawn.ts consumes or returns verbatim:
 *   - resolveTierPlacement — tier/provider/model resolution (explicit params
 *     > tiers[<tier>] > defaults, per key; E_TIER on an unknown tier or a
 *     missing key — there is NO built-in worker tier);
 *   - resolveBriefReportSchema — the brief's report-schema resolution
 *     (E_BRIEF before place(); an unexpected resolver throw degrades to
 *     base-schema-only validation and comes back as degradedWarning);
 *   - detectBriefTierMismatch — the advisory tier-mismatch warning line
 *     ("" when no mismatch / unreadable brief / probe run);
 *   - briefSchemaViolationNote — the "base schema passes, brief fragment
 *     rejects" guidance note the caller appends to E_REPORT_INVALID;
 *   - maybeNotifyFleetIdle — the advisory last-live-worker nudge (fires
 *     notifyFleetIdle only when zero workers are working/blocked).
 * None of them reads any of the seven closure-scoped mutables spawn.ts's
 * MODULE_CONTRACT names as the shared phase state (sessionPath,
 * manifestWarning, reportPath, tierWarning, questionDetected, lastBeat,
 * settleAbort) — none is read here or accepted as a parameter. The decision
 * logic, E_* codes, error texts and details payloads are byte-identical to
 * the pre-extraction inline region; only the phase boundary became a
 * discriminated result. The structural edges are pinned by
 * test/spawn-shrink-check.ts.
 * Dependencies: host.ts (the Transport seam type — the injected transport is
 * a maybeNotifyFleetIdle argument, never an import; the SpawnTier type
 * comes from the same module), tool-result.ts (the fail/errText vocabulary),
 * report-schema.ts (resolveReportSchema/validateReport), manifest-store.ts
 * (the task manifest read behind the nudge), fleet-widget.ts
 * (notifyFleetIdle), plus node:fs/promises, node:path and pi's
 * CONFIG_DIR_NAME for the two-tier schema-library resolution. Never imports
 * spawn.ts — spawn is the root consumer, the DAG holds (ARCHITECTURE.md
 * Laws 4 and 5).
 * Error modes: never throws past the boundary — resolveTierPlacement and
 * resolveBriefReportSchema return {ok:false, failure} carrying the
 * structured E_TIER / E_BRIEF tool result, which the caller returns
 * verbatim; the advisory phases (detectBriefTierMismatch,
 * briefSchemaViolationNote, maybeNotifyFleetIdle) swallow their own
 * failures by contract and never alter a verdict.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { notifyFleetIdle } from "./fleet-widget.ts";
import { manifestStore } from "./manifest-store.ts";
import { resolveReportSchema, validateReport } from "./report-schema.ts";
import { errText, fail, type ToolResult } from "./tool-result.ts";
import type { SpawnTier, Transport } from "./host.ts";

/** Explicit inputs of the tier-resolution phase (no closure state). */
export interface TierResolutionInput {
	name: string;
	tier?: string;
	provider?: string;
	model?: string;
	thinking?: string;
}

/**
 * v1.9.2 tier resolution as a PURE function (verbatim decision logic from
 * the execute closure).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - input: the call's explicit tier/provider/model/thinking params + the
 *     worker name (for the E_TIER details payload)
 *   - tierTable: resolveTierTable() result (the config "tiers" section)
 *   - spawnDefaults: resolveSpawnDefaults() result (the config "defaults")
 * Output: {ok:true, provider, model, thinking} — every key resolved (string),
 *   or {ok:false, failure} — the E_TIER tool result to return verbatim
 * Guarantees:
 *   - explicit params > tiers[<tier>] > defaults, per key; there is NO
 *     built-in worker tier — an unconfigured environment fails with E_TIER
 *     (never a guessed provider)
 *   - pure: no I/O, no closure reads; the config reads happen in the CALLER
 * Raises: never
 */
export function resolveTierPlacement(
	input: TierResolutionInput,
	tierTable: Record<string, SpawnTier>,
	spawnDefaults: { provider?: string; model?: string; thinking?: string; tier?: string },
): { ok: true; provider: string; model: string; thinking: string } | { ok: false; failure: ToolResult } {
	const requestedTier = input.tier ?? spawnDefaults.tier;
	let tierEntry: SpawnTier | undefined;
	if (requestedTier !== undefined) {
		tierEntry = tierTable[requestedTier];
		if (tierEntry === undefined) {
			const available = Object.keys(tierTable).sort();
			return {
				ok: false,
				failure: fail(
					"E_TIER",
					`E_TIER — unknown worker tier "${requestedTier}"` +
						` (configured tiers: ${available.length > 0 ? available.join(", ") : "none"}). ` +
						"Add it to ~/.pi/agent/pi-delegate.config.json under \"tiers\", drop the tier param, " +
						"or pass provider/model/thinking explicitly.",
					{ tier: requestedTier, availableTiers: available, name: input.name },
				),
			};
		}
	}
	const pickTier = (
		explicit: string | undefined,
		fromTier: string | undefined,
		fromDefaults: string | undefined,
	): string | undefined => explicit ?? fromTier ?? fromDefaults;
	const provider = pickTier(input.provider, tierEntry?.provider, spawnDefaults.provider);
	const model = pickTier(input.model, tierEntry?.model, spawnDefaults.model);
	const thinking = pickTier(input.thinking, tierEntry?.thinking, spawnDefaults.thinking);
	const missingTierKeys = [
		provider === undefined ? "provider" : undefined,
		model === undefined ? "model" : undefined,
		thinking === undefined ? "thinking" : undefined,
	].filter((k): k is string => typeof k === "string");
	if (missingTierKeys.length > 0) {
		return {
			ok: false,
			failure: fail(
				"E_TIER",
				`E_TIER — no worker ${missingTierKeys.join("/")} configured (no built-in tier exists). ` +
					"Set \"tiers\" / \"defaults\" in ~/.pi/agent/pi-delegate.config.json, e.g. " +
					'{"tiers": {"flash": {"provider": "zai", "model": "glm-5.3-flash", "thinking": "high"}}, ' +
					"\"defaults\": {\"tier\": \"flash\"}} — or pass provider/model/thinking explicitly.",
				{ missing: missingTierKeys, name: input.name },
			),
		};
	}
	// The E_TIER guard above guarantees all three keys are defined (the same
	// shape the execute closure's later `provider as string` sites relied on).
	return { ok: true, provider: provider as string, model: model as string, thinking: thinking as string };
}

/** Explicit inputs of the report-schema resolution phase (no closure state). */
export interface SchemaResolutionInput {
	name: string;
	/** Resolved brief path (empty for probes). */
	briefPath: string;
	/** Session cwd — the project-local schema library root is resolved from it. */
	cwd: string;
	isProbe: boolean;
}

/**
 * v1.5 report-schema resolution as a PURE function (verbatim decision logic
 * from the execute closure; the one advisory side effect — the
 * "schema resolver threw" progress line — comes back as degradedWarning for
 * the caller to emit, keeping the function itself side-effect-free).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: name (worker name, for the E_BRIEF payload); briefPath (resolved);
 *   cwd; isProbe (probes have no brief → base schema only, no I/O)
 * Output: {ok:true, briefSchema, schemaProvenance, resolvedSchema,
 *   degradedWarning?} — the three closure variables' values, or
 *   {ok:false, failure} — the E_BRIEF tool result to return verbatim
 * Guarantees:
 *   - a bad schema rejects the spawn with E_BRIEF BEFORE place() (never
 *     wastes a worker)
 *   - an unexpected resolver THROW degrades to base-schema-only validation
 *     (ok:true + degradedWarning) — the {ok:false} path is the real
 *     rejection; schema null = the brief has no reportSchema key (base-only
 *     validation, never a rejection)
 *   - pure except the resolver's own documented fs reads (resolveReportSchema)
 * Raises: never (the resolver's throws are caught here, per the contract)
 */
export function resolveBriefReportSchema(input: SchemaResolutionInput): {
	ok: true;
	briefSchema: Record<string, unknown> | null;
	schemaProvenance: string[];
	resolvedSchema: Record<string, unknown> | null;
	degradedWarning?: string;
} | { ok: false; failure: ToolResult } {
	const { name, briefPath, cwd, isProbe } = input;
	if (isProbe) return { ok: true, briefSchema: null, schemaProvenance: [], resolvedSchema: null };
	let resolved: ReturnType<typeof resolveReportSchema>;
	let degradedWarning: string | undefined;
	try {
		// EXTERNAL_DEPENDENCY: filesystem — <cwd>/.pi/delegate-schemas/
		// (via pi's CONFIG_DIR_NAME — the literal ".pi" honoring pi's
		// project-config convention) and ~/.pi/agent/pi-delegate-schemas/
		// (library type files <name>.json).
		// Two-tier schema library: project-local
		// <cwd>/.pi/delegate-schemas/ searched FIRST, user-level second.
		resolved = resolveReportSchema(briefPath, resolve(cwd, CONFIG_DIR_NAME, "delegate-schemas"));
	} catch (err) {
		// A throw is not a resolution failure per the contract ({ok:false} is) —
		// degrade to base-schema-only validation instead of rejecting the spawn.
		resolved = { ok: true, schema: null, provenance: [] };
		degradedWarning = errText(err);
	}
	if (!resolved.ok) {
		return {
			ok: false,
			failure: fail(
				"E_BRIEF",
				`E_BRIEF — report schema resolution failed for ${name}: ${resolved.error}\n` +
					"Fix the brief's reportSchema reference or inline fragment before spawning.",
				{ briefPath, name, resolutionError: resolved.error },
			),
		};
	}
	// Corrected contract (merge gate): schema is null when the brief has no
	// reportSchema key — ok-with-null → base-only validation, never a rejection.
	return {
		ok: true,
		briefSchema: resolved.schema,
		schemaProvenance: resolved.provenance,
		resolvedSchema: resolved.schema,
		...(degradedWarning !== undefined ? { degradedWarning } : {}),
	};
}

/** Explicit inputs of the tier-mismatch detection phase (no closure state). */
export interface TierMismatchInput {
	/** Resolved brief path (empty for probes). */
	briefPath: string;
	/** The resolved worker model — the E_TIER guard above guarantees it is set. */
	model: string;
	/** Probes carry no brief → the guard never fires. */
	isProbe: boolean;
}

/**
 * The tier-mismatch guard as a PURE function (verbatim decision logic and the
 * verbatim warning text from the execute closure). The closure keeps the
 * tierWarning mutable it feeds — this phase only COMPUTES the advisory line,
 * the same shape as the wave-3 schema resolution returning degradedWarning.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: briefPath (resolved), model (resolved), isProbe
 * Output: the warning line ("brief declares <declared> tier but worker runs
 *   <model> — tier mismatch"), or "" when the brief declares no tier, the
 *   declared tier matches the model, the brief is unreadable, or this is a
 *   probe run
 * Guarantees:
 *   - advisory by contract: an unreadable brief yields "" and never blocks
 *     the run (the read failure is swallowed here, exactly as inline before);
 *   - reads NO closure mutable and takes none as a parameter
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — the brief file.
 */
export async function detectBriefTierMismatch(input: TierMismatchInput): Promise<string> {
	const { briefPath, model, isProbe } = input;
	if (isProbe) return "";
	try {
		const briefText = await readFile(briefPath, "utf8");
		const tierMatch = briefText.match(/frontier tier|flash tier|execution tier/i);
		if (tierMatch) {
			const declared = /frontier/i.test(tierMatch[0]) ? "frontier" : "flash";
			const modelStr = model as string; // guaranteed by the E_TIER guard above
			const ok = declared === "frontier" ? /frontier/i.test(modelStr) : /flash|glm/i.test(modelStr);
			if (!ok) return `brief declares ${declared} tier but worker runs ${modelStr} — tier mismatch`;
		}
	} catch {
		// unreadable brief → guard is advisory, never blocks the run
	}
	return "";
}

/** Explicit inputs of the brief-reportSchema violation note (no closure state). */
export interface SchemaViolationNoteInput {
	/** True when the report file is missing — nothing was validated then. */
	missing: boolean;
	/** The path the collect attempt actually read. */
	usedReportPath: string;
	/** The canonical worker name (validateReport's name expectation). */
	canonical: string;
	/** The merged fragment the report was held to (null = base-schema only). */
	resolvedSchema: Record<string, unknown> | null;
	/** The schema resolution provenance chain. */
	schemaProvenance: string[];
}

/**
 * The v1.2/v1.5 brief-reportSchema violation note as a PURE function
 * (verbatim decision logic, guidance text, fragment quote and provenance
 * chain from the execute closure).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: missing, usedReportPath, canonical, resolvedSchema, schemaProvenance
 * Output: the dedicated guidance note ("" when the report is missing, when
 *   the BASE schema itself rejects the report, or when the base schema passes
 *   and there is nothing to distinguish)
 * Guarantees:
 *   - the note is appended to the E_REPORT_INVALID text by the caller — it
 *     never changes the code or the verdict, only the guidance;
 *   - "base passes, fragment rejects" is the ONLY case that produces the
 *     violation prose (unchanged);
 *   - pure except validateReport's own documented report read
 * Raises: never
 * EXTERNAL_DEPENDENCY: filesystem — the report file (via validateReport).
 */
export function briefSchemaViolationNote(input: SchemaViolationNoteInput): string {
	const { missing, usedReportPath, canonical, resolvedSchema, schemaProvenance } = input;
	let schemaNote = "";
	if (!missing) {
		const base = validateReport(usedReportPath, canonical);
		if (base.ok) {
			schemaNote =
				"\nThis is a brief-reportSchema violation: the report violates the brief's reportSchema — " +
				"either the worker or the schema fragment is wrong; compare evidence, then fix the brief or re-brief.";
			// v1.5: the audit trail answers "what schema was this
			// report held to" — quote the merged fragment (truncated) + provenance.
			if (resolvedSchema) {
				const fragmentJson = JSON.stringify(resolvedSchema);
				schemaNote +=
					`\nschema held: ${fragmentJson.length > 300 ? `${fragmentJson.slice(0, 300)}…` : fragmentJson}`;
			}
			if (schemaProvenance.length > 0) {
				schemaNote += `\nschema provenance: ${schemaProvenance.join(" → ")}`;
			}
		}
	}
	return schemaNote;
}

/** Explicit inputs of the last-live-worker nudge (no closure state). */
export interface FleetIdleInput {
	/** The injected Transport seam (the live-worker sensor). */
	transport: Transport;
	/** The tool context (notifyFleetIdle's UI handle). */
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext;
	/** The task dir whose manifest holds the worker count. */
	manifestDir: string;
}

/**
 * The last-live-worker nudge as a PURE-over-its-args function (verbatim logic
 * from the execute closure): when no worker is live (working/blocked) anymore
 * after this collect, fire notifyFleetIdle with the task manifest's worker
 * count. Advisory — never affects outcomes.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: transport, ctx, manifestDir (all explicit — no closure state)
 * Output: resolves when the (skippable) nudge attempt is done
 * Guarantees:
 *   - fires only when zero workers are working/blocked; any failure
 *     (herdr unreachable) is swallowed — advisory only
 * Raises: never
 */
export async function maybeNotifyFleetIdle(input: FleetIdleInput): Promise<void> {
	const { transport, ctx, manifestDir } = input;
	try {
		const statuses = await transport.listStatuses();
		const live = statuses.filter((s) => s.status === "working" || s.status === "blocked");
		if (live.length === 0) {
			notifyFleetIdle(ctx, manifestStore.read(manifestDir)?.workers.length ?? 1);
		}
	} catch {
		// advisory only — herdr unreachable → skip the nudge
	}
}
