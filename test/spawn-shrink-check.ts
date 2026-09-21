/**
 * spawn-shrink-check — Law 6 pins for the spawn.ts execute() closure shrink
 * (ARCHITECTURE.md Law 5 continuation of the wave-3 decomposition).
 *
 * Run with: bun test/spawn-shrink-check.ts   (from repo root; no live herdr).
 *
 * The shrink moved the execute() phases that read NO closure mutable state
 * out of the closure: the pre-placement name/brief validation and the
 * dual-gauge governor moved to src/pre-placement.ts; the tier-mismatch
 * detection, the brief-reportSchema violation note and the last-live-worker
 * nudge became module-level functions, and the Law 5 continuation moved the
 * whole pure-phase region (tier/provider/model resolution, brief report-schema
 * resolution included) to src/spawn-phases.ts — spawn.ts imports the five
 * phases from there. Prose rules rot, so
 * every rule this move introduced is pinned here (Law 6) — test/static-check.ts
 * is deliberately NOT touched by this file.
 *
 * Covers:
 *   P1  the wiring: src/spawn.ts imports both pre-placement phases and calls
 *       them BEFORE any transport.place() — the fail-fast-before-touching-
 *       the-host order the moved region had is the order the calls have.
 *   P2  verbatim single spelling: each moved E_* / guidance text exists
 *       EXACTLY once across src/, in the module that owns the phase now, and
 *       byte-for-byte matches the literal the closure spelled before the move
 *       (the user-visible surface is frozen; a rewrite that rewords a moved
 *       text fails here, not in the field).
 *   P3  the forbidden rewrite stays dead: none of the seven closure-scoped
 *       mutables spawn.ts's MODULE_CONTRACT names as the shared phase state
 *       is threaded into an extracted phase as an input field.
 *   P4  the AS-IS design holds: all seven mutables are still declared inside
 *       the execute() closure.
 *   P5  the DAG holds: src/pre-placement.ts and src/spawn-phases.ts never
 *       import src/spawn.ts (spawn is the root consumer).
 *   P7  behavior through the REAL tool: the three refusals the moved region
 *       owns come back byte-identical — E_NAME, E_CONTEXT, E_BUDGET — and
 *       none of them ever reaches transport.place().
 *
 * Fail-fast (AGENTS.md command discipline): a top-level watchdog exits
 * non-zero no matter what; every wait inside the drivers carries its own
 * deadline (the fake transport never blocks).
 *
 * Exit 0 only if all pins hold.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const watchdog = setTimeout(() => {
	console.error("SPAWN-SHRINK CHECK WATCHDOG FIRED (a driver hung)");
	process.exit(1);
}, 20_000);
watchdog.unref();

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const SRC = resolve(ROOT, "src");

// Sandbox the exchange root BEFORE anything touches it (the same idiom as
// test/silent-catch-check.ts) so the drivers never write into the live root.
const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), "spawn-shrink-exchange-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function readSrc(rel: string): string {
	return readFileSync(resolve(SRC, rel), "utf8");
}

const spawnSrc = readSrc("spawn.ts");
const preSrc = readSrc("pre-placement.ts");
const phasesSrc = readSrc("spawn-phases.ts");
const allSrc = spawnSrc + "\n" + preSrc;

// ---------------------------------------------------------------------------
// P1. Wiring — both phases are called before the first transport.place().
// ---------------------------------------------------------------------------

{
	check(
		"P1.1 src/spawn.ts imports the two pre-placement phases from src/pre-placement.ts",
		/import \{\s*applyGaugeGovernor,\s*validateNameAndBrief\s*\} from "\.\/pre-placement\.ts"/.test(spawnSrc),
	);
	const callNameBrief = spawnSrc.indexOf("validateNameAndBrief({");
	const callGovernor = spawnSrc.indexOf("applyGaugeGovernor({");
	const firstPlace = spawnSrc.indexOf("await transport.place({");
	check(
		"P1.2 execute() calls validateNameAndBrief, then applyGaugeGovernor, then place() — the moved region's fail-fast order",
		callNameBrief > 0 && callGovernor > callNameBrief && firstPlace > callGovernor,
		`nameBrief=${callNameBrief} governor=${callGovernor} place=${firstPlace}`,
	);
	check(
		"P1.3 the governor's refusal line and window come back through the result (maxPct + contextWindow), not through closure recomputation",
		/const \{ maxPct, contextWindow \} = governor;/.test(spawnSrc) &&
			// the closure must not re-derive either value itself any more
			!/const maxPct = params\.maxContextPct \?\? CONTEXT_WARN_PCT;/.test(spawnSrc) &&
			!/const contextWindow = resolveContextWindow\(model\);/.test(spawnSrc),
	);
	check(
		"P1.4 the manifest dir is the phase's result (the probe-dir fallback moved with it)",
		/const manifestDir = nameBrief\.manifestDir;/.test(spawnSrc) &&
			existsSync(resolve(SRC, "pre-placement.ts")) &&
			/function probeExchangeDir\(\): string \{/.test(preSrc) &&
			/return \{ ok: true, manifestDir: exchangeDir \?\? probeExchangeDir\(\) \};/.test(preSrc) &&
			!/probeExchangeDir/.test(spawnSrc),
	);
}

// ---------------------------------------------------------------------------
// P2. Verbatim single spelling of every moved user-visible text.
// ---------------------------------------------------------------------------

{
	// (text, owning module) — the literals are the ones the execute() closure
	// spelled before the extraction; they are the frozen user-visible surface.
	// Owner "spawn-phases.ts" = the pure-phase region moved there verbatim
	// (Law 5 continuation); the text must exist EXACTLY once across the three
	// extraction modules combined, and once in the owner.
	const moved: Array<[string, string, string]> = [
		[
			'E_NAME — invalid worker name "${name}". ',
			"pre-placement.ts",
			"E_NAME refusal (the interpolation reads the destructured `name`)",
		],
		[
			"Names must match [a-z][a-z0-9_-]{0,31}; use the canonical name (read back at start) when retrying.",
			"pre-placement.ts",
			"E_NAME guidance",
		],
		[
			"Write the brief file under ${exchangeRoot()}/<task>/ first, then call delegate again.",
			"pre-placement.ts",
			"E_BRIEF generic guidance",
		],
		[
			"E_BRIEF — ${errText(err)}\\n${guidance}",
			"pre-placement.ts",
			"E_BRIEF text",
		],
		[
			"E_CONTEXT — worker session near compaction (ctx ${pct}% ≥ ${maxPct}%): its next prompt would compact and lose the brief. ",
			"pre-placement.ts",
			"E_CONTEXT refusal text",
		],
		[
			"Start a NEW worker name (diagnosed retry = new brief + fresh context).",
			"pre-placement.ts",
			"E_CONTEXT guidance",
		],
		[
			"E_BUDGET — worker over OUTPUT budget (${priorUsage.output} > ${budgetTokens} tokens). ",
			"pre-placement.ts",
			"E_BUDGET refusal text (the interpolation reads the destructured budgetTokens — same value)",
		],
		[
			"Pick a NEW worker name or pass an explicit higher budgetTokens; budget decline across diagnosed retries is orchestrator policy.",
			"pre-placement.ts",
			"E_BUDGET guidance",
		],
		[
			"brief declares ${declared} tier but worker runs ${modelStr} — tier mismatch",
			"spawn-phases.ts",
			"tier-mismatch warning text",
		],
		[
			"\\nThis is a brief-reportSchema violation: the report violates the brief's reportSchema — ",
			"spawn-phases.ts",
			"reportSchema violation guidance",
		],
		[
			"`\\nschema held: ${fragmentJson.length > 300 ? `${fragmentJson.slice(0, 300)}…` : fragmentJson}`",
			"spawn-phases.ts",
			"schema-held quote",
		],
		[
			"`\\nschema provenance: ${schemaProvenance.join(\" → \")}`",
			"spawn-phases.ts",
			"schema-provenance chain line",
		],
	];
	for (const [literal, owner, label] of moved) {
		const inSpawn = spawnSrc.split(literal).length - 1;
		const inPre = preSrc.split(literal).length - 1;
		const inPhases = phasesSrc.split(literal).length - 1;
		const total = inSpawn + inPre + inPhases;
		const inOwner = owner === "spawn.ts" ? inSpawn : owner === "pre-placement.ts" ? inPre : inPhases;
		check(
			`P2 single spelling in ${owner} — ${label}`,
			total === 1 && inOwner === 1,
			`spawn.ts=${inSpawn} pre-placement.ts=${inPre} spawn-phases.ts=${inPhases}`,
		);
	}
}

// ---------------------------------------------------------------------------
// P3 + P4. The seven closure mutables: never threaded out, still closure-bound.
// ---------------------------------------------------------------------------

{
	const mutables = [
		"sessionPath",
		"manifestWarning",
		"reportPath",
		"tierWarning",
		"questionDetected",
		"lastBeat",
		"settleAbort",
	];
	// P3: the input interfaces of the extracted phases. A mutable appearing as
	// a DECLARED FIELD would mean the phase was made extractable by threading
	// closure state through parameters — the rewrite the AS-IS decision forbids.
	const ifaceParts: Array<string> = [
		/export interface NameBriefInput \{[\s\S]*?\n\}/.exec(preSrc)?.[0] ?? "",
		/export interface GaugeGovernorInput \{[\s\S]*?\n\}/.exec(preSrc)?.[0] ?? "",
		/export interface TierResolutionInput \{[\s\S]*?\n\}/.exec(phasesSrc)?.[0] ?? "",
		/export interface SchemaResolutionInput \{[\s\S]*?\n\}/.exec(phasesSrc)?.[0] ?? "",
		/export interface TierMismatchInput \{[\s\S]*?\n\}/.exec(phasesSrc)?.[0] ?? "",
		/export interface SchemaViolationNoteInput \{[\s\S]*?\n\}/.exec(phasesSrc)?.[0] ?? "",
	];
	const ifaceSrc = ifaceParts.join("\n");
	check("P3.1 all six extracted-phase input interfaces were found", ifaceParts.every((p) => p.length > 0));
	for (const m of mutables) {
		const fieldShape = new RegExp(`(^|\\n)\\s*(readonly\\s+)?${m}\\??\\s*[:,]`, "m");
		check(
			`P3.2 no extracted phase takes "${m}" as an input field (no closure state through parameters)`,
			!fieldShape.test(ifaceSrc),
		);
	}
	// P4: the closure keeps the shared phase state it is designed around.
	const declarations: Array<[string, string]> = [
		["let sessionPath", "sessionPath"],
		["let manifestWarning", "manifestWarning"],
		["let reportPath", "reportPath"],
		["const tierWarning", "tierWarning (computed by the pure phase, stored by the closure)"],
		["let questionDetected", "questionDetected"],
		["let lastBeat", "lastBeat"],
		["const settleAbort", "settleAbort"],
	];
	for (const [shape, label] of declarations) {
		check(`P4 execute() still declares its shared phase state: ${label}`, spawnSrc.includes(shape));
	}
}

// ---------------------------------------------------------------------------
// P5. DAG — the new module never reaches back up to spawn.ts.
// ---------------------------------------------------------------------------

{
	const relativeImports = preSrc.match(/from\s*["']\.[^"']*["']/g) ?? [];
	check(
		"P5 src/pre-placement.ts imports no spawn module (spawn stays the root consumer)",
		relativeImports.every((i) => !i.includes("spawn")),
		relativeImports.join(", "),
	);
	const phasesImports = phasesSrc.match(/from\s*["']\.[^"']*["']/g) ?? [];
	check(
		"P5b src/spawn-phases.ts imports no spawn module (spawn stays the root consumer)",
		phasesImports.every((i) => !i.includes("spawn")),
		phasesImports.join(", "),
	);
}

// ---------------------------------------------------------------------------
// P7. Behavior through the REAL delegate tool — the three moved refusals.
// (The P6 nudge pins were retired with the fleet-idle nudge itself — the
// ambient UI removal took the notifyFleetIdle surface with it; the caller
// sites in spawn.ts were deleted in the same change.)
// ---------------------------------------------------------------------------

{
	const { registerDelegateTool } = await import("../src/spawn.ts");
	const { manifestStore } = await import("../src/manifest-store.ts");
	const { ensureExchangeDir } = await import("../src/exchange.ts");
	const { resolveContextWindow } = await import("../src/usage.ts");

	let placeCalls = 0;
	const transport = {
		place: async () => {
			placeCalls++;
			return { kind: "tab", checkoutPath: "/tmp/spawn-shrink-nowhere", placementRef: "fake:1" };
		},
		startAgent: async () => {
			throw new Error("must never be reached — every P7 driver refuses before place()");
		},
		submitPrompt: async () => {},
		waitSettle: async () => ({ kind: "settled", status: "idle" }),
		getStatus: async () => null,
		listStatuses: async () => [],
		teardown: async () => ({ alreadyGone: false }),
		capabilities: () => ({ worktrees: true, authority: "root" }),
		backendName: () => "fake",
	} as never;

	let captured:
		| { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> }
		| undefined;
	registerDelegateTool({ registerTool: (t: never) => (captured = t as never) } as never, transport as never);
	if (!captured) {
		check("P7.0 the delegate tool was captured", false);
	} else {
		const execute = captured.execute;
		const ctx = { cwd: EXCHANGE_SANDBOX, hasUI: false };
		const textOf = (r: { content: Array<{ type: string; text: string }> }) =>
			r.content.map((c) => c.text).join("");

		// P7.1 E_NAME — invalid name, nothing touched.
		{
			const res = await execute(
				"t-name",
				{ name: "BAD NAME", briefPath: join(EXCHANGE_SANDBOX, "p7", "brief-x.md"), provider: "p", model: "m", thinking: "low" },
				undefined,
				undefined,
				ctx,
			);
			check(
				"P7.1 E_NAME comes back byte-identical and place() is never called",
				res.details.code === "E_NAME" &&
					res.content[0].text ===
						'E_NAME — invalid worker name "BAD NAME". ' +
						"Names must match [a-z][a-z0-9_-]{0,31}; use the canonical name (read back at start) when retrying." &&
					placeCalls === 0,
				`${res.details.code} :: ${res.content[0].text}`,
			);
		}

		// A task dir + brief for the governor drivers (the phase creates the dir,
		// the driver then seeds the manifest with a prior embodiment).
		const taskDir = join(EXCHANGE_SANDBOX, "p7");
		mkdirSync(taskDir, { recursive: true });
		const briefPath = join(taskDir, "brief-gov.md");
		writeFileSync(briefPath, "# brief gov\n\nDo the thing.\n");
		const dir = ensureExchangeDir(briefPath).dir;
		const sessionFile = join(EXCHANGE_SANDBOX, "prior-session.jsonl");
		const window = resolveContextWindow("shrink-test-model");

		const seed = async (sessionPath: string) => {
			await manifestStore.update(dir, (m) => ({
				...m,
				workers: [
					...m.workers,
					{
						name: "shrink-gov",
						placement: { kind: "tab", checkoutPath: "/tmp/spawn-shrink-nowhere", placementRef: "fake:0" },
						briefPath,
						reportPath: join(dir, "report-shrink-gov.json"),
						provider: "p",
						model: "shrink-test-model",
						thinking: "low",
						startedAt: new Date(Date.now() - 60_000).toISOString(),
						sessionPath,
					},
				],
			}));
		};

		// P7.2 E_CONTEXT — the prior session sits at/over the refusal line.
		{
			writeFileSync(
				sessionFile,
				JSON.stringify({ message: { role: "assistant", usage: { input: 10, output: 20, totalTokens: Math.round(window * 0.9) } } }) + "\n",
			);
			await seed(sessionFile);
			const res = await execute(
				"t-ctx",
				{ name: "shrink-gov", briefPath, provider: "p", model: "shrink-test-model", thinking: "low", maxContextPct: 50, repoPath: EXCHANGE_SANDBOX },
				undefined,
				undefined,
				ctx,
			);
			const pct = Math.min(999, Math.round((Math.round(window * 0.9) / window) * 100));
			check(
				"P7.2 E_CONTEXT comes back with the gauge payload and place() is never called",
				res.details.code === "E_CONTEXT" &&
					res.content[0].text.startsWith(
						`E_CONTEXT — worker session near compaction (ctx ${pct}% ≥ 50%): its next prompt would compact and lose the brief. `,
					) &&
					res.details.maxPct === 50 &&
					res.details.contextWindow === window &&
					(res.details.usage as { output: number }).output === 20 &&
					placeCalls === 0,
				`${res.details.code} :: ${res.content[0].text}`,
			);
		}

		// P7.3 E_BUDGET — under the context line, over the OUTPUT budget.
		{
			writeFileSync(
				sessionFile,
				JSON.stringify({ message: { role: "assistant", usage: { input: 10, output: 5000, totalTokens: Math.round(window * 0.1) } } }) + "\n",
			);
			await manifestStore.update(dir, (m) => ({ ...m, workers: [] }));
			await seed(sessionFile);
			const res = await execute(
				"t-budget",
				{ name: "shrink-gov", briefPath, provider: "p", model: "shrink-test-model", thinking: "low", budgetTokens: 100, repoPath: EXCHANGE_SANDBOX },
				undefined,
				undefined,
				ctx,
			);
			check(
				"P7.3 E_BUDGET comes back byte-identical and place() is never called",
				res.details.code === "E_BUDGET" &&
					res.content[0].text ===
						"E_BUDGET — worker over OUTPUT budget (5000 > 100 tokens). " +
						"Pick a NEW worker name or pass an explicit higher budgetTokens; budget decline across diagnosed retries is orchestrator policy." &&
					res.details.budget === 100 &&
					placeCalls === 0,
				`${res.details.code} :: ${res.content[0].text}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// P8. Issue #25: the swarm identity env the spawn flow exports.
// ---------------------------------------------------------------------------

{
	const { buildSwarmEnv } = await import("../src/spawn.ts");
	const env = buildSwarmEnv({ task: "t-x", worker: "w-1", schemaDir: "/proj/.pi/delegate-schemas" });
	check(
		"P8.1 buildSwarmEnv exports exactly SWARM_TASK / SWARM_WORKER / SWARM_SCHEMA_DIR",
		JSON.stringify(env) ===
			JSON.stringify({ SWARM_TASK: "t-x", SWARM_WORKER: "w-1", SWARM_SCHEMA_DIR: "/proj/.pi/delegate-schemas" }),
		JSON.stringify(env),
	);
}

clearTimeout(watchdog);
if (failures > 0) {
	console.error(`\n${failures} SPAWN-SHRINK CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL SPAWN-SHRINK CHECKS PASSED");
