/**
 * ui.js — the v1 dashboard's UI state reducer (issue #66, dashboard shell).
 *
 * ONE pure reducer for the screen's ephemeral state: the attention queue
 * overlay, the selection, the spotlight set the center canvas consumes, the
 * adaptive-collapse expansion set and the pan/zoom view. This state is
 * UI-STATE ONLY — it is never persisted and never written to the journal or
 * the exchange tree ("click expands in place, UI-state only").
 *
 * SELECTION AND SPOTLIGHT ARE DECOUPLED (canvas-intent round, R1): a node
 * click SELECTS (a visible canvas stroke) and never dims anything; the
 * spotlight is set ONLY by `select-attention` (the attention queue) and is
 * cleared by every other attention or selection action — `dismiss-overlay`
 * (Escape / outside click), `chip-click` (chip toggle) and `select-node`.
 * Invariant: the spotlight is non-empty only while the last attention
 * interaction opened it; nothing else can leave the canvas dimmed.
 *
 * `uiReducer` is total: an unknown action is a no-op returning the input
 * state. Nothing here touches the DOM, so the check drives the interaction
 * contract headlessly and the renderers stay thin.
 */

import { initialView } from "./layout.js";

/** The initial UI state (nothing selected, nothing spotlit, nothing open). */
export function createUiState() {
	return {
		overlay: null,
		selection: null,
		focusWorker: null,
		spotlight: new Set(),
		expansion: new Set(),
		view: initialView(),
		detailTab: "console",
	};
}

/**
 * Fold one UI action.
 * <p>
 * FUNCTION_CONTRACT: Input — state (createUiState), action ({type, ...}).
 * Output — the next state (a new object). Total: an unknown action is a
 * no-op. Never throws.
 */
export function uiReducer(state, action) {
	const cur = state && typeof state === "object" ? state : createUiState();
	const type = action && action.type;
	if (type === "chip-click") {
		// R1: a chip toggle ends the attention interaction — the spotlight dies
		// with it (opening another queue starts clean, never pre-dimmed).
		return { ...cur, overlay: cur.overlay === action.kind ? null : action.kind, spotlight: new Set() };
	}
	if (type === "dismiss-overlay") return { ...cur, overlay: null, spotlight: new Set() };
	if (type === "select-attention") {
		const ids = Array.isArray(action.item?.focusIds) ? action.item.focusIds : action.item?.nodeId ? [action.item.nodeId] : [];
		return { ...cur, overlay: null, selection: action.item?.nodeId ?? null, focusWorker: action.item?.worker ?? null, spotlight: new Set(ids) };
	}
	if (type === "select-node") {
		// R1: selection carries no spotlight — a click selects (canvas stroke)
		// and any live attention spotlight is released, never replaced.
		return { ...cur, selection: action.id ?? null, focusWorker: action.focusWorker ?? null, spotlight: new Set() };
	}
	if (type === "toggle-collapse") {
		const expansion = new Set(cur.expansion);
		if (expansion.has(action.leadId)) expansion.delete(action.leadId);
		else expansion.add(action.leadId);
		return { ...cur, expansion };
	}
	if (type === "view") return { ...cur, view: action.view ?? cur.view };
	if (type === "detail-tab") return { ...cur, detailTab: action.tab ?? cur.detailTab };
	return cur;
}
