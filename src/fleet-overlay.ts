/**
 * pi-delegate — /delegate-fleet mission-control overlay.
 * <p>
 * MODULE_CONTRACT: the full-screen read-only overlay (openFleetOverlay +
 * FleetOverlay) and its pure, headless-testable skin — row model (FleetRow,
 * buildRow), the theme-free column fitter (layoutFleetRows / fitRow /
 * fleetUsageOf / FLEET_FLOORS), the ownership/task grouping + fold engine
 * (groupWorkerViews / rankGroups / groupHeaderText / groupFoldedText /
 * megaFoldedText / isFleetStale / fleetAgeText / packLegend / renderFleet) and
 * the module-level Tab fold state. Moved verbatim out of the old fleet.ts
 * SECTION 4/4; the manifest-extras reader and buildWidgetRows that once sat in
 * this section now live in worker-view.ts and fleet-widget.ts respectively.
 * Dependencies: ./ui-text.ts (trunc/visibleWidth), ./worker-view.ts
 * (buildWorkerView + the shared readManifestExtras + WorkerView/ManifestExtras
 * types), ./fleet.ts (ownership classification + glyph — display mapping
 * only), exchange.ts (overlay-empty message root), mailbox-store.ts (the ONE
 * mailbox-state reader), expaths.ts (taskSlug), usage.ts (usage gauges + the
 * shared staleness constant), ./host.ts (CONTEXT_WARN_PCT + the Transport
 * seam), @earendil-works/pi-coding-agent TUI. It imports NO fleet-widget —
 * widget and overlay are independent siblings.
 * Exported surface: FleetDeps, FleetRow, FleetLayoutRow, FleetLayout,
 * FLEET_FLOORS, fleetUsageOf, layoutFleetRows, fitRow, GroupStatsRow,
 * GroupClass, WorkerGroup, MEGA_GROUP_LIMIT, FLEET_STALE_AFTER_MS,
 * groupWorkerViews, rankGroups, groupHeaderText, isFleetStale, fleetAgeText,
 * groupFoldedText, megaFoldedText, fleetFoldToggle, fleetFoldUnfolded,
 * FleetRenderInput, packLegend, renderFleet, openFleetOverlay.
 * Owned invariants (moved verbatim):
 *   - the overlay is strictly READ-ONLY: fs reads + transport.listStatuses
 *     only; timers cleared on close AND dispose.
 *   - display fails CLOSED on ownership (unknown never renders as mine).
 *   - FLEET_STALE_AFTER_MS is a transparent alias of the ONE stale threshold
 *     IMPORTED from usage.ts (WATCH_DEFAULT_STALE_AFTER_MS) — never copied.
 *   - EVERY rendered line passes through fitRow → visibleWidth ≤ innerW (the
 *     v1.8b TUI crash guard); the height window is group-atomic and
 *     stale-aware (fresh blocks fill first).
 *   - the foreign/unknown fold is session-scoped module state (survives
 *     overlay close/reopen, resets on restart, never persisted).
 * Error modes: none thrown to callers — all fs/transport failures degrade to
 * the last snapshot.
 */

import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { exchangeRoot } from "./exchange.ts";
import { mailboxAnswerState } from "./mailbox-store.ts";
import { taskSlug } from "./expaths.ts";
import {
	contextPct,
	formatTokens,
	parseSessionUsage,
	resolveContextWindow,
	WATCH_DEFAULT_STALE_AFTER_MS,
} from "./usage.ts";
import { CONTEXT_WARN_PCT, type Transport } from "./host.ts";
import { trunc, visibleWidth } from "./ui-text.ts";
import { buildWorkerView, readManifestExtras, type WorkerView, type ManifestExtras } from "./worker-view.ts";
import { classifyOwnership, OWNERSHIP_GLYPH, type Ownership, type SelfIdentity } from "./fleet.ts";

/**
 * pi-delegate — `/delegate-fleet` mission-control overlay.
 *
 * OWNERSHIP: worker F2 (impl-fleet); stage 2 (tree + fold) on top.
 *
 * Full-screen read-only overlay: one row per known worker, refreshed every
 * 2s. Strictly read-only — the only side effects are fs READS (manifests,
 * report/q/a existence checks, session JSONL usage parsing) and the
 * read-only transport.listStatuses() inside buildWorkerView(). No mutating
 * herdr calls, no mailbox writes, no timers left behind (interval is
 * cleared on close AND on dispose).
 *
 * STAGE 2 (fleet-UX wave 2): rows group by `manifest.dir ::
 * orchestratorSessionPath` (report-ux-tree.json). MINE rows render FLAT
 * exactly as stage 1 (zero single-session regression). FOREIGN/UNKNOWN
 * groups render an expanded dim header `▼ slug · live/total live · owner ·
 * ctx↑max%` with inline tree glyphs in the name column, and FOLD by default
 * to a self-describing line `~ <class> <slug> · N workers · counts… ·
 * idle <age>` (fleet-UX wave 4 retired the letter-flag alphabet `xN -- L B
 * ! Q v s` — counts are words, the stale `s` condition became an age tail
 * with an ownership-scoped remedy); Tab (0x09) toggles
 * (§4 exact: module-level session-scoped boolean, folded first-open
 * default, no-op when nothing foldable). Per-group sort replaces the
 * global status sort, with fully-stale groups demoted (wave 4); the height
 * window is group-atomic and stale-aware (fresh blocks trim first). All of
 * it is pure (groupWorkerViews/rankGroups/groupHeaderText/groupFoldedText/
 * megaFoldedText/renderFleet) and unit-tested headless in
 * test/fleet-tree-check.ts. The widget (fleet-ui.ts) is untouched.
 */

/** How often the overlay re-renders (poll buildWorkerView + fs state). */
const REFRESH_MS = 2000;

/** Minimal structural slice of the TUI we need — avoids importing pi-tui. */
interface RenderPoke {
	requestRender(force?: boolean): void;
	terminal?: { columns?: number; rows?: number };
}

export interface FleetDeps {
	/** Injected transport (same seam the rest of the extension uses). */
	transport: Transport;
}

// ---------------------------------------------------------------------------
// Local key helper (pi-tui's matchesKey is not reachable from this repo's
// node_modules layout); width/trunc live in this module (SECTION 2).
// ---------------------------------------------------------------------------

function isEscape(data: string): boolean {
	return data === "\x1b"; // bare ESC byte (escape sequences start with ESC[)
}

/** Mailbox state: "Q?" worker question awaiting answer, "A→" answer posted. */
async function mailState(dir: string, name: string): Promise<"Q?" | "A→" | "--"> {
	// EXTERNAL_DEPENDENCY: mailbox files on disk — q-<name>.json / a-<name>.json
	// in the exchange dir (mtime comparison decides which side is newer) —
	// read through the ONE shared reader (mailbox-store.mailboxAnswerState,
	// Wave 3 step 5: one implementation for the overlay AND the status tool).
	const { questionPosted, answerNewerThanQuestion } = await mailboxAnswerState(dir, name);
	if (!questionPosted) return "--";
	return answerNewerThanQuestion ? "A→" : "Q?";
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<WorkerView["status"], number> = {
	blocked: 0,
	working: 1,
	idle: 2,
	done: 3,
	unknown: 4,
};

/**
 * Sorts worker views for fleet display: blocked first, then working, idle,
 * done, unknown (STATUS_ORDER); ties broken alphabetically by name.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - views: worker views in any order (as produced by buildWorkerView)
 * Output: a NEW array sorted by status severity (blocked < working < idle <
 *   done < unknown per STATUS_ORDER), then by name via localeCompare
 * Guarantees:
 *   - pure / non-mutating: the input array is copied (`[...views]`), the
 *     caller's array is never reordered
 *   - deterministic: same input → same output order (localeCompare is a
 *     stable tiebreak; Array.prototype.sort is stable, equal pairs keep
 *     input order)
 *   - never throws for any WorkerView (every status has a STATUS_ORDER entry)
 * Raises: none
 */
function sortViews(views: WorkerView[]): WorkerView[] {
	return [...views].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
	);
}

export interface FleetRow {
	view: WorkerView;
	budget: number;
	input: number;
	output: number;
	percent: number;
	mail: "Q?" | "A→" | "--";
	/** Probe worker (spawned with mode:"probe", manifest briefPath ""). */
	isProbe: boolean;
	/** Ownership class vs THIS session (fail-closed: unknown never mine). */
	ownership: Ownership;
	/** Owner session JSONL (v1.11.1+); undefined = legacy manifest.
	 *  Grouping key half (stage 2) — the per-row class stays authoritative. */
	orchestratorSessionPath?: string;
	/** ISO 8601 collect stamp (v1.12.1) — stale age tail input; undefined =
	 *  never collected (fresh worker). */
	collectedAt?: string;
}

/**
 * Builds one display row: merges the live worker view with manifest extras,
 * mailbox state and session-usage gauges.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - view: WorkerView for the row (dir, name, status, elapsedMs, placement)
 *   - extras: manifest data (ManifestExtras — sessionPath, model, briefPath,
 *     orchestratorSessionPath, collectedAt)
 *   - mail: mailbox state for this worker ("Q?" question pending, "A→"
 *     answered, "--" none) — computed by mailState
 *   - self: this session's identity (for ownership classification)
 * Output: FleetRow — view + usage gauges (budget/input/output/percent),
 *   mail state, isProbe, ownership class, provenance fields
 * Guarantees:
 *   - usage gauges never throw: parseSessionUsage degrades to a zeroed entry
 *     on missing/unreadable session JSONL; contextPct null (unknown ctx) →
 *     percent 0
 *   - isProbe is true exactly when the manifest briefPath is "" (probes are
 *     spawned with mode:"probe", no report expected — probe honesty §19.4)
 *   - ownership is classifyOwnership's fail-closed verdict (unknown is never
 *     "mine")
 *   - read-only: only the session JSONL is read (synchronously, via
 *     parseSessionUsage); nothing is written
 * Raises: none (all failure paths degrade, see Guarantees)
 */
function buildRow(view: WorkerView, extras: ManifestExtras, mail: "Q?" | "A→" | "--", self: SelfIdentity): FleetRow {
	// EXTERNAL_DEPENDENCY (via usage.ts): the worker's session JSONL (manifest
	// `sessionPath`) is read synchronously for the usage gauges.
	const usage = parseSessionUsage(extras.sessionPath ?? "");
	const window = resolveContextWindow(extras.model);
	const percent = contextPct(usage, window) ?? 0;
	// Probe workers never produce a report (§19.4 probe honesty): manifest
	// briefPath is "" exactly for probes.
	const isProbe = extras.briefPath === "";
	const ownership = classifyOwnership(
		extras.orchestratorSessionPath,
		self,
		view.placement,
		extras.masterSessionPath,
	);
	return {
		view,
		budget: window,
		input: usage.input,
		output: usage.output,
		percent,
		mail,
		isProbe,
		ownership,
		orchestratorSessionPath: extras.orchestratorSessionPath,
		collectedAt: extras.collectedAt,
	};
}

/** Ownership glyph + theme color: ● mine (accent), ○ foreign (muted),
 *  ◌ legacy/unknown (dim) — display is fail-closed, unknown never mine. */
function ownershipGlyph(ownership: Ownership): { glyph: string; color: ThemeColor } {
	switch (ownership) {
		case "mine":
			return { glyph: OWNERSHIP_GLYPH.mine, color: "accent" };
		case "foreign":
			return { glyph: OWNERSHIP_GLYPH.foreign, color: "muted" };
		case "unknown":
			return { glyph: OWNERSHIP_GLYPH.unknown, color: "dim" };
	}
}

function statusColor(status: WorkerView["status"]): ThemeColor {
	switch (status) {
		case "blocked":
			return "error";
		case "working":
			return "accent";
		case "done":
			return "success";
		default:
			return "dim";
	}
}

// ---------------------------------------------------------------------------
// Pure layout fitting (extracted for unit testing — quality fix A7): no theme,
// no I/O. FleetOverlay.render is a thin themed skin over these results.
// ---------------------------------------------------------------------------

/** Theme-free input row: exactly what the fitting needs. */
export interface FleetLayoutRow {
	name: string;
	branch: string;
	input: number;
	output: number;
	percent: number;
	budget: number;
}

/** Fitted layout: final column widths + per-row cells, every cell already
 *  truncated and padded to its column width (ellipsis included). */
export interface FleetLayout {
	nameW: number;
	branchW: number;
	usageW: number;
	cells: Array<{ name: string; branch: string; usage: string }>;
}

/** Column floors — shrink loops never go below these. */
export const FLEET_FLOORS = { name: 8, branch: 6, usage: 12 } as const;

/** Usage column string: `↑52.8k ↓34.9k (999% of 150k)` (compact k form, usage.ts formatTokens). */
export function fleetUsageOf(r: Pick<FleetLayoutRow, "input" | "output" | "percent" | "budget">): string {
	return `↑${formatTokens(r.input)} ↓${formatTokens(r.output)} (${r.percent}% of ${formatTokens(r.budget)})`;
}

function pad(s: string, len: number): string {
	return s + " ".repeat(Math.max(0, len - visibleWidth(s)));
}

/**
 * Fit the fleet table (name status branch report mail usage) to `innerW`.
 * Shrink priority: branch → name → usage; floors {branch:6, name:8, usage:12}
 * keep columns readable. Cells are trunc'd then padded — a cell can never
 * push past its (fitted) column, so a row can never push past the border.
 */
export function layoutFleetRows(rows: FleetLayoutRow[], innerW: number): FleetLayout {
	const nameNat = Math.max(4, ...rows.map((r) => visibleWidth(r.name)));
	const branchNat = Math.max(6, ...rows.map((r) => visibleWidth(r.branch)));
	const usageNat = Math.max(12, ...rows.map((r) => visibleWidth(fleetUsageOf(r))));

	let nameW = Math.min(nameNat, 18);
	let branchW = Math.min(branchNat, 18);
	let usageW = Math.min(usageNat, 34);
	// total = glyph(1)+1(sp)+nameW+1+status(7)+1+branchW+1+report(1)+1+mail(2)
	//         +2(sp sp)+usageW — fixed cost 18, verified against the rendered
	// row `${glyph} ${name} ${status} ${branch} ${report} ${mail}  ${usage}`.
	// v1.12.0: the lead space became glyph+space (+1) and the latent bug where
	// the fixed cost ignored the double space before usage (15→17) is fixed.
	const total = () => 2 + nameW + 1 + 7 + 1 + branchW + 1 + 1 + 1 + 2 + 2 + usageW;
	// Shrink priority: branch → name → usage (floors keep columns readable).
	while (total() > innerW && branchW > FLEET_FLOORS.branch) {
		branchW = Math.max(FLEET_FLOORS.branch, branchW - (total() - innerW));
	}
	while (total() > innerW && nameW > FLEET_FLOORS.name) {
		nameW = Math.max(FLEET_FLOORS.name, nameW - (total() - innerW));
	}
	while (total() > innerW && usageW > FLEET_FLOORS.usage) {
		usageW = Math.max(FLEET_FLOORS.usage, usageW - (total() - innerW));
	}

	return {
		nameW,
		branchW,
		usageW,
		cells: rows.map((r) => ({
			name: trunc(pad(r.name, nameW), nameW),
			branch: trunc(pad(r.branch, branchW), branchW),
			usage: trunc(fleetUsageOf(r), usageW),
		})),
	};
}

/** Offset safety (§19 alignment fix), pure and unit-testable: clip row
 *  content to `innerW - 1` BEFORE padding to `innerW`, so nothing (header,
 *  legend, themed rows) can ever push past the right border. */
export function fitRow(content: string, innerW: number): string {
	return pad(trunc(content, innerW - 1), innerW);
}

// ---------------------------------------------------------------------------
// Grouping — ownership/task tree (fleet-UX stage 2, report-ux-tree.json).
// Pure: no fs, no transport, no theme. Unit-tested in test/fleet-tree-check.ts.
// ---------------------------------------------------------------------------

/** Structural slice the grouping + header/folded lines need (FleetRow
 *  satisfies it; tests build it directly). */
export interface GroupStatsRow {
	view: Pick<WorkerView, "name" | "dir" | "status" | "reportExists">;
	/** Per-row ownership class (stage 1) — the group class derives from it. */
	ownership: Ownership;
	/** Owner session JSONL (v1.11.1+); undefined = legacy → unknown bucket. */
	orchestratorSessionPath?: string;
	/** Context-window burn % (0 = unknown). */
	percent: number;
	mail: "Q?" | "A→" | "--";
	/** ISO 8601 collect stamp (v1.12.1) — stale age tail input (§22);
	 *  absent when the worker was never collected. */
	collectedAt?: string;
}

export type GroupClass = "mine" | "foreign" | "owner?";

export interface WorkerGroup<T extends GroupStatsRow = GroupStatsRow> {
	/** `manifest.dir :: orchestratorSessionPath` (unknown bucket for legacy). */
	key: string;
	dir: string;
	/** basename(dir) — the human handle in headers/folded lines. */
	slug: string;
	cls: GroupClass;
	/** Members in encounter order (feed pre-sorted rows: sortViews holds). */
	rows: T[];
}

const UNKNOWN_SESSION = "unknown";

/** More than this many foldable groups → one mega-line (ux-fold §1 guard). */
export const MEGA_GROUP_LIMIT = 6;

/** The folded group's stale age tail shares the watcher's worker-stale
 *  default: collected ≥30 min ago = stale-idle (§22). */
// Migration stage 1: the literal duplicate is GONE — the threshold is ONE
// constant, canonically owned by src/usage.ts (the layer both this module
// and observe.ts import, so no fleet<->observe cycle can re-form). This
// alias keeps fleet's exported surface stable; importing observe.ts here is
// still forbidden (observe imports these render helpers — cycle).
export const FLEET_STALE_AFTER_MS = WATCH_DEFAULT_STALE_AFTER_MS;

function slugOf(dir: string): string {
	// Windows-path fix: was dir.split("/") — a drive-letter dir came back
	// whole as the slug (fleet grouping keys mangled). basename is
	// separator-agnostic; POSIX slugs are unchanged.
	return taskSlug(dir);
}

/**
 * Group rows by `manifest.dir :: orchestratorSessionPath` (report-ux-tree
 * dataMapping). Legacy manifests (field absent) land in the per-dir UNKNOWN
 * bucket — never merged into a named session's group, so the same dir can
 * legitimately split into mine/owner?/foreign groups. Within-group order is
 * the input order. Group class from members: any mine → "mine" (renders
 * FLAT — zero regression, and per-row glyphs keep telling the truth in the
 * degraded-self-id mixed edge); else any unknown → "owner?"; else
 * "foreign".
 *
 * Watcher stage A lexicon: the UNKNOWN bucket ("owner?") is a DISPLAY bucket
 * for rows whose canonical verdict (src/watch-role.ts) is "no-owner" (legacy
 * manifest) or "no-self-id" (degraded display identity). It is a display
 * convention only: an unproven owner is never LABELED foreign in the UI —
 * the bucket asserts nothing. It does NOT describe delivery: delivery is
 * fail-closed in observe.ts (only a proven owner is woken; a legacy no-owner
 * manifest delivers nothing unless watch.legacyFailOpen is set).
 */
export function groupWorkerViews<T extends GroupStatsRow>(rows: T[]): WorkerGroup<T>[] {
	const byKey = new Map<string, WorkerGroup<T>>();
	for (const r of rows) {
		const key = `${r.view.dir} :: ${r.orchestratorSessionPath ?? UNKNOWN_SESSION}`;
		let g = byKey.get(key);
		if (!g) byKey.set(key, (g = { key, dir: r.view.dir, slug: slugOf(r.view.dir), cls: "foreign", rows: [] }));
		g.rows.push(r);
	}
	const groups = [...byKey.values()];
	for (const g of groups) {
		g.cls = g.rows.some((r) => r.ownership === "mine")
			? "mine"
			: g.rows.some((r) => r.ownership === "unknown")
				? "owner?"
				: "foreign";
	}
	return groups;
}

const CLASS_RANK: Record<GroupClass, number> = { mine: 0, "owner?": 1, foreign: 2 };

/** Per-group sort (replaces the global status sort): groups ranked by their
 *  most actionable member (existing STATUS_ORDER); ties mine < owner? <
 *  foreign; then ONE new layer (fleet-UX wave 4): fully-stale groups (every
 *  member collected ≥30 min ago — the §22.3 condition, semantics unchanged)
 *  sort below otherwise-equal fresh ones; then slug. Stable — within-group
 *  order untouched. */
export function rankGroups<T extends GroupStatsRow>(
	groups: WorkerGroup<T>[],
	nowMs: number = Date.now(),
): WorkerGroup<T>[] {
	const actionability = (g: WorkerGroup<T>) => Math.min(...g.rows.map((r) => STATUS_ORDER[r.view.status]));
	const fullyStale = (g: WorkerGroup<T>) =>
		g.rows.length > 0 && g.rows.every((r) => isFleetStale(r.collectedAt, nowMs));
	return [...groups].sort(
		(a, b) =>
			actionability(a) - actionability(b) ||
			CLASS_RANK[a.cls] - CLASS_RANK[b.cls] ||
			Number(fullyStale(a)) - Number(fullyStale(b)) ||
			a.slug.localeCompare(b.slug),
	);
}

/** Expanded group header (one full-width dim line, NOT in the column grid):
 *  `▼ slug · live/total live · owner · ctx↑max%`. ctx is the MAX across
 *  members (the restart-cliff E_CONTEXT cares about — not mean/sum), the
 *  segment is dropped when no member has a known pct. fitRow degrades it
 *  left-to-right by survival value at the 40-col box minimum. */
export function groupHeaderText(
	g: Pick<WorkerGroup, "slug" | "cls">,
	rows: ReadonlyArray<GroupStatsRow>,
): string {
	const live = rows.filter((r) => r.view.status === "working" || r.view.status === "blocked").length;
	const maxPct = rows.reduce((m, r) => Math.max(m, r.percent), 0);
	const ctx = maxPct > 0 ? ` · ctx↑${maxPct}%` : "";
	return `▼ ${g.slug} · ${live}/${rows.length} live · ${g.cls}${ctx}`;
}

/**
 * Stale condition (v1.12.1, §22): the worker was COLLECTED (a valid report
 * was delivered — manifest `collectedAt`) at least FLEET_STALE_AFTER_MS ago.
 * Absent/empty/unparseable/future stamps → false: a flag is a claim, and an
 * unknown stamp never reads as stale. Pure.
 */
export function isFleetStale(collectedAt: string | undefined, nowMs: number): boolean {
	if (typeof collectedAt !== "string" || collectedAt.length === 0) return false;
	const t = Date.parse(collectedAt);
	return Number.isFinite(t) && nowMs - t >= FLEET_STALE_AFTER_MS;
}

/** Human age for the stale tail: `31m` under an hour, else hours+minutes
 *  (`3h46m`); sub-minute/negative reads as `0m`. Pure. */
export function fleetAgeText(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Non-zero-only count segments of the folded grammar (fleet-UX wave 4,
 *  report-lex): the letter flags L B ! Q v spelled out as words, same order,
 *  same non-zero-only rule. blocked / hot-ctx (≥CONTEXT_WARN_PCT) /
 *  question surface only when present; `rep` = report landed. */
function countSegments(rows: ReadonlyArray<GroupStatsRow>): string[] {
	let live = 0,
		blocked = 0,
		hot = 0,
		mailQ = 0,
		reports = 0;
	for (const r of rows) {
		if (r.view.status === "working" || r.view.status === "blocked") live++;
		if (r.view.status === "blocked") blocked++;
		if (r.percent >= CONTEXT_WARN_PCT) hot++;
		if (r.mail === "Q?") mailQ++;
		if (r.view.reportExists) reports++;
	}
	const segs: string[] = [];
	if (live > 0) segs.push(`${live} live`);
	if (blocked > 0) segs.push(`${blocked} blocked`);
	if (hot > 0) segs.push(`${hot} hot-ctx`);
	if (mailQ > 0) segs.push(`${mailQ} question`);
	if (reports > 0) segs.push(`${reports} rep`);
	return segs;
}

/**
 * Stale age tail (fleet-UX wave 4, §22.3): when EVERY member was collected
 * ≥FLEET_STALE_AFTER_MS ago (the retired `s` letter's exact condition —
 * isFleetStale, semantics unchanged), the tail spells the OLDEST member's
 * collectedAt age in human form. The remedy is OWNERSHIP-SCOPED (report-act):
 * /delegate-teardown is a global sweep with no ownership filter, so it is
 * advertised only on MINE groups; foreign/owner? groups point at the owner.
 */
function staleAgeTail(cls: GroupClass, rows: ReadonlyArray<GroupStatsRow>, nowMs: number): string {
	const stale = rows.length > 0 && rows.every((r) => isFleetStale(r.collectedAt, nowMs));
	if (!stale) return "";
	let oldest = Number.POSITIVE_INFINITY;
	for (const r of rows) {
		const t = Date.parse(r.collectedAt ?? "");
		if (Number.isFinite(t) && t < oldest) oldest = t;
	}
	if (!Number.isFinite(oldest)) return ""; // unreachable while stale, but a claim is only ever a claim
	const age = fleetAgeText(nowMs - oldest);
	return cls === "mine"
		? ` · idle ${age} (/delegate-teardown)`
		: ` · idle ${age} · owner can tear down`;
}

/** Folded group line (fleet-UX wave 4, report-lex): self-describing
 *  grammar `~ <class> <slug> · N workers · counts… · idle <age>` — the
 *  class token is SPACE-separated (the dot-join read as a hostname), there
 *  are no bare `xN` counts, no `--` separator and no letter flags; counts
 *  are words a stranger can parse (live / blocked / hot-ctx / question /
 *  rep), non-zero only. Identity (class + slug + worker count) LEADS, so
 *  fitRow's left-to-right degrade keeps it under width pressure. The
 *  `Tab` hint lives in the overlay header (§4), not per-line. */
export function groupFoldedText(
	g: Pick<WorkerGroup, "slug" | "cls">,
	rows: ReadonlyArray<GroupStatsRow>,
	nowMs: number = Date.now(),
): string {
	const n = rows.length;
	const segs = [`~ ${g.cls} ${g.slug}`, `${n} worker${n === 1 ? "" : "s"}`, ...countSegments(rows)];
	return segs.join(" · ") + staleAgeTail(g.cls, rows, nowMs);
}

/** Mega-line guard (>MEGA_GROUP_LIMIT foldable groups): ONE line, same
 *  self-describing vocabulary as groupFoldedText. Tags stay honest:
 *  "owner?" groups are never folded into a plain "foreign" label — a mixed
 *  collapse says so. The mega collapse holds only non-mine groups, so the
 *  stale tail carries the owner-side remedy (never the /delegate-teardown
 *  hint — that sweep is global). */
export function megaFoldedText(
	groups: ReadonlyArray<WorkerGroup>,
	nowMs: number = Date.now(),
): string {
	const rows = groups.flatMap((g) => g.rows);
	const hasForeign = groups.some((g) => g.cls === "foreign");
	const hasOwner = groups.some((g) => g.cls === "owner?");
	const tag = hasForeign && hasOwner ? "foreign+owner?" : hasOwner ? "owner?" : "foreign";
	const segs = [`~ ${tag}`, `${rows.length} workers in ${groups.length} tasks`, ...countSegments(rows)];
	return segs.join(" · ") + staleAgeTail("foreign", rows, nowMs);
}

// ---------------------------------------------------------------------------
// Tab fold state (report-ux-fold §4 exact): module-level boolean = session
// scope — survives overlay close/reopen, resets on restart. NOT persisted to
// /tmp/exchange (surfaces are read-only by contract). FOLDED is the
// first-open default: opening the overlay must never show MORE than today's
// flat table under a foreign fleet.
// ---------------------------------------------------------------------------

let foreignUnfolded = false;

/** Toggle on Tab; no-op when nothing is foldable (foldableCount === 0). */
export function fleetFoldToggle(foldableCount: number): void {
	if (foldableCount > 0) foreignUnfolded = !foreignUnfolded;
}

/** Current fold state (true = foreign/unknown groups expanded). */
export function fleetFoldUnfolded(): boolean {
	return foreignUnfolded;
}

// ---------------------------------------------------------------------------
// Pure overlay skin (stage 2): grouping + tree glyphs + fold + group-atomic
// window. FleetOverlay.render is a thin delegate; tests render headless.
// ---------------------------------------------------------------------------

export interface FleetRenderInput {
	/** Pre-sorted rows (sortViews order — grouping preserves it). */
	rows: FleetRow[];
	/** Terminal width; the box clamps to 40..100 as before. */
	width: number;
	terminalRows?: number;
	/** Fold state (fleetFoldUnfolded()). */
	unfolded: boolean;
	/** Injectable clock for the stale age tail + ordering/trim tiebreak
	 *  (v1.12.1+) — tests pin it; production defaults to Date.now() at
	 *  render time. */
	nowMs?: number;
	theme: Theme;
}

type FleetBlock =
	| { kind: "row"; r: FleetRow; stale: boolean }
	| { kind: "group"; g: WorkerGroup<FleetRow>; stale: boolean }
	| { kind: "folded"; g: WorkerGroup<FleetRow>; stale: boolean }
	| { kind: "mega"; workers: number; stale: boolean };

// --- Legends (fleet-UX wave 4) --------------------------------------------
// Each legend is a list of atomic segments greedily packed into at most TWO
// physical dim lines (one when everything fits — packLegend). FLAT keys
// every token its expanded surface renders, incl. the wave-4 parity keys
// `owner?` untraceable, the probe em-dash, tree glyphs and token arrows
// (report-lex fix 3). FOLD is a WORKED EXAMPLE of the folded grammar plus a
// minimal key for the non-obvious tokens — not a token list.

const FLAT_LEGEND_SEGS = [
	"● mine ○ foreign ◌ owner? untraceable",
	"blocked→working→idle→done→unknown",
	"✓/✗ report",
	"— probe",
	"Q?/A→ mailbox",
	"├└ group",
	"↑↓ in/out",
	"2s refresh",
] as const;

const FOLD_LEGEND_SEGS = [
	"● yours",
	"e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m",
	"live=working/blocked",
	"rep=report landed",
	"idle=collected ≥30m",
] as const;

/** Foreign-fleet framing (report-act fix 1): states the viewer's role —
 *  rendered once whenever any foreign/owner? group is on screen. Affirms
 *  the §22 canon (foreign fleets never mutated) instead of weakening it. */
const FOREIGN_FRAMING = "○ ◌ = another session's fleet — informational; only its owner can act";

/** Greedy-pack legend segments into ≤2 lines that each fit the row budget
 *  (innerW − 2: the legend line's leading render space + fitRow's 1-col
 *  clip margin). The second line may overflow — fitRow clips it, degrade
 *  stays left-to-right. One line when everything fits; never more than
 *  two. Pure. */
export function packLegend(segs: ReadonlyArray<string>, innerW: number): string[] {
	const budget = Math.max(1, innerW - 2);
	const first: string[] = [];
	let i = 0;
	for (; i < segs.length; i++) {
		const next = first.length === 0 ? segs[i] : `${first.join(" · ")} · ${segs[i]}`;
		if (visibleWidth(next) > budget) break;
		first.push(segs[i]);
	}
	const rest = segs.slice(i).join(" · ");
	if (first.length === 0) return [rest]; // single wider-than-line segment → one trunc'd line
	if (rest.length === 0) return [first.join(" · ")];
	return [first.join(" · "), rest];
}

/**
 * Render the overlay: pass 1 builds BLOCKS (mine rows are singletons; a
 * foldable group is its header + ALL children — the height window is
 * group-atomic, a header never shows without its children, so a block that
 * does not fit hides whole); pass 2 fits the column grid over the VISIBLE
 * rows only, with inline tree glyphs `├ `/`└ ` in the name column (V1,
 * report-ux-tree: fitter untouched, glyph truncates as one unit with the
 * name). Group headers/folded lines are full-width dim lines OUTSIDE the
 * grid. Every line goes through fitRow → visibleWidth ≤ innerW.
 */
export function renderFleet(input: FleetRenderInput): string[] {
	const th = input.theme;
	const w = Math.max(40, Math.min(input.width, 100));
	const innerW = w - 2;
	const row = (content: string) => th.fg("border", "│") + fitRow(content, innerW) + th.fg("border", "│");

	const nowMs = input.nowMs ?? Date.now();
	const groups = rankGroups(groupWorkerViews(input.rows), nowMs);
	const foldables = groups.filter((g) => g.cls !== "mine");
	const folded = foldables.length > 0 && !input.unfolded;
	const mega = folded && foldables.length > MEGA_GROUP_LIMIT;
	const fullyStale = (g: WorkerGroup<FleetRow>) =>
		g.rows.length > 0 && g.rows.every((r) => isFleetStale(r.collectedAt, nowMs));

	const blocks: FleetBlock[] = [];
	for (const g of groups) {
		const st = fullyStale(g);
		if (g.cls === "mine") for (const r of g.rows) blocks.push({ kind: "row", r, stale: st });
		else if (!mega) blocks.push(folded ? { kind: "folded", g, stale: st } : { kind: "group", g, stale: st });
	}
	if (mega) {
		blocks.push({
			kind: "mega",
			workers: foldables.reduce((n, g) => n + g.rows.length, 0),
			stale: foldables.length > 0 && foldables.every(fullyStale),
		});
	}

	const blockLines = (b: FleetBlock) => (b.kind === "group" ? 1 + b.g.rows.length : 1);
	const blockWorkers = (b: FleetBlock) =>
		b.kind === "row" ? 1 : b.kind === "mega" ? b.workers : b.g.rows.length;

	// Legends/frame are computed before the window math: they decide the
	// chrome height. Framing renders whenever any foreign/owner? group is on
	// screen (report-act fix 1).
	const legendLines = packLegend(folded ? FOLD_LEGEND_SEGS : FLAT_LEGEND_SEGS, innerW);
	const framing = foldables.length > 0;

	// Height fit (§15 fix + fleet-UX wave 4): chrome = top border + header +
	// blank + blank + legend (1–2 lines) + framing? + bottom border; the
	// extra −2 is the “… and N more” slot plus render slack. Group-atomic: a
	// block that would not fit entirely hides whole. Stale-aware trim
	// (report-pulse fix 2): FRESH blocks fill the window first in display
	// order; fully-stale blocks are admitted only into what remains AFTER
	// every fresh block is shown — so a live (working/blocked) row is never
	// hidden while any stale-group row is visible. Display order is
	// unchanged; shown blocks render at their ranked positions.
	const chromeLines = 5 + legendLines.length + (framing ? 1 : 0);
	const maxVisible = Math.max(1, (input.terminalRows ?? 30) - chromeLines - 2);
	const fresh: Array<[number, FleetBlock]> = [];
	const staleBlocks: Array<[number, FleetBlock]> = [];
	blocks.forEach((b, i) => (b.stale ? staleBlocks : fresh).push([i, b]));
	const shownIdx: number[] = [];
	let used = 0;
	let freshAllShown = true;
	for (const [i, b] of fresh) {
		const n = blockLines(b);
		if (used + n > maxVisible) {
			freshAllShown = false;
			break;
		}
		shownIdx.push(i);
		used += n;
	}
	if (freshAllShown) {
		for (const [i, b] of staleBlocks) {
			const n = blockLines(b);
			if (used + n > maxVisible) break;
			shownIdx.push(i);
			used += n;
		}
	}
	shownIdx.sort((a, b) => a - b);
	const shown = shownIdx.map((i) => blocks[i]);
	const shownWorkers = shown.reduce((n, b) => n + blockWorkers(b), 0);
	const hiddenWorkers = input.rows.length - shownWorkers;

	const visible: Array<{ r: FleetRow; name: string }> = [];
	for (const b of shown) {
		if (b.kind === "row") visible.push({ r: b.r, name: b.r.view.name });
		else if (b.kind === "group") {
			const n = b.g.rows.length;
			b.g.rows.forEach((r, i) => visible.push({ r, name: `${i < n - 1 ? "├" : "└"} ${r.view.name}` }));
		}
	}
	const layout = layoutFleetRows(
		visible.map((v) => ({
			name: v.name,
			branch: v.r.view.branch ?? "-",
			input: v.r.input,
			output: v.r.output,
			percent: v.r.percent,
			budget: v.r.budget,
		})),
		innerW,
	);

	const lines: string[] = [];
	lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
	const hint = foldables.length > 0 ? ` — Tab ${input.unfolded ? "fold" : "unfold"}` : "";
	lines.push(
		row(` ${th.fg("accent", `pi-delegate fleet — ${input.rows.length} worker(s) — q to close${hint}`)}`),
	);
	lines.push(row(""));

	if (input.rows.length === 0) {
		lines.push(row(` ${th.fg("dim", `no delegate workers known (no manifests under ${exchangeRoot()})`)}`));
	}

	let cell = 0;
	const gridRow = () => {
		const { r } = visible[cell];
		const c = layout.cells[cell];
		cell++;
		const own = ownershipGlyph(r.ownership);
		const glyph = th.fg(own.color, own.glyph);
		const name = th.fg("text", c.name);
		const status = th.fg(statusColor(r.view.status), pad7(r.view.status));
		const branch = th.fg("dim", c.branch);
		const report = r.isProbe
			? th.fg("dim", "—") // probe: no report expected — never ✓/✗ (§19.4)
			: r.view.reportExists
				? th.fg("success", "✓")
				: th.fg("error", "✗");
		const mail =
			r.mail === "Q?"
				? th.fg("warning", "Q?")
				: r.mail === "A→"
					? th.fg("success", "A→")
					: th.fg("dim", "--");
		const warn = r.percent >= CONTEXT_WARN_PCT;
		const usage = th.fg(warn ? "warning" : "dim", c.usage);
		// Row shape (the fitter's fixed cost mirrors this): glyph+space lead,
		// then name status branch report mail␣␣usage.
		return row(`${glyph} ${name} ${status} ${branch} ${report} ${mail}  ${usage}`);
	};

	for (const b of shown) {
		if (b.kind === "row") {
			lines.push(gridRow());
		} else if (b.kind === "group") {
			lines.push(row(` ${th.fg("dim", groupHeaderText(b.g, b.g.rows))}`));
			for (let i = 0; i < b.g.rows.length; i++) lines.push(gridRow());
		} else if (b.kind === "folded") {
			lines.push(row(` ${th.fg("dim", groupFoldedText(b.g, b.g.rows, nowMs))}`));
		} else {
			lines.push(row(` ${th.fg("dim", megaFoldedText(foldables, nowMs))}`));
		}
	}

	if (hiddenWorkers > 0) {
		lines.push(
			row(
				` ${th.fg("dim", trunc(`… and ${hiddenWorkers} more (trim the fleet: /delegate-teardown)`, innerW - 1))}`,
			),
		);
	}
	lines.push(row(""));
	for (const l of legendLines) lines.push(row(` ${th.fg("dim", l)}`));
	if (framing) lines.push(row(` ${th.fg("dim", FOREIGN_FRAMING)}`));
	lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

	return lines;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

class FleetOverlay {
	private tui: RenderPoke | undefined;
	private terminalRows: number | undefined;
	private transport: Transport;
	private theme: Theme;
	private done: () => void;
	/** This session's identity — ownership is classified against it. */
	private self: SelfIdentity;
	private rows: FleetRow[] = [];
	/** Foldable groups (foreign + owner?) in the last snapshot — Tab no-ops
	 *  when 0 (ux-fold §4). Computed in refresh, cheap (rows ≤ dozens). */
	private foldableCount = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	private refreshing = false;

	constructor(tui: RenderPoke, transport: Transport, theme: Theme, done: () => void, self: SelfIdentity = {}) {
		this.tui = tui;
		this.terminalRows = tui?.terminal?.rows;
		this.transport = transport;
		this.theme = theme;
		this.done = done;
		this.self = self;
		void this.refresh();
		this.timer = setInterval(() => {
			void this.refresh().then(() => {
				if (!this.closed) this.tui?.requestRender();
			});
		}, REFRESH_MS);
	}

	/** Read-only data refresh; never throws, never overlaps. */
	private async refresh(): Promise<void> {
		if (this.closed || this.refreshing) return;
		this.refreshing = true;
		try {
			const views = sortViews(await buildWorkerView(this.transport));
			const rows: FleetRow[] = [];
			for (const view of views) {
				const [extras, mail] = await Promise.all([
					readManifestExtras(view.dir, view.name),
					mailState(view.dir, view.name),
				]);
				rows.push(buildRow(view, extras, mail, this.self));
			}
			this.rows = rows;
			this.foldableCount = groupWorkerViews(rows).filter((g) => g.cls !== "mine").length;
		} catch {
			// keep last snapshot on any unexpected read failure
		} finally {
			this.refreshing = false;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.done();
	}

	handleInput(data: string): void {
		if (data === "\t") {
			// Tab (0x09) — ux-fold §4 exact: single byte (never an ESC-sequence
			// prefix), no-op when nothing is foldable, then requestRender.
			if (this.foldableCount > 0) {
				fleetFoldToggle(this.foldableCount);
				this.tui?.requestRender();
			}
			return;
		}
		if (isEscape(data) || data === "q") {
			this.close();
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	render(width: number): string[] {
		// Pure skin (stage 2): grouping + tree + fold + group-atomic window.
		return renderFleet({
			rows: this.rows,
			width,
			terminalRows: this.terminalRows,
			unfolded: fleetFoldUnfolded(),
			theme: this.theme,
		});
	}
}

/** Pad the fixed 7-column status cell (theme-free helper). */
function pad7(s: string): string {
	return s + " ".repeat(Math.max(0, 7 - visibleWidth(s)));
}

/**
 * Open the fleet overlay and block until the user closes it (q/escape).
 * Read-only; resolves with void. Ownership glyphs classify against THIS
 * session (live sessionManager getter, tolerantly degraded — same wiring as
 * observe.ts startWatcher).
 */
export async function openFleetOverlay(ctx: ExtensionCommandContext, deps: FleetDeps): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/delegate-fleet is only available in interactive (TUI) mode.", "warning");
		return;
	}
	let sessionFile: string | undefined;
	try {
		sessionFile = ctx.sessionManager?.getSessionFile?.();
	} catch {
		sessionFile = undefined; // degraded self-id — classification degrades, overlay lives
	}
	const self: SelfIdentity = { sessionFile, cwd: ctx.cwd };
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new FleetOverlay(tui, deps.transport, theme, () => done(undefined), self),
		{ overlay: true },
	);
}
