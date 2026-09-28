/**
 * swarm-token-store-check — the shared per-machine operator token
 * (ARCHITECTURE §4.2.4 as amended on the startup-noise round): the swarm
 * server's mutation token is ONE token per machine, stored at
 * `<agentDir>/delegate-swarm-token` (mode 0600), read-or-created by every
 * mount — so the tokenized dashboard link announced in ANY session's UI
 * actually authenticates against the session that serves the fleet (the
 * D1 primary). Rotation = delete the file. A store that cannot be written
 * degrades ADVISORY (Law 8) to a per-process random token with a warning.
 *
 * Run with: bun test/swarm-token-store-check.ts   (from repo root)
 *
 * Covers:
 *   T1  absent file → creates `<agentDir>/delegate-swarm-token` (0600) with
 *       a 64-hex token; result is persisted:true.
 *   T2  existing well-formed file → returned verbatim, file untouched.
 *   T3  malformed file content → replaced with a fresh 64-hex token.
 *   T4  two sequential calls share ONE token (the machine token).
 *   T5  missing agentDir → created (recursive), token persisted.
 *   T6  unwritable store path → per-process random token, persisted:false,
 *       a machine-readable warning, NEVER a throw (Law 8 advisory).
 *   T7  the token is always 64 lowercase hex, whatever the path.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog. Exit 0 only
 * if all checks pass.
 */

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("swarm-token-store-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 15_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const HEX64 = /^[0-9a-f]{64}$/;
const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-token-store-"));

async function main(): Promise<void> {
	const { sharedOperatorToken } = await import("../src/swarm-server/token-store.ts");
	let seq = 0;
	const fixedRandom = (): string => String(seq++).padStart(64, "0"); // distinct, valid 64-hex

	// --- T1: absent file → created 0600, 64-hex, persisted -----------------
	let agentDir = join(SANDBOX, "agent-1");
	{
		const r = sharedOperatorToken({ agentDir, randomHex: fixedRandom });
		const path = join(agentDir, "delegate-swarm-token");
		check("T1.1 absent store → token returned with persisted:true", r.persisted === true && r.warning === undefined, JSON.stringify(r).slice(0, 120));
		check("T1.2 the store file now exists", existsSync(path));
		check("T1.3 the stored token is the returned token (64-hex)", HEX64.test(readFileSync(path, "utf8").trim()) && readFileSync(path, "utf8").trim() === r.token, `token=${r.token.slice(0, 12)}…`);
		check("T1.4 the store file is mode 0600", (statSync(path).mode & 0o777) === 0o600, `mode=${(statSync(path).mode & 0o777).toString(8)}`);
	}

	// --- T2: existing well-formed file → returned verbatim -----------------
	agentDir = join(SANDBOX, "agent-2");
	const preExisting = "aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55";
	{
		const dir = join(agentDir, "nested");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "delegate-swarm-token"), `${preExisting}\n`, { mode: 0o600 });
		const r = sharedOperatorToken({ agentDir: dir, randomHex: fixedRandom });
		check("T2.1 existing well-formed store → returned verbatim, persisted:true", r.token === preExisting && r.persisted === true, JSON.stringify(r).slice(0, 120));
		check("T2.2 the file was NOT rewritten", readFileSync(join(dir, "delegate-swarm-token"), "utf8").trim() === preExisting);
	}

	// --- T3: malformed file → replaced -------------------------------------
	{
		const dir = join(SANDBOX, "agent-3");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "delegate-swarm-token"), "not-a-token\n", { mode: 0o600 });
		const r = sharedOperatorToken({ agentDir: dir, randomHex: fixedRandom });
		check("T3.1 malformed store → fresh 64-hex token, persisted:true", HEX64.test(r.token) && r.token !== "not-a-token" && r.persisted === true, JSON.stringify(r).slice(0, 120));
		check("T3.2 the malformed content was replaced on disk", readFileSync(join(dir, "delegate-swarm-token"), "utf8").trim() === r.token);
	}

	// --- T4: two calls share ONE token --------------------------------------
	{
		const dir = join(SANDBOX, "agent-4");
		const a = sharedOperatorToken({ agentDir: dir, randomHex: fixedRandom });
		const b = sharedOperatorToken({ agentDir: dir, randomHex: fixedRandom });
		check("T4.1 two sequential mounts share the machine token", a.token === b.token && a.persisted && b.persisted);
	}

	// --- T5: missing agentDir → created -------------------------------------
	{
		const dir = join(SANDBOX, "deep", "new", "agent-5");
		const r = sharedOperatorToken({ agentDir: dir, randomHex: fixedRandom });
		check("T5.1 missing agentDir → created recursively and the token persisted", r.persisted === true && HEX64.test(readFileSync(join(dir, "delegate-swarm-token"), "utf8").trim()));
	}

	// --- T6: unwritable store → advisory fallback, never a throw ------------
	{
		// A FILE where the agent dir should be: mkdir/write must fail.
		const blocker = join(SANDBOX, "agent-6-is-a-file");
		writeFileSync(blocker, "not a dir", { mode: 0o600 });
		const r = sharedOperatorToken({ agentDir: join(blocker, "sub"), randomHex: fixedRandom });
		check("T6.1 unwritable store → per-process fallback token, no throw", typeof r.token === "string" && HEX64.test(r.token) && r.persisted === false, JSON.stringify(r).slice(0, 120));
		check("T6.2 the degradation is a machine-readable warning", typeof r.warning === "string" && r.warning.length > 0, JSON.stringify(r.warning));
	}

	// --- T7: default randomness is 64 lowercase hex --------------------------
	{
		const dir = join(SANDBOX, "agent-7");
		const r = sharedOperatorToken({ agentDir: dir });
		check("T7.1 default-generated token is 64 lowercase hex", HEX64.test(r.token), `token=${r.token.slice(0, 12)}…`);
	}

	watchdog.unref();
	if (failures > 0) {
		console.error(`swarm-token-store-check: ${failures} FAILURE(S)`);
		process.exit(1);
	}
	console.log("swarm-token-store-check: ALL PASS");
}

main().catch((err) => {
	console.error("swarm-token-store-check CRASHED:", err);
	process.exit(1);
});
