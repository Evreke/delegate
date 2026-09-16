/**
 * pi-delegate — src/herdr/map.ts (herdr-JSON → seam-type result mapping).
 *
 * MODULE_CONTRACT — one responsibility: turn herdr's JSON (CLI stdout
 * `.result` bodies and socket API payloads) into the seam's types, and encode/
 * decode the adapter's opaque placementRef. Extracted verbatim from
 * src/herdr/host.ts (ARCHITECTURE.md Law 5 decomposition); the
 * FUNCTION_CONTRACTs and BUG_FIX_CONTEXTs below moved with the code.
 *
 * Dependencies: the seam module ../host.ts (types + delegateError /
 * DelegateErrorImpl) and nothing else — NO herdr module import, so the mapper
 * layer stays a leaf inside the adapter and cannot create a cycle through the
 * transport (pinned by test/herdr-split-check.ts).
 *
 * Invariants carried over verbatim:
 *   - totality: every extractor is tolerant — missing/renamed herdr fields
 *     yield undefined (or the caller's fallback), never a throw; the only
 *     raises are the documented E_PLACE DelegateErrors for an unparseable
 *     placement result or a result missing the frozen workspace/pane ids
 *   - the herdr ids (pane_id / tab_id / workspace_id) are read ONLY here and
 *     in the adapter that consumes them: they never cross the seam
 *     (HerdrAgentStatus is the adapter-internal read model; the public read
 *     model carries the opaque placementRef only)
 *   - the frozen herdr field spellings (workspace.worktree.*, root_pane.pane_id,
 *     tab.tab_id, is_linked_worktree) are probed newest-first with the legacy
 *     spellings kept for older herdr builds
 */

import {
	type AgentStatus,
	type AgentStatusName,
	delegateError,
	DelegateErrorImpl,
	type Placement,
	type PlacementReq,
} from "../host.ts";

// ---------------------------------------------------------------------------
// placementRef codec (workerhost inversion, design §3/§4) — adapter-private.
// The ref format is herdr-internal; the seam only ever compares refs opaquely.
// ---------------------------------------------------------------------------

/** Synthesize the opaque placementRef for a herdr pane. Written into manifest
 *  records ALONGSIDE the legacy id fields (design §4: never delete legacy). */
function herdrRefFromPane(paneId: string): string {
	return `herdr:pane:${paneId}`;
}

/** herdrRefFromPane for possibly-absent ids: no pane id → undefined (no ref). */
function herdrRefOrNull(paneId: string | undefined): string | undefined {
	return paneId ? herdrRefFromPane(paneId) : undefined;
}

/** Decode a placementRef back to the herdr pane id. Accepts the current
 *  `herdr:pane:<paneId>` shape AND a raw pane id (legacy callers/tests that
 *  pass a bare id where a ref is expected) — anything else → undefined.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: ref — opaque placement reference (or legacy raw pane id)
 * Output: the herdr pane id, or undefined when the ref is not decodable
 * Guarantees: pure; never throws
 */
export function paneFromHerdrRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	const m = /^herdr:pane:(.+)$/.exec(ref);
	return m?.[1] || ref;
}

// ---------------------------------------------------------------------------
// Result mapping helpers
// ---------------------------------------------------------------------------

/** Placement enriched with the herdr tab id for teardown (transport-local extension). */
export type HerdrPlacement = Placement & { tabId?: string };

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function pick(root: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		const parts = key.split(".");
		let cur: unknown = root;
		let ok = true;
		for (const part of parts) {
			if (isRecord(cur) && part in cur) cur = cur[part];
			else { ok = false; break; }
		}
		if (ok && cur !== undefined && cur !== null) return cur;
	}
	return undefined;
}

export function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function extractAgentName(result: unknown, fallback: string): string {
	if (isRecord(result)) {
		const name = asString(pick(result, "name", "agent.name", "agent_name"));
		if (name) return name;
	}
	return fallback;
}

export function statusFromResult(result: unknown): AgentStatusName | undefined {
	return normalizeStatus(result);
}

/**
 * Single status normalizer for every herdr shape: `agent get`/`agent wait`
 * nest it at `agent.agent_status`, `agent list` entries carry top-level
 * `agent_status`, older shapes may use `status`.
 */
function normalizeStatus(node: unknown): AgentStatusName | undefined {
	if (!isRecord(node)) return undefined;
	const raw = asString(pick(node, "agent_status", "agent.agent_status", "status"));
	if (raw && ["idle", "working", "blocked", "done", "unknown"].includes(raw)) {
		return raw as AgentStatusName;
	}
	return undefined;
}

export function agentStatusFromResult(result: unknown, fallbackName: string): AgentStatus {
	if (!isRecord(result)) return { name: fallbackName, status: "unknown" };
	return {
		status: statusFromResult(result) ?? "unknown",
		// `agent list` entries: agent_name when present; `agent get`: name under result.agent.
		name: asString(pick(result, "name", "agent.name", "agent_name")) ?? fallbackName,
		// Seam read model carries ONLY the opaque ref (workerhost inversion,
		// design §3): herdr ids stay in the adapter (see herdrStatusFromResult).
		placementRef: herdrRefOrNull(
			asString(pick(result, "pane_id", "paneId", "agent.pane_id", "pane.pane_id")),
		),
	};
}

/**
 * Migration stage 3 (audit step 10): the drift-guard reconcile decision is a
 * pure exported function (behaviorally tested in static-check T3.3b — the
 * old T3.3 was a source-text regex over this file). The teardown call site
 * feeds it the recorded id and the live resolution; the decision stays here,
 * next to the adapter-internal id model.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - recordedTabId: the id the manifest placement carries (possibly the
 *     paneId fallback — the broken signature)
 *   - liveTabId: the real tab id from the herdr agent registry, or null when
 *     the agent is gone / statuses unavailable
 * Output: the tab id to close
 * Guarantees:
 *   - the broken signature (recorded === paneId) + a DIFFERENT live id → the
 *     live id (close the REAL tab, not the pane)
 *   - every other input → the recorded id unchanged (a missing live id must
 *     not turn a working close into a wrong-target close)
 * Raises: never
 */
export function reconcileTabClose(recordedTabId: string, liveTabId: string | null): string {
	return liveTabId !== null && liveTabId !== recordedTabId ? liveTabId : recordedTabId;
}

/** Adapter-internal read model: the seam AgentStatus PLUS the herdr ids the
 *  adapter itself needs (resolveLiveTabId drift guard, teardown reconcile).
 *  NEVER crosses the seam — herdr ids stop inside src/herdr/ (map.ts ↔ host.ts). */
export interface HerdrAgentStatus extends AgentStatus {
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
}

export function herdrStatusFromResult(result: unknown, fallbackName: string): HerdrAgentStatus {
	const base = agentStatusFromResult(result, fallbackName);
	if (!isRecord(result)) return base;
	return {
		...base,
		paneId: asString(pick(result, "pane_id", "paneId", "agent.pane_id", "pane.pane_id")),
		tabId: asString(pick(result, "tab_id", "tabId", "agent.tab_id", "tab.tab_id")),
		workspaceId: asString(pick(result, "workspace_id", "workspaceId", "agent.workspace_id", "workspace.workspace_id")),
	};
}

/** Strip the adapter-internal HerdrAgentStatus down to the seam read model
 *  (workerhost inversion, design §3: herdr ids never leave the adapter). */
export function stripToSeamStatuses(list: HerdrAgentStatus[]): AgentStatus[] {
	return list.map(({ paneId: _p, tabId: _t, workspaceId: _w, ...seam }) => seam);
}

/**
 * Extracts a worktree Placement (workspace/pane/branch/checkout) from a
 * parsed `herdr worktree create` result.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: result — parsed `herdr worktree create` result; req — the original
 *   placement request (branch fallback); raw — raw stdout for error text
 * Output: a worktree Placement (workspaceId, paneId, branch, checkoutPath,
 *   isLinkedWorktree)
 * Guarantees:
 *   - checkoutPath/branch fall back to the request values when herdr omits them
 * Raises:
 *   - DelegateErrorImpl E_PLACE for unparseable output or missing
 *     workspace_id/pane_id
 * EXTERNAL_DEPENDENCY: `herdr worktree create` result shape (frozen fields:
 *   workspace.worktree.*, root_pane.pane_id).
 */
export function placementFromWorktreeResult(
	result: unknown,
	req: PlacementReq,
	raw: string,
): Placement {
	if (!isRecord(result)) {
		throw delegateError("E_PLACE", `herdr worktree create returned unparseable output: ${truncate(raw)}`);
	}
	const workspaceId = asString(pick(result, "workspace.workspace_id", "workspace_id", "workspace.id"));
	const paneId = asString(pick(result, "root_pane.pane_id", "pane_id", "root_pane.id"));
	if (!workspaceId || !paneId) {
		throw delegateError(
			"E_PLACE",
			`herdr worktree create output missing workspace_id/pane_id: ${truncate(JSON.stringify(result))}`,
		);
	}
	const checkoutPath = asString(pick(result, "workspace.worktree.checkout_path", "checkout_path"))
		?? req.repoPath;
	return {
		kind: "worktree",
		workspaceId,
		paneId,
		branch: asString(pick(result, "workspace.worktree.branch", "branch")) ?? req.branch,
		checkoutPath,
		isLinkedWorktree: pick(result, "workspace.worktree.is_linked_worktree") === true,
		// Workerhost inversion (design §4): the opaque ref + backend tag ride
		// ALONGSIDE the legacy id fields (version-skew both ways — legacy fields
		// stay until a full 1.15.x cohort rotation).
		backend: "herdr",
		placementRef: herdrRefFromPane(paneId),
	};
}

/**
 * FUNCTION_CONTRACT:
 * Input: result — parsed `herdr tab create` result; workspaceId — the env-
 *   supplied current workspace; raw — raw stdout for error text
 * Output: a tab HerdrPlacement (paneId, tabId, checkoutPath = process.cwd())
 * Guarantees:
 *   - tabId falls back to paneId when herdr omits it
 *   - checkoutPath is the CURRENT session cwd (a tab shares the checkout)
 * Raises:
 *   - DelegateErrorImpl E_PLACE for unparseable output or missing root pane id
 * EXTERNAL_DEPENDENCY: `herdr tab create` result shape (frozen fields:
 *   tab.tab_id, root_pane.pane_id; legacy spellings tab.id/tab_id accepted);
 *   process.cwd() as the shared checkout.
 */
export function placementFromTabResult(
	result: unknown,
	workspaceId: string,
	raw: string,
): HerdrPlacement {
	if (!isRecord(result)) {
		throw delegateError("E_PLACE", `herdr tab create returned unparseable output: ${truncate(raw)}`);
	}
	const paneId = asString(pick(result, "root_pane.pane_id", "pane_id", "root_pane.id"));
	// BUG_FIX_CONTEXT (herdr drift, 2026-09-10): herdr renamed the tab-create
	// result key tab.id → tab.tab_id; the old probe list missed the new spelling
	// so the fallback recorded the PANE id as tabId — every later `tab close`
	// failed with tab_not_found (the pane id is not a tab id), which the retire
	// pass masked as an idempotent close while the agent stayed alive. The
	// current spelling is probed first; the legacy spellings stay for older herdr.
	const tabId = asString(pick(result, "tab.tab_id", "tab.id", "tab_id", "tabId")) ?? paneId;
	if (!paneId) {
		throw delegateError(
			"E_PLACE",
			`herdr tab create output missing root pane id: ${truncate(JSON.stringify(result))}`,
		);
	}
	return {
		kind: "tab",
		workspaceId,
		paneId,
		checkoutPath: process.cwd(),
		tabId,
		// Workerhost inversion (design §4): ref + backend tag ALONGSIDE legacy
		// fields (see placementFromWorktreeResult).
		backend: "herdr",
		placementRef: herdrRefFromPane(paneId),
	};
}

function truncate(s: string, max = 400): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
