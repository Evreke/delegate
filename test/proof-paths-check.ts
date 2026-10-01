/**
 * proof-paths-check — MS-SYM-CONTRACT-1 §5: collect-time proof-path
 * validation (hard-fail on pass).
 *
 * Run with: bun test/proof-paths-check.ts   (from repo root)
 *
 * Covers acceptance 1a–1d, the fail-report non-block, relative-vs-absolute
 * resolution, the ephemeral fail AND warn modes, the config resolution
 * (collect.ephemeralProof "fail" default | "warn"), and a collect-drive over
 * the fake backend proving a status=pass report with a missing proof path
 * surfaces E_PROOF_MISSING (modeled on collect-teardown-check C2.5).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { detectPseudoPath, stripLineSuffix, validateProofPaths } from "../src/proof-paths.ts";
import {
	COLLECT_DEFAULT_EPHEMERAL_PROOF,
	resolveCollectConfig,
} from "../src/watch-config.ts";
import { registerDelegateTool } from "../src/spawn.ts";
import { FakeWorkerHost } from "../src/host/fake.ts";
import type { Transport, WorkerReport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// Unit fixtures — injected ephemeral roots (not the real /tmp) so the
// ephemeral-vs-durable distinction is deterministic regardless of host.
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "proof-work-"));
const cwd = join(work, "proj");
mkdirSync(cwd, { recursive: true });
const tempRoot = join(work, "os-tmp");
mkdirSync(tempRoot, { recursive: true });
const exchangeRoot = join(work, "exchange");
mkdirSync(exchangeRoot, { recursive: true });

const durableFile = join(cwd, "durable.txt");
writeFileSync(durableFile, "x");
const relativeOnly = join(cwd, "rel.txt");
writeFileSync(relativeOnly, "y");
const dirArtifact = join(cwd, "dist");
mkdirSync(dirArtifact, { recursive: true });
const ephemeralFile = join(tempRoot, "eph.txt");
writeFileSync(ephemeralFile, "z");
const exchangeFile = join(exchangeRoot, "in-exchange.txt");
writeFileSync(exchangeFile, "q");

const opts = (ephemeralProof: "fail" | "warn" = "fail") => ({
	cwd,
	exchangeRoot,
	tempDir: tempRoot,
	ephemeralProof,
});

const report = (overrides: Partial<WorkerReport> = {}): WorkerReport => ({
	worker: "w",
	status: "pass",
	summary: "s",
	artifacts: [],
	evidence: [{ claim: "c", file: durableFile }],
	...overrides,
});

// ---------------------------------------------------------------------------
// 1a–1d unit checks
// ---------------------------------------------------------------------------

{
	const r = validateProofPaths(report({ evidence: [] }), opts());
	check("1a evidence.length < 1 → reject", !r.ok && /at least one evidence/.test(r.error), JSON.stringify(r));
}

{
	const r = validateProofPaths(report({ artifacts: [join(cwd, "nope.txt")] }), opts());
	check("1b missing artifact → reject naming the path", !r.ok && /artifact path does not exist/.test(r.error) && r.error.includes("nope.txt"), JSON.stringify(r));
	check("1b existing file artifact → ok", validateProofPaths(report({ artifacts: [durableFile] }), opts()).ok);
	check("1b existing directory artifact → ok", validateProofPaths(report({ artifacts: [dirArtifact] }), opts()).ok);
}

{
	const r = validateProofPaths(report({ evidence: [{ claim: "c", file: join(cwd, "nope.ts") }] }), opts());
	check("1c missing evidence file → reject naming the path", !r.ok && /evidence file does not exist/.test(r.error) && r.error.includes("nope.ts"), JSON.stringify(r));
	check("1c evidence file with :line → ok (suffix stripped)", validateProofPaths(report({ evidence: [{ claim: "c", file: `${durableFile}:42` }] }), opts()).ok);
	check("1c evidence file with :start-end → ok (suffix stripped)", validateProofPaths(report({ evidence: [{ claim: "c", file: `${durableFile}:1-10` }] }), opts()).ok);
}

{
	const markers = ["TODO", "N/A", "TBD", "none"];
	for (const m of markers) {
		const r = validateProofPaths(report({ evidence: [{ claim: "c", file: m }] }), opts());
		check(`1d marker "${m}" → reject as pseudo-path`, !r.ok && /not a filesystem path/.test(r.error) && /placeholder marker/.test(r.error), JSON.stringify(r));
	}
	const ws = validateProofPaths(report({ evidence: [{ claim: "c", file: "docker logs worker-1" }] }), opts());
	check("1d command-output (whitespace) → reject as pseudo-path", !ws.ok && /not a filesystem path/.test(ws.error) && /whitespace/.test(ws.error), JSON.stringify(ws));
	const bare = validateProofPaths(report({ evidence: [{ claim: "c", file: "bare" }] }), opts());
	check("1d bare token (no separator, no extension) → reject as pseudo-path", !bare.ok && /not a filesystem path/.test(bare.error) && /bare token/.test(bare.error), JSON.stringify(bare));
}

// ---------------------------------------------------------------------------
// fail-report non-block + relative/absolute resolution + ephemeral modes
// ---------------------------------------------------------------------------

{
	check(
		"fail report with empty evidence → ok (never blocked, never converted)",
		validateProofPaths(report({ status: "fail", evidence: [], artifacts: [join(cwd, "nope.txt")] }), opts()).ok,
	);
}

{
	check("relative evidence resolves against cwd", validateProofPaths(report({ evidence: [{ claim: "c", file: "rel.txt" }] }), opts()).ok);
	check("absolute evidence used as-is", validateProofPaths(report({ evidence: [{ claim: "c", file: durableFile }] }), opts()).ok);
	// A relative name that resolves under cwd but exists nowhere else proves
	// resolution uses cwd (not process.cwd()): rel.txt lives only in `cwd`.
	check("relative artifact resolves against cwd", validateProofPaths(report({ evidence: [{ claim: "c", file: "rel.txt" }] }), opts()).ok);
}

{
	const r = validateProofPaths(report({ evidence: [{ claim: "c", file: ephemeralFile }] }), opts("fail"));
	check("ephemeral (all under temp dir) → reject in fail mode", !r.ok && /ephemeral/.test(r.error), JSON.stringify(r));
	const w = validateProofPaths(report({ evidence: [{ claim: "c", file: ephemeralFile }] }), opts("warn"));
	check("ephemeral (all under temp dir) → ok + warning in warn mode", w.ok && Array.isArray(w.warnings) && w.warnings.some((x) => /ephemeral/.test(x)), JSON.stringify(w));
	const mixed = validateProofPaths(report({ artifacts: [durableFile], evidence: [{ claim: "c", file: ephemeralFile }] }), opts("fail"));
	check("one durable path among ephemeral ones → ok (not ALL ephemeral)", mixed.ok, JSON.stringify(mixed));
	const ex = validateProofPaths(report({ evidence: [{ claim: "c", file: exchangeFile }] }), opts("fail"));
	check("path under the exchange root is ephemeral too → reject in fail mode", !ex.ok && /ephemeral/.test(ex.error), JSON.stringify(ex));
}

// ---------------------------------------------------------------------------
// detector helpers (direct)
// ---------------------------------------------------------------------------

{
	check("stripLineSuffix :line", stripLineSuffix("a.ts:42") === "a.ts");
	check("stripLineSuffix :start-end", stripLineSuffix("a.ts:1-10") === "a.ts");
	check("stripLineSuffix no suffix", stripLineSuffix("a.ts") === "a.ts");
	check("stripLineSuffix leaves a windows drive prefix intact", stripLineSuffix("C:\\x\\a.ts:12") === "C:\\x\\a.ts");

	check("detectPseudoPath: real refs are not pseudo", detectPseudoPath("f.ts:1") === null && detectPseudoPath("src/a.ts") === null && detectPseudoPath("./Makefile") === null && detectPseudoPath("docs/README") === null);
	check("detectPseudoPath: bare Makefile is pseudo", detectPseudoPath("Makefile") !== null);
}

// ---------------------------------------------------------------------------
// Config resolution: collect.ephemeralProof — "fail" default | "warn"
// ---------------------------------------------------------------------------

{
	check("COLLECT_DEFAULT_EPHEMERAL_PROOF === fail", COLLECT_DEFAULT_EPHEMERAL_PROOF === "fail");
	check("resolveCollectConfig() is total in-process", typeof resolveCollectConfig().ephemeralProof === "string");

	const home = mkdtempSync(join(tmpdir(), "proof-cfg-"));
	const mk = (configJson: string): string => {
		const configDir = join(home, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
		const src = `import {resolveCollectConfig} from ${JSON.stringify(new URL("../src/watch-config.ts", import.meta.url).pathname)}; console.log(resolveCollectConfig().ephemeralProof)`;
		const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
		return res.stdout.toString().trim();
	};
	check("config: no collect section → default fail", mk("{}") === "fail");
	check("config: explicit warn honored", mk(JSON.stringify({ collect: { ephemeralProof: "warn" } })) === "warn");
	check("config: explicit fail honored", mk(JSON.stringify({ collect: { ephemeralProof: "fail" } })) === "fail");
	check("config: garbage → default fail", mk(JSON.stringify({ collect: { ephemeralProof: "no" } })) === "fail");
	check("config: corrupt JSON → default fail, never throws", mk("{ not json ]") === "fail");
	rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Collect-drive (fake backend): a pass report with a missing proof path →
// E_PROOF_MISSING, distinct from E_REPORT_INVALID. A fail report with
// missing paths → collect OK (not blocked).
// ---------------------------------------------------------------------------

{
	// Sandbox the exchange root so the drive never touches the live root.
	const sandbox = mkdtempSync(join(tmpdir(), "proof-drive-"));
	process.env.PI_DELEGATE_EXCHANGE_ROOT = sandbox;
	const NAME = `proof-${process.pid}`;
	const repoDir = mkdtempSync(join(tmpdir(), "proof-repo-"));

	const drive = async (reportJson: string): Promise<{ ok: boolean; code: string; text: string }> => {
		const taskDir = join(sandbox, `task-${Math.random().toString(36).slice(2)}`);
		mkdirSync(taskDir, { recursive: true });
		const briefPath = join(taskDir, `brief-${NAME}.md`);
		writeFileSync(briefPath, `# brief ${NAME}\n\nOUTPUT: report-${NAME}.json\n`);
		writeFileSync(join(taskDir, `report-${NAME}.json`), reportJson);
		const fake = new FakeWorkerHost({ repoPath: repoDir, statusScript: ["working", "done"] });
		let captured!: { execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
		registerDelegateTool({ registerTool: (t: never) => (captured = t as never) } as never, fake as unknown as Transport);
		const result = await captured.execute(
			"t1",
			{ name: NAME, briefPath, provider: "p", model: "m", thinking: "low", waitMs: 1000, repoPath: repoDir, mode: "tab", releaseOn: "settle" },
			undefined,
			() => {},
			{ cwd: repoDir, hasUI: false },
		);
		return {
			ok: result.details.ok === true,
			code: typeof result.details.code === "string" ? result.details.code : "",
			text: result.content.map((c) => c.text).join("\n"),
		};
	};

	const missing = await drive(
		JSON.stringify({
			worker: NAME,
			status: "pass",
			summary: "one-paragraph outcome",
			artifacts: [],
			evidence: [{ claim: "c", file: "missing-proof.ts:1" }],
		}),
	);
	check(
		"collect-drive: pass report with a missing proof path → E_PROOF_MISSING",
		!missing.ok && missing.code === "E_PROOF_MISSING",
		`ok=${missing.ok} code=${missing.code} ${missing.text.slice(0, 200)}`,
	);

	const honestFail = await drive(
		JSON.stringify({
			worker: NAME,
			status: "fail",
			summary: "honest failure",
			artifacts: [],
			evidence: [],
		}),
	);
	check(
		"collect-drive: fail report with missing paths → collect OK (not blocked)",
		honestFail.ok && honestFail.code === "",
		`ok=${honestFail.ok} code=${honestFail.code} ${honestFail.text.slice(0, 200)}`,
	);

	rmSync(sandbox, { recursive: true, force: true });
	rmSync(repoDir, { recursive: true, force: true });
}

rmSync(work, { recursive: true, force: true });

if (failures > 0) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("all proof-paths checks passed");
