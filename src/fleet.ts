/**
 * pi-delegate — fleet presentation layer: worker ownership classification
 * (the one responsibility this module owns outright) plus the re-export facade
 * for the fleet UI modules it was decomposed into.
 * <p>
 * MODULE_CONTRACT (Law 5 execution — the old 1821-line parking lot is now a
 * set of single-responsibility modules; this file keeps ONLY ownership and
 * re-exports the layers that sit below it in the DAG):
 *   - OWNED HERE — worker ownership classification (the former SECTION 1/4):
 *     classifyOwnership, OWNERSHIP_GLYPH, Ownership, SelfIdentity,
 *     OwnershipPlacement, OwnershipOptions. A display mapping over the
 *     canonical verdict in src/watch-role.ts — the UI keeps NO ownership
 *     semantics of its own. Pure: no fs, no transport, no theme.
 *   - MOVED OUT (each now carries its own MODULE_CONTRACT):
 *       · SECTION 2/4 shared text helpers → ./ui-text.ts (a leaf).
 *       · SECTION 5/5 worker-view aggregation + SECTION 4's manifest-extras
 *         reader → ./worker-view.ts (the single shared read-model).
 *       · SECTION 3/4 ambient widget + tool-result transcript rendering +
 *         buildWidgetRows → ./fleet-widget.ts.
 *       · SECTION 4/4 /delegate-fleet full-screen overlay → ./fleet-overlay.ts.
 *   - RE-EXPORT FACADE — the two layers below ownership that carry no fleet
 *     semantics of their own (./ui-text.ts text primitives and ./worker-view.ts
 *     read-model) are re-exported here so existing importers keep resolving
 *     them under the fleet.ts name. The widget and overlay are NOT re-exported
 *     (they are the top of the fleet layering and import ownership FROM here —
 *     re-exporting them would re-form a cycle); importers consume them from
 *     ./fleet-widget.ts / ./fleet-overlay.ts directly.
 * DAG (Law 6): ui-text is a leaf; worker-view imports no fleet module; widget
 * and overlay are independent siblings that each import {ui-text, worker-view,
 * fleet(ownership)} only; fleet.ts imports only watch-role (for the verdict)
 * and re-exports {ui-text, worker-view} — it never imports widget/overlay. The
 * observe→fleet edge stays one-way and no fleet module imports observe.ts.
 * Owned invariant (display fails CLOSED on ownership): a marker is a claim,
 * and an unknown worker must never render as "mine" (●) in either direction of
 * missing data (classifyOwnership + OWNERSHIP_GLYPH).
 * Error modes: none thrown — classifyOwnership is a pure total function.
 */

import { workerAudienceMatch } from "./watch-role.ts";

// ===========================================================================
// worker ownership classification
// (the responsibility this module owns; verbatim from the old SECTION 1/4 —
//  its review-verified header comment is preserved)
// ===========================================================================

/**
 * pi-delegate — worker ownership classification (fleet-UX wave 2, stage 1).
 *
 * Mirror of the watcher's ownership rule (observe.ts isSelf /
 * detectWorkerEvents): a worker is MINE iff the manifest's
 * `orchestratorSessionPath` equals THIS session's JSONL path. Legacy manifests
 * carry no such field → ownership UNKNOWN.
 *
 * DELIBERATE ASYMMETRY vs the watcher — RETIRED: the watcher no longer fails
 * OPEN. Watcher stage A reversed that to fail-closed; src/watch-role.ts is
 * the canonical role/ownership table — do not re-derive the watcher's
 * behavior from this display-side comment. DISPLAY fails CLOSED — a marker
 * is a claim, and an unknown worker must
 * never render as "mine" (●) in either direction of missing data:
 *   - manifest edge: no `orchestratorSessionPath` → UNKNOWN (legacy).
 *   - self edge: no session file → exact comparison impossible → UNKNOWN,
 *     with ONE fallback mirroring the (removed) observe.ts mount equivalent:
 *     a worktree worker whose unique `placement.checkoutPath` equals this
 *     session's cwd is MINE (checkout paths are per-worker; tab workers
 *     share the repo cwd and are NEVER matched by it — they stay UNKNOWN).
 *     Stage C note: the MOUNT gate no longer accepts this equivalent (its
 *     identity is the entry's own sessionPath only) — this fallback remains
 *     DISPLAY-ONLY for the degraded-self-id worktree corner and never feeds
 *     delivery.
 *
 * Pure function: no fs, no transport, no theme — unit-tested in
 * test/ownership-check.ts.
 */

/** Ownership class of one worker, as seen from THIS session. */
export type Ownership = "mine" | "foreign" | "unknown";

/** This session's identity (same shape as observe.ts SelfIdentity). */
export interface SelfIdentity {
	/** This session's JSONL path (ctx.sessionManager.getSessionFile()). */
	sessionFile?: string;
	/** This session's cwd (ctx.cwd). */
	cwd?: string;
}

/** The placement slice classification needs (structurally satisfied by
 *  transport.ts Placement). */
export interface OwnershipPlacement {
	kind?: string;
	checkoutPath?: string;
}

/**
 * Watcher stage A options shape, accepted for parity with the canonical
 * verdict helper (src/watch-role.ts workerAudienceMatch). Display is
 * INVARIANT to legacyFailOpen: a no-owner worker renders unknown whether the
 * delivery edge is open or closed — the flag is a delivery concern only.
 */
export interface OwnershipOptions {
	legacyFailOpen?: boolean;
}

/**
 * Classify one worker's ownership from the manifest's recorded owner session
 * paths, this session's identity, and the worker's placement.
 *
 * Watcher stage A: this is now a DISPLAY MAPPING over the canonical verdict
 * (workerAudienceMatch in src/watch-role.ts) — the UI keeps NO ownership
 * semantics of its own (watch-role.ts role table: a "UI says foreign but
 * the wake left" mismatch is a defect; the display uses the same owner rules
 * without its own fail-open). Signature note: the canonical verdict reads
 * the manifest-level masterSessionPath too (the B1 fallback) — hence the
 * fourth parameter, which older call sites omit.
 *
 * Verdict → display mapping:
 * - "mine" → "mine"; "foreign" → "foreign".
 * - "no-owner" / "no-self-id" → "unknown", EXCEPT one DISPLAY-ONLY
 *   fallback: no owner field + no self.sessionFile + worktree placement
 *   whose checkoutPath === cwd → "mine". This fallback is a display
 *   convenience for the degraded-self-id worktree corner (the mount gate
 *   dropped the same equivalent in the stage C fix — identity by cwd is
 *   ambiguous); it NEVER feeds delivery — a degraded self-id delivers
 *   nothing in observe.ts, unconditionally (fail-closed — ARCHITECTURE.md
 *   Law 8). Tab workers
 *   are never matched by cwd → "unknown".
 */
export function classifyOwnership(
	orchestratorSessionPath: string | undefined,
	self: SelfIdentity,
	placement: OwnershipPlacement,
	masterSessionPath?: string,
	_opts?: OwnershipOptions,
): Ownership {
	const verdict = workerAudienceMatch(
		{ orchestratorSessionPath, masterSessionPath },
		self,
		{ legacyFailOpen: false },
	);
	if (verdict === "mine") return "mine";
	if (verdict === "foreign") return "foreign";
	// DISPLAY-ONLY fallback (never feeds delivery — see the doc above): the
	// degraded-self-id worktree corner.
	if (
		self.sessionFile === undefined &&
		placement?.kind === "worktree" &&
		self.cwd !== undefined &&
		typeof placement.checkoutPath === "string" &&
		placement.checkoutPath === self.cwd
	) {
		return "mine";
	}
	return "unknown"; // no-owner / no-self-id without the display fallback
}

/** Overlay/widget glyph for an ownership class — all 1 terminal column
 *  (U+25CF/U+25CB/U+25CC are outside text.ts charWidth's wide ranges). */
export const OWNERSHIP_GLYPH: Record<Ownership, string> = {
	mine: "●",
	foreign: "○",
	unknown: "◌",
};

// ===========================================================================
// re-export facade — the layers below ownership (Law 5: importers of the old
// monolith keep resolving these under ./fleet.ts; widget/overlay are consumed
// from their own modules and are deliberately NOT re-exported here).
// ===========================================================================

export { stripAnsi, visibleWidth, trunc, clampLines } from "./ui-text.ts";
export {
	buildWorkerView,
	readManifestExtras,
	type WorkerView,
	type ManifestExtras,
} from "./worker-view.ts";
