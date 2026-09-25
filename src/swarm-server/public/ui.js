/**
 * ui.js — the v1 dashboard's UI state reducer (issue #66, dashboard shell).
 *
 * ONE pure reducer for the screen's ephemeral state: the attention queue
 * overlay, the selection, the spotlight set the center canvas consumes, the
 * adaptive-collapse expansion set and the pan/zoom view. This state is
 * UI-STATE ONLY — it is never persisted and never written to the journal or
 * the exchange tree ("click expands in place, UI-state only").
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
		return { ...cur, overlay: cur.overlay === action.kind ? null : action.kind };
	}
	if (type === "dismiss-overlay") return { ...cur, overlay: null };
	if (type === "select-attention") {
		const ids = Array.isArray(action.item?.focusIds) ? action.item.focusIds : action.item?.nodeId ? [action.item.nodeId] : [];
		return { ...cur, overlay: null, selection: action.item?.nodeId ?? null, focusWorker: action.item?.worker ?? null, spotlight: new Set(ids) };
	}
	if (type === "select-node") {
		const ids = Array.isArray(action.spotlightIds) ? action.spotlightIds : [];
		return { ...cur, selection: action.id ?? null, focusWorker: action.focusWorker ?? null, spotlight: new Set(ids) };
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
