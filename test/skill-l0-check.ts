/**
 * pi-delegate — test/skill-l0-check.ts — the BM-1 L0 gate (issue #110):
 * static pins over skills/delegate/SKILL.md + REFERENCE.md.
 *
 * Auto-discovered by test/run-checks.sh (flat test/*.ts glob) — this file IS
 * the "L0 on CI for skill paths" wiring of BM-7 (#116); no workflow edits.
 *
 * Run with: bun test/skill-l0-check.ts   (from repo root)
 * External bound: `timeout 30 bun test/skill-l0-check.ts` (the runner's
 * default CHECK_TIMEOUT); the check is pure file reads + regex — fail-fast.
 *
 * Covers:
 *   P1  engine semantics — forbid fires on a matching UNGUARDED line; a
 *       guard line never fires; require fails only when nothing matches.
 *   P2  every FORBID pin fires on its synthetic violation text (red proof).
 *   P3  every FORBID pin stays silent on the guard phrasings the good text
 *       uses ("never verbatim", "not a tool error", …) — negation teaching
 *       must not fire the pin.
 *   P4  every REQUIRE pin passes against the real texts (green proof on the
 *       merged skill) and fails against text with the anchor removed.
 *   P5  THE GATE — runPins over the real SKILL.md + REFERENCE.md: zero
 *       violations. Any violation prints pin/line/excerpt/source and fails
 *       (non-zero exit — issue #110's "non-zero exit on violations").
 *   P6  determinism — two runs byte-identical.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { L0_PINS, runPin, runPins, type Pin } from "./skill/l0/pins.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(import.meta.dir, "..");
const SKILL = readFileSync(join(ROOT, "skills/delegate/SKILL.md"), "utf8");
const REFERENCE = readFileSync(join(ROOT, "skills/delegate/REFERENCE.md"), "utf8");

// ---------------------------------------------------------------------------
// P1 — engine semantics
// ---------------------------------------------------------------------------

{
	const pin: Pin = {
		id: "synthetic-forbid",
		kind: "forbid",
		target: "SKILL.md",
		description: "synthetic",
		fire: [/sleep\s+\d/],
		guards: [/never/i],
		source: "synthetic",
	};
	check(
		"P1: forbid fires on an unguarded item, not on a guarded one",
		// Separate items (blank line): the guarded sentence cannot exempt its
		// neighbor; inside ONE item the guard would exempt the fire.
		runPin(pin, "wait with sleep 60\n\nnever sleep 60 to wait\n").length === 1 &&
			runPin(pin, "wait with sleep 60, never do that\n").length === 0,
	);
	check(
		"P1: forbid silent when no line matches",
		runPin(pin, "no waiting here\n").length === 0,
	);
	const req: Pin = {
		id: "synthetic-require",
		kind: "require",
		target: "SKILL.md",
		description: "synthetic",
		fire: [/merge gate/],
		source: "synthetic",
	};
	check("P1: require passes on match, fails on absence", runPin(req, "the merge gate owns order").length === 0 && runPin(req, "nothing").length === 1);
	check(
		"P1: violations carry 1-based line numbers",
		runPin(pin, "a\nb\nwait with sleep 30\n")[0]?.line === 3,
	);
}

// ---------------------------------------------------------------------------
// P2 — every FORBID pin fires on its synthetic violation text
// ---------------------------------------------------------------------------

/** One deliberately bad line per forbid pin — the red proof. */
const FORBID_RED: Record<string, string> = {
	"F1-herdr-primary-path": "Spawn workers with `herdr agent start` and collect via `herdr agent read`.",
	"F2-sleep-as-wait": "Wait for the worker: sleep 120 then check again.",
	"F3-status-done-completion": "The worker is complete when herdr shows status done for it.",
	"F4-default-posture-fight": "The delegate call blocks until settle by default; pass waitMs to change that.",
	"F5-report-path-in-output": "OUTPUT — write the report path /tmp/exchange/t/report-bob.json in strict JSON.",
	"F6-verbatim-same-name-retry": "On failure, retry verbatim under the same worker name to keep history clean.",
	"F7-ref-not-primary": "This reference is the primary path for all spawning in this repo.",
};

{
	for (const pin of L0_PINS) {
		if (pin.kind !== "forbid") continue;
		const bad = FORBID_RED[pin.id];
		if (bad === undefined) {
			failures++;
			console.error(`FAIL  P2: no synthetic red line for forbid pin ${pin.id}`);
			continue;
		}
		const target = pin.target === "SKILL.md" ? bad : "";
		const other = pin.target === "SKILL.md" ? "" : bad;
		check(
			`P2: ${pin.id} fires on its synthetic violation`,
			runPin(pin, target).length > 0 || runPin(pin, other).length > 0,
			bad,
		);
	}
}

// ---------------------------------------------------------------------------
// P3 — guard phrasings (the good text's negations) never fire a forbid pin
// ---------------------------------------------------------------------------

const GUARD_LINES = [
	"Diagnosed retry, never verbatim — under a NEW worker name.",
	"`status: \"fail\"` in a valid report is an honest completion: read it as a result, not a tool error.",
	"Never bash-sleep and never re-call the tool to wait.",
	"OUTPUT (acceptance criteria only — the tool's own prompt carries the report path and report contract).",
	"never end a turn having taken zero actions",
];

{
	for (const pin of L0_PINS) {
		if (pin.kind !== "forbid" || pin.target !== "SKILL.md") continue;
		const hits = GUARD_LINES.flatMap((line) => runPin(pin, line));
		check(`P3: ${pin.id} silent on guard/negation phrasings`, hits.length === 0, JSON.stringify(hits));
	}
}

// ---------------------------------------------------------------------------
// P4 — every REQUIRE pin passes on the real texts, fails when the anchor is gone
// ---------------------------------------------------------------------------

{
	const emptySkill = SKILL.replace(/`delegate`/g, "").replace(/[^\n]/g, (c) => (c === "\n" ? "\n" : "x"));
	for (const pin of L0_PINS) {
		if (pin.kind !== "require") continue;
		const real = pin.target === "SKILL.md" ? SKILL : REFERENCE;
		check(`P4: ${pin.id} satisfied by the real ${pin.target}`, runPin(pin, real).length === 0, pin.fire.map((r) => String(r)).join(" "));
		// Blanked text (spaces preserve line structure) must fail every require.
		check(`P4: ${pin.id} fails on anchor-free text`, runPin(pin, emptySkill).length === 1);
	}
}

// ---------------------------------------------------------------------------
// P5 — THE GATE: the real texts pass the full table
// ---------------------------------------------------------------------------

{
	const result = runPins(SKILL, REFERENCE);
	check(
		`P5: real skill passes all ${result.pinsChecked} L0 pins`,
		result.verdictPass,
		result.violations
			.map((v) => `${v.pin} ${v.target}:${v.line} ${v.excerpt}`)
			.join(" | "),
	);
	for (const v of result.violations) {
		console.error(`L0 VIOLATION ${v.pin} ${v.target}:${v.line} — ${v.description}`);
		console.error(`  excerpt: ${v.excerpt}`);
		console.error(`  source:  ${v.source}`);
	}
}

// ---------------------------------------------------------------------------
// P6 — determinism
// ---------------------------------------------------------------------------

{
	const a = JSON.stringify(runPins(SKILL, REFERENCE));
	const b = JSON.stringify(runPins(SKILL, REFERENCE));
	check("P6: repeated runs byte-identical", a === b);
}

if (failures > 0) {
	console.error(`\n${failures} L0 check(s) FAILED`);
	process.exit(1);
}
console.log("\nall skill-l0 checks passed");
