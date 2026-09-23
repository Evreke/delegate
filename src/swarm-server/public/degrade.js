/**
 * degrade.js — the dashboard's degradation vocabulary (issue #53).
 *
 * One place maps each of the four closed graph degradation flags to a
 * DISTINCT, honest visual state. All four are always rendered (a degraded
 * node is shown, never hidden, never faked healthy) with the flag name
 * verbatim in the element text. No framework, plain ES module.
 */

/** flag → the full class string applied to the flag's badge element. */
export const DEGRADED_STYLES = Object.freeze({
	"no-session-path": "degraded degraded-grey",
	"no-live-status": "degraded degraded-ghost",
	"legacy-orphan": "degraded degraded-badge degraded-badge-orphan",
	"usage-unavailable": "degraded degraded-badge degraded-badge-usage",
});

/** The four known flags, in canonical order (used by checks/fixtures). */
export const DEGRADED_FLAGS = Object.freeze(Object.keys(DEGRADED_STYLES));

/**
 * Resolve one flag's visual class. An unknown flag still renders (honesty
 * over tidiness): a distinct unknown style, never dropped.
 */
export function degradeClass(flag) {
	return DEGRADED_STYLES[flag] || "degraded degraded-grey degraded-unknown";
}

/** The four known flags as badge view models (verbatim flag text). */
export function degradeViews(flags) {
	return (Array.isArray(flags) ? flags : []).map((flag) => ({
		flag,
		className: degradeClass(flag),
	}));
}