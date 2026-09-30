/**
 * classifier-check — deterministic checks for the total classifier seam
 * (src/classifier.ts, issue #129 / Milestone #3). Run: bun test/classifier.ts
 *
 * bun caches os.homedir() per process, so the resolveClassifierConfig
 * config-read scenarios run in a child bun process with PI_CODING_AGENT_DIR
 * set at spawn time (the profile-check.ts seam); the classifyReport scenarios
 * inject a fake registry + explicit config in-process.
 *
 * Scenarios: A1 absent section → off; A2 corrupt JSON → off, no throw;
 * A3 partial section → off; A4 valid section → enabled + model; A5 enabled
 * but no model → model undefined; C3 getModelOfType → undefined → null;
 * C4 disabled → null + zero classify calls; C5 happy path →
 * {label:"complete",probability:0.93}; C6 classify rejects → null; C7
 * stopReason:"error" → null; C8 non-choice → null; C9 unknown label → null;
 * C10 classifierNote exact string; C11 classifierDetail raw probability.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyReport, classifierNote, classifierDetail } from "../src/classifier.ts";
import type { ClassifierRegistrySurface, ClassifierConfig } from "../src/classifier.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const AGENT_DIR = mkdtempSync(join(tmpdir(), "classifier-check-"));
const BASE = join(AGENT_DIR, "pi-delegate.config.json");
const CLASSIFIER = new URL("../src/classifier.ts", import.meta.url).pathname;

/** Run resolveClassifierConfig() in a child bun process (agent-dir seam). */
function runResolve(): { ok: true; cfg: Record<string, unknown> } | { ok: false; err: string } {
	const res = spawnSync(
		"bun",
		[
			"-e",
			`import {resolveClassifierConfig} from ${JSON.stringify(CLASSIFIER)};
			 try { console.log(JSON.stringify({ok:true,cfg:resolveClassifierConfig()})); }
			 catch (e) { console.log(JSON.stringify({ok:false,err:String(e)})); }`,
		],
		{ env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR }, encoding: "utf8", timeout: 20_000 },
	);
	try {
		return JSON.parse(res.stdout.toString().trim());
	} catch {
		return { ok: false, err: `child crashed: ${res.stderr.toString().slice(0, 200)}` };
	}
}

// --- A1: absent classifier section → enabled false ---------------------------
writeFileSync(BASE, JSON.stringify({ host: "herdr" }));
{
	const r = runResolve();
	check(
		"A1 absent classifier section → enabled false, no model",
		r.ok && r.cfg.enabled === false && r.cfg.model === undefined,
		JSON.stringify(r).slice(0, 200),
	);
}

// --- A2: corrupt config (invalid JSON) → no throw, enabled false --------------
writeFileSync(BASE, "{not json");
{
	const r = runResolve();
	check(
		"A2 corrupt config → no throw, enabled false",
		r.ok && r.cfg.enabled === false,
		JSON.stringify(r).slice(0, 200),
	);
}

// --- A3: partial classifier section → disabled, no model ---------------------
writeFileSync(
	BASE,
	JSON.stringify({ classifier: { enabled: "yes", model: { provider: 123, id: null } } }),
);
{
	const r = runResolve();
	check(
		"A3 partial classifier section (garbage enabled/model) → disabled, no model",
		r.ok && r.cfg.enabled === false && r.cfg.model === undefined,
		JSON.stringify(r).slice(0, 200),
	);
}

// --- A4: valid classifier section → enabled true + model ---------------------
writeFileSync(
	BASE,
	JSON.stringify({ classifier: { enabled: true, model: { provider: "prov", id: "mod" } } }),
);
{
	const r = runResolve();
	const model = r.ok ? (r.cfg.model as { provider?: string; id?: string } | undefined) : undefined;
	check(
		"A4 valid classifier section → enabled true + model resolved",
		r.ok && r.cfg.enabled === true && model !== undefined && model.provider === "prov" && model.id === "mod",
		JSON.stringify(r).slice(0, 200),
	);
}

// --- A5: enabled true but no model → model undefined -------------------------
writeFileSync(BASE, JSON.stringify({ classifier: { enabled: true } }));
{
	const r = runResolve();
	check(
		"A5 enabled true but no model → model undefined",
		r.ok && r.cfg.enabled === true && r.cfg.model === undefined,
		JSON.stringify(r).slice(0, 200),
	);
}

// --- In-process classifyReport scenarios (fake registry + explicit config) ----
const REPORT = { status: "pass", summary: "done", artifacts: ["a.txt"] };
const CFG_ON: ClassifierConfig = { enabled: true, model: { provider: "p", id: "m" } };

// C3: enabled + model, getModelOfType → undefined → null
{
	const registry: ClassifierRegistrySurface = {
		getModelOfType: () => undefined,
		classify: async () => ({ stopReason: "stop", answers: {} }),
	};
	const v = await classifyReport(registry, REPORT, CFG_ON);
	check("C3 getModelOfType → undefined → null, no throw", v === null);
}

// C3b: a MISSING registry (undefined/null — the fake-host ctx shape) → null,
// never the TypeError the old unguarded access produced on classifier-
// configured hosts (Law 10 regression: classifyReport's contract is total).
{
	const vU = await classifyReport(undefined as unknown as ClassifierRegistrySurface, REPORT, CFG_ON);
	const vN = await classifyReport(null as unknown as ClassifierRegistrySurface, REPORT, CFG_ON);
	check("C3b registry undefined/null → null, no throw (contract: never raises)", vU === null && vN === null);
}

// C4: enabled false (model present) → null AND zero classify calls
{
	let classifyCalls = 0;
	const registry: ClassifierRegistrySurface = {
		getModelOfType: () => ({ model: true }),
		classify: async () => {
			classifyCalls++;
			return { stopReason: "stop", answers: {} };
		},
	};
	const v = await classifyReport(registry, REPORT, { enabled: false, model: { provider: "p", id: "m" } });
	check("C4 enabled false → null and zero classify calls", v === null && classifyCalls === 0, `classifyCalls=${classifyCalls}`);
}

// C5: happy path → { label:"complete", probability:0.93 }
{
	const registry: ClassifierRegistrySurface = {
		getModelOfType: () => ({ model: true }),
		classify: async () => ({
			stopReason: "stop",
			answers: {
				triage: {
					type: "choice",
					choice: "complete",
					probabilities: { complete: 0.93, suspect: 0.07 },
					confidence: 0.93,
				},
			},
		}),
	};
	const v = await classifyReport(registry, REPORT, CFG_ON);
	check(
		"C5 happy path → { label:'complete', probability:0.93 }",
		v !== null && v.label === "complete" && v.probability === 0.93,
		v === null ? "null" : JSON.stringify(v),
	);
}

// C6: classify rejects → null, no throw
{
	const registry: ClassifierRegistrySurface = {
		getModelOfType: () => ({ model: true }),
		classify: async () => {
			throw new Error("auth down");
		},
	};
	const v = await classifyReport(registry, REPORT, CFG_ON);
	check("C6 classify rejects → null, no throw", v === null);
}

// C7: stopReason:"error" → null
{
	const registry: ClassifierRegistrySurface = {
		getModelOfType: () => ({ model: true }),
		classify: async () => ({ stopReason: "error", answers: { triage: { type: "choice", choice: "complete", confidence: 0.9 } } }),
	};
	const v = await classifyReport(registry, REPORT, CFG_ON);
	check("C7 stopReason error → null", v === null);
}

// C8: non-choice answer → null
{
	const registry: ClassifierRegistrySurface = {
		getModelOfType: () => ({ model: true }),
		classify: async () => ({
			stopReason: "stop",
			answers: { triage: { type: "score", score: 0.5, confidence: 0.5 } },
		}),
	};
	const v = await classifyReport(registry, REPORT, CFG_ON);
	check("C8 non-choice answer → null", v === null);
}

// C9: unknown label → null
{
	const registry: ClassifierRegistrySurface = {
		getModelOfType: () => ({ model: true }),
		classify: async () => ({
			stopReason: "stop",
			answers: { triage: { type: "choice", choice: "wibble", probabilities: { wibble: 0.5 }, confidence: 0.5 } },
		}),
	};
	const v = await classifyReport(registry, REPORT, CFG_ON);
	check("C9 unknown label → null", v === null);
}

// C10: classifierNote exact string (2-decimal rounding)
{
	check(
		"C10 classifierNote exact string (0.934 → 'classifier: complete 0.93')",
		classifierNote({ label: "complete", probability: 0.934 }) === "classifier: complete 0.93",
		classifierNote({ label: "complete", probability: 0.934 }),
	);
}

// C11: classifierDetail raw probability (not rounded)
{
	check(
		"C11 classifierDetail raw probability (not rounded)",
		JSON.stringify(classifierDetail({ label: "suspect", probability: 0.934 })) ===
			JSON.stringify({ classifier: { label: "suspect", probability: 0.934 } }),
		JSON.stringify(classifierDetail({ label: "suspect", probability: 0.934 })),
	);
}

rmSync(AGENT_DIR, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\nclassifier-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nclassifier-check: all green");
process.exit(0);
