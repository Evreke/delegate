/**
 * canvas.js — the v1 center canvas (issue #66, dashboard shell).
 *
 * SVG-only rendering of the swarm graph: depth columns, curved bezier
 * `spawned_by` edges, status-language nodes (marker LEFT of the name,
 * one-line sub, context micro-bar, ONE per-flag degradation badge per flag
 * with a tooltip listing them verbatim, dotted border for foreign nodes) and
 * adaptive-collapse aggregates. No physics, no drag-to-rearrange, no
 * canvas/WebGL — node counts are tens.
 *
 * `renderCanvas` paints the layout once; `patchCanvas` updates status/progress
 * text and severity attributes IN PLACE, leaving every `transform` untouched —
 * a status or progress event never relayouts. Spotlight (from the attention
 * queue) is an input contract: non-affected nodes are dimmed, never hidden.
 *
 * ONE coordinate space (issue #78): the SVG viewBox is the ELEMENT PIXEL BOX
 * (`0 0 width height`, measured from the element itself) and the inner
 * `<g data-view>` transform owns pan/zoom. `fitView`/`zoomAt` therefore work
 * in element pixels end to end — the injected `viewport` seam is used only as
 * a fallback when the element cannot be measured (headless), and the
 * hardcoded 1200x720 "fantasy" viewport is ignored whenever a real
 * measurement is available. The old double-fit (viewBox = layout bounds AND
 * an inner fit transform) is gone.
 *
 * Drag-vs-click (issue #137/AC8): the pan gesture records a render-persistent
 * `gesture` (createDragGesture) and a 4px threshold (isDragGesture) — a
 * pointer travel beyond 4px is a PAN whose trailing click never selects, and
 * because the record outlives a re-render, a data snapshot mid-drag neither
 * stalls the pan nor resurrects the suppressed click. `onView` (app.js) must
 * patch the `<g data-view>` transform IN PLACE — a pan step never re-renders.
 */

import { el, on } from "./dom.js";
import { NODE_H, NODE_W, fitView, panBy, zoomAt } from "./layout.js";
import {
	viewTransform,
	FANTASY_VIEWPORT,
	isFantasyViewport,
	measureViewport,
	viewportOf,
	isInitialView,
	sameView,
	parseViewBox,
	cursorToUser,
	createDragGesture,
	DRAG_THRESHOLD_PX,
	isDragGesture,
} from "./canvas-view.js";
import { nodeSubLine, statusView } from "./status.js";

// The view/drag vocabulary is extracted (Law 5) but remains part of THIS
// module's documented surface — every pin and consumer keeps its spelling.
export { viewTransform, FANTASY_VIEWPORT, isFantasyViewport, measureViewport, viewportOf, sameView, parseViewBox, cursorToUser, createDragGesture, DRAG_THRESHOLD_PX, isDragGesture };

/** SVG element creation (real namespace in a browser; createElement under a fake doc). */
function svgEl(doc, tag, attrs, text) {
	const node = typeof doc.createElementNS === "function" ? doc.createElementNS("http://www.w3.org/2000/svg", tag) : doc.createElement(tag);
	if (attrs) {
		for (const key of Object.keys(attrs)) {
			const value = attrs[key];
			if (value === undefined || value === null) continue;
			if (typeof node.setAttribute === "function") node.setAttribute(key, String(value));
		}
	}
	if (text !== undefined && typeof doc.createTextNode === "function") node.appendChild(doc.createTextNode(String(text)));
	return node;
}

const SHAPE_TAGS = { dot: "circle", "dot-hollow": "circle", square: "rect", "square-hollow": "rect", ring: "circle", "ring-dashed": "circle", "ring-solid": "circle", diamond: "rect" };

/** Status classes drawn DASHED (#84): `unknown` shares `idle`'s `dot-hollow`
 *  shape in status.js (not ours to edit), so the canvas recovers the CSS
 *  `.status-unknown` dashed border from the class NAME. */
const DASHED_STATUS_CLASSES = new Set(["status-unknown", "status-no-live-status"]);

/** Marker geometry for one status: `{ r|half, hollow, dashed, strokeWidth }`.
 *  #84: `unknown` is dashed where `idle` is solid, and `done`/`collected`
 *  keep the status.css 2px/1.5px pair — no two statuses share a
 *  geometry+stroke pair. Input is a status view ({ shape, className }). */
export function markerGeometry(view) {
	const dashed = DASHED_STATUS_CLASSES.has(view?.className);
	const shape = view.shape;
	if (shape === "dot" || shape === "dot-hollow") return { r: 5, hollow: shape === "dot-hollow", dashed, strokeWidth: 1.5 };
	if (shape === "ring" || shape === "ring-dashed" || shape === "ring-solid") return { r: 5.5, hollow: true, dashed: shape === "ring-dashed", strokeWidth: shape === "ring-solid" ? 2 : 1.5 };
	if (shape === "diamond") return { half: 6, rotated: true, hollow: false, dashed: false, strokeWidth: 1.5 };
	return { half: 5, hollow: shape === "square-hollow", dashed: false, strokeWidth: 1.5 };
}

function renderSvgMarker(doc, view, cx, cy) {
	const tag = SHAPE_TAGS[view.shape] || "circle";
	const geo = markerGeometry(view);
	const attrs = { class: `graph-marker ${view.className}${view.pulse ? " status-pulse" : ""}`, "data-status-marker": view.shape, "data-shape": view.shape };
	if (tag === "circle") {
		Object.assign(attrs, { cx, cy, r: geo.r, "fill": geo.hollow ? "none" : "currentColor", "stroke": "currentColor", "stroke-width": geo.strokeWidth });
		if (geo.dashed) attrs["stroke-dasharray"] = "3 2";
	} else {
		Object.assign(attrs, { x: cx - geo.half, y: cy - geo.half, width: geo.half * 2, height: geo.half * 2, "fill": geo.hollow ? "none" : "currentColor", "stroke": "currentColor", "stroke-width": geo.strokeWidth, rx: 1 });
		if (geo.rotated) attrs.transform = `rotate(45 ${cx} ${cy})`;
	}
	return svgEl(doc, tag, attrs);
}

function nodeClasses(node) {
	const classes = ["graph-node", `graph-node-${node.kind}`];
	if (node.foreign) classes.push("graph-foreign");
	classes.push(`sev-${node.severity}`);
	return classes.join(" ");
}

function renderNodeGroup(doc, node, pos, opts) {
	const dimmed = opts.spotlight && opts.spotlight.size > 0 && !opts.spotlight.has(node.id);
	const group = svgEl(doc, "g", {
		class: nodeClasses(node),
		"data-graph-node": node.id,
		"data-kind": node.kind,
		"data-depth": pos.col,
		"data-status": node.status,
		"data-severity": node.severity,
		"data-foreign": node.foreign ? "1" : "0",
		"data-x": pos.x,
		"data-y": pos.y,
		"data-dimmed": dimmed ? "1" : "0",
		"data-spotlight": dimmed ? "0" : "1",
		transform: `translate(${pos.x} ${pos.y})`,
	});
	if (node.kind === "aggregate") group.setAttribute("data-aggregate", node.leadId);
	paintNodeContent(doc, group, node);
	on(group, "click", () => {
		// AC8/#137: the trailing click of a pan gesture never selects — the click
		// fires on whatever node sits under the release point, so the shared
		// render-persistent gesture (opts.gesture) is the only honest verdict.
		if (opts.gesture?.dragged) return;
		opts.dispatch?.(
			node.kind === "aggregate" || opts.collapsedLeads?.has(node.id)
				? { type: "toggle-collapse", leadId: node.kind === "aggregate" ? node.leadId : node.id }
				: { type: "select-node", id: node.id, spotlightIds: [node.id, node.parentId].filter(Boolean) },
		);
	});
	return group;
}

/** One text element whose value is an attribute too (patchable in place). */
function textEl(doc, attrs, value) {
	const node = svgEl(doc, "text", attrs, value);
	node.setAttribute("data-text", String(value));
	return node;
}

/**
 * Paint (or repaint) a node group's inner content: marker LEFT of the name,
 * the one-line sub, the context micro-bar and the degraded ⚠N marker. The
 * caller owns the group element and its transform — this only fills it, so a
 * status flip can repaint in place without moving the node.
 */
function paintNodeContent(doc, group, node) {
	while (group.firstChild) group.removeChild(group.firstChild);
	const view = node.kind === "aggregate" ? statusView("collected") : node.statusView;
	const sub = node.kind === "aggregate" ? `worst: ${node.severity}` : subLineFor(node);
	group.appendChild(svgEl(doc, "rect", { class: "graph-box", x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 8 }));
	group.appendChild(renderSvgMarker(doc, view, 12, NODE_H / 2));
	group.appendChild(textEl(doc, { class: "graph-name", "data-node-name": "1", x: 24, y: 20 }, node.name));
	group.appendChild(textEl(doc, { class: "graph-sub", "data-node-sub": "1", x: 24, y: 38 }, sub));
	if (node.kind !== "aggregate" && node.usage && node.usage.available && typeof node.usage.contextPct === "number") {
		const pct = Math.max(0, Math.min(100, node.usage.contextPct));
		group.appendChild(svgEl(doc, "rect", { class: "graph-ctxbar", "data-context-microbar": "1", "data-context-pct": pct, x: NODE_W - 46, y: NODE_H - 12, width: 36, height: 4, rx: 2 }));
		group.appendChild(svgEl(doc, "rect", { class: "graph-ctxbar-fill", x: NODE_W - 46, y: NODE_H - 12, width: (36 * pct) / 100, height: 4, rx: 2 }));
	}
	if (node.kind !== "aggregate" && (node.degraded || []).length > 0) group.appendChild(renderDegradedBadges(doc, node.degraded));
}

/** One canvas glyph per degradation flag (#84): the SVG half of degrade.js's
 *  four-flag vocabulary (an unknown flag keeps the honest `⚠`, never dropped). */
export const DEGRADED_GLYPHS = Object.freeze({ "no-session-path": "\u2298", "no-live-status": "\u25cc", "legacy-orphan": "\u2691", "usage-unavailable": "\u25a4" });

/** The #84 canvas degradation marker: one badge per flag carrying the flag's
 *  own degrade class + severity and a distinct glyph, plus a `<title>` listing
 *  the flags verbatim (tooltip) — never one severity-blind `⚠N` counter. */
export function renderDegradedBadges(doc, badges) {
	const cluster = svgEl(doc, "g", { class: "graph-degraded-cluster", "data-degraded-count": badges.length });
	cluster.appendChild(svgEl(doc, "title", {}, `degraded: ${badges.map((b) => b.flag).join(", ")}`));
	badges.forEach((badge, i) => {
		const glyph = DEGRADED_GLYPHS[badge.flag] || "\u26a0";
		cluster.appendChild(
			svgEl(doc, "text", { class: `graph-degraded-flag ${badge.className}`, "data-degraded-flag": badge.flag, "data-flag-severity": badge.severity, "data-degraded-glyph": glyph, x: NODE_W - 10 - i * 12, y: 18, "text-anchor": "end" }, glyph),
		);
	});
	return cluster;
}

/** The canvas one-line sub: `status · elapsed · progress`, honestly sparse. */
export function subLineFor(node) {
	const progress = node.progressLabel || (node.progress && node.progress.phase ? node.progress.phase : null);
	return nodeSubLine(statusView(node.status), node.elapsedLabel, progress);
}

/**
 * Render the canvas (edges, then nodes) into `root`.
 * <p>
 * FUNCTION_CONTRACT: Input — state, layout (computeLayout), root, doc, opts
 *   ({ dispatch, spotlight, view, viewport, onView, gesture, showCausal }).
 *   Output — a node index ({ svg, nodes: Map }).
 * Guarantees: byte-identical coordinates for identical topology + expansion;
 *   the marker is the first child of each node group (position LEFT). Never
 *   throws on a well-formed layout.
 */
export function renderCanvas(state, layout, root, doc, opts = {}) {
	while (root.firstChild) root.removeChild(root.firstChild);
	// The viewBox is the element pixel box; measure the region before the SVG
	// exists (the SVG fills it), then remeasure the SVG itself on attach.
	const vp = viewportOf(opts, null, root);
	const svg = svgEl(doc, "svg", {
		class: "graph-canvas",
		"data-graph": "1",
		viewBox: `0 0 ${vp.width} ${vp.height}`,
		preserveAspectRatio: "xMidYMid meet",
	});
	const edgeLayer = svgEl(doc, "g", { class: "graph-layer graph-edges", "data-graph-layer": "edges" });
	for (const edge of layout.edges) {
		edgeLayer.appendChild(
			svgEl(doc, "path", { class: "graph-edge", "data-edge": "1", "data-edge-kind": edge.kind, "data-edge-from": edge.from, "data-edge-to": edge.to, d: edge.d }),
		);
	}
	const nodeLayer = svgEl(doc, "g", { class: "graph-layer graph-nodes", "data-graph-layer": "nodes" });
	const nodes = new Map();
	const nodeOpts = { ...opts, collapsedLeads: new Set(layout.collapsedLeadIds) };
	for (const node of layout.nodes) {
		const pos = layout.positions[node.id];
		const group = renderNodeGroup(doc, node, pos, nodeOpts);
		nodes.set(node.id, group);
		nodeLayer.appendChild(group);
	}
	// The view transform wraps both layers: pan/zoom never touch node coords.
	const view = svgEl(doc, "g", { "data-view": "1", transform: viewTransform(opts.view) });
	view.appendChild(edgeLayer);
	view.appendChild(nodeLayer);
	svg.appendChild(view);
	const toolbar = el(doc, "div", { class: "canvas-toolbar", "data-canvas-toolbar": "1" });
	// Round-1fix: the causal toggle next to `fit` — off (default) hides the
	// redundant spawned_by curves (layout.js already filtered them), on
	// re-shows ALL causal edges. aria-pressed keeps the state honest.
	const causal = el(doc, "button", { class: "canvas-causal", "data-canvas-causal": "1", type: "button", "aria-pressed": opts.showCausal ? "true" : "false", title: "show all causal spawned_by edges" }, "causal");
	on(causal, "click", () => opts.dispatch?.({ type: "toggle-causal" }));
	toolbar.appendChild(causal);
	const fit = el(doc, "button", { class: "canvas-fit", "data-canvas-fit": "1", type: "button" }, "fit");
	on(fit, "click", () => opts.onView?.(fitView(layout.bounds, viewportOf(opts, svg, root))));
	toolbar.appendChild(fit);
	root.appendChild(toolbar);
	root.appendChild(svg);
	return { svg, nodes, layout, view, root };
}

/**
 * Wire the documented interactions onto a rendered canvas: wheel zoom
 * (0.5×–2×, cursor-anchored IN USER UNITS), drag pan with the 4px drag-vs-click
 * threshold, and the fit affordance. A fake DOM without listeners is a no-op
 * (the pure helpers stay checkable).
 * FUNCTION_CONTRACT: Input — index (renderCanvas result), doc, opts
 *   ({ getView, onView, viewport, gesture }). Output — none. Never throws.
 */
export function attachCanvasControls(index, doc, opts = {}) {
	if (!index || !index.svg || typeof index.svg.addEventListener !== "function") return;
	const svg = index.svg;
	const root = index.root ?? null;
	const getView = opts.getView || (() => initialViewFallback());
	// The gesture record: caller-owned (render-persistent, #137) when handed in,
	// else one per index (a re-attach of the SAME render still shares it).
	const gesture = opts.gesture ?? (index.gesture ??= createDragGesture());
	// Remeasure on every attach: the element box is the authoritative viewBox
	// (resize is picked up here), and a fresh SVG re-attaches after every render.
	const applyViewport = () => {
		const vp = viewportOf(opts, svg, root);
		if (typeof svg.setAttribute === "function") svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);
		return vp;
	};
	const vp = applyViewport();
	// First measured attach: the identity ui.view is not a frame in element
	// pixel space, so fit once and let onView persist it in ui state (only when
	// the view is untouched AND the fit actually changes it — never a loop).
	if (measureViewport(svg) && isInitialView(getView())) {
		const fitted = fitView(index.layout.bounds, vp);
		if (!sameView(fitted, getView())) opts.onView?.(fitted);
	}
	on(svg, "wheel", (event) => {
		event?.preventDefault?.();
		const factor = event && event.deltaY < 0 ? 1.1 : 0.9;
		// #92: offsetX/offsetY are CSS pixels; zoomAt anchors in USER units.
		// Convert through the live viewBox + measured box before anchoring.
		const box = viewportOf(opts, svg, root);
		const vb = parseViewBox(typeof svg.getAttribute === "function" ? svg.getAttribute("viewBox") : null) ?? { x: 0, y: 0, width: box.width, height: box.height };
		const cursor = cursorToUser(event?.offsetX ?? 0, event?.offsetY ?? 0, vb, box);
		opts.onView?.(zoomAt(getView(), factor, cursor.x, cursor.y));
	});
	on(svg, "pointerdown", (event) => {
		const start = { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
		// A fresh gesture starts at every pointerdown: `dragged` resets here, so
		// the NEXT genuine click selects (the previous drag's flag is consumed).
		gesture.start = start;
		gesture.dragging = start;
		gesture.dragged = false;
	});
	on(svg, "pointermove", (event) => {
		if (gesture.dragging === null) return;
		const next = { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
		// The threshold verdict is measured from the pointerdown START (total
		// travel), not the last move — jitter under 4px stays a click.
		if (isDragGesture(gesture.start, next)) gesture.dragged = true;
		opts.onView?.(panBy(getView(), next.x - gesture.dragging.x, next.y - gesture.dragging.y));
		gesture.dragging = next;
	});
	on(svg, "pointerup", () => {
		gesture.dragging = null;
		// `gesture.dragged` survives the pointerup ON PURPOSE: the browser fires
		// the trailing click AFTER pointerup, and that click must stay suppressed.
	});
	on(svg, "dblclick", () => opts.onView?.(fitView(index.layout.bounds, applyViewport())));
}

/** A defensive default view (the app always passes getView). */
function initialViewFallback() {
	return { zoom: 1, panX: 0, panY: 0 };
}

/**
 * Patch node status/progress/severity IN PLACE (no relayout, no transform
 * change). The aggregate severity and the degraded ⚠N marker update too.
 * FUNCTION_CONTRACT: Input — index (renderCanvas result), state. Output —
 * the same index. Guarantees: `data-x`/`data-y`/`transform` are untouched.
 */
export function patchCanvas(index, state, doc, opts = {}) {
	if (!index) return index;
	const spotlight = opts.spotlight ?? new Set();
	for (const [id, group] of index.nodes) {
		let node = state.byId.get(id);
		if (!node && id.startsWith("agg:")) {
			const decision = state.graph.collapse.get(id.slice(4));
			if (decision) node = { id, kind: "aggregate", name: decision.label, status: "collected", severity: decision.worstSeverity, statusView: statusView("collected"), degraded: [], foreign: false, usage: null };
		}
		if (!node) continue;
		if (group.setAttribute) {
			group.setAttribute("class", nodeClasses(node));
			group.setAttribute("data-status", node.status);
			group.setAttribute("data-severity", node.severity);
			const dimmed = spotlight.size > 0 && !spotlight.has(id);
			group.setAttribute("data-dimmed", dimmed ? "1" : "0");
			group.setAttribute("data-spotlight", dimmed ? "0" : "1");
		}
		// Repaint the content so the marker color/shape and the degraded ⚠N
		// marker follow the status — the group's transform/x/y stay untouched.
		paintNodeContent(doc, group, node);
	}
	return index;
}

/** The canvas node ids in render order (deterministic). */
export function canvasNodeIds(layout) {
	return [...layout.nodes].map((n) => n.id);
}
