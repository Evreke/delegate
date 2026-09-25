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
 *
 * The same strip surface ALSO owns the shell's honest notices: the
 * `scoping…` state while the serving identity is unknown (#81), the
 * role=alert error banner with its operation label/dismiss (#89) and the
 * per-region `loading` vs `cannot read` state (#89 — 'no data' is not
 * 'cannot read').
 */

import { el, on, renderSeverityChip } from "./dom.js";
import { DEGRADED_FLAGS, degradedGloss } from "./degrade.js";

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
		"aria-modal": "true",
		tabindex: "-1",
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
	// #90: the flags are jargon — a compact plain-language legend in the footer.
	const legend = el(doc, "div", { class: "attention-legend", "data-attention-legend": "1" });
	legend.appendChild(el(doc, "span", { class: "attention-legend-title" }, "flag legend"));
	for (const flag of DEGRADED_FLAGS) {
		legend.appendChild(el(doc, "span", { class: `attention-legend-item degraded-flag-${flag}`, "data-legend-flag": flag, title: degradedGloss(flag) }, `${flag} \u2014 ${degradedGloss(flag)}`));
	}
	overlay.appendChild(legend);
	// A click on the backdrop (not an item — items stop propagation) dismisses.
	on(overlay, "click", () => ctx.dispatch?.({ type: "dismiss-overlay" }));
	return overlay;
}

/**
 * Render the attention strip (and the overlay when open) into `root`.
 * <p>
 * FUNCTION_CONTRACT: Input — state (buildDashboardState output), root, doc,
 *   opts ({ dispatch, overlay, scoping }). Output — none (root mutated).
 * Guarantees: chips show the exact model counts (never a re-derivation);
 *   the queue is severity-ordered; an empty model renders the honest
 *   `all clear` chip; while the serving identity is unknown (`opts.scoping`,
 *   issue #81) the strip renders `scoping…` instead of counts that may
 *   retract. Raises: never on a well-formed model.
 */
export function renderAttention(state, root, doc, opts = {}) {
	while (root.firstChild) root.removeChild(root.firstChild);
	const attention = state?.attention;
	const scoping = opts.scoping === true;
	const ctx = { dispatch: opts.dispatch, overlay: opts.overlay ?? null };
	const strip = el(doc, "div", {
		class: "attention-strip",
		"data-attention-strip": "1",
		"data-clear": attention?.clear && !scoping ? "1" : "0",
		"data-scoping": scoping ? "1" : "0",
		role: "status",
		"aria-live": "polite",
		"aria-label": "attention summary",
	});
	if (scoping) {
		strip.appendChild(el(doc, "span", { class: "attention-scoping", "data-attention-scoping": "1" }, "scoping\u2026"));
	} else if (!attention || attention.clear) {
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

/**
 * Render the shell error banner (issue #89): `role=alert`, the operation
 * context label, the server envelope's code/message/hint and a dismiss
 * control. The banner is re-rendered on every failure and never latches —
 * the app clears it on the next successful read.
 * <p>
 * FUNCTION_CONTRACT: Input — node (#error), err (Error with optional
 *   op/code/hint), doc, opts ({ op?, onDismiss? }). Output — none (node
 *   mutated). Guarantees: a missing node is a no-op; never throws.
 */
export function renderErrorBanner(node, err, doc, opts = {}) {
	if (!node) return;
	node.setAttribute("role", "alert");
	while (node.firstChild) node.removeChild(node.firstChild);
	const add = (attrs, text) => node.appendChild(el(doc, "span", attrs, text));
	const label = opts.op || (err && err.op) || "dashboard";
	add({ class: "error-op", "data-error-op-label": label }, `${label}: `);
	if (err && err.code) add({ class: "error-code", "data-error-code": String(err.code) }, `${err.code}: `);
	add({ class: "error-message", "data-error-message": "1" }, `${(err && err.message) || err} `);
	if (err && err.hint) add({ class: "error-hint", "data-error-hint": "1" }, `${err.hint} `);
	const dismiss = el(doc, "button", { class: "error-dismiss", "data-error-dismiss": "1", type: "button", "aria-label": "dismiss error" }, "dismiss");
	on(dismiss, "click", () => opts.onDismiss && opts.onDismiss());
	node.appendChild(dismiss);
	node.removeAttribute("hidden");
}

/** Hide the error banner (issue #89 — auto-clear on the next successful read). */
export function clearErrorBanner(node) {
	if (node) node.setAttribute("hidden", "1");
}

/**
 * The per-region read-state view (issue #89): `no data` (a valid empty/absent
 * model) is NOT `cannot read` (a failed read). Pure.
 */
export function regionStateView(readError) {
	if (readError) return { state: "unavailable", text: "cannot read \u2014 the dashboard data is unavailable" };
	return { state: "loading", text: "loading\u2026" };
}

/** Render one region's read-state notice (a missing region is a no-op). */
export function renderRegionState(root, view, doc) {
	if (!root) return;
	while (root.firstChild) root.removeChild(root.firstChild);
	root.appendChild(el(doc, "div", { class: `region-state region-state-${view.state}`, "data-region-state": view.state, "data-region-unavailable": view.state === "unavailable" ? "1" : "0" }, view.text));
}

/** The chip labels in model order (used by the check). */
export function chipLabels(attention) {
	return (attention?.chips ?? []).map((chip) => chip.label);
}
