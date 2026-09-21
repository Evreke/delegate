/**
 * profile-check — deterministic checks for the named-config-profile layer
 * (src/profile.ts) and its integration into the config readers.
 *
 * Run with: bun test/profile-check.ts   (from repo root)
 *
 * bun caches os.homedir() per process and getAgentDir() resolves the agent
 * dir at import time, so EVERY scenario that needs a different agent dir or
 * profile selection runs in a child bun process with PI_CODING_AGENT_DIR and
 * PI_DELEGATE_PROFILE set at spawn time (the same seam as usage-check.ts's
 * $HOME pattern).
 *
 * Scenarios (operator decisions, 2026-09-15):
 *   P1  no profile selected → the merged view IS the base config
 *   P2  PI_DELEGATE_PROFILE selects a profile; its sections REPLACE the base
 *       sections wholesale; absent sections fall through to base
 *   P3  env var beats the base config's "profile" key
 *   P4  the base config's "profile" key selects when the env is unset
 *   P5  missing profile file → structured E_START (loud, never silent fallback)
 *   P6  corrupt profile file → structured E_START
 *   P7  profile name failing PROFILE_NAME_RE (path traversal) → structured E_START
 *   P8  the profile's own "profile" key is ignored (no nesting)
 *   P9  resolvers see merged values: resolveSpawnDefaults/resolveTierTable/
 *       resolveContextWindow through a profile
 *   P10 the advisory watch surface degrades to defaults on a broken profile
 *   P11 empty PI_DELEGATE_PROFILE counts as unset
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const AGENT_DIR = mkdtempSync(join(tmpdir(), "profile-check-"));
mkdirSync(join(AGENT_DIR, "pi-delegate.d"), { recursive: true });
const BASE = join(AGENT_DIR, "pi-delegate.config.json");
const PROFILES = join(AGENT_DIR, "pi-delegate.d");

// Fixture A base: NO profile key → selection only via env (P1/P2/P5-P7/P9/P10).
const BASE_CFG = {
	host: "herdr",
	contextWindow: 111_000,
	defaults: { tier: "base-tier", budgetTokens: 1000 },
	tiers: { "base-tier": { provider: "prov-base", model: "mod-base", thinking: "low" } },
};

// Profiles on disk
writeFileSync(join(PROFILES, "rpc-local.json"), JSON.stringify({
	host: "rpc",
	tiers: { "local-tier": { provider: "prov-local", model: "mod-local", thinking: "high" } },
	defaults: { tier: "local-tier", budgetTokens: 42 },
	profile: "nested-ignored",
}));
writeFileSync(join(PROFILES, "ctx-only.json"), JSON.stringify({ contextWindow: 999_000 }));
writeFileSync(join(PROFILES, "broken.json"), "{not json");
writeFileSync(join(PROFILES, "from-key.json"), JSON.stringify({ contextWindow: 222_000 }));
// base config AFTER the profile files exist
writeFileSync(BASE, JSON.stringify(BASE_CFG));

const USAGE = new URL("../src/usage.ts", import.meta.url).pathname;
const PROFILE = new URL("../src/profile.ts", import.meta.url).pathname;
const WATCHCFG = new URL("../src/watch-config.ts", import.meta.url).pathname;

/** Run one expression in a child bun process with the given env overrides. */
function runInChild(expr: string, env: Record<string, string>): { stdout: string; stderr: string; code: number } {
	const res = spawnSync("bun", ["-e", expr], {
		env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR, ...env },
		encoding: "utf8",
		timeout: 20_000,
	});
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString(), code: res.status ?? -1 };
}

function loadMerged(env: Record<string, string>): { ok: true; cfg: Record<string, unknown> } | { ok: false; err: string } {
	const r = runInChild(
		`import {loadDelegateConfig} from ${JSON.stringify(PROFILE)};
		 try { console.log(JSON.stringify({ok:true,cfg:loadDelegateConfig()})); }
		 catch (e) { console.log(JSON.stringify({ok:false,err:String(e && e.code ? e.code+": "+e.message : e)})); }`,
		env,
	);
	try {
		return JSON.parse(r.stdout.trim());
	} catch {
		return { ok: false, err: `child crashed: ${r.stderr.slice(0, 200)}` };
	}
}

// --- P1: no profile → base as-is ---------------------------------------------
{
	const r = loadMerged({ PI_DELEGATE_PROFILE: "" });
	check(
		"P1 no profile selected → base config unchanged (no profile key in view)",
		r.ok && r.cfg.host === "herdr" && !("profile" in r.cfg),
		JSON.stringify(r).slice(0, 200),
	);
}

// --- P2: env-selected profile, wholesale section replacement ------------------
{
	const r = loadMerged({ PI_DELEGATE_PROFILE: "rpc-local" });
	const ok =
		r.ok &&
		r.cfg.host === "rpc" && // profile section replaces base
		r.cfg.contextWindow === 111_000 && // absent in profile → falls through to base
		JSON.stringify(r.cfg.tiers) === JSON.stringify({ "local-tier": { provider: "prov-local", model: "mod-local", thinking: "high" } }) &&
		(r.cfg.defaults as { tier?: string }).tier === "local-tier";
	check("P2 profile sections replace base wholesale; absent sections fall through", ok, JSON.stringify(r).slice(0, 300));
}

// --- P3: env beats the config key ----------------------------------------------
{
	const r = loadMerged({ PI_DELEGATE_PROFILE: "rpc-local" }); // base key says "from-key"
	check("P3 PI_DELEGATE_PROFILE beats the base \"profile\" key", r.ok && r.cfg.host === "rpc", JSON.stringify(r).slice(0, 200));
}

// --- P4: the base config's "profile" key selects (env unset) -------------------
{
	writeFileSync(BASE, JSON.stringify({ ...BASE_CFG, profile: "no-such-key-profile" }));
	const r = loadMerged({ PI_DELEGATE_PROFILE: "" });
	check("P4 base profile key selects → missing file → E_START", !r.ok && r.err.includes("E_START") && r.err.includes("no-such-key-profile.json"), JSON.stringify(r).slice(0, 250));
	writeFileSync(BASE, JSON.stringify(BASE_CFG)); // restore fixture A
}

// --- P5/P6: missing / corrupt profile → structured E_START ----------------------
{
	const r5 = loadMerged({ PI_DELEGATE_PROFILE: "no-such-profile" });
	check("P5 missing profile file → E_START naming the file", !r5.ok && r5.err.includes("E_START") && r5.err.includes("no-such-profile.json"), JSON.stringify(r5).slice(0, 250));
	const r6 = loadMerged({ PI_DELEGATE_PROFILE: "broken" });
	check("P6 corrupt profile file → E_START", !r6.ok && r6.err.includes("E_START"), JSON.stringify(r6).slice(0, 250));
}

// --- P7: path-traversal name rejected --------------------------------------------
{
	const r = loadMerged({ PI_DELEGATE_PROFILE: "../escape" });
	check("P7 invalid profile name (traversal) → E_START", !r.ok && r.err.includes("E_START"), JSON.stringify(r).slice(0, 200));
}

// --- P8: the base "profile" key is consumed, never leaked into the merge ------
// (fixture B: base carries profile:"from-key"; the env selects rpc-local; the
// merged view must contain NEITHER the base's nor the profile's profile key)
{
	writeFileSync(BASE, JSON.stringify({ ...BASE_CFG, profile: "from-key" }));
	const r = loadMerged({ PI_DELEGATE_PROFILE: "rpc-local" });
	check(
		"P8 profile key consumed, never leaked; env beats key",
		r.ok && !("profile" in r.cfg) && r.cfg.host === "rpc",
		JSON.stringify(r).slice(0, 200),
	);
	writeFileSync(BASE, JSON.stringify(BASE_CFG)); // restore fixture A
}

// --- P9: resolvers see merged values -------------------------------------------------
{
	const src = `import {resolveSpawnDefaults, resolveTierTable, resolveContextWindow} from ${JSON.stringify(USAGE)};
		console.log(JSON.stringify({
			d: resolveSpawnDefaults(),
			t: Object.keys(resolveTierTable()),
			w: resolveContextWindow(undefined),
		}));`;
	const r = runInChild(src, { PI_DELEGATE_PROFILE: "rpc-local" });
	const v = JSON.parse(r.stdout.trim()) as { d: { tier?: string }; t: string[]; w: number };
	check(
		"P9 resolvers read the merged view (defaults/tiers/contextWindow)",
		v.d.tier === "local-tier" && v.t.join(",") === "local-tier" && v.w === 111_000,
		r.stdout.trim(),
	);
}

// --- P10: advisory watch surface degrades on a broken profile -------------------------
{
	const src = `import {resolveWatchConfig} from ${JSON.stringify(WATCHCFG)};
		console.log(JSON.stringify(resolveWatchConfig()));`;
	const r = runInChild(src, { PI_DELEGATE_PROFILE: "broken" });
	let v: Record<string, unknown> = {};
	try {
		v = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
	} catch {
		/* leave empty → check fails */
	}
	check(
		"P10 broken profile → watch config degrades to defaults (advisory, never throws)",
		r.code === 0 && typeof v.intervalMs === "number",
		`stdout=${r.stdout.trim().slice(0, 120)} stderr=${r.stderr.slice(0, 120)}`,
	);
}

// --- P11: empty env value counts as unset → the base key selects ---------------
{
	writeFileSync(BASE, JSON.stringify({ ...BASE_CFG, profile: "from-key" }));
	const r = loadMerged({ PI_DELEGATE_PROFILE: "   " });
	check(
		"P11 whitespace PI_DELEGATE_PROFILE counts as unset → base profile key selects",
		r.ok && r.cfg.host === "herdr" && r.cfg.contextWindow === 222_000,
		JSON.stringify(r).slice(0, 200),
	);
	writeFileSync(BASE, JSON.stringify(BASE_CFG)); // restore fixture A
}

// --- P12: swarm.verbsFallback resolver (issue #25) -------------------------
{
	const runSwarm = (cfg: Record<string, unknown>) => {
		writeFileSync(BASE, JSON.stringify(cfg));
		const src = `import {resolveSwarmConfig} from ${JSON.stringify(WATCHCFG)};
			console.log(JSON.stringify(resolveSwarmConfig()));`;
		return runInChild(src, {});
	};
	const dflt = runSwarm(BASE_CFG);
	check(
		"P12.1 swarm config absent → verbsFallback defaults ON (issue #25 release)",
		dflt.code === 0 && JSON.parse(dflt.stdout.trim()).verbsFallback === true,
		dflt.stdout + dflt.stderr,
	);
	const off = runSwarm({ ...BASE_CFG, swarm: { verbsFallback: false } });
	check(
		"P12.2 swarm.verbsFallback:false is honored (operator can drop the raw-file fallback)",
		off.code === 0 && JSON.parse(off.stdout.trim()).verbsFallback === false,
		off.stdout + off.stderr,
	);
	const bad = runSwarm({ ...BASE_CFG, swarm: { verbsFallback: "yes" } });
	check(
		"P12.3 garbage swarm.verbsFallback → default ON, never throws",
		bad.code === 0 && JSON.parse(bad.stdout.trim()).verbsFallback === true,
		bad.stdout + bad.stderr,
	);
	writeFileSync(BASE, JSON.stringify(BASE_CFG)); // restore fixture
}

rmSync(AGENT_DIR, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\nprofile-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nprofile-check: all green");
process.exit(0);
