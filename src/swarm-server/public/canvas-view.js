/**
 * canvas-view.js — the canvas viewport seam: pan/zoom/fit controls and the
 * view math (issues #78/#92; split from canvas.js in the canvas-intent round).
 *
 * ONE coordinate space: the SVG viewBox is the ELEMENT PIXEL BOX and the inner
 * `<g data-view>` transform owns pan/zoom, so fit/zoom work in element pixels
 * end to end. The injected `viewport` seam is only the fallback when the
 * element cannot be measured (headless), and the hardcoded 1200x720 "fantasy"
 * box is ignored whenever a real measurement exists.
 *
 * A fake DOM without listeners is a no-op (the pure helpers stay checkable).
 *
 * R5 (canvas-intent) lives here too: (a) the wheel zoom floor is DYNAMIC —
 * `zoomFloorFor(bounds, viewport)` lowers the documented 0.5 to the fit ratio
 * when the graph only fits below it, so wheel-out never traps the view above
 * the fitting zoom; (b) `dragGesture` is the drag-vs-click threshold — a
 * pointer must travel more than CLICK_DRAG_THRESHOLD_PX before the gesture
 * pans, and a gesture that panned suppresses its trailing synthetic click so
 * a pan never selects the node it ended on.
 */

import { on } from "./dom.js";
import { fitView, panBy, zoomAt, zoomFloorFor } from "./layout.js";

/** The view transform string for the SVG `<g data-view>` wrapper. */
export function viewTransform(view) {
	const v = view || { zoom: 1, panX: 0, panY: 0 };
	return `translate(${v.panX} ${v.panY}) scale(${v.zoom})`;
}

/** The viewport box a stale hardcoded app.js seam reports (never authoritative). */
export const FANTASY_VIEWPORT = Object.freeze({ width: 1200, height: 720 });

/** True for the hardcoded 1200x720 "fantasy" viewport app.js still injects. */
export function isFantasyViewport(vp) {
	return !!vp && vp.width === FANTASY_VIEWPORT.width && vp.height === FANTASY_VIEWPORT.height;
}

/**
 * Measure a real element's pixel box. Guarded: a fake/headless seam without
 * layout has no `getBoundingClientRect`/`clientWidth` and yields null, so the
 * pure fit/zoom math stays checkable without a DOM.
 */
export function measureViewport(element) {
	if (!element) return null;
	let width = 0;
	let height = 0;
	if (typeof element.getBoundingClientRect === "function") {
		const rect = element.getBoundingClientRect();
		width = rect?.width ?? 0;
		height = rect?.height ?? 0;
	}
	if ((!width || !height) && typeof element.clientWidth === "number") {
		width = element.clientWidth;
		height = element.clientHeight;
	}
	if (!width || !height) return null;
	return { width, height };
}

/**
 * The ONE authoritative viewport for fit/zoom math (issue #78).
 * <p>
 * FUNCTION_CONTRACT: Input — opts ({ viewport }), element (the SVG), fallback
 *   element (the region). Output — { width, height }. Guarantees: a real
 *   measured element box wins; the injected seam is consulted only when the
 *   element cannot be measured AND is not the hardcoded 1200x720 fantasy;
 *   the last resort is the same 1200x720 box. Raises: never.
 */
export function viewportOf(opts = {}, element = null, fallbackElement = null) {
	const measured = measureViewport(element) ?? measureViewport(fallbackElement);
	if (measured) return measured;
	if (typeof opts.viewport === "function") {
		const external = opts.viewport();
		if (external && external.width > 0 && external.height > 0 && !isFantasyViewport(external)) return { width: external.width, height: external.height };
	}
	return { ...FANTASY_VIEWPORT };
}

/** True for the untouched `initialView()` — the only state an auto-fit may replace. */
function isInitialView(view) {
	return !!view && view.zoom === 1 && view.panX === 0 && view.panY === 0;
}

/** Epsilon view equality (auto-fit re-entry guard — never loops). */
export function sameView(a, b) {
	return !!a && !!b && Math.abs(a.zoom - b.zoom) < 1e-9 && Math.abs(a.panX - b.panX) < 1e-9 && Math.abs(a.panY - b.panY) < 1e-9;
}

/** Parse an SVG `viewBox` ("minX minY width height") — null when malformed. */
export function parseViewBox(value) {
	const parts = String(value ?? "").trim().split(/[\s,]+/).map(Number);
	return parts.length === 4 && parts.every(Number.isFinite) ? { x: parts[0], y: parts[1], width: parts[2], height: parts[3] } : null;
}

/** Convert a CSS-pixel pointer offset into the viewBox USER units (#92): scale
 *  by the viewBox ratio and remove the `xMidYMid meet` letterbox gutters.
 *  Identity when the viewBox IS the element box; degenerate input never NaNs. */
export function cursorToUser(offsetX, offsetY, viewBox, box) {
	const ox = Number.isFinite(offsetX) ? offsetX : 0;
	const oy = Number.isFinite(offsetY) ? offsetY : 0;
	const vbW = Math.max(1, Number(viewBox?.width) || 0) || 1;
	const vbH = Math.max(1, Number(viewBox?.height) || 0) || 1;
	const boxW = Math.max(1, Number(box?.width) || 0) || vbW;
	const boxH = Math.max(1, Number(box?.height) || 0) || vbH;
	if (boxW === vbW && boxH === vbH) return { x: ox, y: oy };
	const scale = Math.min(boxW / vbW, boxH / vbH);
	return { x: (ox - (boxW - vbW * scale) / 2) / scale, y: (oy - (boxH - vbH * scale) / 2) / scale };
}

/** The drag-vs-click movement threshold (R5): a pointer must travel MORE
 *  than this many CSS pixels from its origin before the gesture becomes a
 *  pan — at or below it the gesture stays a click and select still fires. */
export const CLICK_DRAG_THRESHOLD_PX = 4;

/**
 * One pointer gesture's drag-vs-click state machine (R5). Pure bookkeeping
 * over injected coordinates: `down` opens a gesture, `move` returns the pan
 * delta ONLY once the pointer has travelled past the threshold (null
 * before), `up` closes the gesture and reports whether it ended a pan, and
 * `suppressesClick` stays true for the synthetic click that follows a pan
 * tail (cleared on the next `down`) — that click must not select.
 * FUNCTION_CONTRACT: Input — numeric client coordinates. Output — see above;
 *   never throws, no DOM access.
 */
export function dragGesture({ threshold = CLICK_DRAG_THRESHOLD_PX } = {}) {
	let origin = null;
	let last = null;
	let panning = false;
	let tail = false;
	return {
		down(x, y) {
			origin = last = { x, y };
			panning = false;
			tail = false;
		},
		move(x, y) {
			if (!origin) return null;
			if (!panning && Math.hypot(x - origin.x, y - origin.y) > threshold) panning = true;
			const delta = panning ? { dx: x - last.x, dy: y - last.y } : null;
			last = { x, y };
			return delta;
		},
		up() {
			tail = panning;
			origin = last = null;
			panning = false;
			return tail;
		},
		isPanning() {
			return panning;
		},
		suppressesClick() {
			return tail;
		},
	};
}

/** Wire the documented interactions onto a rendered canvas: wheel zoom
 *  (clamped, cursor-anchored IN USER UNITS, floored at the R5 reachability
 *  floor), THRESHOLDED drag pan, the fit affordance. A fake DOM without
 *  listeners is a no-op (the pure helpers stay checkable).
 *  FUNCTION_CONTRACT: Input — index (renderCanvas result), doc, opts
 *    ({ getView, onView, viewport }). Output — none. Never throws. */
export function attachCanvasControls(index, doc, opts = {}) {
	if (!index || !index.svg || typeof index.svg.addEventListener !== "function") return;
	const svg = index.svg;
	const root = index.root ?? null;
	const getView = opts.getView || (() => initialViewFallback());
	// Remeasure on every attach: the element box is the authoritative viewBox
	// (resize is picked up here), and a fresh SVG re-attaches after every render.
	const applyViewport = () => {
		const vp = viewportOf(opts, svg, root);
		if (typeof svg.setAttribute === "function") svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);
		return vp;
	};
	const vp = applyViewport();
	// First measured attach: fit once and persist via onView — only when the
	// view is untouched AND the fit actually changes it (never a loop).
	if (measureViewport(svg) && isInitialView(getView())) {
		const fitted = fitView(index.layout.bounds, vp);
		if (!sameView(fitted, getView())) opts.onView?.(fitted);
	}
	// R5: the wheel floor follows the fit — a fleet that only fits below 0.5×
	// keeps a wheel-out path back to the full fit (never trapped above it).
	const floorFor = () => zoomFloorFor(index.layout.bounds, viewportOf(opts, svg, root));
	on(svg, "wheel", (event) => {
		event?.preventDefault?.();
		const factor = event && event.deltaY < 0 ? 1.1 : 0.9;
		// #92: offsetX/offsetY are CSS pixels; zoomAt anchors in USER units.
		// Convert through the live viewBox + measured box before anchoring.
		const box = viewportOf(opts, svg, root);
		const vb = parseViewBox(typeof svg.getAttribute === "function" ? svg.getAttribute("viewBox") : null) ?? { x: 0, y: 0, width: box.width, height: box.height };
		const cursor = cursorToUser(event?.offsetX ?? 0, event?.offsetY ?? 0, vb, box);
		opts.onView?.(zoomAt(getView(), factor, cursor.x, cursor.y, floorFor()));
	});
	// R5: the drag threshold — sub-threshold pointer travel never pans, and a
	// gesture that panned suppresses its trailing click (canvas.js consults
	// the same gesture object via `index.gesture`).
	const gesture = index.gesture ?? dragGesture();
	index.gesture = gesture;
	on(svg, "pointerdown", (event) => {
		gesture.down(event?.clientX ?? 0, event?.clientY ?? 0);
	});
	on(svg, "pointermove", (event) => {
		const delta = gesture.move(event?.clientX ?? 0, event?.clientY ?? 0);
		if (delta) opts.onView?.(panBy(getView(), delta.dx, delta.dy));
	});
	on(svg, "pointerup", () => {
		gesture.up();
	});
	on(svg, "dblclick", () => opts.onView?.(fitView(index.layout.bounds, applyViewport())));
}

/** A defensive default view (the app always passes getView). */
function initialViewFallback() {
	return { zoom: 1, panX: 0, panY: 0 };
}

