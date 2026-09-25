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
 * The vocabulary and its view helpers are pure data + pure functions. The
 * module ALSO owns the static-frame status chrome (issue #79/#82/#86): the
 * connection pill, the token pill, the journal/source health footer and the
 * time-aware activity ticker — one factory (`createStatusChrome`) behind a
 * `byId` seam, so the same code runs in the browser and headlessly.
 */

import { el } from "./dom.js";
import { chromeScope } from "./fleet-scope.js";
import { humanizeDuration } from "./journal.js";

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

/** The transport tokens → human labels + colour classes of the connection pill
 *  (issue #79). The CSS vocabulary is the class; the attribute keeps the raw
 *  machine token, so both readers stay honest. */
const CONNECTION_LABELS = Object.freeze({ open: "live", closed: "disconnected", connecting: "connecting", reconnecting: "reconnecting" });
const CONNECTION_CLASSES = Object.freeze({ open: "conn-open", closed: "conn-closed", connecting: "conn-connecting", reconnecting: "conn-reconnecting" });

/** Resolve one transport state to the connection pill view. */
export function connectionView(state) {
	const token = typeof state === "string" && state.length > 0 ? state : "closed";
	return { token, label: CONNECTION_LABELS[token] ?? token, className: `conn ${CONNECTION_CLASSES[token] ?? CONNECTION_CLASSES.closed}` };
}

/** The read-model honesty block's four sources, in footer order (issue #86). */
export const HEALTH_SOURCES = Object.freeze(["journal", "manifests", "liveStatus", "usage"]);

/**
 * The footer source-health rows. A model's absent `sources`/`available` block
 * (or no model at all — before the first fetch) is an honest `—`, never a
 * fabricated healthy `ok` and never a `0`.
 */
export function sourceHealthView(model) {
	if (!model) return { known: false, rows: [{ name: null, state: "unknown", text: "\u2014" }] };
	const rows = HEALTH_SOURCES.map((name) => {
		const ok = model.available !== false && !(model.sources && model.sources[name] === false);
		return { name, state: ok ? "ok" : "unavailable", text: `${name}: ${ok ? "ok" : "unavailable"}` };
	});
	return { known: true, rows };
}

/** A stream older than this dims the activity ticker (issue #86). */
export const TICKER_STALE_MS = 120_000;

/**
 * The time-aware ticker view from the newest journal event (issue #86).
 * Input: latest — {kind, seq, worker, tsMs} or null; nowMs — the clock reading.
 * Output: { text, stale, ageMs }. An empty journal is the distinct
 * `no events yet`; a missing event ts renders the label without an age.
 */
export function tickerView(latest, nowMs) {
	if (!latest) return { text: "no events yet", stale: false, ageMs: null };
	const parts = [];
	if (latest.kind) parts.push(latest.kind);
	if (typeof latest.seq === "number") parts.push(`#${latest.seq}`);
	if (latest.worker) parts.push(latest.worker);
	const head = parts.join(" ") || "event";
	if (typeof latest.tsMs !== "number" || typeof nowMs !== "number") return { text: head, stale: false, ageMs: null };
	const ageMs = Math.max(0, nowMs - latest.tsMs);
	return { text: `${head} \u00b7 ${humanizeDuration(ageMs) ?? "0s"}`, stale: ageMs > TICKER_STALE_MS, ageMs };
}

/**
 * Build the static-frame status chrome (connection pill, token pill, journal
 * footer + source health + last-updated age, activity ticker, scope chrome).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: { doc, byId, nowMs, tickMs } — the DOM seam, an id→element lookup, a
 *   clock reading and the age-refresh interval.
 * Output: the setters/renders the app wiring calls plus `close()`.
 * Guarantees: every lookup is guarded (a missing element is a no-op); the
 *   age/ticker refresh is one periodic timer, cleared by `close()`; never
 *   throws on a well-formed call.
 * Raises: never
 */
export function createStatusChrome({ doc = null, byId = () => null, nowMs = () => Date.now(), tickMs = 1000 } = {}) {
	let latest = null;
	let updatedMs = null;
	const setConnection = (state) => {
		const node = byId("connection-state");
		if (!node) return;
		const view = connectionView(state);
		node.setAttribute("data-connection-state", view.token);
		node.setAttribute("class", view.className);
		node.textContent = view.label;
	};
	const setToken = (state) => {
		const node = byId("token-state");
		if (!node) return;
		node.setAttribute("data-token-state", state);
		node.textContent = `token: ${state}`;
	};
	const setJournal = (journal) => {
		const count = byId("journal-count");
		const bytes = byId("journal-bytes");
		if (count) count.textContent = journal && typeof journal.count === "number" ? String(journal.count) : "\u2014";
		if (bytes) bytes.textContent = journal && typeof journal.dbSizeBytes === "number" ? String(journal.dbSizeBytes) : "\u2014";
	};
	const renderTicker = () => {
		const node = byId("activity-ticker");
		if (!node) return;
		const view = tickerView(latest, nowMs());
		node.textContent = view.text;
		node.setAttribute("data-stale", view.stale ? "1" : "0");
	};
	const renderAge = () => {
		const node = byId("journal-updated");
		if (!node) return;
		node.textContent = updatedMs === null ? "\u2014" : `updated ${humanizeDuration(Math.max(0, nowMs() - updatedMs)) ?? "0s"}`;
	};
	const renderStatus = (model, version) => {
		const schema = byId("schema-version");
		if (schema) schema.textContent = version === null || version === undefined ? "\u2014" : String(version);
		const sources = byId("health-sources");
		if (sources) {
			while (sources.firstChild) sources.removeChild(sources.firstChild);
			for (const row of sourceHealthView(model).rows) sources.appendChild(el(doc, "span", { class: `source source-${row.state}`, "data-source": row.name, "data-source-state": row.state }, row.text));
		}
		renderTicker();
		renderAge();
	};
	const setLatestEvent = (event) => {
		const tsMs = event && typeof event.ts === "string" && Number.isFinite(Date.parse(event.ts)) ? Date.parse(event.ts) : null;
		latest = event && typeof event === "object" ? { kind: typeof event.kind === "string" ? event.kind : null, seq: typeof event.seq === "number" ? event.seq : null, worker: typeof event.worker === "string" ? event.worker : null, tsMs } : null;
		renderTicker();
	};
	const setScope = (fleetId, fleets) => {
		if (!doc) return;
		const scope = chromeScope({ fleetId, fleets });
		const shell = byId("fleet-tree");
		if (shell) shell.setAttribute("data-fleet-id", scope.key);
		const brand = byId("brand-sub");
		if (brand) brand.textContent = scope.brandText;
		doc.title = scope.title;
		const switcher = byId("scope-switch");
		if (!switcher) return;
		while (switcher.firstChild) switcher.removeChild(switcher.firstChild);
		if (!scope.show) {
			switcher.setAttribute("hidden", "1");
			return;
		}
		switcher.removeAttribute("hidden");
		for (const entry of scope.entries) switcher.appendChild(el(doc, "a", { href: entry.href, class: "scope-link", "data-fleet-link": entry.href, "data-current": entry.current ? "1" : "0" }, entry.label));
	};
	const markUpdated = () => {
		updatedMs = nowMs();
		renderAge();
	};
	const tick = () => {
		renderTicker();
		renderAge();
	};
	const timer = typeof setInterval === "function" && tickMs > 0 ? setInterval(tick, tickMs) : null;
	if (timer && typeof timer.unref === "function") timer.unref();
	return { setConnection, setToken, setJournal, setLatestEvent, renderStatus, setScope, markUpdated, tick, close: () => timer && clearInterval(timer) };
}
