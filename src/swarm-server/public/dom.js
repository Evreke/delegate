/**
 * dom.js — the dashboard's minimal DOM seam (issue #66, dashboard shell).
 *
 * The renderers are handed a `doc`-like seam ({createElement, createTextNode})
 * so the same code runs in a browser and under the headless check's fake
 * document. No innerHTML, no framework — element creation and attribute
 * setting only, with event listeners attached only when the seam supports
 * them (a fake doc in a check simply does not).
 */

/** Create an element with attributes and optional text (a null attr is skipped). */
export function el(doc, tag, attrs, text) {
	const node = doc.createElement(tag);
	if (attrs) {
		for (const key of Object.keys(attrs)) {
			const value = attrs[key];
			if (value === undefined || value === null) continue;
			node.setAttribute(key, String(value));
		}
	}
	if (text !== undefined) node.appendChild(doc.createTextNode(String(text)));
	return node;
}

/** Attach a listener when the seam supports one (no-op on a fake doc). */
export function on(node, type, handler) {
	if (node && typeof node.addEventListener === "function") node.addEventListener(type, handler);
	return node;
}

/**
 * Render a status marker: color + shape + position LEFT of the name. The
 * marker is the FIRST child of its row, so document order alone guarantees
 * the position (CSS keeps it inline-left).
 */
export function renderStatusMarker(doc, view) {
	return el(doc, "span", {
		class: `status-marker ${view.className}${view.pulse ? " status-pulse" : ""}`,
		"data-status-marker": view.shape,
		"data-status": view.className.replace(/^status-/, ""),
		"data-shape": view.shape,
		"aria-hidden": "true",
	});
}

/** Render the degraded chips for one node (flag text verbatim, severity data). */
export function renderDegradedChips(doc, degraded) {
	const chips = [];
	for (const badge of Array.isArray(degraded) ? degraded : []) {
		chips.push(
			el(doc, "span", { class: `${badge.className}`, "data-degraded-flag": badge.flag, "data-severity": badge.severity }, badge.flag),
		);
	}
	return chips;
}

/** Render a severity chip (info / warn / crit) with the token verbatim. */
export function renderSeverityChip(doc, severity, text) {
	return el(doc, "span", { class: `severity severity-${severity}`, "data-severity": severity }, text);
}

/** Clear every child of a container (the renderers own their subtree). */
export function clear(root) {
	while (root && root.firstChild) root.removeChild(root.firstChild);
}
