/**
 * pi-delegate — test/skill/quality/l2-text.ts — the BM-6 static L2 leg: the
 * tag→anchor TEXT PROJECTION that turns the stage-1 scenario set
 * (test/skill/scenarios/S01–S12.json) into deterministic per-scenario traces
 * over the skill TEXT, so the composite Q can carry an L2 number without a
 * live model run.
 *
 * MODULE_CONTRACT — owns:
 *   - The ANCHOR TABLE: one entry per (tag, role). Roles matter because four
 *     tags are dual-use — expected in one scenario, forbidden in another
 *     (S02 expects mode:worktree; S03 forbids it for sub-orchestrators) — so
 *     the projection is PER-SCENARIO: a scenario's trace contains its expect
 *     tags whose expect-anchor fires plus its forbid tags whose forbid-
 *     anchor fires. Matching is LINE-SCOPED with the same guard semantics as
 *     the L0 pin engine (a line matching a guard is exempt — negation
 *     teaching such as "never re-call the tool to wait" must not fire
 *     wait:delegate-rewait). Anchors were derived from the CURRENT merged
 *     skill text and the scenario semantics; every anchor is red/green-pinned
 *     by test/skill-quality-check.ts.
 *   - CONTEXTUAL FORBID DEAD ZONES: some scenario `forbid` tags are wrong
 *     only in their scenario's context (S12 forbids tool:delegate BECAUSE
 *     the tool is absent; S03 forbids mode:worktree BECAUSE the actor is a
 *     sub-orchestrator). Static text projection cannot see context, so those
 *     forbid-role entries carry `fire: []` — they never fire statically; the
 *     behavioral verdict for them belongs to live replay traces (stage-1
 *     TraceDoc), not to this layer.
 *   - projectScenarioTrace(scenario, texts) → TraceDoc (pure); firedTags
 *     for diagnostics; scoreScenariosAgainstTexts(scenariosDir, texts) →
 *     per-scenario ScoreResult + mean, reusing the stage-1 rubric
 *     scoreTrace UNCHANGED (frozen surface — import, never reshape).
 *
 * NOT owned: the rubric/weights (runner/rubric.ts), scenario loading
 * (runner/l2-runner.ts loadScenario/listJsonFiles — reused), L0/L1/L3/L4.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listJsonFiles, loadScenario } from "../runner/l2-runner.ts";
import {
	scoreTrace,
	type ScenarioDoc,
	type ScoreResult,
	type TraceDoc,
} from "../runner/rubric.ts";
import { firesOn } from "../text-match.ts";

export type AnchorRole = "expect" | "forbid";

export interface Anchor {
	tag: string;
	role: AnchorRole;
	/** The tag fires iff a text line matches a fire and no guard. */
	fire: RegExp[];
	guards?: RegExp[];
	/** Why this anchor exists / why a contextual tag cannot fire statically. */
	note: string;
}

/**
 * The anchor table. Extension by addition; anchors may be RE-DERIVED only
 * together with the skill text they cite (test/skill-quality-check.ts pins
 * the current coverage: every expect-role anchor fires on the real texts,
 * every forbid-role anchor stays silent on them).
 */
export const ANCHORS: readonly Anchor[] = [
	// ------------------------------------------------------- expect-role tags
	{ tag: "tool:delegate", role: "expect", fire: [/`delegate` tool/, /delegate_status/], note: "the tool is the primary path (SKILL header)" },
	{ tag: "tool:delegate-mailbox", role: "expect", fire: [/mailbox/], note: "mailbox answers blocked workers (SKILL recovery)" },
	{ tag: "topology:single-direct", role: "expect", fire: [/single one-shot/, /tool alone suffices/], note: "single task → no fan-out (SKILL frontmatter)" },
	{ tag: "topology:fan-out", role: "expect", fire: [/fan-out/, /fan out/], note: "fan-out topologies (SKILL decompose)" },
	{ tag: "mode:worktree", role: "expect", fire: [/worktree isolation/, /one worker = one worktree/], note: "root default: worktree isolation (SKILL spawn)" },
	{ tag: "mode:shared", role: "expect", fire: [/share its checkout/, /shared/], note: "sub-orchestrator workers share the checkout (SKILL spawn)" },
	{ tag: "release:on-started", role: "expect", fire: [/watcher owns the wait/, /release[d]? on start/], note: "release-on-started posture: watcher owns the wait (SKILL recovery)" },
	{ tag: "release:on-settle", role: "expect", fire: [/settle and release windows/, /blocks? until the worker settles/], note: "settle windows are tool-owned vocabulary (SKILL header)" },
	{ tag: "turn:end", role: "expect", fire: [/end your turn/i], note: "end your turn on timeouts (SKILL recovery)" },
	{ tag: "turn:end-after-fleet", role: "expect", fire: [/end your turn right after the fleet/], note: "two-tier: end turn once the fleet is out (SKILL recovery)" },
	{ tag: "verify:report-evidence", role: "expect", fire: [/file:line evidence/], note: "verification demands file:line evidence (SKILL verify)" },
	{ tag: "retry:diagnosed", role: "expect", fire: [/diagnosed retry/i], note: "diagnosed retry mandate (SKILL recovery)" },
	{ tag: "retry:new-name", role: "expect", fire: [/NEW worker name/], note: "retry under a NEW worker name (SKILL recovery)" },
	{ tag: "brief:diagnosed-retry", role: "expect", fire: [/new brief naming the wrong path/], note: "retry brief names wrong path/cause/fix (SKILL recovery)" },
	{ tag: "report:status-fail-honored", role: "expect", fire: [/honest completion/], note: "status-fail report is honest completion (SKILL header)" },
	{ tag: "wait:wake-tool", role: "expect", fire: [/woken when the report lands/, /watcher wakes/], note: "the wake mechanism is the watcher (SKILL recovery)" },
	{ tag: "skill:reference-fallback", role: "expect", fire: [/REFERENCE\.md/], note: "tool-absent fallback pointer (SKILL tail)" },
	{ tag: "brief:file-first", role: "expect", fire: [/one file per worker/, /put it in a file/], note: "briefs are files, prompts point at them (SKILL brief / REFERENCE §2)" },
	{ tag: "brief:disjoint-slices", role: "expect", fire: [/disjoint file lists?/], note: "shared-checkout workers get disjoint file lists per brief (SKILL spawn/decompose)" },
	// ------------------------------------------------------ forbid-role tags
	{
		tag: "wait:sleep",
		role: "forbid",
		fire: [/\bsleep\s+[0-9]/, /sleep\s+in\s+bash/, /sleep(ing)?\s+(to|until)\s+wait/],
		guards: [/never/i, /\bnot\b/i, /don'?t/i, /avoid/i],
		note: "sleep-as-wait teaching; 'Never bash-sleep' is guarded",
	},
	{
		tag: "wait:delegate-rewait",
		role: "forbid",
		fire: [/re-?call (the |a )?(delegate|tool)/, /call delegate again to (wait|check)/],
		guards: [/never/i, /\bnot\b/i, /don'?t/i],
		note: "re-calling delegate to wait; 'never re-call the tool to wait' is guarded",
	},
	{
		tag: "wait:status-poll-loop",
		role: "forbid",
		fire: [/poll[^.]{0,50}(loop|until|repeatedly)/, /polling (status|delegate_status) (until|in a loop|to wait)/],
		guards: [/never/i, /\bnot\b/i],
		note: "polling in a loop instead of ending the turn; 'look-now alternative' does not fire",
	},
	{
		tag: "retry:verbatim",
		role: "forbid",
		fire: [/re-?sen[dt][^]{0,30}(same|original) (brief|prompt)/, /retry (the |with the )?same (brief|prompt)/, /verbatim retry/i],
		guards: [/never/i, /banned/i, /avoid/i, /\bnot\b/i],
		note: "verbatim retry teaching; 'A verbatim retry is a banned move' is guarded",
	},
	{
		tag: "retry:same-name",
		role: "forbid",
		fire: [/same[- ]name (retry|respawn)/, /retry[^]{0,40}same (worker )?name/, /keeps? the (same|old) (name|one)/],
		guards: [/never/i, /\bnot\b/i, /NEW worker name/i],
		note: "same-name retry teaching; '(the settled agent keeps the old one)' is guarded by the NEW-name phrase on the same line",
	},
	{
		tag: "retry:respawn",
		role: "forbid",
		fire: [/respawn/],
		guards: [/never/i, /\bnot\b/i],
		note: "respawn-instead-of-answer/retry teaching; absent from the current texts",
	},
	{
		tag: "turn:escalate-tool-error",
		role: "forbid",
		fire: [/treat[^]{0,40}as a tool error/, /status: "fail"[^]{0,60}(tool error|escalate)/, /escalate[^]{0,40}status: "fail"/],
		guards: [/not a tool error/i, /, not/i, /never/i],
		note: "misreading a valid fail-report as a tool error; 'read it as a result, not a tool error' is guarded",
	},
	{
		tag: "turn:end-idle",
		role: "forbid",
		fire: [/end (your|the|a) turn (idle|without|having taken zero|doing nothing)/],
		guards: [/never/i, /\bnot\b/i],
		note: "ending a turn idle; 'never end a turn having taken zero actions' is guarded",
	},
	// --------------------------------------- contextual forbids: static dead zones
	{ tag: "mode:worktree", role: "forbid", fire: [], note: "CONTEXTUAL (S03: wrong only for sub-orchestrators) — static projection cannot fire it; live replay owns this verdict" },
	{ tag: "mode:shared", role: "forbid", fire: [], note: "CONTEXTUAL (S02: wrong only for root fan-outs) — static projection cannot fire it; live replay owns this verdict" },
	{ tag: "topology:fan-out", role: "forbid", fire: [], note: "CONTEXTUAL (S01: wrong only for single tasks) — static projection cannot fire it; live replay owns this verdict" },
	{ tag: "tool:delegate", role: "forbid", fire: [], note: "CONTEXTUAL (S12: wrong only when the tool is absent) — static projection cannot fire it; live replay owns this verdict" },
];

function anchorFor(tag: string, role: AnchorRole): Anchor | undefined {
	return ANCHORS.find((a) => a.tag === tag && a.role === role);
}

function anchorFires(anchor: Anchor, texts: string[]): boolean {
	return firesOn(texts.join("\n"), anchor.fire, anchor.guards);
}

/** Does (tag, role) fire on the texts? Dead-zone anchors never fire. */
export function firedTag(tag: string, role: AnchorRole, texts: string[]): boolean {
	const anchor = anchorFor(tag, role);
	if (anchor === undefined) return false;
	return anchorFires(anchor, texts);
}

/**
 * The per-scenario projected trace: the scenario's expect tags whose
 * expect-anchor fires + its forbid tags whose forbid-anchor fires. Pure.
 */
export function projectScenarioTrace(scenario: ScenarioDoc, texts: string[]): TraceDoc {
	const steps: Array<{ tag: string }> = [];
	for (const item of scenario.expect) {
		if (firedTag(item.tag, "expect", texts)) steps.push({ tag: item.tag });
	}
	for (const item of scenario.forbid) {
		if (firedTag(item.tag, "forbid", texts)) steps.push({ tag: item.tag });
	}
	return { version: 1, scenario: scenario.id, steps };
}

export interface L2TextResult {
	mean: number;
	perScenario: ScoreResult[];
}

/**
 * Load every scenario from the dir (stage-1 loader, unchanged), project the
 * union texts PER SCENARIO, score with the stage-1 rubric, return mean +
 * per-scenario. Deterministic: same dir + same texts → byte-identical result.
 */
export function scoreScenariosAgainstTexts(
	scenariosDir: string,
	texts: string[],
): { ok: true; result: L2TextResult } | { ok: false; error: string } {
	const listed = listJsonFiles(scenariosDir);
	if (!listed.ok) return listed;
	const perScenario: ScoreResult[] = [];
	for (const name of listed.names) {
		const loaded = loadScenario(join(scenariosDir, name));
		if (!loaded.ok) return loaded;
		const trace = projectScenarioTrace(loaded.scenario, texts);
		perScenario.push(scoreTrace(loaded.scenario, trace));
	}
	const mean =
		perScenario.length === 0
			? 0
			: Math.round((perScenario.reduce((s, r) => s + r.total, 0) / perScenario.length + Number.EPSILON) * 100) / 100;
	return { ok: true, result: { mean, perScenario } };
}

/** Convenience: read the two skill texts from a skill dir. */
export function readSkillTexts(skillDir: string): string[] {
	return ["SKILL.md", "REFERENCE.md"].map((name) => readFileSync(join(skillDir, name), "utf8"));
}
