/**
 * rail.js — the v1 left rail (issue #66, dashboard shell).
 *
 * Renders the dashboard model's rail: fleets grouped by owning session (own
 * fleet first, foreign fleets marked read-only), then each TaskNode with its
 * live `done/total` counter and a warn marker when a worker of the task has a
 * pending ask. The session row of a group and every task row carry
 * `data-node-id` — this is the ONE rail element per graph node (the canvas
 * uses its own `data-graph-node`), so "one screen, no duplication" is
 * checkable in the DOM.
 *
 * Every row is a real `<button>` (rail-ux F1): Tab reaches session, task and
 * worker rows, Enter/Space fire the same dispatch a click does, and each
 * `.rail-group` section roves focus through its rows on
 * ArrowUp/ArrowDown/Home/End. The focused row is visible through the global
 * `:focus-visible` accent outline (app.css). Worker rows sit in their `li`
 * wrappers inside the task's `ul` — a `<button>` is not valid directly under
 * `<ul>`, and the list semantics stay.
 *
 * Status markers render through the shared status language (color + shape,
 * LEFT of the name). Degraded chips render verbatim with their severity.
 * No framework; pure view function over the model.
 */

import { el, on, renderDegradedChips, renderStatusMarker } from "./dom.js";
import { statusView } from "./status.js";

/** Wrap one worker-row button in its list item (valid `<ul>` content). */
function appendWorkerItem(list, doc, row) {
	const item = doc.createElement("li");
	item.appendChild(row);
	list.appendChild(item);
}

/** Rove focus through a group's rows on ArrowUp/ArrowDown/Home/End (F1).
 *  The rows are Tab-reachable buttons; the arrows move focus within the
 *  group (roving movement, one shared listener on the section). */
function attachRailGroupKeys(section, rows, doc) {
	if (rows.length === 0 || typeof section?.addEventListener !== "function") return;
	on(section, "keydown", (event) => {
		const key = event && event.key;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
		const active = doc && doc.activeElement ? rows.indexOf(doc.activeElement) : -1;
		let index = 0;
		if (key === "ArrowDown") index = active < 0 ? 0 : Math.min(active + 1, rows.length - 1);
		else if (key === "ArrowUp") index = active < 0 ? 0 : Math.max(active - 1, 0);
		else if (key === "Home") index = 0;
		else index = rows.length - 1;
		const next = rows[index];
		if (!next) return;
		if (typeof event.preventDefault === "function") event.preventDefault();
		if (typeof next.focus === "function") next.focus();
	});
}

/** One session/task row: a `<button>` carrying the node identity (the frozen
 *  `data-node-id` surface) + status marker + hidden status label + name +
 *  degraded chips + the foreign read-only tag. */
function statusRow(doc, node, extra) {
	const attrs = {
		class: extra.className,
		"data-node-id": node.id,
		"data-rail-kind": node.kind,
		"data-status": node.status,
		"data-severity": node.severity,
		"data-foreign": node.foreign ? "1" : "0",
		"data-selected": extra.selected ? "1" : "0",
	};
	if (extra.tag === "button") attrs.type = "button";
	const row = el(doc, extra.tag, attrs);
	row.appendChild(renderStatusMarker(doc, node.statusView));
	// #91: the marker is a visual shape only — a visually-hidden label carries
	// the same status to screen readers (color+shape never the only channel).
	row.appendChild(el(doc, "span", { class: "rail-status-label", "data-rail-status-label": "1" }, node.statusView.label));
	row.appendChild(el(doc, "span", { class: "rail-name", "data-rail-name": "1" }, extra.name));
	for (const chip of renderDegradedChips(doc, node.degraded)) row.appendChild(chip);
	if (node.foreign) row.appendChild(el(doc, "span", { class: "rail-readonly", "data-rail-readonly": "1" }, "read-only"));
	return row;
}

function renderWorkerRow(doc, task, ctx, rows) {
	const list = el(doc, "ul", { class: "rail-workers", "data-rail-workers": task.id });
	for (const w of task.workers || []) {
		const row = el(doc, "button", {
			class: "rail-worker",
			type: "button",
			"data-rail-worker": w.name,
			"data-worker-id": w.id ?? w.name,
			"data-session-id": w.sessionId,
			"data-status": w.status,
			"data-severity": w.severity,
		});
		row.appendChild(renderStatusMarker(doc, w.statusView));
		row.appendChild(el(doc, "span", { class: "rail-status-label", "data-rail-status-label": "1" }, w.statusView.label));
		row.appendChild(el(doc, "span", { class: "rail-worker-name" }, w.name));
		for (const chip of renderDegradedChips(doc, w.degraded)) row.appendChild(chip);
		// #85b: a worker row is a FOCUS affordance, not a display-only label —
		// tapping it selects the task AND focuses that worker in the detail panel.
		on(row, "click", () => ctx.dispatch?.({ type: "select-node", id: task.id, focusWorker: w.name, spotlightIds: taskFocusIds(task) }));
		appendWorkerItem(list, doc, row);
		rows.push(row);
	}
	return list;
}

function renderTask(doc, task, ctx, rows) {
	const row = statusRow(doc, task, { tag: "button", className: "rail-task", name: task.name, selected: ctx.selection === task.id });
	const counters = task.counters || { done: 0, total: 0 };
	row.appendChild(el(doc, "span", { class: "rail-counters", "data-counters": `${counters.done}/${counters.total}` }, `${counters.done}/${counters.total}`));
	if (task.ask) row.appendChild(el(doc, "span", { class: "rail-ask", "data-rail-ask": "1", "aria-label": "pending ask" }, "\u2691"));
	on(row, "click", () => ctx.dispatch?.({ type: "select-node", id: task.id }));
	rows.push(row);
	const box = el(doc, "div", { class: "rail-task-box", "data-rail-task": task.id });
	box.appendChild(row);
	if ((task.workers || []).length > 0) box.appendChild(renderWorkerRow(doc, task, ctx, rows));
	return box;
}

/**
 * Render the rail into `root` (the renderer clears it first).
 * <p>
 * FUNCTION_CONTRACT: Input — state (buildDashboardState output), root, doc,
 *   opts ({ dispatch, selection }). Output — none (root mutated).
 * Guarantees: own groups precede foreign groups; every rendered node appears
 *   once with `data-node-id`; foreign groups carry the read-only marker and
 *   no mutation affordance; session/task/worker rows are keyboard-operable
 *   `<button>`s (Enter/Space fire the click dispatch; the group's section
 *   roves focus on arrow keys). Raises: never on a well-formed model.
 */
export function renderRail(state, root, doc, opts = {}) {
	while (root.firstChild) root.removeChild(root.firstChild);
	if (!state || !state.rail) return;
	const ctx = { dispatch: opts.dispatch, selection: opts.selection ?? null };
	const wrap = el(doc, "div", { class: "rail-inner", "data-rail": "1" });
	for (const group of state.rail.groups) {
		const section = el(doc, "section", { class: "rail-group", "data-rail-group": group.session.id, "data-foreign": group.foreign ? "1" : "0" });
		const rows = [];
		const header = statusRow(doc, group.session, { tag: "button", className: "rail-session", name: group.session.worker || group.session.id, selected: ctx.selection === group.session.id });
		header.appendChild(el(doc, "span", { class: "rail-role", "data-rail-role": group.session.role }, group.session.role));
		on(header, "click", () => ctx.dispatch?.({ type: "select-node", id: group.session.id }));
		rows.push(header);
		section.appendChild(header);
		for (const task of group.fleets) section.appendChild(renderTask(doc, task, ctx, rows));
		if (group.fleets.length === 0) section.appendChild(el(doc, "div", { class: "rail-empty", "data-rail-empty": "1" }, "no tasks"));
		attachRailGroupKeys(section, rows, doc);
		wrap.appendChild(section);
	}
	if (state.rail.groups.length === 0) wrap.appendChild(el(doc, "div", { class: "rail-empty", "data-rail-empty": "all" }, "no fleets"));
	root.appendChild(wrap);
}

/** The rail's node ids in render order (used by the check + S7 node count). */
export function railNodeIds(state) {
	const ids = [];
	for (const group of state?.rail?.groups ?? []) {
		ids.push(group.session.id);
		for (const task of group.fleets) ids.push(task.id);
	}
	return ids;
}

/** The status-language view a rail row uses (exported for the check). */
export function railStatusView(node) {
	return statusView(node.status);
}

/**
 * The center-view nodes a rail task tap focuses: the task, its owning session
 * and each worker's session node. The center consumes this as its spotlight
 * input, so a rail click focuses the graph without a screen switch.
 */
export function taskFocusIds(task) {
	const ids = [task.id];
	if (task.parentId) ids.push(task.parentId);
	for (const w of task.workers || []) if (w.sessionId) ids.push(w.sessionId);
	return ids;
}
