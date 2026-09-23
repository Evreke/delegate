/**
 * T1 — Static/design conformance checks.
 *
 * Run with: bun test/static-check.ts   (from repo root)
 *
 * Checks (migration stage 3, audit step 10: every fix-specific source-text
 * pin is replaced by a BEHAVIORAL test — the registered tools/commands are
 * driven, the exported pure helpers are exercised; the ONLY remaining
 * source scans are the four hygiene lint rules, which prohibit literals
 * or path shapes and are textual by nature):
 *   1. Package boundary (migration stage 3, audit step 9): the herdr adapter
 *      is published ONLY as the separate export subpath "./herdr" — module
 *      resolution, not a source-text regex, enforces the import rule; the
 *      adapter is loaded and CONSTRUCTED here (T1.1b-drive — the old T1.1b
 *      text pin is deleted).
 *   2. delegate_status read-only, BEHAVIORALLY: the registered tool is driven
 *      against a recording transport — execute touches ONLY listStatuses.
 *   3. WORKER_NAME_RE rejects "Bad-Name", "-x", 33-char names; accepts valid ones.
 *   4. validateReport() error strings for 6 invalid shapes + 1 valid report.
 *   5. W0 retry mandate (rng-sum bug 2), BEHAVIORALLY: the captured delegate
 *      tool's runtime promptGuidelines carry the RETRY_MANDATE constant, and
 *      a DRIVEN settle-fail (fake host, no report) carries it in the actual
 *      E_REPORT_MISSING guidance; the same drive consumes a stale
 *      nudge-failed marker (T2.5b).
 *   6. Hygiene lint (source scans by nature): the seam imports no relative
 *      modules; no hardcoded tier or /root/ literal in src/.
 *   7. Exchange-path pin (TZ windows-path §3.7, source scan by nature):
 *      production src/ builds exchange-layer paths ONLY through
 *      src/expaths.ts — no raw `/`-separator template-literal path assembly,
 *      no split("/") path parsing, no endsWith("/_probe") classification,
 *      no startsWith(x + "/") containment outside the builder itself.
 *   9. swarm-core pins (#31, Law 6; binding spec §4.1.2/§4.1.3):
 *      T1.12 sqlite confinement — no src/ module outside src/swarm/journal*.ts
 *      references a sqlite driver; T1.13 the watcher family performs no direct
 *      node:fs reads of exchange-layer paths (satellites excepted; the journal
 *      is consumed only through src/swarm/journal-read.ts); T1.14 the exchange
 *      file projection (report/q/a/p paths) is written only by the swarm CLI
 *      verb modules plus the named Phase A legacy writers. Each pin carries
 *      canary fixtures (T1.9b efficacy precedent) AND a seeded-file probe: a
 *      fixture tree walked by the real scanner must produce the offender —
 *      the pin is provably not vacuous.
 *  10. swarm-server pins (#50, Law 6/13; binding spec §4.2): the session-
 *      hosted read server family (src/swarm-server/) is a Law-13 CLIENT —
 *      fleet state enters ONLY via the read-model. T1.15 bans the family's
 *      direct imports of durable stores, observation surfaces, backend
 *      adapters and the journal WRITER half (manifest-store, watch-store,
 *      exchange, observe, watcher, fleet, worker-view, the herdr/rpc adapter
 *      modules, swarm/journal.ts, swarm/journal-copy.ts,
 *      swarm/journal-driver.ts, swarm/journal-manifest-store.ts); the
 *      sanctioned doors are ../swarm/journal-read.ts (the reader),
 *      ../swarm/{graph,events,snapshot,result,storage}.ts (the read API),
 *      ../host.ts (the Transport TYPE seam, Law 4) and ../usage.ts (the
 *      read-model's declared usage input seam).
 *  11. T1.16 (#51, Law 6/8/11): the mutation surface's write path never
 *      bypasses the journal. The shared core src/swarm/mailbox-verbs.ts must
 *      call appendSwarmEvent for steer/answer (the verb journal plumbing);
 *      no src/swarm-server/** file may make a direct mailbox write (the
 *      server delegates to the core — it cannot publish an envelope without
 *      the journal row); and the mount wires the core (runOrchestratorVerb).
 *  12. fleet-dashboard static pins (#53, Law 6/§4.2): the read-only
 *      dashboard SPA under src/swarm-server/public/ is a static asset set
 *      (no build step, no framework/bundler, no external network, no
 *      mutation shape) whose sessionStorage holds only the reconnect
 *      cursor. T1.20–T1.23 pin the asset set, the forbidden shapes, the
 *      cursor scope and the absence of build artifacts.
 *
 * Exit 0 only if all checks pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import {
	WORKER_NAME_RE,
} from "../src/host.ts";
import {
	placementFromTabResult,
} from "../src/herdr/host.ts";
import { validateReport, TEARDOWN_LOG_NAME, teardownLogLine } from "../src/exchange.ts";
import { registerDelegateTool, RETRY_MANDATE } from "../src/spawn.ts";
import { registerCommands, registerStatusTool } from "../src/observe.ts";
import { FakeWorkerHost } from "../src/host/fake.ts";
import type { Transport } from "../src/host.ts";

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");

// Fixture hygiene (field lesson 2026-09-10, host-fake-check convention): the
// exchange root is SANDBOXED via $PI_DELEGATE_EXCHANGE_ROOT for the behavioral
// drives below — the real /tmp/exchange is never touched.
const SANDBOX = mkdtempSync(resolve(tmpdir(), "static-check-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = SANDBOX;

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// 1. Package boundary (migration stage 3, audit step 9)
// ---------------------------------------------------------------------------

// The old T1.1/T1.1c TEXT pins (regex scans for herdr imports across src/)
// are GONE: the rule "the adapter is reachable only through its export
// subpath, bound once by the composition root" is now enforced by module
// RESOLUTION — package.json's exports map exposes "." → index.ts and the
// adapter at the separate subpath "./herdr", nothing else. The check below
// pins the boundary itself (fail-closed: a removed/renamed subpath or a
// re-widened exports map fails here).
interface PackageExports {
	exports?: Record<string, string>;
	version?: string;
}
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as PackageExports;
check(
	"T1.1e package boundary: exports map exposes only '.' (index.ts) and './herdr' (the adapter subpath) — the import rule is module-resolution, not text",
	pkg.exports?.["."] === "./index.ts" && pkg.exports?.["./herdr"] === "./src/herdr/host.ts",
	JSON.stringify(pkg.exports ?? null),
);

// Version single-sourcing (Law 9 — one artifact, one source of truth):
// src/version.ts is the runtime version stamped into tool results; the pin
// makes a package.json bump without the matching version.ts bump (or vice
// versa) a CI failure, not a silent drift between "the version the user
// installed" and "the version the tool reports".
{
	const versionSrc = readFileSync(resolve(ROOT, "src/version.ts"), "utf8");
	const m = versionSrc.match(/EXTENSION_VERSION = "([^"]+)"/);
	check(
		"T-version src/version.ts is the single runtime version source and byte-matches package.json",
		m?.[1] !== undefined && m[1] === pkg.version,
		`version.ts=${m?.[1] ?? "(unparsed)"} package.json=${pkg.version ?? "(absent)"}`,
	);
}

// The old T1.1b POSITIVE text pin (index.ts imports the adapter) is GONE
// (migration stage 3, audit step 10): the binding's SUBSTANCE is the runtime
// proof below — the adapter module imports, constructs and serves the full
// Transport contract through the package boundary (T1.1b-drive + T1.1e);
// which file calls the constructor is compile-time wiring (tsc qa config).

// Behavioral binding proof (replaces the T1.1b text pin): the adapter module
// LOADS through its src path and constructs — the composition root's binding
// target exists and serves the seam.
{
	const { createHerdrTransport } = await import(resolve(ROOT, "src/herdr/host.ts"));
	const t = createHerdrTransport();
	check(
		"T1.1b-drive the herdr adapter constructs and serves the Transport seam (backendName + capabilities)",
		typeof t.backendName === "function" && t.backendName() === "herdr" && typeof t.capabilities === "function",
	);
}

// Bottom-of-graph pin (workerhost inversion, research risk #2): the seam
// module imports node builtins ONLY — zero relative/src imports (error
// guidance strings and helpers get DUPLICATED into it, never imported from
// tool modules — a shared helper would drag the whole graph under the seam).
const hostSrc = readFileSync(resolve(ROOT, "src/host.ts"), "utf8");
const hostRelativeImports = hostSrc.match(/from\s*["']\.[^"']*["']/g) ?? [];
check(
	"T1.1d src/host.ts (the seam) imports node builtins only — no relative imports (bottom of the graph)",
	hostRelativeImports.length === 0,
	hostRelativeImports.join(", "),
);

// ---------------------------------------------------------------------------
// 1.5 No hardcoded worker tier in src/ (v1.9.2)
// ---------------------------------------------------------------------------

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = resolve(dir, e.name);
		if (e.isDirectory()) out.push(...listTsFiles(p));
		else if (e.name.endsWith(".ts")) out.push(p);
	}
	return out;
}

const tierOffenders = listTsFiles(resolve(ROOT, "src")).filter((f) =>
	readFileSync(f, "utf8").includes("llm-platform-alpha"),
);
check(
	"T1.5 src/ contains no hardcoded worker tier provider (config tiers/defaults + E_TIER instead)",
	tierOffenders.length === 0,
	tierOffenders.join(", "),
);

// ---------------------------------------------------------------------------
// 1.6 No hardcoded /root/ path literal in src/ (user-reported: WORKTREE_DIR
// broke every non-root user — all host paths resolve via os.homedir())
// ---------------------------------------------------------------------------

const rootPathOffenders = listTsFiles(resolve(ROOT, "src")).filter((f) =>
	readFileSync(f, "utf8").includes("/root/"),
);
check(
	"T1.6 src/ contains no /root/ path literal (homedir()-resolved paths instead)",
	rootPathOffenders.length === 0,
	rootPathOffenders.join(", "),
);

// ---------------------------------------------------------------------------
// 1.7 Law 1 pins (constitution): the platform is the API — no hardcoded
// agent-dir joins, no union-of-literals tool enums.
// ---------------------------------------------------------------------------

/** Strip line comments (slash-slash) and block comments (slash-star ... star-
 *  slash) from TypeScript source so
 *  only CODE constructs are scanned (display-only guidance inside comments is
 *  allowed to mention ~/.pi/agent paths). String literals survive stripping —
 *  they are scanned by the shape rules below, which distinguish code joins
 *  from prose (a prose path is inside a sentence, never a join argument). */
function stripComments(src: string): string {
	return src
		// Block comments are blanked char-by-char with NEWLINES preserved, so
		// scanners below report line numbers against the ORIGINAL file.
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
		// Line comments: a `//` is a comment when preceded by line start or a
		// non-`\`/non-`:` char — `:` keeps protocol spellings (`https://…`) in
		// strings alive, `\\` keeps a regex literal's escaped-slash body
		// (`/^\//` contains an adjacent `//` of delimiters, not a comment).
		.replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

// Law 1 (directory constants): never join os.homedir() with literal .pi/.pi/agent
// segments — pi exports getAgentDir()/CONFIG_DIR_NAME for this. The pin scans
// CODE (comments stripped) and flags exactly the audit's offender shapes:
//   - a homedir() call followed by a ".pi" join segment (homedir(), ".pi", ...)
//   - a join(...) argument carrying a ".pi" or ".pi/agent" literal segment
//   - a module constant assigned a relative ".pi/..." path literal
//   - a template-literal path assembly containing .pi/agent
// Display-only strings inside sentences ("see ~/.pi/agent/...") never match:
// they are neither join arguments nor assignments nor template assemblies.
const agentDirOffenders: string[] = [];
for (const f of listTsFiles(resolve(ROOT, "src"))) {
	const code = stripComments(readFileSync(f, "utf8"));
	const lines = code.split("\n");
	lines.forEach((line, i) => {
		const offenderShape =
			/homedir\(\)\s*,\s*["']\.pi["']/.test(line) ||
			/join\(\s*["'][^"']*\.pi\/agent[^"']*["']/.test(line) ||
			/join\([^\n]*["']\.pi["']/.test(line) ||
			/=\s*["']\.pi\//.test(line) ||
			/`[^`]*\.pi\/agent[^`]*`/.test(line);
		if (offenderShape) agentDirOffenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
	});
}
check(
	"T1.7 src/ builds no agent-dir path by joining homedir() with literal .pi/.pi/agent segments (Law 1: pi's getAgentDir()/CONFIG_DIR_NAME instead)",
	agentDirOffenders.length === 0,
	agentDirOffenders.join(" | "),
);

// Law 1 (tool enums): no tool parameter schema uses Type.Union of Type.Literal
// members — that shape breaks Google models; StringEnum from @earendil-works/
// pi-ai is the only allowed spelling. Scans the two tool-schema files
// (comments stripped; prose mentions of the rule in comments are invisible).
const enumUnionOffenders: string[] = [];
for (const f of [resolve(ROOT, "src/spawn.ts"), resolve(ROOT, "src/observe.ts")]) {
	const code = stripComments(readFileSync(f, "utf8"));
	const lines = code.split("\n");
	lines.forEach((line, i) => {
		if (/Type\.Union\s*\(\s*\[[^\n]*Type\.Literal/.test(line)) {
			enumUnionOffenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
		}
	});
}
check(
	"T1.7b no tool parameter schema in src/spawn.ts / src/observe.ts uses Type.Union of Type.Literal members (Law 1: StringEnum instead)",
	enumUnionOffenders.length === 0,
	enumUnionOffenders.join(" | "),
);

// ---------------------------------------------------------------------------
// 1.8 Law 6 pin — layering: no src/ module imports src/observe.ts except
//     the composition root's slices (Wave 3a: the watch-config extraction
//     killed the spawn→observe edge; this pin keeps it dead).
// ---------------------------------------------------------------------------

// Plain read-based assertion (modeled on the T1.5/T1.6 hygiene scans):
// every src/**/*.ts file must not carry a relative import of ./observe —
// with exactly two allowlisted exceptions: src/compose.ts (the watcher
// mount slice) and index.ts (the composition root — outside src/ anyway,
// listed here for clarity). Everything the rest of the layer needs from
// observe's neighborhood lives in the extracted modules (watch-config.ts,
// watch-store.ts, report-schema.ts, mailbox-store.ts, manifest-store.ts,
// archive.ts); importing observe for it re-creates the forbidden edge.
// Re-audit 2026-09-12: the allowlist is EMPTY — compose.ts no longer imports
// observe.ts either; the pin is exact. Keep the filter shape so a future
// waiver needs a named entry + a written reason, not a silent pass.
const OBSERVE_IMPORT_ALLOWLIST = new Set<string>([]);
const observeImportOffenders = listTsFiles(resolve(ROOT, "src"))
	.filter((f) => !OBSERVE_IMPORT_ALLOWLIST.has(f.split("/").pop() ?? ""))
	.filter((f) => /from\s*["']\.\/observe(\.ts)?["']/.test(readFileSync(f, "utf8")));
check(
	"T1.8 no src/ module imports src/observe.ts except compose.ts (Law 6: the spawn→observe edge stays dead — config lives in watch-config.ts)",
	observeImportOffenders.length === 0,
	observeImportOffenders.join(", "),
);

// ---------------------------------------------------------------------------
// 1.9 Exchange-path pin (TZ windows-path §3.7): production src/ builds
//     exchange-layer paths ONLY through src/expaths.ts. The migration is
//     done (reportPathFor / questionPathFor / … / taskSlug / isProbeDir /
//     sameDir / isDirUnder); this pin keeps the raw shapes dead:
//       - template-literal path assembly   `${dir}/report-x.json`
//       - split on a path separator        dir.split("/")
//       - probe classify by suffix         dir.endsWith("/_probe")
//       - containment by concat            cwd.startsWith(root + "/")
//     Comments are stripped first (BUG_FIX_CONTEXT prose in the sources and
//     herdr/host.ts legally documents the OLD shapes — it must not fire);
//     string literals are scanned as-is (guidance strings live there).
// ---------------------------------------------------------------------------

/** Deterministic offender shapes, one regex each. All non-global — they are
 *  exec'd per line with no lastIndex state, so the scanner below is pure and
 *  unit-callable (the T1.9b bite-proof calls it on canary fixtures). */
const EXCHANGE_PATH_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
	{
		// `${expr}/<segment starting with a letter/underscore>` — a path is being
		// continued past an interpolated dir. Counters (`${attempt}/${n}`),
		// display rows (`${e.worker}/${e.kind}`) and guidance placeholders
		// (`${exchangeRoot()}/<task>/`) have a non-letter after the `/` and do
		// not match — see the T1.9c precision fixtures.
		kind: "template path assembly",
		re: /\$\{[^}\n]+\}\/[A-Za-z_]/,
	},
	{
		// .split("/") / .split('\\') and the char-class regex twins — path
		// PARSING by separator. The class form requires an actual separator
		// member (a source-level `\\` or `/` inside [...]) so `[^\n]`-style
		// classes (e.g. /\s+/) never fire.
		kind: "split on path separator",
		re: /\.split\(\s*(["'])[\\/]\1\s*\)|\.split\(\s*\/\[[^\]]*(?:\\\\|\/)[^\]]*\]\/[a-z]*\s*\)/,
	},
	{
		// The old probe classifier and its backslash twin. In SOURCE text the
		// backslash twin is written "\\_probe" (two backslash chars) — both
		// spellings are covered.
		kind: "endsWith probe-suffix classify",
		re: /\.endsWith\(\s*(["'])(?:[\/]|\\\\)_probe\1\s*\)/,
	},
	{
		// Containment by concat: .startsWith(expr + "/") and the template twin
		// .startsWith(`${expr}/`). expaths.isDirUnder is the replacement.
		kind: "startsWith containment concat",
		re: /\.startsWith\(\s*(?:[A-Za-z_$][\w$.]*\s*\+\s*(["'])[\/]\1|`[^`\n]*\}[\/]`\s*)\)/,
	},
];

/** Pure per-source scan (unit-callable — the T1.9b bite-proof feeds it
 *  canary fixtures directly). Input is raw file text; comments are stripped
 *  here, line numbers refer to the original file (stripComments keeps
 *  newlines). Output offenders carry line + kind + the matched text. */
export function scanCodeForExchangePathOffenders(
	code: string,
): Array<{ line: number; kind: string; text: string }> {
	const out: Array<{ line: number; kind: string; text: string }> = [];
	stripComments(code).split("\n").forEach((lineText, i) => {
		for (const { kind, re } of EXCHANGE_PATH_PATTERNS) {
			const m = re.exec(lineText);
			if (m) out.push({ line: i + 1, kind, text: m[0].trim() });
		}
	});
	return out;
}

/** Named waivers (T1.8 convention: an entry + a written reason, never a
 *  silent pass). Matched on file basename + offender kind. */
const EXCHANGE_PATH_ALLOWLIST: ReadonlyArray<{ file: string; kind: string; reason: string }> = [
	{
		file: "report-schema.ts",
		kind: "split on path separator",
		reason:
			"splits the type-fest JSON-pointer instancePath (reportSchema error location) on '/' — a JSON pointer, never a filesystem path",
	},
];

const exchangePathOffenders: string[] = [];
for (const f of listTsFiles(resolve(ROOT, "src"))) {
	// src/expaths.ts is EXCLUDED: the builder itself owns these shapes — the
	// pin enforces that nothing OUTSIDE it re-invents them.
	if ((f.split(/[\\/]/).pop() ?? "") === "expaths.ts") continue;
	const base = f.split(/[\\/]/).pop() ?? f;
	for (const o of scanCodeForExchangePathOffenders(readFileSync(f, "utf8"))) {
		const waived = EXCHANGE_PATH_ALLOWLIST.some((a) => a.file === base && a.kind === o.kind);
		if (!waived) exchangePathOffenders.push(`${f}:${o.line} [${o.kind}] ${o.text}`);
	}
}
check(
	"T1.9 src/ builds exchange-layer paths only through expaths.ts — no raw template/split/endsWith/startsWith path shapes (TZ §3.7)",
	exchangePathOffenders.length === 0,
	exchangePathOffenders.join(" | "),
);

// Bite-proof (Law 8): the pin must actually FIRE on every forbidden shape —
// each canary below is a real offender the scan must flag by kind.
const PIN_CANARIES: ReadonlyArray<[string, string]> = [
	["template path assembly", "const _p = `${dir}/report-x.json`;"],
	["template path assembly", "const _p = `${exchangeRoot()}/_probe`;"],
	["split on path separator", 'const _segs = dir.split("/");'],
	["split on path separator", "const _segs = dir.split(/[\\\\/]/);"],
	["endsWith probe-suffix classify", 'const _b = dir.endsWith("/_probe");'],
	["endsWith probe-suffix classify", 'const _b = dir.endsWith("\\\\_probe");'],
	["startsWith containment concat", 'const _u = cwd.startsWith(WORKTREE_DIR + "/");'],
	["startsWith containment concat", "const _u = cwd.startsWith(`${root}/`);"],
];
const missedCanaries = PIN_CANARIES
	.filter(([kind, code]) => !scanCodeForExchangePathOffenders(code).some((o) => o.kind === kind))
	.map(([kind, code]) => `${kind}: ${code}`);
check(
	"T1.9b the pin BITES: every forbidden shape in the canary fixtures is flagged (unit-called scanner)",
	missedCanaries.length === 0,
	missedCanaries.join(" | "),
);

// Precision guards: legitimate non-path shapes nearby must NOT fire (a pin
// that cries wolf on counters/display rows would be reverted within a week).
const PIN_CLEAN: ReadonlyArray<string> = [
	'const _c = `${attempt}/${GRACE_RECHECKS} rechecks`;', // counter display
	'const _g = `under ${exchangeRoot()}/<task>/ first`;', // guidance placeholder, not assembly
	'const _d = `${e.worker}/${e.kind}#${e.fingerprint ?? ""}`;', // log display row
	'const _l = raw.split("\\n");', // line split, not path parsing
	'const _w = text.split(/\\s+/).filter(Boolean);', // whitespace split
	'const _at = arg.startsWith("@");', // @-prefix strip
];
const falsePositives = PIN_CLEAN
	.filter((code) => scanCodeForExchangePathOffenders(code).length > 0)
	.map((code) => `${code} → ${JSON.stringify(scanCodeForExchangePathOffenders(code))}`);
check(
	"T1.9c the pin is PRECISE: counter/display/guidance/line-split shapes are not flagged",
	falsePositives.length === 0,
	falsePositives.join(" | "),
);

// The allowlist must stay LIVE (T1.8 convention): the waived shape is really
// matched raw in its file, and the waiver removes exactly that — an entry
// whose pattern no longer occurs fails here so stale waivers get re-audited.
{
	const rsRaw = scanCodeForExchangePathOffenders(
		readFileSync(resolve(ROOT, "src/report-schema.ts"), "utf8"),
	);
	const waived = rsRaw.filter((o) =>
		EXCHANGE_PATH_ALLOWLIST.some((a) => a.file === "report-schema.ts" && a.kind === o.kind)
	);
	check(
		"T1.9d the allowlist is LIVE: report-schema.ts's JSON-pointer split matches raw and is fully waived by the named entry",
		rsRaw.length > 0 && waived.length === rsRaw.length,
		JSON.stringify({ raw: rsRaw, waived: waived.length }),
	);
}

// ---------------------------------------------------------------------------
// 2. delegate_status tool read-only (section slice: observe.ts SECTION 1/3)
// ---------------------------------------------------------------------------

// Behavioral (migration stage 3, audit step 10 — replaces the old source-text
// regex over the observe.ts section slice): the REGISTERED delegate_status
// tool is driven against a recording transport; the read-only contract is
// that its execute touches ONLY the read sensor (listStatuses), never a
// mutating backend operation.
{
	const statusCalls: string[] = [];
	const recordingTransport = {
		backendName: () => "herdr",
		capabilities: () => ({ worktrees: true, authority: "root" }),
		listStatuses: async () => {
			statusCalls.push("listStatuses");
			return [];
		},
		place: async () => {
			statusCalls.push("place");
			throw new Error("place MUST NOT be called by delegate_status");
		},
		startAgent: async () => {
			statusCalls.push("startAgent");
			throw new Error("startAgent MUST NOT be called by delegate_status");
		},
		submitPrompt: async () => {
			statusCalls.push("submitPrompt");
			throw new Error("submitPrompt MUST NOT be called by delegate_status");
		},
		teardown: async () => {
			statusCalls.push("teardown");
			throw new Error("teardown MUST NOT be called by delegate_status");
		},
	} as unknown as Transport;
	let statusTool!: { execute: (...a: unknown[]) => Promise<unknown> };
	registerStatusTool({ registerTool: (t: never) => (statusTool = t as never) } as never, recordingTransport);
	await statusTool.execute("t1", {}, undefined, () => {}, { cwd: SANDBOX, hasUI: false });
	check(
		"T1.2 delegate_status execute calls ONLY listStatuses — zero mutating transport ops (behavioral)",
		statusCalls.length === 1 && statusCalls[0] === "listStatuses",
		JSON.stringify(statusCalls),
	);
}

// ---------------------------------------------------------------------------
// 3. Name validation
// ---------------------------------------------------------------------------

const rejected = ["Bad-Name", "-x", "a".repeat(33), "with space", "Агент", "", "1abc", "café"];
const accepted = ["qa", "e2e-worker", "a".repeat(32), "w_1", "w-1"];
check(
	"T1.3 WORKER_NAME_RE rejects invalid names",
	rejected.every((n) => !WORKER_NAME_RE.test(n)),
	rejected.filter((n) => WORKER_NAME_RE.test(n)).join(","),
);
check(
	"T1.3b WORKER_NAME_RE accepts valid names",
	accepted.every((n) => WORKER_NAME_RE.test(n)),
	accepted.filter((n) => !WORKER_NAME_RE.test(n)).join(","),
);

// ---------------------------------------------------------------------------
// 4. Report schema — validateReport()
// ---------------------------------------------------------------------------

import { tmpdir } from "node:os";
const tmp = mkdtempSync(resolve(tmpdir(), "qa-reports-"));

function writeReport(name: string, content: unknown): string {
	const p = resolve(tmp, name);
	writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
	return p;
}

const valid = {
	worker: "w",
	status: "pass",
	summary: "all good",
	artifacts: ["test/x.ts"],
	evidence: [{ claim: "c", file: "f.ts:1" }],
};

const cases: Array<[string, string, string, string]> = [
	// [label, path, canonicalName, expectedErrorSubstring]
	[
		"missing file",
		resolve(tmp, "nope.json"),
		"w",
		"Report file not readable",
	],
	["empty file", writeReport("empty.json", ""), "w", "Report file is empty"],
	[
		"invalid JSON",
		writeReport("badjson.json", "{nope"),
		"w",
		"Report is not valid JSON",
	],
	[
		"array instead of object",
		writeReport("arr.json", []),
		"w",
		"Report must be a JSON object",
	],
	[
		"missing worker",
		writeReport("noworker.json", { ...valid, worker: undefined }),
		"w",
		'Report field "worker" must be a non-empty string',
	],
	[
		"worker name mismatch",
		writeReport("mismatch.json", { ...valid, worker: "other" }),
		"w",
		'Report "worker" is "other" but canonical name is "w"',
	],
	[
		"bad status",
		writeReport("badstatus.json", { ...valid, status: "PASS" }),
		"w",
		'Report "status" must be "pass" or "fail"',
	],
	[
		"empty summary",
		writeReport("nosummary.json", { ...valid, summary: "" }),
		"w",
		'Report field "summary" must be a non-empty string',
	],
	[
		"artifacts not array of strings",
		writeReport("badartifacts.json", { ...valid, artifacts: [1] }),
		"w",
		'Report field "artifacts" must be an array of strings',
	],
	[
		"evidence missing",
		writeReport("noevidence.json", { worker: "w", status: "pass", summary: "s", artifacts: [] }),
		"w",
		'Report field "evidence" must be an array',
	],
	[
		"evidence item missing file",
		writeReport("badevidence.json", { ...valid, evidence: [{ claim: "c" }] }),
		"w",
		'must have non-empty string "claim" and "file"',
	],
];

for (const [label, p, canonical, expected] of cases) {
	const res = validateReport(p, canonical);
	check(
		`T1.4 validateReport rejects: ${label}`,
		!res.ok && res.error.includes(expected),
		res.ok ? "unexpectedly accepted" : res.error,
	);
}

const goodPath = writeReport("good.json", valid);
const good = validateReport(goodPath, "w");
check("T1.4b validateReport accepts a valid report", good.ok, good.ok ? "" : good.error);

// ---------------------------------------------------------------------------
// 5. W0 pin (rng-sum bug 2) — retry guidance mandates a NEW suffixed name.
// Migration stage 1: the sentence is ONE exported constant (RETRY_MANDATE in
// src/spawn.ts); the pins verify BOTH guidance sites use the constant, so the
// two copies can never drift apart again.
// ---------------------------------------------------------------------------

// Behavioral (migration stage 3, audit step 10 — replaces the old source-text
// pins over spawn.ts): the REGISTERED delegate tool is captured and its
// model-facing guidance inspected at RUNTIME (T2.1b/T2.2b), and a real
// settle-fail is DRIVEN on the fake host so the E_REPORT_MISSING guidance is
// asserted on the actual tool RESULT (T2.3b). The same drive proves the
// stale-marker cleanup (section 6).
{
	let delegateTool!: {
		promptGuidelines: string[];
		execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
	};
	registerDelegateTool({ registerTool: (t: never) => (delegateTool = t as never) } as never, new FakeWorkerHost({ repoPath: SANDBOX, statusScript: ["working", "done"] }) as unknown as Transport);
	check(
		"T2.1b the delegate promptGuidelines (runtime array) carry the RETRY_MANDATE constant",
		delegateTool.promptGuidelines.some((g) => g.includes(RETRY_MANDATE)),
	);

	// Drive a genuine settle-fail: the fake settles (working → done) but NO
	// report file exists → E_REPORT_MISSING → the "Treat as a failed spawn"
	// guidance must carry the mandate.
	const FAIL_NAME = "static-fail-worker";
	const failDir = join(SANDBOX, `static-fail-${process.pid}`);
	mkdirSync(failDir, { recursive: true });
	const briefFail = join(failDir, `brief-${FAIL_NAME}.md`);
	writeFileSync(briefFail, `# brief\n\nOUTPUT: report-${FAIL_NAME}.json\n`);
	// The stale marker (F6 review fix, section 6): a PRE-EXISTING marker from a
	// same-name retry must be consumed by the spawn flow.
	const staleMarker = join(failDir, `nudge-failed-${FAIL_NAME}.json`);
	writeFileSync(staleMarker, JSON.stringify({ name: FAIL_NAME, ts: "T", error: "stale" }));
	const failResult = await delegateTool.execute(
		"t1",
		{ name: FAIL_NAME, briefPath: briefFail, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: SANDBOX, mode: "tab", releaseOn: "settle" },
		undefined,
		() => {},
		{ cwd: SANDBOX, hasUI: false },
	);
	const failText = failResult.content.map((c) => c.text).join("\n");
	check(
		"T2.3b a settled-without-report fail result carries 'Treat as a failed spawn' + the RETRY_MANDATE (behavioral)",
		failResult.details.ok === false && failResult.details.code === "E_REPORT_MISSING" &&
			failText.includes("Treat as a failed spawn") && failText.includes(RETRY_MANDATE),
		failText.slice(0, 200),
	);
	check(
		"T2.5b the spawn flow consumed the stale nudge-failed marker right after its manifest append (behavioral)",
		!existsSync(staleMarker),
	);
}
check(
	"T2.4 the mandate names the suffixed shape explicitly (<name>-r2) — a same-name retry must read as impossible",
	/<name>-r2/.test(RETRY_MANDATE) && /name stays taken/.test(RETRY_MANDATE),
);

// ---------------------------------------------------------------------------
// 7. herdr drift pins (2026-09-10 implement-osb field report): herdr renamed
// tab-create result tab.id → tab.tab_id; the old probe list missed it and the
// paneId fallback recorded pane ids as tabId — every tab close failed
// tab_not_found while the agent stayed alive.
// ---------------------------------------------------------------------------

const CURRENT_TAB_SHAPE = {
	id: "cli:tab:create",
	result: {
		root_pane: { pane_id: "wKD:p4", tab_id: "wKD:t4", workspace_id: "wKD" },
		tab: { tab_id: "wKD:t4", label: "shape-probe", number: 4, pane_count: 1, workspace_id: "wKD" },
		type: "tab_created",
	},
};
const LEGACY_TAB_SHAPE = { result: { root_pane: { pane_id: "wKD:p4" }, tab: { id: "wKD:t4" } } };

const tabPlacement = placementFromTabResult(CURRENT_TAB_SHAPE.result, "wKD", "raw");
check("T3.1 current herdr shape: tabId parsed from tab.tab_id (NOT the paneId fallback)", tabPlacement.tabId === "wKD:t4" && tabPlacement.paneId === "wKD:p4", JSON.stringify(tabPlacement));
const legacyTabPlacement = placementFromTabResult(LEGACY_TAB_SHAPE.result, "wKD", "raw");
check("T3.2 legacy herdr shape (tab.id) still parses", legacyTabPlacement.tabId === "wKD:t4");
// Behavioral (migration stage 3, audit step 10 — replaces the old source-text
// regex over the adapter): the reconcile DECISION is the exported pure
// helper the teardown call site feeds (recorded id + live resolution).
{
	const { reconcileTabClose } = await import(resolve(ROOT, "src/herdr/host.ts"));
	check(
		"T3.3 teardown reconcile decision: broken paneId signature + a different live id → close the REAL tab",
		reconcileTabClose("wKD:p4", "wKD:t9") === "wKD:t9",
	);
	check(
		"T3.3b no live id (agent gone / statuses unavailable) → the recorded id, never a wrong-target close",
		reconcileTabClose("wKD:p4", null) === "wKD:p4" && reconcileTabClose("wKD:t4", "wKD:t4") === "wKD:t4",
	);
}

// ---------------------------------------------------------------------------
// 8. Watcher log UX pin (2026-09-10): the production log sink must write an
// audit file and surface to the pane ONLY errors/anomalies — routine retire
// bookkeeping must never reach the user's UI again.
// ---------------------------------------------------------------------------

// Behavioral (migration stage 3, audit step 10 — replaces the T4.1–T4.4
// source-text regexes over observe.ts): the log sink is driven through its
// exported factory (child process — bun caches os.homedir(), so $HOME must be
// set at spawn time), and the /delegate-teardown COMMAND is driven against a
// recording transport.
{
	// T4.1/T4.2 — the sink audits every line and surfaces ONLY error-shaped
	// ones to the pane. Child bun: fresh $HOME + a fresh module registry.
	const home = mkdtempSync(join(tmpdir(), "static-check-home-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true }); // production always has this dir; a fresh $HOME must pre-create it for the audit append
	const sinkSrc =
		`const { makeWatcherLogSink } = await import(${JSON.stringify(resolve(ROOT, "src/observe.ts"))});` +
		`const { appendFileSync } = await import("node:fs");` +
		`const seen = [];` +
		`const orig = console.error; console.error = (...a) => { seen.push(a.join(" ")); };` +
		`const sink = makeWatcherLogSink();` +
		`sink("retired worker probe-1 (ttl)");` +
		`sink("retire pass error for probe-2 (herdr exploded)");` +
		`await new Promise((r) => setTimeout(r, 150));` + // async append must land
		`const audit = appendFileSync; ` +
		`orig(JSON.stringify(seen));`;
	const res = spawnSync("bun", ["-e", sinkSrc], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
	let paneLines: string[] = [];
	try {
		// console.error writes to stderr — the surfaced-line JSON is the last line there
		paneLines = JSON.parse((res.stderr?.trim().split("\n").pop() ?? "[]")) as string[];
	} catch {
		// spawn flake — surfaced by the empty-panes check below
	}
	const auditPath = join(home, ".pi", "agent", "delegate-watch.log");
	let audit = "";
	try {
		audit = readFileSync(auditPath, "utf8");
	} catch {
		// absent audit file → the T4.1b check fails below
	}
	check(
		"T4.1b the log sink audits EVERY line to ~/.pi/agent/delegate-watch.log (behavioral)",
		audit.includes("retired worker probe-1 (ttl)") && audit.includes("retire pass error for probe-2"),
		JSON.stringify(audit.slice(0, 200)),
	);
	check(
		"T4.2b the pane sees ONLY the error-shaped line — routine bookkeeping never reaches the UI (behavioral)",
		paneLines.length === 1 && paneLines[0]?.includes("retire pass error") && !paneLines[0]?.includes("probe-1"),
		JSON.stringify(paneLines),
	);
	rmSync(home, { recursive: true, force: true });

	// T4.3/T4.4 — the /delegate-teardown command is DRIVEN: a manifest with one
	// retired-history entry + one actionable already-gone worker → the retired
	// one is skipped (with a count), the live one closes as a structured
	// idempotent no-op ("already closed, no-op"), never tab_not_found.
	const tdDir = join(SANDBOX, `static-teardown-${process.pid}`);
	mkdirSync(tdDir, { recursive: true });
	const NOW_ISO = new Date().toISOString();
	const mkWorkerEntry = (name: string, extra: Record<string, unknown>): Record<string, unknown> => ({
		name,
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: NOW_ISO,
		reportPath: join(tdDir, `report-${name}.json`),
		placement: { kind: "tab", workspaceId: "w1", paneId: `w1:${name}`, tabId: `w1:t-${name}` },
		...extra,
	});
	writeFileSync(
		join(tdDir, "manifest.json"),
		JSON.stringify({
			task: "static-teardown",
			dir: tdDir,
			workers: [
				mkWorkerEntry("td-retired", { retiredAt: NOW_ISO }),
				mkWorkerEntry("td-gone", {}),
			],
		}),
	);
	const tdCalls: string[] = [];
	const tdTransport = {
		backendName: () => "herdr",
		capabilities: () => ({ worktrees: true, authority: "root" }),
		listStatuses: async () => [],
		teardown: async (req: { name: string }) => {
			tdCalls.push(req.name);
			return { alreadyGone: true }; // the structured idempotent-close signal
		},
	} as unknown as Transport;
	const commands: Record<string, { handler: (args: unknown, ctx: unknown) => Promise<void> }> = {};
	registerCommands({ registerCommand: (n: string, def: never) => (commands[n] = def as never) } as never, tdTransport);
	const notifications: string[] = [];
	const confirmPrompts: string[] = [];
	await commands["delegate-teardown"]?.handler(
		[],
		// hasUI: true — the command's headless guard (pi docs Mode Behavior) must
		// not refuse the drive; this fake ctx models an interactive session.
		{ hasUI: true, ui: { notify: (m: string) => notifications.push(m), confirm: async (_t: string, body: string) => { confirmPrompts.push(body); return true; } } },
	);
	const allNotifications = notifications.join("\n");
	check(
		"T4.3b /delegate-teardown SKIPS retired history (counted in the confirm prompt, never attempted) — behavioral",
		!tdCalls.includes("td-retired") && confirmPrompts.some((p) => p.includes("retired history entries skipped")),
		JSON.stringify({ tdCalls, confirmPrompts }),
	);
	check(
		"T4.4b an already-gone close reads the structured alreadyGone field → 'already closed, no-op' (behavioral)",
		tdCalls.includes("td-gone") && allNotifications.includes("already closed, no-op"),
		JSON.stringify(notifications),
	);
}

// ---------------------------------------------------------------------------
// 6. F6 review-fix — same-name spawn clears a stale nudge-failed marker
// (review minor #1): the spawn flow deletes nudge-failed-<name>.json right
// after appending the manifest entry, or a fresh watcher session would
// re-fire the previous worker's marker once.
// ---------------------------------------------------------------------------

// Migration stage 3 (audit step 10): the old T2.5/T2.6 source-text pins are
// GONE — the cleanup is behaviorally proven by the section-5 drive (T2.5b:
// the pre-existing stale marker is consumed by the real spawn flow). The
// module boundary (nudgeFailedPathFor lives in exchange.ts) is compile-time
// enforced (tsc qa config: a wrong import fails the build, not a regex).

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. Law 5 size ledger — src/ files above 400 lines must carry a row in the
// decomposition ledger below (the ledger lives HERE, in code, per the
// allowlist pattern of Law 6 — never in a rotting prose doc). Verification
// is both-directional: a src file over the threshold without a ledger row
// fails, and a ledger row naming a file that has shrunk under the threshold
// fails — the over-threshold list is computed, never enumerated in prose.
// The plan column is an obligation with a date (Law 5): at release time a
// row whose target release has arrived is executed or re-justified to the
// operator, never silently kept.
// ---------------------------------------------------------------------------

const LAW5_SIZE_LIMIT = 400;
const decompositionLedger: ReadonlyArray<{ file: string; owner: string; targetRelease: string; plan: string }> = [
	{ file: "src/spawn.ts", owner: "operator", targetRelease: "1.18.0", plan: "finish the delegate-tool flow split: execute the remaining SECTION banners, extract the compose/execute phases into modules" },
	{ file: "src/herdr/host.ts", owner: "operator", targetRelease: "1.18.0", plan: "adapter split LANDED (commit 426851f: cli.ts = subprocess runner with SIGTERM-to-SIGKILL escalation, socket.ts = NDJSON unix-socket client, map.ts = answer mapping to the E_* taxonomy; facade re-exports preserve the value surface, pins S1-S8 guard it); remaining: shrink the facade's placement/teardown dispatch as later slices" },
	{ file: "src/host/rpc.ts", owner: "operator", targetRelease: "1.18.0", plan: "extract the line-protocol framing and error classification from the transport lifecycle" },
	{ file: "src/watch-detect.ts", owner: "operator", targetRelease: "1.19.0", plan: "extract the delivery fingerprint dedup next to the journal cursor" },
	{ file: "src/watcher.ts", owner: "operator", targetRelease: "1.19.0", plan: "extract per-session mount/teardown ownership from the observation tick" },
	{ file: "src/host.ts", owner: "operator", targetRelease: "1.19.0", plan: "move error-guidance strings into an import-free module (the seam stays the bottom of the graph — duplicating strings there is allowed)" },
	{ file: "src/exchange.ts", owner: "operator", targetRelease: "1.19.0", plan: "remaining facade: exchange-root conventions plus archive; the store modules are already extracted" },
	{ file: "src/lifecycle.ts", owner: "operator", targetRelease: "1.19.0", plan: "extract the transition table from side checks; the reducer stays a total function" },
	{ file: "src/usage.ts", owner: "operator", targetRelease: "1.19.0", plan: "the one-parser law stays; extract budget-threshold validation from line parsing" },
	{ file: "src/manifest-store.ts", owner: "operator", targetRelease: "1.19.0", plan: "extract the concurrent update() fold from manifest file I/O" },
	{ file: "src/mailbox-store.ts", owner: "operator", targetRelease: "1.19.0", plan: "extract question/answer envelope assembly from question-file I/O" },
	{ file: "src/herdr/cli.ts", owner: "operator", targetRelease: "1.19.0", plan: "extract CLI argument assembly from canned-answer parsing" },
	{ file: "src/swarm/journal-manifest-store.ts", owner: "operator", targetRelease: "1.19.0", plan: "extract the pure replay/diff fold (replayManifest + diffManifestEvents) into a journal-manifest-replay.ts sibling" },
	{ file: "src/swarm-server/server.ts", owner: "operator", targetRelease: "1.19.0", plan: "extract the #51 mutation-response cluster (auth + id/body validation + outcome mapping) into a server-mutation.ts sibling; the #51+#52 merge pushed the route layer over the threshold" },
];

const sizeOffenders = listTsFiles(resolve(ROOT, "src"))
	.map((f) => ({ f, lines: readFileSync(f, "utf8").split("\n").length }))
	.filter(({ lines }) => lines > LAW5_SIZE_LIMIT)
	.map(({ f }) => relative(ROOT, f).replaceAll("\\", "/"))
	.sort();

const ledgerFiles = decompositionLedger.map((r) => r.file).sort();
const unplanned = sizeOffenders.filter((f) => !ledgerFiles.includes(f));
const stalePlans = ledgerFiles.filter((f) => !sizeOffenders.includes(f));
const duplicateRows = decompositionLedger.length !== new Set(ledgerFiles).size;
check(
	`T1.10 Law 5 size ledger: every src/ file above ${LAW5_SIZE_LIMIT} lines has exactly one decomposition row, and no row names a file under the threshold`,
	unplanned.length === 0 && stalePlans.length === 0 && !duplicateRows,
	`over-threshold without a row: ${unplanned.join(", ") || "none"}; rows without an over-threshold file: ${stalePlans.join(", ") || "none"}; duplicate rows: ${duplicateRows}`,
);

// ---------------------------------------------------------------------------
// 8. Law 11 — no secrets in the repository. Scan all git-tracked files for
// secret-shaped literals: JWT-like payloads, provider sk-keys, and literal
// assignments to credential-shaped env names. Comments/CHANGELOG prose that
// merely names the env vars are fine — only literal VALUES fail.
// ---------------------------------------------------------------------------

const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8", cwd: ROOT });
const trackedFiles = tracked.status === 0
	? tracked.stdout.split("\n").map((f) => f.trim()).filter(Boolean)
	: [];
check("T1.11a git ls-files usable for the secrets scan", tracked.status === 0 && trackedFiles.length > 0);

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
	// JWT-shaped tokens (three base64url segments, first starts with eyJ)
	{ name: "jwt-like token", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
	// Provider-style secret keys (sk-…, ghp_…, xox…)
	{ name: "provider-style secret key", re: /\b(sk|ghp|gho|github_pat|xox)[-_][A-Za-z0-9_-]{16,}/ },
	// Literal assignment to a credential-shaped variable (value present, not a
	// placeholder/name reference): KEY=/SECRET=/TOKEN= with a quoted value.
	{ name: "literal credential assignment", re: /(MODEL_API_KEY|PI_LLM_API_KEY|API_KEY|APIKEY|SECRET|PASSWORD|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)\s*[:=]\s*["'][^"']{8,}["']/ },
];
const secretSkip = new Set(["bun.lock"]); // lockfile: huge, no credential literals by construction
const secretHits: string[] = [];
for (const f of trackedFiles) {
	if (secretSkip.has(f)) continue;
	let content: string;
	try {
		content = readFileSync(resolve(ROOT, f), "utf8");
	} catch {
		continue; // deleted between ls-files and read — not a secret issue
	}
	for (const { name, re } of SECRET_PATTERNS) {
		if (re.test(content)) secretHits.push(`${f} (${name})`);
	}
}
check(
	"T1.11 Law 11: no secret-shaped literals in tracked files (no keys in the repository, ever)",
	secretHits.length === 0,
	secretHits.join(", ") || "clean",
);

// ---------------------------------------------------------------------------
// 9. swarm-core static pins (#31, Law 6). Binding spec: ARCHITECTURE §4.1.2
//    (sqlite confinement — “no src/ module outside the journal module family
//    (src/swarm/journal*.ts) imports a sqlite driver”), §4.1.2/#26 (watcher
//    consumes the journal through the reader), §4.1.3 Phase B (the swarm CLI
//    verbs are the projection's only writers — #31 pin). Each pin is a shape
//    pin in the T1.9 class: deterministic offender regexes over comment-
//    stripped code, canary fixtures proving it bites (T1.9b), precision
//    fixtures proving it does not cry wolf (T1.9c), a LIVE allowlist
//    (T1.9d — a row whose shape vanished fails the audit that must retire
//    it), and a SEEDED-FILE probe: a fixture tree walked by the very scanner
//    the real check uses must name the offender — the pin-efficacy precedent.
//
//    Scope note (Law 13's client-boundary pin is deliberately ABSENT —
//    operator ruling on #31): Law 13's enforcement clause says the pin
//    “lands in the same commit as the read-model read API”. The read API
//    (#30, PR #44) has landed — `swarm snapshot` / `swarm events --after`
//    are pure reads over the journal + stores and add no write path (T1.14
//    stays green with them present) — but PR #44 shipped no client-boundary
//    pin and NO observation consumer (status-tool.ts, fleet-widget.ts,
//    worker-view.ts — Law 13's named migration debt) has migrated to the
//    read-model yet: a client-boundary pin today would pin a boundary no
//    client crosses. §4.1 therefore defers the pin until the read-model's
//    consumers exist; #31 ships only the three pins below. Follow-up: land
//    the Law 13 pin with the first observation-consumer migration (and note
//    Law 13's enforcement clause is now overdue against its own wording —
//    flag for the next constitution truth pass).
// ---------------------------------------------------------------------------

/** §4.1.2: the journal module family — the glob src/swarm/journal*.ts
 *  (journal.ts, journal-read.ts, journal-driver.ts, journal-manifest-store.ts,
 *  future journal-compact.ts). Prefix match on the basename inside src/swarm/
 *  only: graph-journal.ts is NOT family. */
function isJournalFamilyFile(relPath: string): boolean {
	return /^src\/swarm\/journal[^/]*\.ts$/.test(relPath.replaceAll("\\", "/"));
}

/** The closed driver-specifier set: the two runtime-native drivers the
 *  journal-driver adapts between (bun:sqlite, node:sqlite) plus the npm
 *  drivers a stray dependency could drag in. A sqlite driver may be
 *  referenced ONLY inside the journal module family (§4.1.2). */
const SQLITE_DRIVER_SPECIFIERS = ["bun:sqlite", "node:sqlite", "better-sqlite3", "sqlite3", "sql.js"] as const;

const SQLITE_DRIVER_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
	// static import / re-export / bare side-effect import:
	// `from "bun:sqlite"`, `import "node:sqlite"`. The bare-import alternative
	// is `import` + a quote DIRECTLY — `import(` (dynamic) and `import {`
	// (named) cannot match it, so the three kinds stay disjoint.
	{
		kind: "static import",
		re: new RegExp(`(?:\\bfrom\\s*|\\bimport\\s+[\\w{\\s,}$]*?\\bfrom\\s*|\\bimport\\s*)["'](${SQLITE_DRIVER_SPECIFIERS.map((d) => d.replace(/\./g, "\\.")).join("|")})["']`),
	},
	// dynamic import: `await import("node:sqlite")`
	{
		kind: "dynamic import",
		re: new RegExp(`\\bimport\\(\\s*["'](${SQLITE_DRIVER_SPECIFIERS.map((d) => d.replace(/\./g, "\\.")).join("|")})["']\\s*\\)`),
	},
	// any call whose argument is the bare driver literal — require(), a
	// createRequire alias (`req("bun:sqlite")` — the journal-driver's real
	// shape), a custom loader. A bare driver literal in call position is a
	// load attempt; type-union members and prose mentions do not match.
	{
		kind: "driver-literal call",
		re: new RegExp(`\\b\\w+\\s*\\(\\s*["'](${SQLITE_DRIVER_SPECIFIERS.map((d) => d.replace(/\./g, "\\.")).join("|")})["']\\s*[,)]`),
	},
];

/** Pure per-source scan (T1.9 convention: unit-callable so canary fixtures
 *  prove the pin bites). Input is raw file text; comments are stripped here,
 *  line numbers refer to the original file. */
export function scanCodeForSqliteDriverRefs(
	code: string,
): Array<{ line: number; kind: string; text: string }> {
	const out: Array<{ line: number; kind: string; text: string }> = [];
	stripComments(code).split("\n").forEach((lineText, i) => {
		for (const { kind, re } of SQLITE_DRIVER_PATTERNS) {
			const m = re.exec(lineText);
			if (m) out.push({ line: i + 1, kind, text: m[0].trim() });
		}
	});
	return out;
}

/** File-tree walk shared by the real pin and the seeded-file probe: scan
 *  every TypeScript file under <root>/src (recursively) outside the journal
 *  family for driver refs. */
function scanTreeForSqliteDrivers(root: string): string[] {
	const offenders: string[] = [];
	for (const f of listTsFiles(resolve(root, "src"))) {
		const rel = relative(root, f).replaceAll("\\", "/");
		if (isJournalFamilyFile(rel)) continue;
		for (const o of scanCodeForSqliteDriverRefs(readFileSync(f, "utf8"))) {
			offenders.push(`${rel}:${o.line} [${o.kind}] ${o.text}`);
		}
	}
	return offenders;
}

{
	const sqliteOffenders = scanTreeForSqliteDrivers(ROOT);
	check(
		"T1.12 sqlite confinement (§4.1.2, Law 6): no src/ module outside src/swarm/journal*.ts references a sqlite driver",
		sqliteOffenders.length === 0,
		sqliteOffenders.join(" | "),
	);
}

// The exemption must stay MEANINGFUL (T1.9d LIVE convention): the journal
// module family really exists and really carries the driver seam — a removed
// journal-driver (or a renamed family glob) fails here so the exemption gets
// re-audited, never silently widened.
check(
	"T1.12b the journal family exemption is LIVE: src/swarm/journal-driver.ts exists and still carries the driver literals (adaptive bun/node seam)",
	existsSync(resolve(ROOT, "src/swarm/journal-driver.ts")) &&
		scanCodeForSqliteDriverRefs(readFileSync(resolve(ROOT, "src/swarm/journal-driver.ts"), "utf8")).length > 0,
);

// Canaries (T1.9b): every driver-reference shape must be flagged.
const SQLITE_CANARIES: ReadonlyArray<[string, string]> = [
	["static import", 'import { Database } from "bun:sqlite";'],
	["static import", 'export { DatabaseSync } from "node:sqlite";'],
	["static import", 'import "node:sqlite";'], // bare side-effect import — a load attempt with no binding
	["dynamic import", 'const s = await import("node:sqlite");'],
	["driver-literal call", 'const db = require("better-sqlite3");'],
	["driver-literal call", 'const d = req("sqlite3");'],
];
const sqliteMissed = SQLITE_CANARIES
	.filter(([kind, code]) => !scanCodeForSqliteDriverRefs(code).some((o) => o.kind === kind))
	.map(([kind, code]) => `${kind}: ${code}`);
check(
	"T1.12c the pin BITES: every driver-reference canary is flagged (unit-called scanner)",
	sqliteMissed.length === 0,
	sqliteMissed.join(" | "),
);

// Precision guards (T1.9c): type-union members, SQL internals (sqlite_master
// is a table name, not a driver specifier) and comment prose never fire.
const SQLITE_CLEAN: ReadonlyArray<string> = [
	'export type JournalDriverName = "bun:sqlite" | "node:sqlite";',
	'const table = db.queryOne("SELECT name FROM sqlite_master WHERE type = \'table\'");',
	'// the driver is chosen adaptively — see bun:sqlite / node:sqlite docs',
];
const sqliteFalse = SQLITE_CLEAN
	.filter((code) => scanCodeForSqliteDriverRefs(code).length > 0)
	.map((code) => `${code} → ${JSON.stringify(scanCodeForSqliteDriverRefs(code))}`);
check(
	"T1.12d the pin is PRECISE: type unions, sqlite_master SQL and comment prose are not flagged",
	sqliteFalse.length === 0,
	sqliteFalse.join(" | "),
);

// Seeded-file probe (the known-violation probe the brief demands): a fixture
// tree walked by the REAL scanner must name the offending module, while the
// same literal inside a journal-family file stays exempt — the glob is
// path-based, not name-gutted, and the walk flags exactly the violator.
{
	const seed = mkdtempSync(resolve(tmpdir(), "sqlite-pin-probe-"));
	mkdirSync(resolve(seed, "src", "swarm"), { recursive: true });
	writeFileSync(
		resolve(seed, "src", "fleet.ts"),
		'import { Database } from "bun:sqlite";\nexport const db = new Database("x.db");\n',
	);
	writeFileSync(
		resolve(seed, "src", "swarm", "journal-future.ts"),
		'import { Database } from "bun:sqlite";\nexport const db = new Database("x.db");\n',
	);
	const seeded = scanTreeForSqliteDrivers(seed);
	check(
		"T1.12e seeded-file probe: an offending module turns the pin red, the journal-family glob stays exempt",
		seeded.length === 1 && seeded[0]?.startsWith("src/fleet.ts:1") && !seeded.some((s) => s.includes("journal-future")),
		JSON.stringify(seeded),
	);
	rmSync(seed, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 9b. T1.13 — watcher family: no direct node:fs reads of exchange-layer
//     paths (#26 + §4.1.2). What #26 landed on HEAD: the watcher's durable
//     dedup reads the journal through src/swarm/journal-read.ts (the journal
//     cursor replaced the delivered-facts store). What remains Phase-A-true:
//     event DETECTION still derives facts from exchange files — but only
//     through the store/helper modules (manifest-store, mailbox-store,
//     exchange.readLastProgress, fs-probe fileMtimeMs, usage.ts), never by a
//     family file calling node:fs itself. This pin freezes exactly that
//     boundary: inside the watcher family a node:fs read API may touch ONLY
//     the watcher's own satellites (watch-*.json stamps, cursor-*.json via
//     their builders); any read call whose line carries an expaths-built
//     exchange path (alias-resolved) or exchangeRoot( is a violation.
//     Phase B follow-up: when journal-is-truth lands for detection
//     (§4.1.3), the store reads shrink and this pin stays the floor.
// ---------------------------------------------------------------------------

const WATCHER_FAMILY_FILES: ReadonlyArray<string> = [
	"watcher.ts",
	"watch-detect.ts",
	"watch-role.ts",
	"watch-cursor.ts",
	"watch-store.ts",
	"watch-retire.ts",
	"watch-config.ts",
];

/** Every path builder src/expaths.ts exports — the exchange-layer path
 *  vocabulary. Alias-resolved per file before matching. */
const EXPATHS_BUILDERS = [
	"manifestPathFor",
	"reportPathFor",
	"questionPathFor",
	"answerPathFor",
	"nudgeFailedPathFor",
	"releasePathFor",
	"progressPathFor",
	"questionArchivePathFor",
	"probeDirPathFor",
] as const;

/** node:fs read APIs (sync + promises twins). Bare names are counted only
 *  when the file imports that name from node:fs(/promises) — the watch-detect
 *  lesson: a local `truncate(s, max)` string helper is not fs. */
const FS_READ_APIS = [
	"readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync", "readlinkSync", "accessSync", "openSync",
	"readFile", "readdir", "stat", "lstat", "access",
] as const;

/** Prepared per-file scan state shared by the T1.13/T1.14 scanners. */
interface PreparedScan {
	/** code with comments AND `export … from` pass-through clauses blanked
	 *  (a re-exported name is a pass-through, never a use) — newlines kept. */
	noReexport: string;
	/** names imported via `import { … } from …` (alias targets resolved). */
	imported: Set<string>;
	/** namespace-import aliases of node:fs / node:fs/promises — covers ALL
	 *  three namespace spellings: `import * as fs`, the default import
	 *  `import fs from "node:fs"` (and the mixed `import fs, { … }` form),
	 *  and the CJS binding `const fs = require("node:fs")`. */
	nsFs: string[];
	/** alias identifiers bound to any of `names` (import … as …). */
	aliasesOf(names: readonly string[]): string[];
}

const RE_EXPORT_FROM = /export\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']*["']/g;

function prepareScan(code: string): PreparedScan {
	const stripped = stripComments(code);
	const noReexport = stripped.replace(RE_EXPORT_FROM, (m) => m.replace(/[^\n]/g, ""));
	const imported = new Set<string>();
	// Named imports, including the mixed `import fs, { readFileSync } from
	// "node:fs"` form (a leading default binding before the braces).
	for (const m of noReexport.matchAll(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']*)["']/g)) {
		for (const piece of m[1].split(",")) {
			const binding = piece.trim().split(/\s+as\s+/)[0]?.trim();
			if (binding) imported.add(binding);
		}
	}
	const nsFs = [...noReexport.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*["']node:fs(?:\/promises)?["']/g)].map((m) => m[1]);
	// Default (and mixed default+named) namespace imports of node:fs.
	for (const m of noReexport.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']node:fs(?:\/promises)?["']/g)) nsFs.push(m[1]);
	// CJS namespace bindings: const fs = require("node:fs").
	for (const m of noReexport.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']node:fs(?:\/promises)?["']\s*\)/g)) nsFs.push(m[1]);
	return {
		noReexport,
		imported,
		nsFs,
		aliasesOf: (names: readonly string[]) => {
			const out: string[] = [];
			for (const n of names) {
				for (const m of noReexport.matchAll(new RegExp(`\\b${n}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g"))) out.push(m[1]);
			}
			return out;
		},
	};
}

/** Pure line scan (unit-callable): import-verified node:fs read calls whose
 *  line carries an exchange path (expaths builder, alias-resolved) or
 *  exchangeRoot(. */
export function scanCodeForWatcherExchangeReads(
	code: string,
): Array<{ line: number; api: string; text: string }> {
	const p = prepareScan(code);
	const builderNames = [...EXPATHS_BUILDERS, ...p.aliasesOf(EXPATHS_BUILDERS)];
	const nameAlt = builderNames.join("|");
	const out: Array<{ line: number; api: string; text: string }> = [];
	p.noReexport.split("\n").forEach((lineText, i) => {
		for (const api of FS_READ_APIS) {
			const bare = p.imported.has(api) && new RegExp(`(?<![\\w$.])${api}\\s*\\(`).test(lineText);
			const viaNs = p.nsFs.some((ns) => new RegExp(`\\b${ns}\\.${api}\\s*\\(`).test(lineText));
			if (!bare && !viaNs) continue;
			const hit = new RegExp(`\\b(?:${nameAlt})\\b`).test(lineText) || /\bexchangeRoot\s*\(/.test(lineText);
			if (hit) out.push({ line: i + 1, api, text: lineText.trim().slice(0, 120) });
		}
	});
	return out;
}

/** Walk <root>/src watcher-family files. Returns per-file offender strings. */
function scanTreeForWatcherExchangeReads(root: string): string[] {
	const offenders: string[] = [];
	for (const base of WATCHER_FAMILY_FILES) {
		const f = resolve(root, "src", base);
		if (!existsSync(f)) continue;
		for (const o of scanCodeForWatcherExchangeReads(readFileSync(f, "utf8"))) {
			offenders.push(`src/${base}:${o.line} [${o.api}] ${o.text}`);
		}
	}
	return offenders;
}

{
	const watcherReadOffenders = scanTreeForWatcherExchangeReads(ROOT);
	check(
		"T1.13 watcher family: no direct node:fs read of an exchange-layer path — satellites excepted, exchange facts via stores + the journal reader (#26, §4.1.2)",
		watcherReadOffenders.length === 0,
		watcherReadOffenders.join(" | "),
	);
}

// #26's mechanism must stay wired (a pin on absence alone could survive the
// journal reader being deleted): watcher.ts consumes the journal ONLY through
// src/swarm/journal-read.ts — createJournalReader imported from that module.
{
	const watcherSrc = readFileSync(resolve(ROOT, "src", "watcher.ts"), "utf8");
	check(
		"T1.13b the watcher consumes the journal through the reader: watcher.ts wires createJournalReader from ./swarm/journal-read.ts (#26's durable cursor seam)",
		/from\s*["']\.\/swarm\/journal-read\.ts["']/.test(watcherSrc) && /\bcreateJournalReader\b/.test(stripComments(watcherSrc)),
	);
}

// Canaries: every forbidden read shape fires (fixture code carries the import
// so the import-verification gate itself is exercised).
const WATCHER_READ_CANARIES: ReadonlyArray<[string, string]> = [
	["readFileSync", 'import { readFileSync } from "node:fs";\nconst r = readFileSync(reportPathFor(dir, name), "utf8");'],
	["existsSync", 'import { existsSync } from "node:fs";\nif (existsSync(join(exchangeRoot(), slug))) return;'],
	["statSync", 'import { statSync } from "node:fs";\nconst m = statSync(answerPathFor(dir, name)).mtimeMs;'],
	["readFile", 'import { readFile } from "node:fs/promises";\nconst t = await readFile(questionPathFor(dir, name), "utf8");'],
	["readFileSync", 'import fs from "node:fs";\nconst r = fs.readFileSync(reportPathFor(dir, name), "utf8");'], // default-import namespace
	["readdirSync", 'import fs, { existsSync } from "node:fs";\nconst es = fs.readdirSync(join(exchangeRoot(), slug));'], // mixed default+named
	["statSync", 'const fs = require("node:fs");\nconst m = fs.statSync(progressPathFor(dir, name)).mtimeMs;'], // CJS binding
];
const watcherMissed = WATCHER_READ_CANARIES
	.filter(([api, code]) => !scanCodeForWatcherExchangeReads(code).some((o) => o.api === api))
	.map(([api, code]) => `${api}: ${code.replaceAll("\n", " ")}`);
check(
	"T1.13c the pin BITES: every exchange-read canary is flagged (unit-called scanner)",
	watcherMissed.length === 0,
	watcherMissed.join(" | "),
);

// Precision guards: satellite reads (the watcher's own durable state) and
// store-routed exchange reads are the SANCTIONED shapes — never flagged.
const WATCHER_READ_CLEAN: ReadonlyArray<string> = [
	'import { readFileSync } from "node:fs";\nraw = readFileSync(watchCursorPathFor(dir, watcherKey), "utf8");',
	'import { statSync } from "node:fs";\nmtimeMs = statSync(watchCursorPathFor(dir, key)).mtimeMs;',
	'const q = readQuestionState(questionPathFor(w.dir, w.name));', // store-routed (mailbox-store)
	'const m = fileMtimeMs(answerPathFor(dir, name));', // helper-routed (fs-probe)
	'lastPing = readLastProgress(progressPathFor(v.dir, v.name)) ?? undefined;', // store-routed (exchange.ts)
];
const watcherFalse = WATCHER_READ_CLEAN
	.filter((code) => scanCodeForWatcherExchangeReads(code).length > 0)
	.map((code) => `${code.replaceAll("\n", " ")} → ${JSON.stringify(scanCodeForWatcherExchangeReads(code))}`);
check(
	"T1.13d the pin is PRECISE: satellite reads and store/helper-routed exchange reads are not flagged",
	watcherFalse.length === 0,
	watcherFalse.join(" | "),
);

// Seeded-file probe: a family file seeded with the forbidden shape is named
// by the real walk, while the same tree's satellite-reading cursor file stays
// clean — red on the violation, green on the sanctioned shape.
{
	const seed = mkdtempSync(resolve(tmpdir(), "watcher-pin-probe-"));
	mkdirSync(resolve(seed, "src"), { recursive: true });
	writeFileSync(
		resolve(seed, "src", "watcher.ts"),
		'import { readFileSync } from "node:fs";\nimport { reportPathFor } from "./expaths.ts";\nconst r = readFileSync(reportPathFor(dir, name), "utf8");\n',
	);
	writeFileSync(
		resolve(seed, "src", "watch-cursor.ts"),
		'import { readFileSync } from "node:fs";\nraw = readFileSync(watchCursorPathFor(dir, watcherKey), "utf8");\n',
	);
	const seeded = scanTreeForWatcherExchangeReads(seed);
	check(
		"T1.13e seeded-file probe: an offending family file turns the pin red; the satellite-reading sibling stays clean",
		seeded.length === 1 && seeded[0]?.startsWith("src/watcher.ts:3") && !seeded.some((s) => s.includes("watch-cursor")),
		JSON.stringify(seeded),
	);
	rmSync(seed, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 9c. T1.14 — single projection writer (§4.1.3 Phase B: “the swarm CLI verbs
//     are the projection's only writers (#31 pin)”), judged HONESTLY on HEAD
//     (Phase A→B transition): the tool paths still write the mailbox
//     projection (§4.1.1 keeps the orchestrator verbs wrapped by the pi tools
//     in this milestone). The pin therefore freezes the writer SET:
//
//     A src/ file that references a projection-path builder (the expaths
//     report/q/a/p builders below, alias-resolved; `export … from`
//     pass-throughs excluded) AND performs a write-shaped file call
//     (import-verified node:fs write API, or the shared atomic/store writers
//     atomicWriteFileSync / writeAnswer / writeRelease) must appear in the
//     typed allowlist below. Deletion APIs (rm/unlink) are NOT write-shaped:
//     they serve the release/nudge-marker consume discipline, not content
//     writes (the retired-row audit, not this pin, owns them).
//
//     Both directions are exact — an unlisted match is a NEW projection
//     writer (red), and an allowlisted row whose file no longer matches is a
//     stale row that the audit must retire (red) — the Law 5 ledger
//     convention. The allowlist is the follow-up ledger: when Phase A
//     retires (mailbox writes migrate to swarm verbs), the legacy rows
//     shrink to verbs-only.
// ---------------------------------------------------------------------------

/** The projection path set this pin owns: report/q/a/p (§4.1.3's “expaths-
 *  built report/q/a/p paths”). manifest.json, release- and nudge-markers and
 *  watcher satellites are separate contracts with their own stores. */
const PROJECTION_BUILDERS = ["reportPathFor", "questionPathFor", "answerPathFor", "progressPathFor"] as const;

/** Write-shaped APIs. Plain fs/promises names (rename, writeFile, …) are
 *  import-verified (a local string helper named `truncate` is not fs); sync
 *  names likewise for uniformity. atomicWriteFileSync / writeAnswer /
 *  writeRelease are src store writers — any call site counts, wherever the
 *  function was defined. */
const FS_WRITE_APIS = [
	"writeFileSync", "appendFileSync", "renameSync", "writeFile", "appendFile", "rename",
	"writeSync", "openSync", "truncate", "truncateSync", "copyFileSync", "cpSync",
] as const;
const STORE_WRITE_APIS = ["atomicWriteFileSync", "writeAnswer", "writeRelease"] as const;

function projectionWriterShape(code: string): { builders: boolean; writeCalls: string[] } {
	const p = prepareScan(code);
	const names = [...PROJECTION_BUILDERS, ...p.aliasesOf(PROJECTION_BUILDERS)];
	const builders = names.length > 0 && new RegExp(`\\b(?:${names.join("|")})\\b`).test(p.noReexport);
	const writeCalls: string[] = [];
	for (const api of FS_WRITE_APIS) {
		if (p.imported.has(api) && new RegExp(`(?<![\\w$.])${api}\\s*\\(`).test(p.noReexport)) writeCalls.push(api);
	}
	for (const ns of p.nsFs) {
		for (const api of FS_WRITE_APIS) {
			if (new RegExp(`\\b${ns}\\.${api}\\s*\\(`).test(p.noReexport)) writeCalls.push(`${ns}.${api}`);
		}
	}
	for (const api of STORE_WRITE_APIS) {
		if (new RegExp(`(?<![\\w$.])${api}\\s*\\(`).test(p.noReexport)) writeCalls.push(api);
	}
	return { builders, writeCalls };
}

/** The allowlist IS the statement of who may write the projection on HEAD.
 *  Keep rows typed and reasoned (T1.8 convention: a named entry + a written
 *  reason, never a silent pass). */
const PROJECTION_WRITER_ALLOWLIST: ReadonlyArray<{ file: string; klass: string; reason: string }> = [
	{ file: "src/swarm/write-report.ts", klass: "verb", reason: "swarm write-report — publishes report-<name>.json (writeFileSync validate-temp + renameSync publish, §4.1.3 Phase B ordering)" },
	{ file: "src/swarm/ask.ts", klass: "verb", reason: "swarm ask — posts q-<name>.json atomically after the journal append" },
	{ file: "src/swarm/write-progress.ts", klass: "verb", reason: "swarm write-progress — appends p-<name>.jsonl after the journal append" },
	{ file: "src/mailbox-store.ts", klass: "legacy-phase-a", reason: "Phase A tool path — the a-file writer (writeAnswer via postSteerAndNudge) + release-marker writer + the shared question archive, driven by the delegate_mailbox tool and the #51 HTTP verb core; §4.1.1 keeps orchestrator verbs tool-wrapped this milestone; shrinks when the tool path migrates to swarm verbs" },
	{ file: "src/swarm/mailbox-verbs.ts", klass: "orchestrator-verb", reason: "#51 HTTP mutation core — routes steer/answer through the SAME writeAnswer/postSteerAndNudge the tool uses, then appends the journal row; the sanctioned orchestrator-verb writer (§4.2.4)" },
	{ file: "src/mailbox-tool.ts", klass: "legacy-phase-a", reason: "Phase A tool path — the delegate_mailbox tool: q→answered archive rename + drives the a-file write; same retirement as mailbox-store" },
	{ file: "src/spawn.ts", klass: "legacy-phase-a-adjacent", reason: "co-occurrence row, NOT a projection writer: builder refs are read-only (report-witness/question/progress reads); its exchange-dir writes are the teardown.log append and nudge-marker cleanup only — the pin's file-level predicate is co-occurrence, not dataflow, so the row exists with this reason; retiring Phase A must shrink this set" },
];

function scanTreeForProjectionWriters(root: string): string[] {
	const matches: string[] = [];
	for (const f of listTsFiles(resolve(root, "src"))) {
		const rel = relative(root, f).replaceAll("\\", "/");
		const shape = projectionWriterShape(readFileSync(f, "utf8"));
		if (shape.builders && shape.writeCalls.length > 0) matches.push(rel);
	}
	return matches.sort();
}

{
	const computed = scanTreeForProjectionWriters(ROOT);
	const allowed = PROJECTION_WRITER_ALLOWLIST.map((r) => r.file).sort();
	const unlisted = computed.filter((f) => !allowed.includes(f));
	const stale = allowed.filter((f) => !computed.includes(f));
	check(
		"T1.14 projection writer set (§4.1.3): the only src/ files combining a report/q/a/p builder with a write-shaped call are the CLI verbs + the named Phase A legacy rows — exact in both directions",
		unlisted.length === 0 && stale.length === 0,
		`new writers outside the allowlist: ${unlisted.join(", ") || "none"}; stale rows (audit must retire): ${stale.join(", ") || "none"}`,
	);
}

/** Pure line scan: a write-shaped call carrying a projection-builder call
 *  DIRECTLY in its argument list. Neither the verb pattern (assign to a
 *  local, then write) nor the store pattern (writeAnswer(path) with the path
 *  built by a helper) ever produces this shape — so a direct combo is always
 *  a violation, allowlisted files included. */
export function scanCodeForProjectionWriteCombos(
	code: string,
): Array<{ line: number; kind: string; text: string }> {
	const p = prepareScan(code);
	const names = [...PROJECTION_BUILDERS, ...p.aliasesOf(PROJECTION_BUILDERS)];
	const writeApis: string[] = [];
	for (const api of FS_WRITE_APIS) if (p.imported.has(api)) writeApis.push(api);
	for (const ns of p.nsFs) for (const api of FS_WRITE_APIS) writeApis.push(`${ns}.${api}`); // raw — the join below escapes the dots once
	writeApis.push(...STORE_WRITE_APIS);
	const writeAlt = writeApis.join("|").replace(/\./g, "\\.");
	// Text-global (a call's arguments may span lines — the waived q-archive
	// rename in mailbox-tool.ts is exactly that shape); [^)]*? cannot cross
	// the closing paren of the write call's own argument list, so matches stay
	// bounded to one call. Line numbers are computed from the match offset.
	const combo = new RegExp(`(?<![\\w$.])(?:${writeAlt})\\s*\\([^)]*?\\b(?:${names.join("|")})\\s*\\(`, "g");
	const out: Array<{ line: number; kind: string; text: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = combo.exec(p.noReexport)) !== null) {
		const line = p.noReexport.slice(0, m.index).split("\n").length;
		out.push({ line, kind: "direct write combo", text: m[0].replace(/\s+/g, " ").trim().slice(0, 120) });
	}
	return out;
}

/** Named waiver for the ONE sanctioned direct combo on HEAD: the shared
 *  question archive (mailbox-store.ts archiveQuestion, used by the
 *  delegate_mailbox tool AND the #51 HTTP verb core) renames the pending
 *  question immediately after the answer lands (q-<name>.json →
 *  q-<name>.answered-<ts>.json) — the frozen Phase A consume discipline (a
 *  surviving q-file would re-fire AWAITING_ANSWER). */
const PROJECTION_COMBO_WAIVERS: ReadonlyArray<{ file: string; api: string; reason: string }> = [
	{ file: "src/mailbox-store.ts", api: "rename", reason: "q→answered archive rename right after the answer lands — the frozen consume discipline; the ONE shared implementation (tool + #51 HTTP core)" },
];

{
	const offenders: string[] = [];
	for (const f of listTsFiles(resolve(ROOT, "src"))) {
		const rel = relative(ROOT, f).replaceAll("\\", "/");
		for (const o of scanCodeForProjectionWriteCombos(readFileSync(f, "utf8"))) {
			const waived = PROJECTION_COMBO_WAIVERS.some((w) => w.file === rel && o.text.includes("questionPathFor"));
			if (!waived) offenders.push(`${rel}:${o.line} ${o.text}`);
		}
	}
	check(
		"T1.14b no direct write combo on a projection path anywhere in src/ (neither verbs nor legacy rows write builders inline — the one waived Phase A q-archive rename excepted)",
		offenders.length === 0,
		offenders.join(" | "),
	);
	// The waiver must stay LIVE (T1.9d): the waived shape really occurs.
	const mtCombos = scanCodeForProjectionWriteCombos(readFileSync(resolve(ROOT, "src", "mailbox-store.ts"), "utf8"))
		.filter((o) => o.text.includes("questionPathFor"));
	check(
		"T1.14c the combo waiver is LIVE: mailbox-store.ts archiveQuestion still carries the waived q→answered rename (stale waiver fails the audit)",
		mtCombos.length > 0,
	);
}

// Canaries + precision for the combo scanner.
{
	const comboCanaries: ReadonlyArray<[boolean, string]> = [
		[true, 'import { writeFileSync } from "node:fs";\nimport { reportPathFor } from "./expaths.ts";\nwriteFileSync(reportPathFor(d, n), x);'],
		[true, 'import { appendFile } from "node:fs/promises";\nimport { progressPathFor as pp } from "./expaths.ts";\nawait appendFile(pp(d, n), line);'],
		[true, 'import { atomicWriteFileSync } from "./manifest-store.ts";\nimport { questionPathFor } from "./expaths.ts";\natomicWriteFileSync(questionPathFor(d, n), c);'],
		[true, 'import fs from "node:fs";\nimport { reportPathFor } from "./expaths.ts";\nfs.writeFileSync(reportPathFor(d, n), x);'], // default-import namespace write
		[true, 'const fs = require("node:fs");\nimport { answerPathFor } from "./expaths.ts";\nfs.appendFileSync(answerPathFor(d, n), x);'], // CJS binding write
		[false, 'import { writeFileSync } from "node:fs";\nimport { reportPathFor } from "./expaths.ts";\nconst p = reportPathFor(d, n);\nwriteFileSync(p, x);'], // verb pattern: local then write
		[false, 'import { readFileSync } from "node:fs";\nimport { reportPathFor } from "./expaths.ts";\nconst r = readFileSync(reportPathFor(d, n), "utf8");'], // read, not write
	];
	const comboMissed = comboCanaries
		.filter(([shouldFire, code]) => (scanCodeForProjectionWriteCombos(code).length > 0) !== shouldFire)
		.map(([shouldFire, code]) => `expected ${shouldFire ? "FIRE" : "clean"}: ${code.replaceAll("\n", " ")}`);
	check(
		"T1.14d the combo pin BITES and is PRECISE: direct builder-in-write-call fires; the verb local-variable pattern and read calls do not",
		comboMissed.length === 0,
		comboMissed.join(" | "),
	);
}

// Seeded-file probe: a new module writing a projection path joins the
// computed writer set — which no longer equals the allowlist, i.e. the pin
// goes red exactly as acceptance 1 demands.
{
	const seed = mkdtempSync(resolve(tmpdir(), "writer-pin-probe-"));
	mkdirSync(resolve(seed, "src"), { recursive: true });
	// Reuse the REAL allowlist files? No — the probe asserts set arithmetic on a
	// minimal tree: allowlist minus seeded tree is all-stale, so compare only
	// the membership side: the seeded violator must appear in the computed set.
	writeFileSync(
		resolve(seed, "src", "fleet.ts"),
		'import { writeFileSync } from "node:fs";\nimport { reportPathFor } from "./expaths.ts";\nexport function dump(d: string, n: string, x: string) { writeFileSync(reportPathFor(d, n), x); }\n',
	);
	writeFileSync(
		resolve(seed, "src", "reader.ts"),
		'import { readFileSync } from "node:fs";\nimport { questionPathFor } from "./expaths.ts";\nexport function q(d: string, n: string) { return readFileSync(questionPathFor(d, n), "utf8"); }\n',
	);
	const seeded = scanTreeForProjectionWriters(seed);
	const seededCombos = scanCodeForProjectionWriteCombos(readFileSync(resolve(seed, "src", "fleet.ts"), "utf8"));
	check(
		"T1.14e seeded-file probe: a new projection-writing module enters the computed writer set and trips the combo ban; the read-only sibling does not",
		seeded.length === 1 && seeded[0] === "src/fleet.ts" && seededCombos.length === 1,
		JSON.stringify({ seeded, seededCombos }),
	);
	rmSync(seed, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 10. swarm-server pins (#50, Law 6/13; binding spec §4.2). The session-hosted
//     read server is a Law-13 CLIENT: fleet state enters ONLY via the
//     read-model. The pin bans the family's direct imports of durable stores,
//     observation surfaces, backend adapters and the journal writer half;
//     the journal is consumed ONLY through swarm/journal-read.ts (the
//     reader), the read API through the swarm verb/read-model modules.
// ---------------------------------------------------------------------------

/** The banned import targets for src/swarm-server/**, relative from the
 *  family root (normalized to repo-relative paths at scan time). */
const SWARM_SERVER_BANNED_IMPORTS: ReadonlyArray<string> = [
	"src/manifest-store.ts", // durable store (Law 13)
	"src/watch-store.ts", // durable store (Law 13)
	"src/exchange.ts", // exchange-layer reads incl. progress files (Law 13)
	"src/observe.ts", // observation surface internals (Law 6 allowlist edge)
	"src/watcher.ts", // watcher internals (not a client surface)
	"src/fleet.ts", // observation-surface state derivation (Law 13)
	"src/worker-view.ts", // observation-surface state derivation (Law 13)
	"src/herdr/host.ts", // backend adapter (Law 4 — index.ts only)
	"src/host/rpc.ts", // backend adapter (Law 4 — index.ts only)
	"src/swarm/journal.ts", // the journal WRITER half; the reader is the only door
	"src/swarm/journal-copy.ts", // the CLI-only temp-copy workaround (§4.2 spec)
	"src/swarm/journal-driver.ts", // the sqlite seam (also T1.12)
	"src/swarm/journal-manifest-store.ts", // manifest replay enters via snapshot.ts's manifestSource
];

/** Pure per-source scan (T1.9 convention: unit-callable for canaries).
 *  Input: file text + the file's repo-relative path (for specifier
 *  normalization); flags every static/dynamic/side-effect relative import
 *  that resolves to a banned target. */
export function scanCodeForSwarmServerBannedImports(
	code: string,
	fromRelPath: string,
): Array<{ line: number; target: string; text: string }> {
	const out: Array<{ line: number; target: string; text: string }> = [];
	const dir = fromRelPath.includes("/") ? fromRelPath.slice(0, fromRelPath.lastIndexOf("/")) : "";
	const importRe = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
	const stripped = stripComments(code);
	let m: RegExpExecArray | null;
	while ((m = importRe.exec(stripped)) !== null) {
		const spec = m[1];
		// resolve <dir>/<spec> against the repo root, POSIX-normalized
		const parts = (dir ? dir.split("/") : []);
		for (const seg of spec.split("/")) {
			if (seg === ".") continue;
			if (seg === "..") parts.pop();
			else parts.push(seg);
		}
		const target = parts.join("/");
		if (SWARM_SERVER_BANNED_IMPORTS.includes(target)) {
			const line = stripped.slice(0, m.index).split("\n").length;
			out.push({ line, target, text: m[0].replace(/\s+/g, " ").trim() });
		}
	}
	return out;
}

/** Walk the family tree under <root>/src/swarm-server (recursively). */
function scanTreeForSwarmServerBannedImports(root: string): string[] {
	const offenders: string[] = [];
	for (const f of listTsFiles(resolve(root, "src", "swarm-server"))) {
		const rel = relative(root, f).replaceAll("\\", "/");
		for (const o of scanCodeForSwarmServerBannedImports(readFileSync(f, "utf8"), rel)) {
			offenders.push(`${rel}:${o.line} → ${o.target} [${o.text}]`);
		}
	}
	return offenders;
}

{
	const offenders = scanTreeForSwarmServerBannedImports(ROOT);
	check(
		"T1.15 swarm-server family (Law 13 read-path): no direct import of a durable store, observation surface, backend adapter or the journal writer half (#50, §4.2)",
		offenders.length === 0,
		offenders.join(" | "),
	);
}

// LIVE (T1.9d): the family exists and really crosses the sanctioned doors —
// a deleted family (or a renamed dir) must fail the audit that retires this pin.
check(
	"T1.15b the pin is LIVE: src/swarm-server/ exists and the sanctioned doors exist (reader + read API)",
	existsSync(resolve(ROOT, "src", "swarm-server", "server.ts")) &&
		existsSync(resolve(ROOT, "src", "swarm", "journal-read.ts")) &&
		existsSync(resolve(ROOT, "src", "swarm", "graph.ts")),
);
{
	const mountSrc = readFileSync(resolve(ROOT, "src", "swarm-server", "journal-session.ts"), "utf8");
	check(
		"T1.15c the family consumes the journal ONLY through the reader (journal-session.ts wires createJournalReader from ../swarm/journal-read.ts)",
		/createJournalReader/.test(stripComments(mountSrc)) && /journal-read\.ts/.test(mountSrc),
	);
}

// Canary + precision + seeded probe (T1.9b/c/e): every banned shape fires,
// the sanctioned doors stay clean, and a seeded offender tree goes red.
{
	const canaries: ReadonlyArray<[string, string]> = [
		["manifest-store", 'import { manifestStore } from "../manifest-store.ts";'],
		["exchange", 'import { readLastProgress } from "../exchange.ts";'],
		["herdr adapter", 'import { createHerdrTransport } from "../herdr/host.ts";'],
		["journal writer", 'import { createJournalWriter } from "../swarm/journal.ts";'],
		["journal-copy", 'const { withJournalCopy } = await import("../swarm/journal-copy.ts");'],
		["dynamic manifest-store", 'const s = await import("../manifest-store.ts");'],
	];
	const missed = canaries
		.filter(([, code]) => scanCodeForSwarmServerBannedImports(code, "src/swarm-server/x.ts").length === 0)
		.map(([name, code]) => `${name}: ${code}`);
	check("T1.15d the pin BITES: every banned-import canary is flagged (unit-called scanner)", missed.length === 0, missed.join(" | "));

	const clean: ReadonlyArray<string> = [
		'import { createJournalReader } from "../swarm/journal-read.ts";',
		'import { buildSwarmGraph } from "../swarm/graph.ts";',
		'import { parseSessionUsage } from "../usage.ts";',
		'import type { Transport } from "../host.ts";',
		'import { mountSwarmServer } from "./mount.ts";',
	];
	const falsePositives = clean
		.filter((code) => scanCodeForSwarmServerBannedImports(code, "src/swarm-server/x.ts").length > 0);
	check("T1.15e the pin is PRECISE: the sanctioned doors (reader, read API, usage seam, host TYPE, family-internal) stay clean", falsePositives.length === 0, falsePositives.join(" | "));

	const seed = mkdtempSync(resolve(tmpdir(), "swarm-server-pin-probe-"));
	mkdirSync(resolve(seed, "src", "swarm-server"), { recursive: true });
	writeFileSync(resolve(seed, "src", "swarm-server", "evil.ts"), 'import { manifestStore } from "../manifest-store.ts";\nexport const x = 1;\n');
	writeFileSync(resolve(seed, "src", "swarm-server", "ok.ts"), 'import { createJournalReader } from "../swarm/journal-read.ts";\nexport const y = 2;\n');
	const seeded = scanTreeForSwarmServerBannedImports(seed);
	check(
		"T1.15f seeded-file probe: a family module importing a durable store goes red; the reader-door sibling stays clean",
		seeded.length === 1 && seeded[0].includes("evil.ts") && seeded[0].includes("src/manifest-store.ts"),
		seeded.join(" | "),
	);
	rmSync(seed, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 11. T1.16 — #51 mutation surface: the write path never bypasses the journal
//     (Law 6/8). The shared core journals every mutation; the server family
//     owns no direct mailbox write, so it cannot append without a journal row.
// ---------------------------------------------------------------------------

/** Direct mailbox/projection write-shaped APIs the SERVER family must not
 *  call — the mutation core owns the write AND the journal append. */
const SERVER_DIRECT_MAILBOX_WRITE_APIS = [
	"writeAnswer",
	"postSteerAndNudge",
	"atomicWriteFileSync",
	"writeFileSync",
	"appendFileSync",
	"answerPathFor",
] as const;

/** Pure per-source scan (T1.9 convention: unit-callable for canaries). */
export function scanCodeForServerDirectMailboxWrite(code: string): string[] {
	const stripped = stripComments(code);
	return SERVER_DIRECT_MAILBOX_WRITE_APIS.filter((api) =>
		new RegExp(`(?<![\\w$.])${api}\\s*\\(`).test(stripped),
	);
}

{
	const coreSrc = readFileSync(resolve(ROOT, "src", "swarm", "mailbox-verbs.ts"), "utf8");
	check(
		"T1.16a the #51 mutation core journals every mutation: src/swarm/mailbox-verbs.ts calls appendSwarmEvent (the verb journal plumbing)",
		existsSync(resolve(ROOT, "src", "swarm", "mailbox-verbs.ts")) && /appendSwarmEvent\s*\(/.test(stripComments(coreSrc)),
	);

	const offenders: string[] = [];
	for (const f of listTsFiles(resolve(ROOT, "src", "swarm-server"))) {
		const rel = relative(ROOT, f).replaceAll("\\", "/");
		const hits = scanCodeForServerDirectMailboxWrite(readFileSync(f, "utf8"));
		if (hits.length > 0) offenders.push(`${rel} → ${hits.join(", ")}`);
	}
	check(
		"T1.16b no src/swarm-server/** file makes a direct mailbox write — the mutation path delegates to the journaling core, so it cannot bypass the journal (#51 acceptance 6)",
		offenders.length === 0,
		offenders.join(" | "),
	);

	const mountSrc = readFileSync(resolve(ROOT, "src", "swarm-server", "mount.ts"), "utf8");
	check(
		"T1.16c the mutation core is really wired: mount.ts imports runOrchestratorVerb and passes it as the route table's mutate seam",
		/runOrchestratorVerb/.test(stripComments(mountSrc)) && /mutate/.test(stripComments(mountSrc)),
	);

	const canaries: ReadonlyArray<[boolean, string]> = [
		[true, 'import { writeAnswer } from "../mailbox-store.ts";\nwriteAnswer(p, t);'],
		[true, 'import { postSteerAndNudge } from "../mailbox-store.ts";\nawait postSteerAndNudge(tr, n, d, t);'],
		[true, 'import { writeFileSync } from "node:fs";\nwriteFileSync(p, x);'],
		[false, 'import { runOrchestratorVerb } from "../swarm/mailbox-verbs.ts";\nconst r = await runOrchestratorVerb(deps, req);'],
		[false, 'export type T = { answerPath?: string };'],
	];
	const missed = canaries
		.filter(([shouldFire, code]) => (scanCodeForServerDirectMailboxWrite(code).length > 0) !== shouldFire)
		.map(([shouldFire, code]) => `expected ${shouldFire ? "FIRE" : "clean"}: ${code.replaceAll("\n", " ")}`);
	check(
		"T1.16d the pin BITES and is PRECISE: direct mailbox writes fire; the core-delegation shape stays clean",
		missed.length === 0,
		missed.join(" | "),
	);

	const seed = mkdtempSync(resolve(tmpdir(), "swarm-server-journal-pin-"));
	mkdirSync(resolve(seed, "src", "swarm-server"), { recursive: true });
	writeFileSync(resolve(seed, "src", "swarm-server", "bad.ts"), 'import { writeAnswer } from "../mailbox-store.ts";\nexport const x = (p: string, t: string) => writeAnswer(p, t);\n');
	writeFileSync(resolve(seed, "src", "swarm-server", "good.ts"), 'import { runOrchestratorVerb } from "../swarm/mailbox-verbs.ts";\nexport const y = 2;\n');
	const seeded = listTsFiles(resolve(seed, "src", "swarm-server"))
		.map((f) => relative(seed, f).replaceAll("\\", "/"))
		.filter((rel) => scanCodeForServerDirectMailboxWrite(readFileSync(resolve(seed, rel), "utf8")).length > 0);
	check(
		"T1.16e seeded-file probe: a family module writing the mailbox directly goes red; the core-delegating sibling stays clean",
		seeded.length === 1 && seeded[0].includes("bad.ts"),
		seeded.join(" | "),
	);
	rmSync(seed, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 12. fleet-dashboard static pins (#53, Law 6/§4.2). The read-only dashboard
//     is a static SPA served as source: no build step, no framework/bundler,
//     no external network, no mutation verbs, sessionStorage for the cursor
//     ONLY. The pins are textual by nature (they prohibit literals/shapes)
//     and carry canaries + a seeded-file probe so a vacuous pin self-fails.
// ---------------------------------------------------------------------------

/** The dashboard asset root (issue #53). */
const DASHBOARD_PUBLIC_DIR = resolve(ROOT, "src", "swarm-server", "public");

/** The rule ids the dashboard-asset scanner can emit. */
export type DashboardAssetRule =
	| "external-url"
	| "framework-or-bundler"
	| "mutation-verb"
	| "local-storage";

/** Pure scan of one dashboard asset (JS/HTML/CSS) for forbidden runtime
 *  shapes. Comments are stripped first so prose (docs in the module header)
 *  never trips a rule. Input: the raw file text. Output: one entry per match. */
export function scanDashboardAsset(code: string): Array<{ rule: DashboardAssetRule; match: string }> {
	const out: Array<{ rule: DashboardAssetRule; match: string }> = [];
	const stripped = stripComments(code);
	const push = (rule: DashboardAssetRule, m: RegExpMatchArray | null) => {
		if (m) out.push({ rule, match: m[0].replace(/\s+/g, " ").trim() });
	};
	for (const m of stripped.matchAll(/https?:\/\/[^\s"'`)]+/g)) out.push({ rule: "external-url", match: m[0] });
	push(
		"framework-or-bundler",
		stripped.match(/\b(react|preact|vue|svelte|angular|jquery|webpack|rollup|esbuild|vite|parcel|node_modules)\b/i),
	);
	push("mutation-verb", stripped.match(/["'](POST|PUT|PATCH|DELETE)["']|\bmethod\s*:/));
	push("local-storage", stripped.match(/\blocalStorage\b/));
	return out;
}

/** Walk every dashboard asset under <root>/src/swarm-server/public. */
function listDashboardAssets(root: string): string[] {
	try {
		return readdirSync(resolve(root, "src", "swarm-server", "public"), { withFileTypes: true })
			.filter((e) => e.isFile() && /\.(js|html|css)$/.test(e.name))
			.map((e) => resolve(root, "src", "swarm-server", "public", e.name));
	} catch {
		return [];
	}
}

{
	const assets = listDashboardAssets(ROOT).map((f) => relative(ROOT, f).replaceAll("\\", "/"));
	check(
		"T1.20 the dashboard assets exist (index.html + one file per module)",
		["index.html", "app.js", "app.css", "tree.js", "stream.js", "degrade.js"].every((n) => assets.includes(`src/swarm-server/public/${n}`)),
		assets.join(", "),
	);

	const offenders: string[] = [];
	for (const f of listDashboardAssets(ROOT)) {
		const rel = relative(ROOT, f).replaceAll("\\", "/");
		for (const o of scanDashboardAsset(readFileSync(f, "utf8"))) offenders.push(`${rel}: ${o.rule} [${o.match}]`);
	}
	check(
		"T1.21 dashboard assets make ZERO external network calls and carry no framework/bundler/mutation-shape (#53)",
		offenders.length === 0,
		offenders.join(" | "),
	);
}

check(
	"T1.21b the pin is LIVE: the server wires the static route and static.ts owns the html/js/css MIME set",
	existsSync(resolve(ROOT, "src", "swarm-server", "static.ts")) &&
		/serveStaticFile/.test(readFileSync(resolve(ROOT, "src", "swarm-server", "server.ts"), "utf8")) &&
		/\.html/.test(readFileSync(resolve(ROOT, "src", "swarm-server", "static.ts"), "utf8")),
);

{
	// sessionStorage is the cursor store ONLY; localStorage is banned.
	const app = readFileSync(resolve(ROOT, "src", "swarm-server", "public", "app.js"), "utf8");
	const others = ["tree.js", "stream.js", "degrade.js"].filter((n) => readFileSync(resolve(ROOT, "src", "swarm-server", "public", n), "utf8").includes("sessionStorage"));
	check(
		"T1.22 sessionStorage is used only by app.js and only for the cursor key (no localStorage)",
		app.includes("swarm.dashboard.lastSeq") && others.length === 0 && scanDashboardAsset(app).every((o) => o.rule !== "local-storage"),
		others.join(", "),
	);

	// No build artifacts: only flat source assets, no maps/bundles/dist.
	const artifacts = readdirSync(DASHBOARD_PUBLIC_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory() || /\.(map|min\.js|bundle\.js)$/.test(e.name))
		.map((e) => e.name);
	check("T1.23 no build artifacts under the dashboard asset root (no dist/, no *.map/*.min.js)", artifacts.length === 0, artifacts.join(", "));
}

{
	// Canaries: every rule bites; a clean asset stays clean.
	const canaries: ReadonlyArray<[DashboardAssetRule, string]> = [
		["external-url", 'fetch("https://cdn.example.com/x.js");'],
		["framework-or-bundler", 'import React from "react";'],
		["mutation-verb", 'fetch("/api/x", { method: "POST" });'],
		["local-storage", 'localStorage.setItem("x", "1");'],
	];
	const missed = canaries.filter(([rule, code]) => !scanDashboardAsset(code).some((o) => o.rule === rule)).map(([rule]) => rule);
	check("T1.23b the pin BITES: every forbidden shape has a canary that fires", missed.length === 0, missed.join(", "));

	const clean = [
		'const res = await fetch("/api/swarm/snapshot");',
		'import { buildTreeView } from "./tree.js";',
		'sessionStorage.setItem("swarm.dashboard.lastSeq", String(seq));',
	];
	const falsePositives = clean.filter((code) => scanDashboardAsset(code).length > 0);
	check("T1.23c the pin is PRECISE: relative fetches, relative imports and the cursor write stay clean", falsePositives.length === 0, falsePositives.join(" | "));

	// Seeded-file probe: a fixture tree walked by the real scanner goes red.
	const seed = mkdtempSync(resolve(tmpdir(), "dashboard-pin-probe-"));
	mkdirSync(resolve(seed, "src", "swarm-server", "public"), { recursive: true });
	writeFileSync(resolve(seed, "src", "swarm-server", "public", "evil.js"), 'fetch("https://evil.example/x");\n', "utf8");
	writeFileSync(resolve(seed, "src", "swarm-server", "public", "ok.js"), 'fetch("/api/swarm/snapshot");\n', "utf8");
	const seeded = listDashboardAssets(seed).flatMap((f) => scanDashboardAsset(readFileSync(f, "utf8")).map((o) => `${relative(seed, f)}:${o.rule}`));
	check(
		"T1.23d seeded-file probe: a fixture with an external URL goes red; the relative sibling stays clean",
		seeded.length === 1 && seeded[0].includes("evil.js") && seeded[0].includes("external-url"),
		seeded.join(" | "),
	);
	rmSync(seed, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL STATIC CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
