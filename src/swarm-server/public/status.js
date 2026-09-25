/**
 * status.js — the v1 status language (issue #66, dashboard shell).
 *
 * The ONE place a node/worker state becomes a visual. The v1 system is
 * color + shape + position: the marker is rendered LEFT of the name, carries
 * a distinct shape (so colorblind readers get the same signal) and a pulse
 * only for live/attention states. Six canonical states are frozen by the
 * issue — running / idle / ask / collected / retired / dead — plus three
 * honest extensions for states the read-model can actually report
 * (`blocked` and `done` from the transport, `unknown` for a node whose
 * liveness source is unavailable). `unknown` is a REAL state, never a
 * fabricated "healthy": a node flagged `no-live-status` renders it and keeps
 * its degraded chip.
 *
 * Pure data + pure functions; no DOM, no framework. The renderer owns
 * placement; this module owns the vocabulary.
 */

/** The status language table. `shape` is the marker geometry, `pulse` marks
 *  a live/attention animation (CSS), `className` carries the palette token. */
export const STATUS_LANGUAGE = Object.freeze({
	running: Object.freeze({ className: "status-running", shape: "dot", label: "running", pulse: true }),
	idle: Object.freeze({ className: "status-idle", shape: "dot-hollow", label: "idle", pulse: false }),
	ask: Object.freeze({ className: "status-ask", shape: "square", label: "ask", pulse: true }),
	collected: Object.freeze({ className: "status-collected", shape: "ring", label: "collected", pulse: false }),
	retired: Object.freeze({ className: "status-retired", shape: "ring-dashed", label: "retired", pulse: false }),
	dead: Object.freeze({ className: "status-dead", shape: "diamond", label: "dead", pulse: false }),
	blocked: Object.freeze({ className: "status-blocked", shape: "square-hollow", label: "blocked", pulse: false }),
	done: Object.freeze({ className: "status-done", shape: "ring-solid", label: "done", pulse: false }),
	unknown: Object.freeze({ className: "status-unknown", shape: "dot-hollow", label: "no live status", pulse: false }),
});

/** The canonical statuses the issue names (order = display/documentation order). */
export const CANONICAL_STATUSES = Object.freeze(["running", "idle", "ask", "collected", "retired", "dead"]);

/** The marker always renders LEFT of the name (position is part of the language). */
export const STATUS_MARKER_POSITION = "left";

/** Resolve one status token to its visual view (unknown tokens stay honest). */
export function statusView(status) {
	return STATUS_LANGUAGE[status] || STATUS_LANGUAGE.unknown;
}

/** A terminal status: the worker's history is closed, no new activity coming. */
export function isTerminalStatus(status) {
	return status === "collected" || status === "retired";
}

/** A collapse-terminal status (issue #66 §6): a worker whose history is CLOSED —
 *  `collected`, `retired`, or `dead-rebooted`. Distinct from
 *  `isTerminalStatus` (the rail's done-counter, where a dead worker is settled
 *  but never `done`): the adaptive-collapse rule names dead-reboot among its
 *  terminal statuses, so a dead child must collapse WITH its crit severity
 *  surfaced, never disappear. */
export function isSettledStatus(status) {
	return status === "collected" || status === "retired" || status === "dead";
}

/** Map a transport `AgentStatusName` to the status language. */
export function liveStatusToName(liveStatus) {
	if (liveStatus === "working") return "running";
	if (liveStatus === "idle") return "idle";
	if (liveStatus === "blocked") return "blocked";
	if (liveStatus === "done") return "done";
	return "unknown";
}

/** The attention severity a status contributes to the unified ladder. */
export function statusSeverity(status) {
	if (status === "dead") return "crit";
	if (status === "ask" || status === "blocked" || status === "unknown") return "warn";
	return "info";
}

/** The one-line sub-caption a canvas node shows: `status · elapsed · progress`. */
export function nodeSubLine(view, elapsedLabel, progressLabel) {
	const parts = [view.label];
	if (elapsedLabel) parts.push(elapsedLabel);
	if (progressLabel) parts.push(progressLabel);
	return parts.join(" \u00b7 ");
}
