/**
 * T-fleet-split — Law 6 machine-enforcement of the fleet.ts decomposition DAG.
 *
 * Run with: bun test/fleet-split-check.ts   (from repo root)
 *
 * These pins are the machine-checked layering of the fleet modules
 * (ARCHITECTURE.md Law 5): ui-text.ts (leaf), worker-view.ts (the shared
 * read-model), fleet-widget.ts (the ambient live-rows widget — the only
 * visual indicator that workers are running) and src/fleet.ts (ownership +
 * a narrow re-export facade). The /delegate-fleet overlay was REMOVED
 * (operator decision) — its pins went with it. Prose layering rots (Law 6);
 * these scans make the DAG a build failure if anyone re-introduces a
 * forbidden edge.
 *
 * The acyclic layering pinned here:
 *   ui-text.ts          imports NO src/ module (a leaf).
 *   worker-view.ts      imports NO fleet module (it sits below the widget
 *                       and the facade).
 *   fleet-widget.ts     imports NO overlay module (the overlay was removed;
 *                       this pin guards against re-introducing a sibling).
 *   fleet.ts            imports NO fleet-widget.ts — the facade re-exports
 *                       ONLY the two lower layers (ui-text, worker-view);
 *                       re-exporting the widget would re-form the cycle it
 *                       imports ownership through.
 *   (none of the four)  imports observe.ts — the observe→fleet edge stays
 *                       one-way (T1.8 complement).
 *   FLEET_STALE_AFTER_MS is the transparent alias of the ONE stale threshold
 *   imported from usage.ts (WATCH_DEFAULT_STALE_AFTER_MS) — never a copied
 *   literal, never sourced from observe.ts (Law 9 single source of truth).
 *
 * Fail-fast (AGENTS.md command discipline): a top-level watchdog exits
 * non-zero no matter what; the check itself is pure synchronous source scans
 * and cannot await anything unbounded.
 *
 * Exit 0 only if all pins hold.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const watchdog = setTimeout(() => {
	console.error("FLEET-SPLIT CHECK WATCHDOG FIRED (a scan hung)");
	process.exit(1);
}, 20_000);
watchdog.unref();

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const SRC = resolve(ROOT, "src");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function read(rel: string): string {
	return readFileSync(resolve(SRC, rel), "utf8");
}

/** Every relative module specifier a file pulls in via `import ... from "…"`
 *  or `export { … } from "…"` — the import graph edges, stripped of comments
 *  so a prose mention of a module name never counts as an edge. */
function relativeSpecifiers(src: string): string[] {
	const noComments = src
		.replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc headers)
		.replace(/(^|\n)\s*\/\/[^\n]*/g, "$1"); // line comments
	const specs: string[] = [];
	const re = /(?:from|import)\s*["'](\.\/[^"']+)["']/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(noComments)) !== null) specs.push(m[1]!);
	return specs;
}

/** Basename (without extension) of each relative specifier a file imports. */
function importedBasenames(rel: string): string[] {
	return relativeSpecifiers(read(rel)).map((s) => s.replace(/^\.\//, "").replace(/\.ts$/, ""));
}

// --- 0. the split landed: every planned module exists ----------------------
const NEW_MODULES = ["ui-text.ts", "worker-view.ts", "fleet-widget.ts", "fleet.ts"];
for (const m of NEW_MODULES) {
	check(`S0 ${m} exists`, existsSync(resolve(SRC, m)));
}

// --- 1. ui-text.ts is a leaf (imports no src/ module) ----------------------
{
	const imports = relativeSpecifiers(read("ui-text.ts"));
	check("S1 ui-text.ts imports NO src/ module (leaf)", imports.length === 0, imports.join(", "));
}

// --- 2. worker-view.ts sits below the fleet UI (imports no fleet module) ---
{
	const bad = importedBasenames("worker-view.ts").filter((b) =>
		["fleet", "fleet-widget"].includes(b),
	);
	check("S2 worker-view.ts imports no fleet/fleet-widget", bad.length === 0, bad.join(", "));
}

// --- 5. the facade never imports the top layer (cycle guard) ---------------
{
	const bad = importedBasenames("fleet.ts").filter((b) => ["fleet-widget"].includes(b));
	check("S5 fleet.ts imports no fleet-widget (no facade↔UI cycle)", bad.length === 0, bad.join(", "));
}

// --- 6. observe→fleet stays one-way (T1.8 complement) ----------------------
{
	const offenders = ["fleet.ts", "ui-text.ts", "worker-view.ts", "fleet-widget.ts"].filter(
		(m) => importedBasenames(m).includes("observe"),
	);
	check("S6 no fleet module imports observe.ts", offenders.length === 0, offenders.join(", "));
}

// --- 7. the widget consumes ownership FROM fleet.ts (the one edge) ---------
{
	const widgetOk = importedBasenames("fleet-widget.ts").includes("fleet");
	check("S7 fleet-widget.ts imports ownership from fleet.ts", widgetOk);
}

// --- 9. the facade re-exports the two lower layers (importer compatibility) -
{
	const fleet = read("fleet.ts");
	const reExportsUiText = /export\s*\{[^}]*stripAnsi[^}]*\}\s*from\s*["']\.\/ui-text\.ts["']/.test(fleet);
	const reExportsWorkerView =
		/export\s*\{[^}]*buildWorkerView[^}]*\}\s*from\s*["']\.\/worker-view\.ts["']/.test(fleet);
	check("S9 fleet.ts re-exports the ui-text primitives", reExportsUiText);
	check("S9 fleet.ts re-exports the worker-view read-model", reExportsWorkerView);
}

// --- 10. Law 5 size line: the facade is no longer a parking lot ------------
{
	const lines = read("fleet.ts").split("\n").length;
	check("S10 fleet.ts is ≤ 500 lines (ownership + facade only)", lines <= 500, `${lines} lines`);
}

if (failures > 0) {
	console.error(`\n${failures} fleet-split check(s) FAILED`);
	process.exit(1);
}
clearTimeout(watchdog);
console.log("\nALL FLEET-SPLIT CHECKS PASSED");
