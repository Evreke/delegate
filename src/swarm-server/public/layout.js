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
 * Column-by-depth comes from BFS over the STRUCTURAL edges (#136):
 * `owned_by` (from = task → to = owner session — the task hangs under its
 * owner) and `contains` (from = task → to = worker session — the worker hangs
 * under its task), so the columns read orchestrator 0 → task 1 → worker 2.
 * `spawned_by` is CAUSAL lineage (worker → orchestrator session) — it never
 * drives a column and is HIDDEN by default when the structural chain
 * (contains + owned_by through one task) already reaches the same orchestrator
 * (round-1fix readability); the `showCausal` option re-shows every causal edge.
 * The wire's `depth` is the authority TIER (0/1), not tree depth (issue #80 —
 * the live snapshot carries depth 0 on every node), so it is kept on the node
 * as a decorative attribute and never read as a column. Row order inside a
 * column is the STRUCTURAL-FAMILY order (round-1fix): a deterministic DFS from
 * the structural roots, children in id order — a task's workers sit in rows
 * adjacent to their task's row, never id-scattered across the column.
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

/**
 * The `spawned_by` edges whose story the structural chain already tells: a
 * causal edge (w → o) is REDUNDANT when one task both `contains` w and is
 * `owned_by` o — the canvas already draws task→w and task→o, so the causal
 * curve only crosses the task column. A causal edge from a session NO task
 * contains (an unembodied worker) is that node's only structural tie and is
 * NEVER redundant. Pure; deterministic (first edge wins).
 */
function redundantSpawnedBy(state) {
	const containsParent = new Map();
	const taskOwner = new Map();
	for (const e of state?.edges ?? []) {
		if (e.kind === "contains") {
			if (!containsParent.has(e.to)) containsParent.set(e.to, e.from);
		} else if (e.kind === "owned_by") {
			if (!taskOwner.has(e.from)) taskOwner.set(e.from, e.to);
		}
	}
	const redundant = new Set();
	for (const e of state?.edges ?? []) {
		if (e.kind !== "spawned_by") continue;
		const task = containsParent.get(e.from);
		if (task !== undefined && taskOwner.get(task) === e.to) redundant.add(e);
	}
	return redundant;
}

/**
 * The visible node set for one expansion state (collapse applied) + edges:
 * structural always, causal `spawned_by` only when not redundant — unless
 * `opts.showCausal` re-shows ALL of them.
 */
export function visibleNodes(state, expansion, opts = {}) {
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
	const redundant = opts.showCausal === true ? null : redundantSpawnedBy(state);
	const edges = state.edges
		.filter((e) => redundant === null || !redundant.has(e))
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
 * Resolve each node's COLUMN by BFS over the STRUCTURAL edges (#136):
 * `owned_by` parents the task under its owner session, `contains` parents the
 * worker session under its task — so the columns read orchestrator 0 → task 1
 * → worker 2. `spawned_by` is CAUSAL lineage (worker → orchestrator, often
 * skipping the task column) and deliberately does NOT drive a column; its
 * edges are still drawn. Issue #80: the wire's `node.depth` is the authority
 * tier (manifestDepthFor returns 0 for a root orchestrator's workers), NOT
 * tree depth — trusting it collapses the whole graph into one strip.
 * `node.depth` is kept as a decorative attribute and used only as the fallback
 * column for a node unreachable from any root (a pure cycle).
 * <p>
 * FUNCTION_CONTRACT: Input — state (buildDashboardState output). Output — a
 *   Map(id → column). Guarantees: deterministic (roots and children visited
 *   in id order); a node whose structural parent chain reaches a root gets
 *   its distance from that root; never throws. Raises: never
 */
export function resolveDepths(state) {
	const nodes = state?.nodes ?? [];
	const ids = new Set(nodes.map((n) => n.id));
	// parent[child] = parent from the STRUCTURAL edges only (#136), each kind
	// keying its CHILD end: owned_by hangs the task (from) under its owner (to);
	// contains hangs the worker (to) under its task (from). spawned_by (causal)
	// and the lifecycle stamps (collected/retired) never assign a column. First
	// edge wins (deterministic input order).
	const parent = new Map();
	const adopt = (child, par) => {
		if (child === par || !ids.has(child) || !ids.has(par)) return;
		if (!parent.has(child)) parent.set(child, par);
	};
	for (const e of state?.edges ?? []) {
		if (e.kind === "owned_by") adopt(e.from, e.to);
		else if (e.kind === "contains") adopt(e.to, e.from);
	}
	const children = new Map();
	for (const [child, par] of parent) {
		if (!children.has(par)) children.set(par, []);
		children.get(par).push(child);
	}
	for (const list of children.values()) list.sort();

	const depths = new Map();
	const queue = [];
	// Roots: no STRUCTURAL parent, visited in id order (deterministic BFS).
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
 * Input: state — buildDashboardState output; opts — { expansion, showCausal }
 * Output: { nodes, edges, columns, positions, aggregates, bounds, visibleIds }
 * Guarantees: identical topology + expansion → byte-identical positions; a
 *   collapsed lead contributes ONE aggregate node with the worst child
 *   severity (children are hidden, never silently dropped as healthy).
 * Raises: never
 */
export function computeLayout(state, opts = {}) {
	const { nodes, edges } = visibleNodes(state, opts.expansion, opts);
	const depths = resolveDepths(state);
	// A hidden subtree's aggregate sits one column right of its lead (no structural edge of its own).
	const colOf = (node) => (node.kind === "aggregate" ? (depths.get(node.leadId) ?? 0) + 1 : (depths.get(node.id) ?? 0));
	// Row order by STRUCTURAL FAMILY (round-1fix): a preorder DFS from the
	// structural roots over owned_by (child = the task) + contains (child = the
	// worker), children in id order. Rows are GLOBAL leaf slots: leaves (and
	// collapse aggregates) take consecutive slots in DFS order, every non-leaf
	// copies its subtree's FIRST slot — a task's row IS its worker block's first
	// row (contains edges near-horizontal). The walk places visible nodes only,
	// so a visible node under a hidden parent still lands in its family; nodes
	// it cannot place (a pure structural cycle) take fresh slots below, in id
	// order. Pure + deterministic.
	const visible = new Set(nodes.map((n) => n.id));
	const aggByLead = new Map(nodes.filter((n) => n.kind === "aggregate").map((n) => [n.leadId, n]));
	const childrenOf = new Map();
	const hasParent = new Set();
	// FIRST structural parent wins (mirrors resolveDepths): the family walk is a forest.
	const link = (child, par) => {
		if (child === par || hasParent.has(child)) return;
		if (!childrenOf.has(par)) childrenOf.set(par, []);
		childrenOf.get(par).push(child);
		hasParent.add(child);
	};
	for (const e of state?.edges ?? []) {
		if (e.kind === "owned_by") link(e.from, e.to);
		else if (e.kind === "contains") link(e.to, e.from);
	}
	for (const list of childrenOf.values()) list.sort();
	const rank = new Map();
	const seen = new Set();
	let nextSlot = 0;
	const slotOf = (id) => {
		if (rank.has(id)) return rank.get(id);
		if (seen.has(id)) return null;
		seen.add(id);
		const agg = aggByLead.get(id);
		let first = null;
		if (agg) {
			// A collapsed subtree occupies ONE slot (the aggregate's).
			first = nextSlot++;
			rank.set(agg.id, first);
		} else {
			for (const child of childrenOf.get(id) ?? []) {
				const r = slotOf(child);
				if (first === null) first = r;
			}
			if (first === null && visible.has(id)) first = nextSlot++;
		}
		if (first !== null && visible.has(id)) rank.set(id, first);
		return first;
	};
	for (const id of [...(state?.byId?.keys() ?? [])].sort()) if (!hasParent.has(id)) slotOf(id);
	for (const n of [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		if (rank.has(n.id)) continue;
		rank.set(n.id, nextSlot++);
	}
	const sorted = [...nodes].sort((a, b) => {
		const ad = colOf(a);
		const bd = colOf(b);
		if (ad !== bd) return ad - bd;
		const ar = rank.get(a.id) ?? 0;
		const br = rank.get(b.id) ?? 0;
		if (ar !== br) return ar - br;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const columns = new Map();
	const positions = {};
	for (const node of sorted) {
		const col = colOf(node);
		if (!columns.has(col)) columns.set(col, []);
		columns.get(col).push(node.id);
		const row = rank.get(node.id) ?? 0;
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
