/**
 * attention.js — the v1 attention strip + queue overlay (issue #66).
 *
 * The persistent strip is the answer to the constitution's question ("what
 * needs me?"): chips for `N asks waiting` / `N dead-reboot` / `N degraded`,
 * or an honest `all clear`. The aggregates are computed in state.js over OWN
 * fleets ONLY — a foreign fleet never raises attention, so the strip can
 * never nag about work this session cannot touch.
 *
 * Clicking a chip opens the severity-ordered queue overlay (absolute,
 * dismissed by a click outside it). Selecting an item dispatches
 * `select-attention`: the app moves the spotlight to the affected nodes
 * (the center dims the rest) and focuses the detail panel — never a screen
 * switch. This module is a pure view over the model.
 */

import { el, on, renderSeverityChip } from "./dom.js";

/** The queue items for one chip kind (severity order already folded). */
export function attentionItemsFor(attention, kind) {
	if (!attention) return [];
	if (!kind || kind === "clear") return attention.items.slice();
	return attention.items.filter((item) => item.kind === kind);
}

const CHIP_KINDS = ["ask", "dead-reboot", "degraded"];

function renderChip(doc, chip, ctx) {
	const button = el(doc, "button", {
		class: `attention-chip attention-chip-${chip.kind}`,
		"data-attention-chip": chip.kind,
		"data-count": chip.count,
		"data-active": ctx.overlay === chip.kind ? "1" : "0",
		type: "button",
	});
	button.appendChild(el(doc, "span", { class: "attention-count", "data-attention-count": chip.count }, String(chip.count)));
	button.appendChild(el(doc, "span", { class: "attention-label" }, chip.label));
	on(button, "click", () => ctx.dispatch?.({ type: "chip-click", kind: chip.kind }));
	return button;
}

function renderOverlay(doc, attention, kind, ctx) {
	const overlay = el(doc, "div", {
		class: "attention-overlay",
		"data-attention-overlay": kind || "all",
		role: "dialog",
		"aria-label": "attention queue",
	});
	overlay.appendChild(el(doc, "div", { class: "attention-overlay-title" }, `attention queue \u2014 ${kind || "all"}`));
	const list = el(doc, "div", { class: "attention-items", "data-attention-items": kind || "all" });
	const items = attentionItemsFor(attention, kind);
	if (items.length === 0) list.appendChild(el(doc, "div", { class: "attention-empty", "data-attention-empty": "1" }, "nothing here \u2014 the queue drained"));
	for (const item of items) {
		const row = el(doc, "button", {
			class: "attention-item",
			"data-attention-item": "1",
			"data-kind": item.kind,
			"data-severity": item.severity,
			"data-node-id": item.nodeId,
			"data-worker": item.worker,
			type: "button",
		});
		row.appendChild(renderSeverityChip(doc, item.severity, item.severity));
		row.appendChild(el(doc, "span", { class: "attention-item-label" }, item.label));
		if (item.detail) row.appendChild(el(doc, "span", { class: "attention-item-detail" }, item.detail));
		on(row, "click", (event) => {
			event?.stopPropagation?.();
			ctx.dispatch?.({ type: "select-attention", item });
		});
		list.appendChild(row);
	}
	overlay.appendChild(list);
	// A click on the backdrop (not an item — items stop propagation) dismisses.
	on(overlay, "click", () => ctx.dispatch?.({ type: "dismiss-overlay" }));
	return overlay;
}

/**
 * Render the attention strip (and the overlay when open) into `root`.
 * <p>
 * FUNCTION_CONTRACT: Input — state (buildDashboardState output), root, doc,
 *   opts ({ dispatch, overlay }). Output — none (root mutated).
 * Guarantees: chips show the exact model counts (never a re-derivation);
 *   the queue is severity-ordered; an empty model renders the honest
 *   `all clear` chip. Raises: never on a well-formed model.
 */
export function renderAttention(state, root, doc, opts = {}) {
	while (root.firstChild) root.removeChild(root.firstChild);
	const attention = state?.attention;
	const ctx = { dispatch: opts.dispatch, overlay: opts.overlay ?? null };
	const strip = el(doc, "div", {
		class: "attention-strip",
		"data-attention-strip": "1",
		"data-clear": attention?.clear ? "1" : "0",
	});
	if (!attention || attention.clear) {
		strip.appendChild(el(doc, "span", { class: "attention-clear", "data-attention-clear": "1" }, "all clear"));
	} else {
		for (const chip of attention.chips) {
			if (chip.kind === "clear") continue;
			if (!CHIP_KINDS.includes(chip.kind)) continue;
			strip.appendChild(renderChip(doc, chip, ctx));
		}
	}
	root.appendChild(strip);
	if (ctx.overlay) root.appendChild(renderOverlay(doc, attention, ctx.overlay, ctx));
}

/** The chip labels in model order (used by the check). */
export function chipLabels(attention) {
	return (attention?.chips ?? []).map((chip) => chip.label);
}
