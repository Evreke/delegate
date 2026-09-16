/**
 * pi-delegate — width-safe shared text helpers for UI rendering.
 * <p>
 * MODULE_CONTRACT: the ONE spelling of the width-safe text primitives every
 * UI surface shares — stripAnsi, visibleWidth, trunc, clampLines (and the
 * private charWidth they build on). This module is a LEAF: it imports nothing
 * from src/ (node/pi types only, and here it needs neither). Every other UI
 * module (fleet-widget, fleet-overlay, the status tool) imports these from
 * here; local duplicates were deleted (quality fix A7 — the former
 * triplication had DIVERGENT semantics under the same names).
 * Owned invariants (moved verbatim from the old fleet.ts SECTION 2/4):
 *   - line-width-clamping: clampLines is the single guard every TUI-rendered
 *     line must pass through — an over-wide line crashes the whole TUI with
 *     uncaughtException (the v1.8b field crash).
 *   - ONE trunc (visibleWidth-aware, wide-char safe), ONE stripAnsi.
 * Error modes: none thrown — pure string functions.
 */

/**
 * pi-delegate — shared text helpers for UI rendering (quality fix A7).
 *
 * ONE token-k spelling (usage.ts formatTokens — Wave 3 step 5 fold), ONE trunc (visibleWidth-aware, wide-char safe), ONE stripAnsi.
 * Previously these were triplicated with DIVERGENT semantics across
 * fleet.ts / observe.ts (status tool) (same names, different
 * output — e.g. formatTokens(836) was "836" in fleet.ts but "1k" in fleet-ui.ts).
 * All UI modules import from here; local duplicates were deleted.
 */

/** Strip ANSI escape sequences (CSI … final-byte) from a string. */
export function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Display width of a single code point: 2 for CJK/wide ranges, else 1. */
function charWidth(ch: string): number {
	const cp = ch.codePointAt(0) ?? 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		cp >= 0x20000
	) {
		return 2;
	}
	return 1;
}

/** Visible width of a string (ANSI-free; wide chars count as 2 columns). */
export function visibleWidth(s: string): number {
	let w = 0;
	for (const ch of stripAnsi(s)) w += charWidth(ch);
	return w;
}

/** Width-aware truncate with ellipsis (wide-char safe, ANSI-tolerant):
 *  the result's visible width never exceeds `w`. */
export function trunc(s: string, w: number): string {
	if (w <= 0) return "";
	if (visibleWidth(s) <= w) return s;
	let out = "";
	for (const ch of s) {
		if (visibleWidth(out) + charWidth(ch) > w - 1) break;
		out += ch;
	}
	return `${out}…`;
}

/** Clamp every rendered line to the width pi-tui passes to
 *  component.render(width). Over-wide transcript lines crash the whole TUI
 *  with uncaughtException "Rendered line N exceeds terminal width" — every
 *  custom render closure MUST route its lines through this (field crash
 *  2026-09-05: delegate heartbeat headline 150 > 139 killed pi). No-op when
 *  no width is known (headless/session replay). */
export function clampLines(lines: string[], width?: number): string[] {
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return lines;
	const w = Math.floor(width);
	return lines.map((l) => (visibleWidth(l) <= w ? l : trunc(l, w)));
}
