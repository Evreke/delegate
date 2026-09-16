/**
 * pi-delegate — src/profile.ts (named config profiles, "gap 0").
 *
 * MODULE_CONTRACT — the ONE config-loading layer for pi-delegate. Every
 * reader of operator configuration (usage.ts resolvers, watch-config.ts,
 * index.ts host binding) takes the merged view from here; none reads
 * BUDGET_CONFIG_PATH directly anymore.
 *
 * Profiles: named config presets living in ~/.pi/agent/pi-delegate.d/<name>.json.
 * Each profile file has the SAME shape as the base config
 * (~/.pi/agent/pi-delegate.config.json): host, contextWindow, defaults,
 * tiers, watch. Merge rule: TOP-LEVEL SECTION REPLACEMENT — a section present
 * in the profile replaces the base section WHOLESALE (no partial merging
 * inside tiers/defaults/watch — predictable, no surprise unions). Keys absent
 * from the profile fall through to the base config. The profile's own
 * "profile" key (if any) is ignored — profiles do not nest.
 *
 * Selection precedence (operator decisions, 2026-09-15):
 *   1. PI_DELEGATE_PROFILE env var (per-terminal choice),
 *   2. the base config's "profile" key (persistent choice),
 *   3. neither → the base config as-is (today's behavior, byte-identical).
 *
 * Error model (deliberate asymmetry):
 *   - the BASE config stays fully tolerant (missing/corrupt/partial → empty
 *     fallbacks, never throws) — the long-standing convention;
 *   - a NAMED profile that is missing or unparseable is an OPERATOR INTENT
 *     error: loadDelegateConfig() throws a structured DelegateErrorImpl
 *     (E_START) naming the file and the way out. Advisory surfaces (the
 *     watcher, fleet rows, status gauges) deliberately catch it and degrade
 *     to defaults; the spawn path fails loudly with the structured error —
 *     the operator asked for a profile, silence would be a lie.
 *   - a profile name failing PROFILE_NAME_RE is rejected the same way (the
 *     name is used as a filename — no path traversal).
 *
 * Host binding stays a SESSION-START decision (index.ts, composition root):
 * mid-session profile edits change defaults/tiers/watch/contextWindow on the
 * next resolver read, never the bound adapter.
 *
 * Dependencies: node builtins + getAgentDir() (Law 1) + the seam's
 * DelegateErrorImpl. No other src/ imports.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DelegateErrorImpl } from "./host.ts";
import { BUDGET_CONFIG_PATH } from "./host.ts";

/** Directory holding named profile files: <agentDir>/pi-delegate.d/<name>.json. */
export const PROFILES_DIR = join(getAgentDir(), "pi-delegate.d");

/** Profile names are filenames — strict, traversal-proof. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: the selected profile name, or undefined when none is selected
 * Guarantees:
 *   - PI_DELEGATE_PROFILE (trimmed) beats the base config's "profile" key
 *   - an empty/whitespace env value counts as unset
 *   - base-config read failures (missing/corrupt) count as "no profile key"
 * Raises: never (base-config tolerance; env is always readable)
 */
export function resolveProfileName(): string | undefined {
	const env = process.env.PI_DELEGATE_PROFILE?.trim();
	if (env) return env;
	try {
		const cfg = JSON.parse(readFileSync(BUDGET_CONFIG_PATH, "utf8")) as { profile?: unknown };
		if (typeof cfg.profile === "string" && cfg.profile.trim().length > 0) return cfg.profile.trim();
	} catch {
		// no/ corrupt base config → no profile key (tolerant convention)
	}
	return undefined;
}

/** Tolerant JSON read: missing/corrupt → {}. Base-config convention. */
function readTolerant(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * FUNCTION_CONTRACT:
 * Input: none
 * Output: the merged config view (base ⊕ profile, top-level section
 *   replacement; the base "profile" key is consumed, never leaked)
 * Guarantees:
 *   - no profile selected → byte-identical to reading the base config alone
 *   - selected profile missing/corrupt/name-invalid → structured
 *     DelegateErrorImpl E_START naming the file (fail loud, never fallback)
 *   - profiles do not nest: the profile's own "profile" key is ignored
 * Raises:
 *   - DelegateErrorImpl E_START for the operator-intent errors above
 */
export function loadDelegateConfig(): Record<string, unknown> {
	const base = readTolerant(BUDGET_CONFIG_PATH);
	const name = resolveProfileName();
	if (name === undefined) return base;
	if (!PROFILE_NAME_RE.test(name)) {
		throw new DelegateErrorImpl(
			"E_START",
			`pi-delegate profile: invalid profile name ${JSON.stringify(name)} (from PI_DELEGATE_PROFILE or the config "profile" key)`,
			`Profile names must match ${PROFILE_NAME_RE.source} — they are used as filenames under ${PROFILES_DIR}. Fix the selection and retry.`,
		);
	}
	const path = join(PROFILES_DIR, `${name}.json`);
	let profile: unknown;
	try {
		profile = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new DelegateErrorImpl(
			"E_START",
			`pi-delegate profile "${name}" is missing or unparseable: ${(err as Error).message} (looked at ${path})`,
			`Create ${path} with the same shape as the base config (host/contextWindow/defaults/tiers/watch — sections replace the base wholesale) or clear the selection: unset PI_DELEGATE_PROFILE and remove the "profile" key from ${BUDGET_CONFIG_PATH}.`,
			err,
		);
	}
	if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
		throw new DelegateErrorImpl(
			"E_START",
			`pi-delegate profile "${name}" must be a JSON object (looked at ${path})`,
			`Fix ${path} to hold a top-level JSON object with the same keys as the base config.`,
		);
	}
	const { profile: _ignoredBase, ...baseRest } = base;
	const { profile: _ignoredProfile, ...profileRest } = profile as Record<string, unknown>;
	return { ...baseRest, ...profileRest };
}
