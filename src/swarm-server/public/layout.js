/**
 * layout.js — the v1 center-canvas geometry (issue #66, dashboard shell).
 *
 * PURE, DETERMINISTIC geometry for the SVG swarm graph: depth columns,
 * integer grid slots, curved bezier edge paths and adaptive-collapse
 * aggregates. No DOM, no physics, no drag-to-rearrange, no randomness — two
 * calls over the same topology produce byte-identical node coordinates (the
 * golden rule), and a status/progress change that does not alter topology or
 * the expansion set produces a byte-identical layout (the in-place-update
 * rule).
 *
 * Columns are the RULLED PROTOTYPE READ (canvas-intent R6, divergence
 * C12): three fixed columns synthesized from the node ROLES — column 0
 * orchestrator sessions, column 1 task nodes, column 2 worker sessions
 * grouped under their own task. The wire makes a task and its workers
 * SIBLINGS (both `spawned_by` the orchestrator, `src/swarm/edges.ts`), so a
 * BFS over those edges reads as a hub of mixed siblings; the ruling keeps
 * the read model untouched and synthesizes the grouping here from the
 * wire's own task↔worker association (the embodiment `sessionId`, folded by
 * state.js onto the session node's `task`). Rows follow one task-major band
 * ("T first, then its workers top-to-bottom, then the next task") so a
 * task's workers sit adjacent to its row band. The wire's `depth` is the
 * authority TIER (issue #80), kept as a decorative attribute and never read
 * as a column. Node order inside a column is id-sorted — never insertion
 * order.
 *
 * Pan/zoom/fit are the documented interaction range: wheel zoom 0.5×–2×,
 * cursor-anchored; pan by scroll/drag; `fit` resolves the whole graph into
 * the viewport. R5 (canvas-intent): the 0.5 floor is DYNAMIC — a fleet whose
 * fit ratio falls below 0.5 lowers the floor to that ratio (`zoomFloorFor`),
 * so fit and wheel-out can always bring the WHOLE graph back into view and
 * content is never unreachable behind the `overflow:hidden` region.
 *
 * This module also owns the adaptive-collapse DECISION (which all-terminal
 * lead collapses) because geometry and visibility are one responsibility.
 */

import { worstSeverity } from "./degrade.js";
import { isSettledStatus } from "./status.js";

/** One grid slot's pixel size (CSS px, deterministic). */
export const NODE_W = 168;
export const NODE_H = 58;
export const COL_GAP = 56;
export const ROW_GAP = 18;
export const PAD = 24;

/** The documented zoom range. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

/** Clamp a zoom factor into the documented range (non-finite → 1). */
export function clampZoom(zoom) {
	return clampZoomWithFloor(zoom, ZOOM_MIN);
}

/** Clamp into [floor, ZOOM_MAX]; the floor may only LOWER the documented
 *  0.5 (never raise it) — the reachability exception of R5. */
function clampZoomWithFloor(zoom, floor) {
	if (typeof zoom !== "number" || !Number.isFinite(zoom)) return 1;
	const lo = typeof floor === "number" && Number.isFinite(floor) ? Math.min(floor, ZOOM_MIN) : ZOOM_MIN;
	return Math.min(ZOOM_MAX, Math.max(lo, zoom));
}

/** The reachability floor for one (bounds, viewport) pair (R5): the
 *  documented 0.5, or the fit ratio itself when the whole graph only fits
 *  below it — a fleet of ANY size stays zoomable back to a full fit. Pure,
 *  degenerate input never NaNs. */
export function zoomFloorFor(bounds, viewport) {
	const width = Math.max(1, Number(bounds?.width) || 0);
	const height = Math.max(1, Number(bounds?.height) || 0);
	const vw = Math.max(1, Number(viewport?.width) || 0);
	const vh = Math.max(1, Number(viewport?.height) || 0);
	return Math.min(ZOOM_MIN, vw / width, vh / height);
}

/** The initial view (fit-to-content is applied by `fitView`). */
export function initialView() {
	return { zoom: 1, panX: 0, panY: 0 };
}

/**
 * Zoom around a viewport-anchored cursor point (the point under the cursor
 * stays put). Pure. The optional `floor` is the R5 reachability floor
 * (`zoomFloorFor`) — the wheel may zoom out past 0.5 only down to the zoom
 * that still fits the whole graph.
 * FUNCTION_CONTRACT: Input — view {zoom,panX,panY}, factor (>0), cursorX/Y,
 *   floor (default ZOOM_MIN). Output — a new view with the clamped zoom and
 *   the anchored pan.
 */
export function zoomAt(view, factor, cursorX = 0, cursorY = 0, floor = ZOOM_MIN) {
	const next = clampZoomWithFloor(view.zoom * factor, floor);
	const worldX = (cursorX - view.panX) / view.zoom;
	const worldY = (cursorY - view.panY) / view.zoom;
	return { zoom: next, panX: cursorX - worldX * next, panY: cursorY - worldY * next };
}

/** Pan by a screen-space delta (drag/scroll). Pure. */
export function panBy(view, dx, dy) {
	return { ...view, panX: view.panX + dx, panY: view.panY + dy };
}

/** Fit `bounds` into a viewport, clamped and centered. Pure. R5: the fit
 *  zoom has no 0.5 floor — a fleet too large for 0.5× fits at its own ratio
 *  (`zoomFloorFor`), so every node lands inside the viewport for ANY fleet
 *  size (pan then covers the zoomed-in regime). */
export function fitView(bounds, viewport) {
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);
	const zoom = clampZoomWithFloor(Math.min(viewport.width / width, viewport.height / height), zoomFloorFor(bounds, viewport));
	const panX = (viewport.width - width * zoom) / 2 - bounds.minX * zoom;
	const panY = (viewport.height - height * zoom) / 2 - bounds.minY * zoom;
	return { zoom, panX, panY };
}

/** The node set the canvas shows for one expansion state (collapse applied). */
export function visibleNodes(state, expansion) {
	const expanded = expansion instanceof Set ? expansion : new Set(Array.isArray(expansion) ? expansion : []);
	const hidden = new Set();
	const aggregates = [];
	for (const [leadId, decision] of state.graph.collapse) {
		if (expanded.has(leadId)) continue;
		for (const id of decision.hiddenIds) hidden.add(id);
		const lead = state.byId.get(leadId);
		aggregates.push({
			id: `agg:${leadId}`,
			kind: "aggregate",
			name: decision.label,
			leadId,
			depth: (lead?.depth ?? 0) + 1,
			severity: decision.worstSeverity,
			total: decision.total,
			collected: decision.collected,
			childIds: decision.childIds,
		});
	}
	const nodes = state.nodes.filter((n) => !hidden.has(n.id)).concat(aggregates);
	const visibleIds = new Set(nodes.map((n) => n.id));
	const edges = state.edges
		.map((e) => {
			let from = e.from;
			let to = e.to;
			if (hidden.has(from)) from = `agg:${state.byId.get(e.to)?.id ?? e.to}`;
			if (hidden.has(to)) to = `agg:${state.byId.get(e.from)?.id ?? e.from}`;
			return { ...e, from, to };
		})
		.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));
	return { nodes, edges };
}

/**
 * Resolve each node's COLUMN by its ROLE (R6): orchestrator sessions 0, task
 * nodes 1, worker sessions 2. The pre-R6 derivation was a BFS over the
 * `spawned_by` edges; the wire makes a task and its workers siblings (both
 * spawned by the orchestrator), so that BFS read as a hub of mixed siblings
 * — the ruling synthesizes the prototype's 3-column read from the roles
 * instead, with the task grouping derived in `bandOrder`. Issue #80 stands:
 * the wire's `node.depth` is the authority TIER, never a column (it survives
 * only as the decorative fallback for an unknown node kind).
 * <p>
 * FUNCTION_CONTRACT: Input — state (buildDashboardState output). Output — a
 *   Map(id → column). Guarantees: deterministic (a pure function of the
 *   node's kind/role); every session/task node gets its ruled column; never
 *   throws. Raises: never
 */
export function resolveColumns(state) {
	const cols = new Map();
	for (const node of state?.nodes ?? []) cols.set(node.id, columnFor(node));
	return cols;
}

/** The ruled column of ONE node (R6): orchestrator 0, task 1, worker 2. An
 *  aggregate summarizes a collapsed sub-fleet next to its lead, so it takes
 *  the worker column. An unknown kind keeps the decorative-depth fallback. */
function columnFor(node) {
	if (node.kind === "task") return 1;
	if (node.kind === "aggregate") return 2;
	if (node.kind === "session") return node.isWorker === true ? 2 : 0;
	return typeof node.depth === "number" ? node.depth : 0;
}

/** The task-major BAND order (R6): every orchestrator (id-sorted, column 0),
 *  then for each task (id-sorted) the task itself followed by its worker
 *  sessions (id-sorted) — "T first, then its workers top-to-bottom, then the
 *  next task". A worker session groups under the task the wire's embodiment
 *  association names (state.js folds it onto `session.task`); a worker whose
 *  task is absent from the node set lands in the ungrouped tail. An
 *  aggregate follows its lead when the lead is a visible worker session
 *  (its collapsed sub-fleet reads as the lead's own summary); the rest close
 *  the band, id-sorted. */
function bandOrder(nodes) {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const idSort = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const orchestrators = [];
	const tasks = [];
	const grouped = new Map();
	const ungrouped = [];
	for (const node of nodes) {
		if (node.kind === "task") {
			tasks.push(node);
			continue;
		}
		if (node.kind === "aggregate") continue;
		if (columnFor(node) !== 2) {
			orchestrators.push(node);
			continue;
		}
		const owner = node.task != null ? byId.get(node.task) : null;
		if (owner && owner.kind === "task") {
			if (!grouped.has(node.task)) grouped.set(node.task, []);
			grouped.get(node.task).push(node);
		} else ungrouped.push(node);
	}
	orchestrators.sort(idSort);
	tasks.sort(idSort);
	ungrouped.sort(idSort);
	for (const list of grouped.values()) list.sort(idSort);
	const pendingAggregates = new Map(nodes.filter((n) => n.kind === "aggregate").map((n) => [n.leadId, n]));
	const emitWithAggregate = (node, out) => {
		out.push(node);
		const agg = pendingAggregates.get(node.id);
		if (agg) {
			pendingAggregates.delete(node.id);
			out.push(agg);
		}
	};
	const ordered = [...orchestrators];
	for (const task of tasks) {
		ordered.push(task);
		for (const worker of grouped.get(task.id) ?? []) emitWithAggregate(worker, ordered);
	}
	for (const worker of ungrouped) emitWithAggregate(worker, ordered);
	ordered.push(...[...pendingAggregates.values()].sort(idSort));
	return ordered;
}

/**
 * Compute the deterministic layout for the current expansion state.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: state — buildDashboardState output; opts — { expansion }
 * Output: { nodes, edges, columns, positions, aggregates, bounds, visibleIds }
 * Guarantees: identical topology + expansion → byte-identical positions (the
 *   task-major band and every group order are id-sorted); the ruled 3-column
 *   read — orchestrator 0, tasks 1, workers 2 grouped under their own task;
 *   a collapsed lead contributes ONE aggregate node with the worst child
 *   severity (children are hidden, never silently dropped as healthy).
 * Raises: never
 */
export function computeLayout(state, opts = {}) {
	const { nodes, edges } = visibleNodes(state, opts.expansion);
	// R6: one task-major band emits columns 1-2 (task, then its workers),
	// column 0 counts its own rows — the whole graph reads
	// `orchestrator → task → its workers` instead of the wire's sibling hub.
	const ordered = bandOrder(nodes);
	const columns = new Map();
	const positions = {};
	let bandRow = 0;
	let rootRow = 0;
	for (const node of ordered) {
		const col = columnFor(node);
		const row = col === 0 ? rootRow++ : bandRow++;
		if (!columns.has(col)) columns.set(col, []);
		columns.get(col).push(node.id);
		positions[node.id] = { col, row, x: PAD + col * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP) };
	}
	const paths = [];
	for (const e of edges) {
		const from = positions[e.from];
		const to = positions[e.to];
		if (!from || !to) continue;
		paths.push({ kind: e.kind, from: e.from, to: e.to, at: e.at ?? null, d: bezier(from, to) });
	}
	const bounds = layoutBounds(positions);
	const aggregates = ordered.filter((n) => n.kind === "aggregate");
	return {
		nodes: ordered,
		edges: paths,
		columns,
		positions,
		aggregates,
		bounds,
		visibleIds: new Set(ordered.map((n) => n.id)),
		collapsedLeadIds: aggregates.map((a) => a.leadId),
	};
}

/** One curved bezier from child (from) to parent (to). */
export function bezier(from, to) {
	const x1 = from.x + NODE_W / 2;
	const y1 = from.y + NODE_H / 2;
	const x2 = to.x + NODE_W / 2;
	const y2 = to.y + NODE_H / 2;
	const dx = (x2 - x1) / 2;
	const c1x = x1 + dx;
	const c2x = x2 - dx;
	return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
}

/** The layout's pixel bounds (for fit + SVG viewBox). */
export function layoutBounds(positions) {
	const slots = Object.values(positions);
	if (slots.length === 0) return { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H, width: NODE_W, height: NODE_H };
	const minX = Math.min(...slots.map((p) => p.x));
	const minY = Math.min(...slots.map((p) => p.y));
	const maxX = Math.max(...slots.map((p) => p.x + NODE_W));
	const maxY = Math.max(...slots.map((p) => p.y + NODE_H));
	return { minX: minX - PAD, minY: minY - PAD, maxX: maxX + PAD, maxY: maxY + PAD, width: maxX - minX + PAD * 2, height: maxY - minY + PAD * 2 };
}

/** A stable golden of every node coordinate (the byte-identity witness). */
export function coordinateGolden(layout) {
	return Object.keys(layout.positions)
		.sort()
		.map((id) => `${id}@${layout.positions[id].x},${layout.positions[id].y}`)
		.join("|");
}

/**
 * Adaptive-collapse decisions: a lead whose whole subtree is settled — every
 * descendant `collected`, `retired` or `dead-rebooted` (issue #66 §6) — gets
 * ONE aggregate child (`N/N collected ✓`) instead of its children. The
 * aggregate severity is the WORST descendant severity, so a dead child keeps
 * its crit marker and degraded children are never hidden as healthy. UI state
 * only; computed from the snapshot, never written.
 */
export function computeCollapse(nodes, children, byId, journal) {
	const decisions = new Map();
	for (const lead of nodes) {
		if (lead.kind !== "session" || !lead.ownsChildren) continue;
		const childIds = (children.get(lead.id) ?? []).filter((id) => byId.has(id));
		if (childIds.length === 0) continue;
		const descendants = [];
		const stack = [...childIds];
		while (stack.length > 0) {
			const id = stack.pop();
			const node = byId.get(id);
			if (!node) continue;
			descendants.push(node);
			for (const child of children.get(id) ?? []) stack.push(child);
		}
		const allTerminal = isSettledStatus(lead.status) && descendants.length > 0 && descendants.every((n) => isSettledStatus(n.status));
		const anyAsk = descendants.some((n) => n.ask) || lead.ask !== null;
		if (!allTerminal || anyAsk) continue;
		const collected = descendants.filter((n) => n.status === "collected").length;
		decisions.set(lead.id, {
			leadId: lead.id,
			childIds,
			hiddenIds: descendants.map((n) => n.id),
			total: descendants.length,
			collected,
			worstSeverity: worstSeverity(descendants.map((n) => n.severity)),
			label: `${collected}/${descendants.length} collected \u2713`,
		});
	}
	return decisions;
}
