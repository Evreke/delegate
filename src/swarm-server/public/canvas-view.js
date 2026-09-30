/**
 * canvas-view.js — the canvas VIEW vocabulary (issue #78, #92, #137/AC8).
 *
 * Extracted from canvas.js (Law 5: the drag fix crossed the size cap). PURE
 * helpers, no painting: the one-coordinate-space math (the element pixel box
 * is the viewBox; the inner `<g data-view>` transform owns pan/zoom), the
 * user-unit cursor conversion, and the render-persistent drag gesture with
 * its 4px drag-vs-click threshold. Everything here is headless-checkable — a
 * fake DOM without measurement just yields the fallbacks.
 */

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
export function isInitialView(view) {
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

/**
 * The render-persistent drag gesture (#137/AC8): ONE record per canvas that
 * OUTLIVES every render. The pointer handlers (attachCanvasControls) write it;
 * the node click handlers (renderNodeGroup) read `dragged` — so a mid-drag
 * re-render (a data snapshot rebuilding the SVG) neither resets the pan nor
 * resurrects the suppressed trailing click. The app owns the record and hands
 * the SAME object to renderCanvas and attachCanvasControls.
 */
export function createDragGesture() {
	return { start: null, dragging: null, dragged: false };
}

/** The drag-vs-click threshold in CSS px: a gesture that travelled further
 *  than this is a PAN, and its trailing click must never select (AC8). */
export const DRAG_THRESHOLD_PX = 4;

/**
 * The pure drag-vs-click decision (headless-checkable): true only when the
 * pointer travelled STRICTLY more than `thresholdPx` from the pointerdown
 * start. Degenerate input (either point missing) is a click, never a drag.
 * FUNCTION_CONTRACT: Input — start {x,y}, end {x,y}, thresholdPx (=4).
 * Output — boolean. Raises: never.
 */
export function isDragGesture(start, end, thresholdPx = DRAG_THRESHOLD_PX) {
	if (!start || !end) return false;
	const dx = (end.x ?? 0) - (start.x ?? 0);
	const dy = (end.y ?? 0) - (start.y ?? 0);
	return Math.hypot(dx, dy) > thresholdPx;
}
