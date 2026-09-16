/**
 * T-fleet-split — Law 6 machine-enforcement of the fleet.ts decomposition DAG.
 *
 * Run with: bun test/fleet-split-check.ts   (from repo root)
 *
 * These pins are the machine-checked layering of the modules the old
 * src/fleet.ts was split into (ARCHITECTURE.md Law 5): ui-text.ts (leaf),
 * worker-view.ts (the shared read-model), fleet-widget.ts and fleet-overlay.ts
 * (the two independent UI surfaces), and src/fleet.ts (ownership + a narrow
 * re-export facade). Prose layering rots (Law 6); these scans make the DAG a
 * build failure if anyone re-introduces a forbidden edge.
 *
 * The acyclic layering pinned here:
 *   ui-text.ts          imports NO src/ module (a leaf).
 *   worker-view.ts      imports NO fleet module (it sits below widget/overlay
 *                       and the facade).
 *   fleet-widget.ts     imports NO fleet-overlay.ts   (siblings never depend
 *   fleet-overlay.ts    imports NO fleet-widget.ts     on each other).
 *   fleet.ts            imports NO fleet-widget.ts / fleet-overlay.ts — the
 *                       facade re-exports ONLY the two lower layers
 *                       (ui-text, worker-view); re-exporting widget/overlay
 *                       would re-form the cycle they import ownership through.
 *   (none of the five)  imports observe.ts — the observe→fleet edge stays
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
const NEW_MODULES = ["ui-text.ts", "worker-view.ts", "fleet-widget.ts", "fleet-overlay.ts"];
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
		["fleet", "fleet-widget", "fleet-overlay"].includes(b),
	);
	check("S2 worker-view.ts imports no fleet/fleet-widget/fleet-overlay", bad.length === 0, bad.join(", "));
}

// --- 3/4. widget and overlay are independent siblings ----------------------
{
	const w = importedBasenames("fleet-widget.ts").includes("fleet-overlay");
	check("S3 fleet-widget.ts imports no fleet-overlay", !w);
	const o = importedBasenames("fleet-overlay.ts").includes("fleet-widget");
	check("S4 fleet-overlay.ts imports no fleet-widget", !o);
}

// --- 5. the facade never imports the top layer (cycle guard) ---------------
{
	const bad = importedBasenames("fleet.ts").filter((b) => ["fleet-widget", "fleet-overlay"].includes(b));
	check("S5 fleet.ts imports no fleet-widget/fleet-overlay (no facade↔UI cycle)", bad.length === 0, bad.join(", "));
}

// --- 6. observe→fleet stays one-way (T1.8 complement) ----------------------
{
	const offenders = ["fleet.ts", "ui-text.ts", "worker-view.ts", "fleet-widget.ts", "fleet-overlay.ts"].filter(
		(m) => importedBasenames(m).includes("observe"),
	);
	check("S6 no fleet module imports observe.ts", offenders.length === 0, offenders.join(", "));
}

// --- 7. widget and overlay consume ownership FROM fleet.ts (the one edge) --
{
	const widgetOk = importedBasenames("fleet-widget.ts").includes("fleet");
	const overlayOk = importedBasenames("fleet-overlay.ts").includes("fleet");
	check("S7 fleet-widget.ts imports ownership from fleet.ts", widgetOk);
	check("S7 fleet-overlay.ts imports ownership from fleet.ts", overlayOk);
}

// --- 8. FLEET_STALE_AFTER_MS is the ONE shared threshold (Law 9) -----------
{
	const overlay = read("fleet-overlay.ts");
	const importsWatch =
		/import\s*\{[^}]*\bWATCH_DEFAULT_STALE_AFTER_MS\b[^}]*\}\s*from\s*["']\.\/usage\.ts["']/.test(overlay);
	const aliasOnly = /export const FLEET_STALE_AFTER_MS = WATCH_DEFAULT_STALE_AFTER_MS;/.test(overlay);
	// no numeric literal assigned to the stale threshold (would be a copy)
	const literalCopy = /FLEET_STALE_AFTER_MS\s*=\s*\d/.test(overlay);
	check("S8 fleet-overlay imports WATCH_DEFAULT_STALE_AFTER_MS from usage.ts", importsWatch);
	check("S8 FLEET_STALE_AFTER_MS is a transparent alias of the shared constant", aliasOnly && !literalCopy);
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
