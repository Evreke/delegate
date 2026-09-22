/**
 * herdr-split-check — Law 6 pins for the src/herdr/ decomposition wave.
 *
 * Run with: bun test/herdr-split-check.ts   (from repo root; no live herdr).
 *
 * The ARCHITECTURE.md Law 5 split of src/herdr/host.ts created three new
 * dependency edges inside the herdr adapter (host.ts → cli.ts / socket.ts /
 * map.ts). Prose rules rot, so every rule that split introduced is pinned here
 * (Law 6) — test/static-check.ts is deliberately NOT touched by this file.
 *
 * Covers:
 *   S1  src/herdr/cli.ts imports node builtins only — the CLI subprocess
 *       runner needs no seam type and no sibling herdr module (so it cannot
 *       import the socket client either).
 *   S2  src/herdr/socket.ts imports node builtins only.
 *   S3  src/herdr/map.ts imports NO herdr module — its only relative import is
 *       the seam (../host.ts), so the mapper layer cannot cycle through the
 *       transport.
 *   S4  nothing outside src/herdr/ imports any moved module (relative import,
 *       re-export, or dynamic import — resolved, not text-matched): the adapter
 *       keeps ONE import surface, src/herdr/host.ts (package.json "./herdr").
 *   S5  the facade still serves the pre-split export surface under the same
 *       names (behavioral: a dynamic import of the adapter module).
 *   S6  the frozen herdr CLI/OS surface stays adapter-local: every token below
 *       is present inside src/herdr/ and absent from every other src/ file and
 *       index.ts.
 *   S7  the extension's single documented raw-throw deviation (Law 8) is still
 *       exactly one raw `throw new Error` inside src/herdr/, and it lives in
 *       the CLI runner (runHerdr's exec-parity wrapper).
 *   S8  the Law 5 target shape landed: the three modules exist and
 *       src/herdr/host.ts still owns HerdrTransport + createHerdrTransport.
 *
 * Exit 0 only if all checks pass.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// FAIL-FAST WATCHDOG — this script must never hang. Whatever is wrong, it exits
// non-zero within WATCHDOG_MS so a direct `bun test/<file>.ts` run cannot block
// an agent forever. Run the suite via test/run-checks.sh instead (per-check
// timeout, structured report).
const WATCHDOG_MS = 20_000;
const watchdog = setTimeout(() => {
	console.error(`WATCHDOG: check script exceeded ${WATCHDOG_MS}ms — fail-fast exit (a check awaited something unbounded; fix the check, do not raise this)`);
	process.exit(1);
}, WATCHDOG_MS);
// unref: the watchdog must not be the reason the loop stays alive after the
// checks finished — it only fires while something ELSE is still pending.
(watchdog as unknown as { unref?: () => void }).unref?.();

const HERDR_DIR = resolve(ROOT, join("src", "herdr"));
const MOVED = ["cli", "socket", "map"].map((n) => join(HERDR_DIR, `${n}.ts`));
const FACADE = join(HERDR_DIR, "host.ts");

/** Every module specifier a file pulls in: static `import`/`export ... from`,
 *  bare side-effect imports, and dynamic `import(...)` calls carrying a string
 *  literal. Returned as raw specifiers (unresolved). */
function importSpecs(file: string): string[] {
	const src = readFileSync(file, "utf8");
	const out: string[] = [];
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\bimport\s+["']([^"']+)["']/g,
	];
	for (const re of patterns) {
		for (const m of src.matchAll(re)) out.push(m[1]);
	}
	return out;
}

function listTs(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...listTs(p));
		else if (e.name.endsWith(".ts")) out.push(p);
	}
	return out;
}

const HERDR_FILES = listTs(HERDR_DIR);
/** Containment prefix for the inside/outside split. Both HERDR_DIR and listTs()
 *  come from node:path, so on win32 their separator is "\" — a literal "/"
 *  compared here matched nothing and classified every herdr file as OUTSIDE
 *  (S4 and S6 then fired on the adapter's own files). `sep` keeps the POSIX
 *  spelling byte-identical and makes the test portable to a real Windows host. */
const HERDR_PREFIX = HERDR_DIR + sep;
/** Every production + test module OUTSIDE src/herdr/ (the layer that must not
 *  reach into the adapter's internals). */
const OUTSIDE_FILES = [
	...listTs(resolve(ROOT, "src")).filter((f) => !f.startsWith(HERDR_PREFIX)),
	resolve(ROOT, "index.ts"),
	...listTs(resolve(ROOT, "test")),
];

// --- S0 the inside/outside classifier is separator-portable ------------------
// Canary for the bug above: if containment is ever spelled with a literal "/"
// again, every HERDR_FILES entry lands in OUTSIDE_FILES and S4/S6 fire on the
// adapter's own files (which is exactly what a Windows host observed).
check(
	"S0 no file inside src/herdr/ is classified as outside it (separator-portable containment)",
	HERDR_FILES.every((f) => !OUTSIDE_FILES.includes(f)),
	HERDR_FILES.filter((f) => OUTSIDE_FILES.includes(f)).join(" | "),
);

// --- S1/S2/S3 the shape of each new module's import list ---------------------

for (const [name, rule] of [
	["cli.ts", "node builtins only (no relative import at all — so it cannot import socket.ts)"],
	["socket.ts", "node builtins only (no src/ import of any kind)"],
] as const) {
	const file = join(HERDR_DIR, name);
	const relative = importSpecs(file).filter((s) => s.startsWith("."));
	check(
		`S1/S2 src/herdr/${name} imports ${rule}`,
		existsSync(file) && relative.length === 0,
		relative.join(", "),
	);
}

{
	const file = join(HERDR_DIR, "map.ts");
	const relative = importSpecs(file).filter((s) => s.startsWith("."));
	// A herdr-internal specifier: a same-directory sibling, or any path naming
	// one of the adapter's modules. "../host.ts" is NOT one of them — from
	// src/herdr/ that specifier is the seam (src/host.ts).
	const HERDR_INTERNAL_SPEC = /^\.\/(?:cli|socket|host)\.ts$|\/herdr\/(?:cli|socket|map|host)\.ts$/;
	const herdrSiblings = relative.filter((s) => HERDR_INTERNAL_SPEC.test(s));
	check(
		"S3 src/herdr/map.ts imports no herdr module — its only relative import is the seam ../host.ts",
		existsSync(file) && relative.length === 1 && relative[0] === "../host.ts" && herdrSiblings.length === 0,
		relative.join(", "),
	);
}

// --- S4 the adapter keeps one import surface ---------------------------------

// RESOLUTION-based (the repo's own migration lesson: the import rule is module
// resolution, not text): every relative import / export-from / dynamic-import
// specifier of every module outside src/herdr/ is resolved and compared against
// the moved module paths. Prose that merely mentions a file name is not an
// import, so the pin file itself (which must name what it pins) never fires it.
{
	const offenders: string[] = [];
	for (const file of OUTSIDE_FILES) {
		if (!existsSync(file)) continue;
		for (const spec of importSpecs(file)) {
			if (!spec.startsWith(".")) continue;
			const abs = resolve(dirname(file), spec);
			if (MOVED.includes(abs)) offenders.push(`${file}: ${spec}`);
		}
	}
	check(
		"S4 no module outside src/herdr/ imports the moved modules — src/herdr/host.ts is the adapter's only import surface",
		offenders.length === 0,
		offenders.join(" | "),
	);
}

// --- S5 the facade serves the pre-split export surface -----------------------

const PRE_SPLIT_EXPORTS = [
	"SIGKILL_GRACE_MS",
	"winQuoteArg",
	"runHerdr",
	"parseHerdrResult",
	"DEFAULT_HERDR_SOCK",
	"HERDR_SOCKET_TRANSPORT_ENV",
	"SOCKET_REQUEST_TIMEOUT_MS",
	"SOCKET_CONNECT_TIMEOUT_MS",
	"HerdrSocketError",
	"HerdrSocketClient",
	"HerdrTransport",
	"reconcileTabClose",
	"placementFromTabResult",
	"createHerdrTransport",
];
{
	const mod = (await import(FACADE)) as Record<string, unknown>;
	const missing = PRE_SPLIT_EXPORTS.filter((name) => mod[name] === undefined);
	check(
		"S5 src/herdr/host.ts still exports the whole pre-split value surface under the same names",
		missing.length === 0,
		`missing: ${missing.join(", ")}`,
	);
	// The type-only exports (HerdrRunResult, HerdrSocketClientOptions,
	// HerdrPlacement) carry no runtime value; they are pinned by the qa
	// typecheck (test/tsconfig.qa.json) through the importers that use them.
	check(
		"S5b the facade binds a working transport (the composition root's binding target)",
		typeof mod.createHerdrTransport === "function" && (mod.createHerdrTransport as () => { backendName: () => string })().backendName() === "herdr",
	);
}

// --- S6 the frozen herdr surface stays adapter-local -------------------------

{
	const FROZEN = [
		"not_linked_worktree",
		"is_linked_worktree",
		"workspace.worktree.checkout_path",
		"root_pane.pane_id",
		"tab.tab_id",
		"taskkill",
		"cmd.exe",
		"HERDR_WORKSPACE_ID",
	];
	const inside = HERDR_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
	const missingInside = FROZEN.filter((t) => !inside.includes(t));
	const PRODUCTION_OUTSIDE = [
		...listTs(resolve(ROOT, "src")).filter((f) => !f.startsWith(HERDR_PREFIX)),
		resolve(ROOT, "index.ts"),
	];
	const leaked: string[] = [];
	for (const file of PRODUCTION_OUTSIDE) {
		if (!existsSync(file)) continue;
		const src = readFileSync(file, "utf8");
		for (const t of FROZEN) if (src.includes(t)) leaked.push(`${file}: ${t}`);
	}
	check(
		"S6 the frozen herdr CLI/OS strings live inside src/herdr/ and nowhere else in production src/ (they never leak above the adapter)",
		missingInside.length === 0 && leaked.length === 0,
		`missing: ${missingInside.join(", ")} | leaked: ${leaked.join(", ")}`,
	);
}

// --- S7 one raw throw, in the CLI runner, as Law 8 documents -----------------

{
	const rawThrowSites = HERDR_FILES.flatMap((f) =>
		readFileSync(f, "utf8")
			.split("\n")
			.map((line, i) => ({ f, i: i + 1, line }))
			.filter((l) => /throw new Error\(/.test(l.line))
			.map((l) => `${l.f}:${l.i}`),
	);
	const cliPath = join(HERDR_DIR, "cli.ts");
	check(
		"S7 exactly one raw `throw new Error` in src/herdr/ (the runHerdr exec-parity wrapper — the extension's single documented deviation)",
		rawThrowSites.length === 1 && rawThrowSites[0].startsWith(`${cliPath}:`),
		rawThrowSites.join(", "),
	);
}

// --- S8 the Law 5 target shape landed ---------------------------------------

{
	const shape = MOVED.every((f) => existsSync(f));
	const facadeSrc = readFileSync(FACADE, "utf8");
	check(
		"S8 herdr/cli.ts + herdr/socket.ts + herdr/map.ts exist and src/herdr/host.ts still owns HerdrTransport + createHerdrTransport",
		shape && /export class HerdrTransport implements Transport/.test(facadeSrc) && /export function createHerdrTransport/.test(facadeSrc),
	);
}

if (failures > 0) {
	console.error(`\n${failures} HERDR-SPLIT CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL HERDR-SPLIT CHECKS PASSED");
