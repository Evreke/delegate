/**
 * canvas.js — the v1 center canvas (issue #66, dashboard shell).
 *
 * SVG-only rendering of the swarm graph: depth columns, curved bezier
 * `spawned_by` edges, status-language nodes (marker LEFT of the name,
 * one-line sub, context micro-bar, degraded ⚠N marker, dotted border for
 * foreign nodes) and adaptive-collapse aggregates. No physics, no
 * drag-to-rearrange, no canvas/WebGL — node counts are tens.
 *
 * `renderCanvas` paints the layout once; `patchCanvas` updates status/progress
 * text and severity attributes IN PLACE, leaving every `transform` untouched —
 * a status or progress event never relayouts. Spotlight (from the attention
 * queue) is an input contract: non-affected nodes are dimmed, never hidden.
 */

import { el, on } from "./dom.js";
import { NODE_H, NODE_W, fitView, panBy, zoomAt } from "./layout.js";
import { nodeSubLine, statusView } from "./status.js";

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

/** The marker geometry for one status (color + shape, LEFT of the name). */
export function markerGeometry(view) {
	if (view.shape === "dot" || view.shape === "dot-hollow") return { r: 5, hollow: view.shape === "dot-hollow" };
	if (view.shape === "ring" || view.shape === "ring-dashed" || view.shape === "ring-solid") return { r: 5.5, hollow: true, dashed: view.shape === "ring-dashed" };
	if (view.shape === "diamond") return { half: 6, rotated: true };
	return { half: 5, hollow: view.shape === "square-hollow" };
}

function renderSvgMarker(doc, view, cx, cy) {
	const tag = SHAPE_TAGS[view.shape] || "circle";
	const geo = markerGeometry(view);
	const attrs = { class: `graph-marker ${view.className}${view.pulse ? " status-pulse" : ""}`, "data-status-marker": view.shape, "data-shape": view.shape };
	if (tag === "circle") {
		Object.assign(attrs, { cx, cy, r: geo.r, "fill": geo.hollow ? "none" : "currentColor", "stroke": "currentColor", "stroke-width": 1.5 });
		if (geo.dashed) attrs["stroke-dasharray"] = "3 2";
	} else {
		Object.assign(attrs, { x: cx - geo.half, y: cy - geo.half, width: geo.half * 2, height: geo.half * 2, "fill": geo.hollow ? "none" : "currentColor", "stroke": "currentColor", "stroke-width": 1.5, rx: 1 });
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
	on(group, "click", () =>
		opts.dispatch?.(
			node.kind === "aggregate" || opts.collapsedLeads?.has(node.id)
				? { type: "toggle-collapse", leadId: node.kind === "aggregate" ? node.leadId : node.id }
				: { type: "select-node", id: node.id, spotlightIds: [node.id, node.parentId].filter(Boolean) },
		),
	);
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
	if (node.kind !== "aggregate" && (node.degraded || []).length > 0) {
		group.appendChild(svgEl(doc, "text", { class: "graph-degraded", "data-degraded-count": node.degraded.length, x: NODE_W - 10, y: 18, "text-anchor": "end" }, `\u26a0${node.degraded.length}`));
	}
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
 *   ({ dispatch, spotlight }). Output — a node index ({ svg, nodes: Map }).
 * Guarantees: byte-identical coordinates for identical topology + expansion;
 *   the marker is the first child of each node group (position LEFT). Never
 *   throws on a well-formed layout.
 */
export function renderCanvas(state, layout, root, doc, opts = {}) {
	while (root.firstChild) root.removeChild(root.firstChild);
	const svg = svgEl(doc, "svg", {
		class: "graph-canvas",
		"data-graph": "1",
		viewport: `${layout.bounds.minX} ${layout.bounds.minY} ${layout.bounds.width} ${layout.bounds.height}`,
		viewBox: `${layout.bounds.minX} ${layout.bounds.minY} ${layout.bounds.width} ${layout.bounds.height}`,
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
	const fit = el(doc, "button", { class: "canvas-fit", "data-canvas-fit": "1", type: "button" }, "fit");
	on(fit, "click", () => opts.onView?.(fitView(layout.bounds, viewportOf(opts))));
	toolbar.appendChild(fit);
	root.appendChild(toolbar);
	root.appendChild(svg);
	return { svg, nodes, layout, view };
}

/** The view transform string for the SVG `<g data-view>` wrapper. */
export function viewTransform(view) {
	const v = view || { zoom: 1, panX: 0, panY: 0 };
	return `translate(${v.panX} ${v.panY}) scale(${v.zoom})`;
}

/** The viewport size (from the injected seam, else a documented default). */
function viewportOf(opts) {
	if (typeof opts.viewport === "function") return opts.viewport();
	return { width: 1200, height: 720 };
}

/**
 * Wire the documented interactions onto a rendered canvas: wheel zoom
 * (0.5×–2×, cursor-anchored), drag pan, and the fit affordance. A fake DOM
 * without listeners is a no-op (the pure helpers stay checkable).
 * FUNCTION_CONTRACT: Input — index (renderCanvas result), doc, opts
 *   ({ getView, onView, viewport }). Output — none. Never throws.
 */
export function attachCanvasControls(index, doc, opts = {}) {
	if (!index || !index.svg || typeof index.svg.addEventListener !== "function") return;
	const svg = index.svg;
	const getView = opts.getView || (() => initialViewFallback());
	on(svg, "wheel", (event) => {
		event?.preventDefault?.();
		const factor = event && event.deltaY < 0 ? 1.1 : 0.9;
		opts.onView?.(zoomAt(getView(), factor, event?.offsetX ?? 0, event?.offsetY ?? 0));
	});
	let dragging = null;
	on(svg, "pointerdown", (event) => {
		dragging = { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
	});
	on(svg, "pointermove", (event) => {
		if (dragging === null) return;
		const next = { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
		opts.onView?.(panBy(getView(), next.x - dragging.x, next.y - dragging.y));
		dragging = next;
	});
	on(svg, "pointerup", () => {
		dragging = null;
	});
	on(svg, "dblclick", () => opts.onView?.(fitView(index.layout.bounds, viewportOf(opts))));
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
