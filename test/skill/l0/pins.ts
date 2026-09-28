/**
 * pi-delegate — test/skill/l0/pins.ts — the BM-1 L0 static pin layer (issue
 * #110): the pin engine + the pin table over `skills/delegate/SKILL.md` and
 * `skills/delegate/REFERENCE.md`.
 *
 * MODULE_CONTRACT — owns:
 *   - The LINE-SCOPED matching semantics, shared by every pin: a text is
 *     split into lines; a `forbid` pin VIOLATES iff some line matches one of
 *     its `fire` regexes while matching NO `guard` regex (guards exempt the
 *     line — negations such as "never verbatim" must not fire the pin); a
 *     `require` pin PASSES iff some line matches one of its `fire` regexes.
 *     Guards exist exactly because the good text teaches the ANTI-pattern by
 *     name ("never retry verbatim", "not a tool error") — the pin engine must
 *     distinguish teaching a forbidden move from forbidding it.
 *   - runPins(skillText, referenceText) — pure: zero IO, zero clock, zero
 *     randomness. Returns one Violation per (pin, offending line), each with
 *     a 1-based line number and the line excerpt, plus the count of pins
 *     checked. verdictPass = violations.length === 0.
 *   - The pin table L0_PINS — issue #110's minimum pin set. Each row carries
 *     a `source` citation of the repo truth it defends (the fixture
 *     `test/skill/tool-contract.json` claim ids whose `source` fields point
 *     at src/; README/config default postures; the issue text itself).
 *
 * NOT owned: reading the real files (the flat check test/skill-l0-check.ts
 * does that and maps violations to exit codes), the L1 scorer, anything
 * behavioral. Extension is by ADDING rows to L0_PINS; the engine semantics
 * are frozen (the flat check pins the engine itself with synthetic inputs).
 */

import { firesOn } from "../text-match.ts";

/** Which text a pin targets — the primary path vs the fallback reference. */
export type PinTarget = "SKILL.md" | "REFERENCE.md";

export interface Pin {
	/** Stable id — cited by checks and reports; never rename (frozen). */
	id: string;
	kind: "forbid" | "require";
	target: PinTarget;
	/** What the pin defends, in issue #110 wording. */
	description: string;
	/** Forbid: a violation iff a line matches a fire and no guard.
	 *  Require: satisfied iff a line matches a fire. */
	fire: RegExp[];
	/** Forbid only: a line matching ANY guard is exempt. */
	guards?: RegExp[];
	/** Repo-truth citation (fixture claim id + src path, README, or issue). */
	source: string;
}

export interface Violation {
	pin: string;
	kind: "forbid" | "require";
	target: PinTarget;
	/** 1-based; 0 for a `require` pin that matched nowhere. */
	line: number;
	excerpt: string;
	description: string;
	source: string;
}

export interface L0Result {
	/** Number of pins evaluated (table size — stable across runs). */
	pinsChecked: number;
	verdictPass: boolean;
	violations: Violation[];
}

/** Split into lines the way violation reports cite them (1-based). */
function linesOf(text: string): string[] {
	return text.split("\n");
}

/** Evaluate one pin against its target text. Pure. */
export function runPin(pin: Pin, text: string): Violation[] {
	const out: Violation[] = [];
	if (pin.kind === "require") {
		if (!firesOn(text, pin.fire)) {
			out.push({
				pin: pin.id,
				kind: pin.kind,
				target: pin.target,
				line: 0,
				excerpt: "",
				description: pin.description,
				source: pin.source,
			});
		}
		return out;
	}
	// Forbid: paragraph-scoped verdict through firesOn — a wrapped fire still
	// violates, and a guard exempts its whole paragraph (the negation and its
	// subject share the wrapped lines). Violations still cite a physical line.
	if (firesOn(text, pin.fire, pin.guards)) {
		const lines = linesOf(text);
		let cited = 0;
		let excerpt = "";
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (!pin.fire.some((re) => re.test(line))) continue;
			if (pin.guards !== undefined && pin.guards.some((re) => re.test(line))) continue;
			cited = i + 1;
			excerpt = line.trim().slice(0, 160);
			break;
		}
		if (cited === 0) {
			// The fire exists only in the joined-paragraph view: cite the first
			// physical line that contributes to a firing paragraph.
			const paragraphs = text.split(/\n\s*\n/);
			outer: for (const paragraph of paragraphs) {
				const joined = paragraph.split("\n").join(" ").replace(/\s+/g, " ");
				if (!pin.fire.some((re) => re.test(joined))) continue;
				if (pin.guards !== undefined && pin.guards.some((re) => re.test(joined))) continue;
				const first = paragraph.split("\n")[0]!;
				cited = lines.indexOf(first) + 1;
				excerpt = first.trim().slice(0, 160);
				break outer;
			}
			if (cited === 0) cited = 1;
		}
		out.push({
			pin: pin.id,
			kind: pin.kind,
			target: pin.target,
			line: cited,
			excerpt,
			description: pin.description,
			source: pin.source,
		});
	}
	return out;
}

/** Run the full L0 table against the two skill texts. Pure and deterministic. */
export function runPins(skillText: string, referenceText: string): L0Result {
	const violations: Violation[] = [];
	for (const pin of L0_PINS) {
		const text = pin.target === "SKILL.md" ? skillText : referenceText;
		violations.push(...runPin(pin, text));
	}
	return {
		pinsChecked: L0_PINS.length,
		verdictPass: violations.length === 0,
		violations,
	};
}

/**
 * The L0 pin table — issue #110's minimum set. Anchors were derived from the
 * CURRENT merged skill text plus the repo truths the fixture's `source`
 * fields point at (src/spawn.ts prompt guidelines, src/watch-config.ts
 * fallback, README §release postures). Frozen ids; extension by addition.
 */
export const L0_PINS: readonly Pin[] = [
	// ------------------------------------------------------------------ forbid
	{
		id: "F1-herdr-primary-path",
		kind: "forbid",
		target: "SKILL.md",
		description:
			"SKILL.md must not teach herdr CLI spawn/collect as the primary path — the delegate tool owns mechanics; the manual ritual lives in REFERENCE.md only",
		fire: [/\bherdr\s+(agent|tab|worktree|pane|workspace)\b/i, /\bherdr\b[^]{0,40}\bspawn\b/i],
		source: "issue #110 (primary-path herdr agent spawn/collect); skills/delegate/REFERENCE.md gate",
	},
	{
		id: "F2-sleep-as-wait",
		kind: "forbid",
		target: "SKILL.md",
		description:
			"SKILL.md must not teach sleeping to wait for a worker (sleep-as-wait)",
		fire: [/\bsleep\s+[0-9]/, /sleep\s+in\s+bash/, /\bsleep(ing)?\s+(to|until)\s+wait/],
		guards: [/never/i, /\bnot\b/i, /don'?t/i, /avoid/i],
		source: "issue #110; fixture claim timeout-end-turn (src/spawn.ts:548)",
	},
	{
		id: "F3-status-done-completion",
		kind: "forbid",
		target: "SKILL.md",
		description:
			"SKILL.md must not treat agent status done as a completion criterion — the validated report file is the criterion",
		fire: [
			/status[^]{0,24}\bdone\b/i,
			/\bdone\b[^]{0,24}\bstatus\b/i,
			/status\s*[:=]\s*["'`]done["'`]/i,
		],
		guards: [/never/i, /\bnot\b/i, /vocabulary/i, /anti-pattern/i, /means the turn ended/i],
		source: "issue #110; fixture claim completion-report-file (src/spawn.ts:543)",
	},
	{
		id: "F4-default-posture-fight",
		kind: "forbid",
		target: "SKILL.md",
		description:
			"SKILL.md must not claim a default release/settle posture that fights README/config (the default is releaseOn \"started\"; settle is the opt-out)",
		fire: [
			/(default|defaults|by default|default posture)[^]{0,60}\bsettle\b/i,
			/\bsettle\b[^]{0,40}by default/i,
			/releaseOn\s*[:=]\s*["'`]settle["'`]/i,
			/blocks?\s+until[^]{0,30}by default/i,
		],
		guards: [/never/i, /\bnot\b/i, /opt-?out/i, /explicit/i],
		source: "issue #110; fixture claim release-default (src/watch-config.ts:167); README §started-vs-settle",
	},
	{
		id: "F5-report-path-in-output",
		kind: "forbid",
		target: "SKILL.md",
		description:
			"SKILL.md must not put the report path/report JSON shape into a brief's OUTPUT section — acceptance criteria only; the tool's prompt owns name/path/contract",
		fire: [
			/report-<name>/,
			/report-\{name\}/,
			/OUTPUT[^]{0,120}(report path|report JSON|report-<name>)/,
		],
		guards: [/tool('s)? own prompt/i, /the tool's/i, /tool prompt/i, /never paste/i, /name-agnostic/i],
		source: "issue #110; fixture claim brief-output-rules (src/host.ts:611)",
	},
	{
		id: "F6-verbatim-same-name-retry",
		kind: "forbid",
		target: "SKILL.md",
		description:
			"SKILL.md must not teach a verbatim or same-name retry — the diagnosed retry runs under a NEW worker name",
		fire: [
			/retry verbatim/i,
			/verbatim retry/i,
			/retry[^]{0,40}same (worker )?name/i,
			/same[- ]name (retry|respawn)/i,
			/re-?sen[dt][^]{0,30}(same|original) (brief|prompt)/i,
		],
		guards: [/never/i, /banned/i, /avoid/i, /\bnot\b/i],
		source: "issue #110; fixture claim retry-new-name (src/spawn.ts:252)",
	},
	{
		id: "F7-ref-not-primary",
		kind: "forbid",
		target: "REFERENCE.md",
		description:
			"REFERENCE.md must not claim to be the primary/default path — it is the tool-absent fallback only",
		fire: [
			/this (file|ritual|reference|section) is the (primary|default|preferred)/i,
			/use this (file|ritual|reference) (first|by default|instead)/i,
		],
		source: "issue #110 (REFERENCE fallback framing); REFERENCE.md header gate",
	},
	// ----------------------------------------------------------------- require
	{
		id: "R1-tool-first",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md names the delegate tool as the owner of mechanics",
		fire: [/`delegate` tool/, /the delegate tool/],
		source: "issue #110 (tool-first); SKILL.md header",
	},
	{
		id: "R2-fallback-pointer",
		kind: "require",
		target: "SKILL.md",
		description:
			"SKILL.md points at REFERENCE.md as the tool-absent fallback",
		fire: [/REFERENCE\.md/],
		source: "issue #110 (tool-absent fallback framing)",
	},
	{
		id: "R3-report-file-completion",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: the validated report file is the completion criterion",
		fire: [/validated report file/, /report file is the completion/],
		source: "fixture claim completion-report-file (src/spawn.ts:543)",
	},
	{
		id: "R4-not-agent-status",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: success is never an agent's status",
		fire: [/never an agent'?s status/],
		source: "fixture claim completion-report-file (src/spawn.ts:543)",
	},
	{
		id: "R5-honest-fail-report",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: a status-fail report is an honest completion",
		fire: [/honest completion/],
		source: "fixture claim completion-report-file (src/spawn.ts:543)",
	},
	{
		id: "R6-diagnosed-retry",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md mandates the diagnosed retry",
		fire: [/diagnosed retry/i],
		source: "fixture claim retry-new-name (src/spawn.ts:252)",
	},
	{
		id: "R7-retry-new-name",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: the retry runs under a NEW worker name",
		fire: [/NEW worker name/],
		source: "fixture claim retry-new-name (src/spawn.ts:252)",
	},
	{
		id: "R8-never-verbatim",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md forbids the verbatim retry explicitly",
		fire: [/never verbatim/],
		source: "issue #110; fixture claim retry-new-name",
	},
	{
		id: "R9-merge-gate",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: the orchestrator is the single merge gate",
		fire: [/merge gate/],
		source: "issue #110 (merge gate)",
	},
	{
		id: "R10-workers-never-merge",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: workers never merge, never push",
		fire: [/never merge/],
		source: "issue #110 (merge gate)",
	},
	{
		id: "R11-output-acceptance-only",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: a brief's OUTPUT carries acceptance criteria only",
		fire: [/acceptance criteria only/i],
		source: "fixture claim brief-output-rules (src/host.ts:611)",
	},
	{
		id: "R12-brief-name-agnostic",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: briefs stay name-agnostic",
		fire: [/name-agnostic/],
		source: "fixture claim brief-output-rules (src/host.ts:611)",
	},
	{
		id: "R13-negative-load-trigger",
		kind: "require",
		target: "SKILL.md",
		description:
			"SKILL.md: a fan-out of ≥3 triggers the negative load check (smoke first)",
		fire: [/≥\s?3/, /at least 3/],
		source: "issue #110 (negative load trigger)",
	},
	{
		id: "R14-smoke-first",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: the cheap smoke check precedes a big fan-out",
		fire: [/smoke/],
		source: "issue #110 (negative load trigger)",
	},
	{
		id: "R15-timeout-end-turn",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: end your turn on timeouts — the watcher owns the wait",
		fire: [/end your turn/i],
		source: "fixture claim timeout-end-turn (src/spawn.ts:548)",
	},
	{
		id: "R16-never-rewait",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: never re-call the tool to wait",
		fire: [/re-call the tool to wait/, /never re-call/],
		source: "fixture claim timeout-end-turn (src/spawn.ts:548)",
	},
	{
		id: "R17-never-bash-sleep",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: never bash-sleep to wait for a worker",
		fire: [/bash-sleep/, /never sleep/],
		source: "fixture claim timeout-end-turn (src/spawn.ts:548)",
	},
	{
		id: "R18-worktree-authority",
		kind: "require",
		target: "SKILL.md",
		description:
			"SKILL.md: only the root orchestrator gets worktree isolation (sub-orchestrator authority)",
		fire: [/root orchestrator/],
		source: "fixture claim placement-sub-orchestrator (src/herdr/host.ts:648)",
	},
	{
		id: "R19-sub-orch-shared",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: a sub-orchestrator's workers share its checkout",
		fire: [/share its checkout/, /shared/],
		source: "fixture claim placement-sub-orchestrator (src/herdr/host.ts:648)",
	},
	{
		id: "R20-probe-owned-by-tool",
		kind: "require",
		target: "SKILL.md",
		description: "SKILL.md: the probe protocol is tool-owned vocabulary",
		fire: [/probe/],
		source: "fixture claim probe-no-report (src/spawn.ts:547)",
	},
	{
		id: "R21-ref-gate-only-when-absent",
		kind: "require",
		target: "REFERENCE.md",
		description: "REFERENCE.md gates itself: the ritual applies ONLY when the tool is absent",
		fire: [/applies ONLY when/, /tool[- ]absent/i],
		source: "issue #110 (REFERENCE fallback framing)",
	},
	{
		id: "R22-ref-tool-present-bug",
		kind: "require",
		target: "REFERENCE.md",
		description:
			"REFERENCE.md: running the ritual while the tool exists is a bug, not a shortcut",
		fire: [/bug\*{0,2}, not a shortcut/],
		source: "issue #110 (REFERENCE fallback framing)",
	},
];
