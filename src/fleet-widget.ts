/**
 * pi-delegate — ambient fleet UI (the live-rows widget + tool-result
 * transcript rendering).
 * <p>
 * MODULE_CONTRACT: the ADVISORY ambient surface — the live-rows widget mounted
 * above the editor (mountFleetUI / renderLiveRows / foldLiveByOwnership /
 * disposeFleetUI), the idle nudge (notifyFleetIdle), the themed transcript
 * rendering of every delegate-family tool result (renderDelegateLines), and
 * the widget's row assembly (buildWidgetRows). Moved verbatim out of the old
 * fleet.ts SECTION 3/4 plus the widget's buildWidgetRows from SECTION 4/4.
 * Dependencies: ./ui-text.ts (width-safe clampLines/trunc), ./worker-view.ts
 * (WorkerView + the shared readManifestExtras), ./fleet.ts (ownership
 * classification — the display mapping only), exchange.ts (ping/progress
 * reads), usage.ts (token + context gauges), ./host.ts (the ONE 80% budget
 * warning fraction + CONTEXT_WARN_PCT), @earendil-works/pi-coding-agent TUI.
 * It imports NO fleet-overlay — widget and overlay are independent siblings.
 * Exported surface: FleetWidgetRow, FleetUIDeps, FleetFoldLine, mountFleetUI,
 * disposeFleetUI, renderLiveRows, foldLiveByOwnership, notifyFleetIdle,
 * renderDelegateLines, buildWidgetRows.
 * Owned invariants (moved verbatim):
 *   - every UI fn is INERT when the context has no UI (headless guard).
 *   - the fleet UI is ADVISORY: fs/transport read failures keep the last
 *     snapshot and never alter a spawn/collect/wake outcome.
 *   - the widget's 2 s interval is NOT cleared when the live set goes empty
 *     (only on dispose) so the widget can re-mount on the next spawn; the
 *     mount registry lives on globalThis so a double module load shares one
 *     registry (re-mount replaces, never stacks).
 *   - display fails CLOSED on ownership: a foreign/legacy live worker folds
 *     into at most one attention-gated summary line; a quiet foreign fleet
 *     renders nothing.
 *   - EVERY rendered line passes through clampLines/trunc (the v1.8b TUI
 *     crash guard).
 * Error modes: none thrown to callers — all failures degrade.
 */

import { basename } from "node:path";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { isProbeDir, progressPathFor, readLastProgress } from "./exchange.ts";
import { contextPct, formatTokens, parseSessionUsage, resolveContextWindow } from "./usage.ts";
import { BUDGET_WARN_FRACTION, CONTEXT_WARN_PCT } from "./host.ts";
import { clampLines, trunc } from "./ui-text.ts";
import { readManifestExtras, type WorkerView } from "./worker-view.ts";
import { classifyOwnership, type Ownership, type SelfIdentity } from "./fleet.ts";

/**
 * pi-delegate — ambient fleet UI.
 *
 * OWNERSHIP: contracts authored by the tech lead; implementation owned by
 * worker B6 (impl-ui). All functions MUST be inert when the context has no UI.
 *
 * Primitives (verified in pi docs/examples, Patterns 4/5/6):
 *   ctx.ui.setWidget(id, renderer, {placement})   — live rows above editor
 *   (setFooter REJECTED — it REPLACES pi's native footer (context %, model,
 *    cost, cwd): unacceptable. The placed-count chip was REMOVED entirely
 *    (confusing: global cross-session count, pessimistic burn) — v1.8.
 *    The live-rows widget is the only ambient surface.)
 *   ctx.ui.notify(msg, level)                     — nudges
 *   registerTool renderCall/renderResult          — themed transcript rendering
 *
 * Design choice (documented in report-impl-ui.json): the refresh interval is
 * NOT cleared when the live set goes empty (only on dispose) — clearing the
 * timer on empty would freeze the widget forever after
 * the first idle window (nothing would ever re-mount it when a new worker
 * spawns). Keeping the 2 s tick costs one cheap getRows() poll and lets the
 * widget reappear on the next spawn; the WIDGET is cleared on empty, the
 * FOOTER chip persists per the B6 contract.
 */


/** Data the UI needs per worker — supplied by the caller (observe.ts + usage.ts). */
export interface FleetWidgetRow {
	name: string;
	status: string;
	kind: string;
	branch?: string;
	reportExists?: boolean;
	isProbe?: boolean;
	inputTokens: number;
	outputTokens: number;
	budgetPct: number | null;
	lastPing?: { phase: string; pct?: number };
	/** Ownership class vs THIS session (v1.12.0). Absent (legacy callers)
	 *  degrades to the fold's legacy class — never rendered as mine. */
	ownership?: Ownership;
	/** Exchange task slug (manifest dir basename) — fold-line task list. */
	task?: string;
}

export interface FleetUIDeps {
	getRows(): Promise<FleetWidgetRow[]>;
}

// ---------------------------------------------------------------------------
// Module-level mount registry: /delegate-teardown restores the footer via
// disposeFleetUI() without needing the dispose handle that mountFleetUI
// returned (possibly in a different closure). Double-mount replaces — and the
// replace DISPOSES the old handle (never leaks). Wave 2 (Law 3): the registry
// lives on globalThis so a double module load (two copies of this module)
// still shares one registry — a re-mount replaces the previous widget instead
// of stacking a second one.
// ---------------------------------------------------------------------------

const FLEET_MOUNT_REGISTRY_KEY = "__piDelegateFleetMountDispose";

/** The currently mounted fleet UI's dispose (globalThis slot — shared across
 *  module copies; null when nothing is mounted). */
let activeDispose: (() => void) | null;
try {
	activeDispose = ((globalThis as unknown as Record<string, unknown>)[FLEET_MOUNT_REGISTRY_KEY] as
		| (() => void)
		| undefined) ?? null;
} catch {
	activeDispose = null;
}

/** Dispose the currently mounted fleet UI (widget cleared, default footer
 *  restored). Safe to call when nothing is mounted. */
export function disposeFleetUI(): void {
	const d = activeDispose;
	activeDispose = null;
	(globalThis as unknown as Record<string, unknown>)[FLEET_MOUNT_REGISTRY_KEY] = null;
	d?.();
}

// ---------------------------------------------------------------------------
// Shared formatting helpers live in this module (SECTION 2) (ONE token-k spelling via usage.ts formatTokens/ONE trunc/stripAnsi —
// quality fix A7); this module imports from there.
// ---------------------------------------------------------------------------

/** Minimal structural slice of Theme — renderDelegateLines must stay pure and
 *  unit-testable without importing the real Theme class. */
interface FgTheme {
	fg(color: ThemeColor, text: string): string;
}

const LIVE_STATUSES = new Set(["working", "blocked"]);
/** Budget burn at/above this percentage renders in the error color — derived
 *  from the ONE 80% spelling (host.ts BUDGET_WARN_FRACTION, Law 9). */
const BURN_ERROR_PCT = BUDGET_WARN_FRACTION * 100;

function isLive(row: FleetWidgetRow): boolean {
	return LIVE_STATUSES.has(row.status);
}

// ---------------------------------------------------------------------------
// mountFleetUI
// ---------------------------------------------------------------------------

/**
 * Mount the live fleet widget (only ambient surface). Idempotent: calling
 * twice replaces the previous mount. Starts a 2 s refresh interval that
 * renders live workers (working/blocked) as rows above the editor; the
 * widget clears when no live workers remain. Returns a dispose function
 * (clears timers + widget) — used by /delegate-teardown.
 */
export function mountFleetUI(ctx: ExtensionContext, deps: FleetUIDeps): () => void {
	// Headless guard: MUST work (no-op) when there is no UI.
	if (!ctx.hasUI || !ctx.ui) return () => {};

	// Idempotent double-mount: replace the previous mount.
	activeDispose?.();
	activeDispose = null;

	const WIDGET_KEY = "delegate-fleet";
	const REFRESH_MS = 2000;

	let rows: FleetWidgetRow[] = [];
	let widgetShown = false;
	let disposed = false;
	let tuiRef:
		| { requestRender(force?: boolean): void; terminal?: { columns?: number } }
		| undefined;

	const showWidget = (): void => {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui;
				return {
					// v1.8b: clamp to the width pi-tui passes — over-wide widget lines
					// crash the TUI (same failure shape as transcript lines).
					render: (width?: number) =>
						clampLines(
							renderLiveRows(rows, theme, (tui as { terminal?: { columns?: number } } | undefined)?.terminal?.columns ?? width),
							width,
						),
					invalidate: () => {},
				};
			},
			{ placement: "aboveEditor" },
		);
		widgetShown = true;
	};

	const refresh = async (): Promise<void> => {
		if (disposed) return;
		try {
			rows = await deps.getRows();
		} catch {
			// keep last snapshot on read failure — the UI is advisory
			return;
		}
		if (disposed) return;
		const live = rows.filter(isLive);
		if (live.length === 0 && widgetShown) {
			// EMPTY live set → live-rows widget cleared; chip widget tracks placed count.
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			widgetShown = false;
		} else if (live.length > 0 && !widgetShown) {
			showWidget();
		}
		tuiRef?.requestRender();
	};

	void refresh();
	const timer = setInterval(() => {
		void refresh();
	}, REFRESH_MS);

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		clearInterval(timer);
		if (ctx.hasUI && ctx.ui) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			// Defensive: restore the native footer if any older build replaced it.
			ctx.ui.setFooter(undefined);
		}
		if (activeDispose === dispose) {
			activeDispose = null;
			(globalThis as unknown as Record<string, unknown>)[FLEET_MOUNT_REGISTRY_KEY] = null;
		}
	};
	activeDispose = dispose;
	(globalThis as unknown as Record<string, unknown>)[FLEET_MOUNT_REGISTRY_KEY] = dispose;
	return dispose;
}

/** Themed live rows: `▲ name status ↑in ↓out P% [ping: phase]` — clamped to width.
 *  Ownership policy (v1.12.0, attention-gated fold): MY live workers render
 *  exactly as before (byte-identical lines); foreign/legacy live workers are
 *  FOLDED into at most one summary line PER CLASS (≤2 total), and a class
 *  line appears IFF at least one worker in that class is `blocked` OR at
 *  `ctx% ≥ CONTEXT_WARN_PCT` — a quiet foreign fleet renders NOTHING above
 *  the editor. Pure and unit-testable (test/ownership-check.ts). */
export function renderLiveRows(rows: FleetWidgetRow[], theme: Theme, width?: number): string[] {
	const live = rows.filter(isLive);
	if (live.length === 0) return [];
	const mine = live.filter((r) => r.ownership === "mine");
	const maxW = width && width > 20 ? width - 1 : undefined;
	const lines = mine.map((r) => {
		const pct = typeof r.budgetPct === "number" ? `${r.budgetPct}%` : "?";
		const ping = r.lastPing ? ` [ping: ${r.lastPing.phase}]` : "";
		const line = `▲ ${r.name} ${r.status} ↑${formatTokens(r.inputTokens)} ↓${formatTokens(r.outputTokens)} ${pct} of budget${ping}`;
		// Budgets ≥80% burn override the status color with error.
		const color: ThemeColor =
			typeof r.budgetPct === "number" && r.budgetPct >= BURN_ERROR_PCT
				? "error"
				: r.status === "blocked"
					? "warning"
					: "accent";
		return theme.fg(color, maxW ? trunc(line, maxW) : line);
	});
	for (const fold of foldLiveByOwnership(live)) lines.push(theme.fg(fold.color, fold.text));
	return lines;
}

/** One folded summary line: pre-colored text + its theme color. */
export interface FleetFoldLine {
	text: string;
	color: ThemeColor;
}

/** Fold-line shape per non-mine class: `○ N foreign live (task1, task2)`
 *  (muted) / `◌ N legacy live (…)` (dim). Task list = unique task slugs of
 *  that class's LIVE workers. */
const FOLD_CLASSES: Array<{
	cls: Exclude<Ownership, "mine">;
	glyph: string;
	label: string;
	color: ThemeColor;
}> = [
	{ cls: "foreign", glyph: "○", label: "foreign", color: "muted" },
	{ cls: "unknown", glyph: "◌", label: "legacy", color: "dim" },
];

/**
 * Attention-gated widget fold (pure): the foreign/legacy summary lines for a
 * LIVE set, at most one per class (≤2 lines total). A class line appears IFF
 * at least one of its live workers is `blocked` or sits at/above
 * CONTEXT_WARN_PCT context burn — no signals → no line (a quiet foreign
 * fleet costs the widget NOTHING). Uses only row data: no fs reads, no
 * mailbox joins. Fold lines are short by construction and the widget render
 * routes every line through clampLines (v1.8b TUI-crash guard).
 */
export function foldLiveByOwnership(live: FleetWidgetRow[]): FleetFoldLine[] {
	const lines: FleetFoldLine[] = [];
	for (const { cls, glyph, label, color } of FOLD_CLASSES) {
		const rows = live.filter((r) => (r.ownership ?? "unknown") === cls);
		if (rows.length === 0) continue;
		const attention = rows.some(
			(r) =>
				r.status === "blocked" ||
				(typeof r.budgetPct === "number" && r.budgetPct >= CONTEXT_WARN_PCT),
		);
		if (!attention) continue;
		const tasks = [...new Set(rows.map((r) => r.task).filter((t): t is string => typeof t === "string" && t.length > 0))];
		const list = tasks.length > 0 ? ` (${tasks.join(", ")})` : "";
		lines.push({ text: `${glyph} ${rows.length} ${label} live${list}`, color });
	}
	return lines;
}

// ---------------------------------------------------------------------------
// notifyFleetIdle
// ---------------------------------------------------------------------------

/** Fire the teardown nudge: ctx.ui.notify when the fleet just went idle. */
export function notifyFleetIdle(ctx: ExtensionContext, placedCount: number): void {
	if (!ctx.hasUI || !ctx.ui) return; // headless → no-op
	if (placedCount <= 0) return;
	ctx.ui.notify(`fleet idle — /delegate-teardown to clean up ${placedCount} tabs`, "info");
}

// ---------------------------------------------------------------------------
// renderDelegateLines — pure, unit-testable
// ---------------------------------------------------------------------------

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

/**
 * Build the ambient widget's rows (Wave 2, Law 9 — ONE row assembly): the
 * verbatim move of the former inline mapping in index.ts's FleetUIDeps.getRows
 * (that copy is deleted). Field-by-field behavior is IDENTICAL to the old
 * widget path: isProbe comes from isProbeDir(dir) (the overlay's buildRow
 * derives it from extras.briefPath === "" — a documented difference, both
 * pinned by their own checks); budgetPct stays nullable (the overlay coerces
 * to 0); lastPing degrades to undefined on read failure.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - views: worker views (as produced by buildWorkerView)
 *   - self: THIS session's identity (ownership classification — fail-closed)
 * Output: one FleetWidgetRow per view, same order
 * Guarantees:
 *   - never throws: manifest reads, session-usage parses and ping reads all
 *     degrade (absent extras → zero gauges, no ping marker)
 *   - read-only: manifest + session JSONL + ping file reads only
 * Raises: none
 * EXTERNAL_DEPENDENCY: manifest.json, worker session JSONLs and
 *   p-<name>.jsonl pings under the exchange dirs (via readManifestExtras /
 *   parseSessionUsage / readLastProgress).
 */
export async function buildWidgetRows(views: WorkerView[], self: SelfIdentity): Promise<FleetWidgetRow[]> {
	return Promise.all(
		views.map(async (v) => {
			const extras = await readManifestExtras(v.dir, v.name);
			const usage = parseSessionUsage(extras.sessionPath ?? "");
			const window = resolveContextWindow(extras.model);
			let lastPing: FleetWidgetRow["lastPing"];
			try {
				lastPing = readLastProgress(progressPathFor(v.dir, v.name)) ?? undefined;
			} catch {
				lastPing = undefined; // advisory — absent ping → no marker
			}
			return {
				name: v.name,
				status: v.status,
				kind: v.kind,
				branch: v.branch,
				reportExists: v.reportExists,
				isProbe: isProbeDir(v.dir),
				inputTokens: usage.input,
				outputTokens: usage.output,
				budgetPct: contextPct(usage, window),
				lastPing,
				ownership: classifyOwnership(
					extras.orchestratorSessionPath,
					self,
					v.placement,
					extras.masterSessionPath,
				),
				task: basename(v.dir),
			};
		}),
	);
}
