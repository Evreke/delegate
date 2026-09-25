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
 * Column-by-depth comes from BFS over the `spawned_by` edges (child = from,
 * parent = to): the wire's `depth` is the authority TIER (0/1), not tree
 * depth (issue #80 — the live snapshot carries depth 0 on every node), so it
 * is kept on the node as a decorative attribute and never read as a column.
 * Node order inside a column is the model's deterministic order (id-sorted),
 * never insertion order.
 *
 * Pan/zoom/fit are the documented interaction range: wheel zoom 0.5×–2×,
 * cursor-anchored; pan by scroll/drag; `fit` resolves the whole graph into
 * the viewport at a clamped zoom.
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
	if (typeof zoom !== "number" || !Number.isFinite(zoom)) return 1;
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** The initial view (fit-to-content is applied by `fitView`). */
export function initialView() {
	return { zoom: 1, panX: 0, panY: 0 };
}

/**
 * Zoom around a viewport-anchored cursor point (the point under the cursor
 * stays put). Pure.
 * FUNCTION_CONTRACT: Input — view {zoom,panX,panY}, factor (>0), cursorX/Y.
 * Output — a new view with the clamped zoom and the anchored pan.
 */
export function zoomAt(view, factor, cursorX = 0, cursorY = 0) {
	const next = clampZoom(view.zoom * factor);
	const worldX = (cursorX - view.panX) / view.zoom;
	const worldY = (cursorY - view.panY) / view.zoom;
	return { zoom: next, panX: cursorX - worldX * next, panY: cursorY - worldY * next };
}

/** Pan by a screen-space delta (drag/scroll). Pure. */
export function panBy(view, dx, dy) {
	return { ...view, panX: view.panX + dx, panY: view.panY + dy };
}

/** Fit `bounds` into a viewport, clamped and centered. Pure. */
export function fitView(bounds, viewport) {
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);
	const zoom = clampZoom(Math.min(viewport.width / width, viewport.height / height));
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
 * Resolve each node's COLUMN by BFS over the `spawned_by` edges (child = from,
 * parent = to). Issue #80: the wire's `node.depth` is the authority tier
 * (manifestDepthFor returns 0 for a root orchestrator's workers), NOT tree
 * depth — trusting it collapses the whole graph into one strip. `node.depth`
 * is kept as a decorative attribute and used only as the fallback column for a
 * node unreachable from any root (a pure cycle).
 * <p>
 * FUNCTION_CONTRACT: Input — state (buildDashboardState output). Output — a
 *   Map(id → column). Guarantees: deterministic (roots and children visited
 *   in id order); a node whose parent chain reaches a root gets its distance
 *   from that root; never throws. Raises: never
 */
export function resolveDepths(state) {
	const nodes = state?.nodes ?? [];
	const ids = new Set(nodes.map((n) => n.id));
	// parent[child] = parent (the first spawned_by edge that spawns the child).
	const parent = new Map();
	for (const e of state?.edges ?? []) {
		if (e.kind !== "spawned_by") continue;
		if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
		if (!parent.has(e.from)) parent.set(e.from, e.to);
	}
	const children = new Map();
	for (const [child, par] of parent) {
		if (!children.has(par)) children.set(par, []);
		children.get(par).push(child);
	}
	for (const list of children.values()) list.sort();

	const depths = new Map();
	const queue = [];
	// Roots: no parent, visited in id order (deterministic BFS).
	for (const id of [...ids].sort()) {
		if (parent.has(id)) continue;
		depths.set(id, 0);
		queue.push(id);
	}
	for (let head = 0; head < queue.length; head++) {
		const cur = queue[head];
		const d = depths.get(cur);
		for (const child of children.get(cur) ?? []) {
			if (depths.has(child)) continue;
			depths.set(child, d + 1);
			queue.push(child);
		}
	}
	// A pure cycle has no root: keep determinism via the decorative depth.
	for (const node of nodes) {
		if (depths.has(node.id)) continue;
		depths.set(node.id, typeof node.depth === "number" ? node.depth : 0);
	}
	return depths;
}

/**
 * Compute the deterministic layout for the current expansion state.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: state — buildDashboardState output; opts — { expansion }
 * Output: { nodes, edges, columns, positions, aggregates, bounds, visibleIds }
 * Guarantees: identical topology + expansion → byte-identical positions; a
 *   collapsed lead contributes ONE aggregate node with the worst child
 *   severity (children are hidden, never silently dropped as healthy).
 * Raises: never
 */
export function computeLayout(state, opts = {}) {
	const { nodes, edges } = visibleNodes(state, opts.expansion);
	const depths = resolveDepths(state);
	// A hidden subtree's aggregate sits one column right of its lead — it has no
	// spawned_by edge of its own, so it is placed by the lead's BFS column.
	const colOf = (node) => (node.kind === "aggregate" ? (depths.get(node.leadId) ?? 0) + 1 : (depths.get(node.id) ?? 0));
	const sorted = [...nodes].sort((a, b) => {
		const ad = colOf(a);
		const bd = colOf(b);
		if (ad !== bd) return ad - bd;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const columns = new Map();
	const positions = {};
	for (const node of sorted) {
		const col = colOf(node);
		if (!columns.has(col)) columns.set(col, []);
		const row = columns.get(col).length;
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
	const aggregates = sorted.filter((n) => n.kind === "aggregate");
	return {
		nodes: sorted,
		edges: paths,
		columns,
		positions,
		aggregates,
		bounds,
		visibleIds: new Set(sorted.map((n) => n.id)),
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
