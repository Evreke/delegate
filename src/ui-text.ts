/**
 * pi-delegate — width-safe shared text helpers for UI rendering.
 * <p>
 * MODULE_CONTRACT: the ONE spelling of the width-safe text primitives every
 * rendering surface shares — stripAnsi, visibleWidth, trunc, clampLines,
 * renderDelegateLines (and the private charWidth/wrapLine they build on).
 * This module is a LEAF: it imports nothing from src/ (pi types only).
 * Consumers: the status tool, the delegate/mailbox tools' transcript
 * rendering; local duplicates were deleted (quality fix A7 — the former
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

// ---------------------------------------------------------------------------
// renderDelegateLines — delegate-family tool-result rendering (moved verbatim
// from the removed fleet-widget.ts; the ambient widget/overlay surfaces were
// removed with them — this is the functional part the tools consume).
// ---------------------------------------------------------------------------

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

interface FgTheme {
	fg?: (color: ThemeColor, text: string) => string;
}

/** herdr internals that must never appear in visible lines (details only). */
const HERD_ID_RE = /\b(?:terminal_id|pane_id|workspace_id)=[^\s,;)]+/gi;
const HERD_ID_PLACEHOLDER = "<herdr ids in details>";

/** Recoverable codes render as warning; the rest as error. */
const WARNING_CODES = new Set(["E_TIMEOUT", "E_PROMPT_STALLED"]);

/** Word-wrap at ~100 columns on spaces (plain-text details, ANSI-free input). */
function wrapLine(text: string, width = 100): string[] {
	const out: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (current.length === 0) {
			current = word;
		} else if (current.length + 1 + word.length <= width) {
			current += ` ${word}`;
		} else {
			out.push(current);
			current = word;
		}
	}
	if (current.length > 0) out.push(current);
	return out;
}

/**
 * Render one delegate-family tool result as themed lines for the transcript.
 * Rules: status-colored badge; E_* code as error/warning;
 * ONE-line verdict headline; herdr internals (terminal_id/pane_id/… patterns)
 * NEVER in the headline — caller still puts them in details. Returns lines.
 */
export function renderDelegateLines(
	toolName: string,
	resultText: string,
	theme: unknown,
): string[] {
	const th = theme as FgTheme;
	const fg = (color: ThemeColor, text: string): string =>
		th && typeof th.fg === "function" ? th.fg(color, text) : text;

	const allLines = (resultText ?? "").split("\n");
	const rawHeadline = allLines[0] ?? "";
	const detailText = allLines.slice(1).join(" ").trim();

	// Badge selection: AWAITING_ANSWER → warning; E_* → error/warning; else OK.
	let badge: string;
	if (/\bAWAITING_ANSWER\b/.test(rawHeadline)) {
		badge = fg("warning", "[AWAITING_ANSWER]");
	} else {
		const codeMatch = rawHeadline.match(/^E_[A-Z_]+/);
		if (codeMatch) {
			const code = codeMatch[0];
			badge = fg(WARNING_CODES.has(code) ? "warning" : "error", `[${code}]`);
		} else {
			badge = fg("success", "[OK]");
		}
	}

	// Headline: one line, herdr internals stripped (details carry them).
	const headline = rawHeadline.replace(HERD_ID_RE, HERD_ID_PLACEHOLDER);
	const lines = [`${fg("muted", `[${toolName}]`)} ${badge} ${headline}`];

	// Up to 3 wrapped detail lines, herdr internals stripped.
	if (detailText.length > 0) {
		const stripped = detailText.replace(HERD_ID_RE, HERD_ID_PLACEHOLDER);
		const wrapped = wrapLine(stripped).slice(0, 3);
		for (const w of wrapped) lines.push(fg("dim", `  ${w}`));
	}
	return lines;
}
