/**
 * degrade.js — the dashboard's degradation vocabulary (issue #53).
 *
 * One place maps each of the four closed graph degradation flags to a
 * DISTINCT, honest visual state. All four are always rendered (a degraded
 * node is shown, never hidden, never faked healthy) with the flag name
 * verbatim in the element text. No framework, plain ES module.
 *
 * #66 adds the UNIFIED SEVERITY LADDER: every flag also carries one of
 * `info` / `warn` / `crit` so degraded chips, status markers and attention
 * items sort on ONE scale. Severity is data, like the flag itself — an
 * unknown flag is honest `info`, never dropped and never upgraded.
 */

/** flag → the full class string applied to the flag's badge element. Every
 *  flag also carries a `degraded-flag-<id>` class so the SHAPE channel (glyph +
 *  left-border accent, detail.css) carries the flag, not only its text. */
export const DEGRADED_STYLES = Object.freeze({
	"no-session-path": "degraded degraded-grey degraded-flag-no-session-path",
	"no-live-status": "degraded degraded-ghost degraded-flag-no-live-status",
	"legacy-orphan": "degraded degraded-badge degraded-badge-orphan degraded-flag-legacy-orphan",
	"usage-unavailable": "degraded degraded-badge degraded-badge-usage degraded-flag-usage-unavailable",
});

/** flag → plain-language gloss (issue #90: the ids are jargon; the gloss is
 *  the honest explanation rendered as title/aria-label + the overlay legend). */
export const DEGRADED_GLOSS = Object.freeze({
	"no-session-path": "the worker's session transcript path is unknown",
	"no-live-status": "the backend reports no live status for this worker",
	"legacy-orphan": "an old record with no live owning session",
	"usage-unavailable": "the backend reports no token usage",
});

/** flag → a distinct shape glyph (rendered by CSS `::before`, never in the
 *  chip's text node — the flag id stays the verbatim chip text). */
export const DEGRADED_GLYPH = Object.freeze({
	"no-session-path": "\u2205",
	"no-live-status": "\u25cb",
	"legacy-orphan": "\u2691",
	"usage-unavailable": "\u25d4",
});

/** One flag's plain-language gloss (an unknown flag is honestly unknown). */
export function degradedGloss(flag) {
	return DEGRADED_GLOSS[flag] || "unrecognized degradation flag";
}

/** One flag's distinct glyph (an unknown flag gets the honest placeholder). */
export function degradedGlyph(flag) {
	return DEGRADED_GLYPH[flag] || "\u25ca";
}

/** The four known flags, in canonical order (used by checks/fixtures). */
export const DEGRADED_FLAGS = Object.freeze(Object.keys(DEGRADED_STYLES));

/** flag → unified severity token (the #66 ladder: info / warn / crit). */
export const FLAG_SEVERITY = Object.freeze({
	"no-session-path": "info",
	"no-live-status": "warn",
	"legacy-orphan": "warn",
	"usage-unavailable": "info",
});

/** The severity ladder rank (`clear` = nothing wrong at all). */
export const SEVERITY_RANK = Object.freeze({ clear: 0, info: 1, warn: 2, crit: 3 });

/** Rank one severity token (unknown tokens rank as info). */
export function severityRank(severity) {
	return SEVERITY_RANK[severity] ?? SEVERITY_RANK.info;
}

/** One flag's unified severity (an unknown flag is honest `info`). */
export function severityFor(flag) {
	return FLAG_SEVERITY[flag] || "info";
}

/**
 * The worst severity in a list of severity tokens.
 * <p>
 * FUNCTION_CONTRACT: Input — severity tokens (any values). Output — the
 * token with the highest ladder rank, or `clear` for an empty list. Total;
 * unknown tokens contribute `info`. Never throws.
 */
export function worstSeverity(values) {
	let worst = "clear";
	for (const value of Array.isArray(values) ? values : []) {
		const token = SEVERITY_RANK[value] === undefined ? "info" : value;
		if (severityRank(token) > severityRank(worst)) worst = token;
	}
	return worst;
}

/**
 * Resolve one flag's visual class. An unknown flag still renders (honesty
 * over tidiness): a distinct unknown style, never dropped.
 */
export function degradeClass(flag) {
	return DEGRADED_STYLES[flag] || "degraded degraded-grey degraded-unknown";
}

/** The four known flags as badge view models (verbatim flag text + severity). */
export function degradeViews(flags) {
	return (Array.isArray(flags) ? flags : []).map((flag) => ({
		flag,
		className: degradeClass(flag),
		severity: severityFor(flag),
	}));
}