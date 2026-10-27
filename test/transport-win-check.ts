/**
 * T-WIN — Windows launch policy + tree-kill escalation in runHerdr (TZ §3.6).
 *
 * Run with: bun test/transport-win-check.ts   (from repo root; NO live herdr,
 * NO Windows machine needed — the win32 spawn/kill policy is driven via the
 * injected `platform: "win32"` parameter against stub CLIs on a prepended
 * PATH, including a stub `cmd.exe` that de-quotes per the Windows convention).
 *
 * Problem (1.16.x): on Windows the herdr CLI is typically an npm shim
 * (`herdr.cmd`); modern Node refuses to spawn .cmd/.bat shell-less
 * (CVE-2024-27980 → EINVAL) and a bare spawn does not resolve it (ENOENT) —
 * every herdr CLI call failed before herdr was reached. The kill escalation
 * child.kill("SIGKILL") killed only the direct child, leaving herdr's agent
 * processes as orphans.
 *
 * Checks:
 *   W.1 POSIX default policy (no platform arg): the spawned command is
 *       `herdr` with the RAW argv (regression pin — byte-identical launch);
 *       cmd.exe is never involved.
 *   W.2 Win32 launch, batch shim (injected platform "win32"): the stub cmd.exe
 *       receives `/d /s /c herdr …`; per-arg quoting round-trips — an arg with
 *       spaces arrives as ONE argv element, an arg with embedded quotes
 *       survives; the resolved policy demands verbatim args (no second quoting
 *       pass by node — the 2026-10-27 incident).
 *   W.3 Win32 escalation (hang stub + injected win32): at the timeout the
 *       promise rejects with the SAME shape as POSIX (killed:true, signal
 *       SIGTERM); after SIGKILL_GRACE_MS the stub `taskkill` receives
 *       `/pid <stubPid> /T /F` and actually kills the stub tree process.
 *   W.4 winQuoteArg unit cases: space, embedded quotes, plain, empty.
 *   W.5 Win32 launch, native executable: cmd.exe is NEVER involved and an argv
 *       element carrying cmd metacharacters (`<`, `>`, `|`, `&`, `"`, `%`)
 *       reaches the child BYTE-FOR-BYTE. This is the regression check for the
 *       2026-10-27 incident: the old policy routed this element through
 *       cmd.exe, whose re-parse turned `<…>` into input redirection, so cmd
 *       died with ERROR_FILE_NOT_FOUND before herdr ran and every delegate
 *       prompt was lost (a 32-byte prompt containing `<x>` was enough to
 *       reproduce; length was irrelevant).
 *   W.6 resolveLaunch unit cases: native vs batch classification by PATH +
 *       PATHEXT, explicit path-shaped commands, unresolvable commands (shim),
 *       and the POSIX branch (no shim, no verbatim flag).
 *
 * Blind spot this file used to have (why the incident shipped green): the stub
 * cmd.exe is an argv-array consumer — the OS splits the command line for it —
 * but REAL cmd.exe re-parses ONE command-line string with its own quoting and
 * redirection rules. W.5 therefore asserts at the policy level (which command
 * is spawned) instead of trying to emulate cmd's parser.
 *
 * Cleanup: every stub it spawns is verified dead or killed in the end; the
 * stub dir is removed.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runHerdr,
	parseHerdrResult,
	winQuoteArg,
	resolveLaunch,
	SIGKILL_GRACE_MS,
} from "../src/herdr/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ART = mkdtempSync(`${tmpdir()}/pi-delegate-win-`);
const STUB_DIR = join(ART, "bin");
mkdirSync(STUB_DIR, { recursive: true });
const ARGVFILE = join(ART, "herdr-argv.json");
const CMDLOG = join(ART, "cmd-argv.log");
const TKLOG = join(ART, "taskkill-argv.log");
const PIDFILE = join(ART, "stub.pid");

// The `herdr` shim on the test PATH: dispatches on $WIN_STUB_SCRIPT.
writeFileSync(join(STUB_DIR, "herdr"), `#!/usr/bin/env node\nrequire(process.env.WIN_STUB_SCRIPT);\n`, { mode: 0o755 });
// Launch-policy markers: the win32 shim decision is a PATH+PATHEXT lookup, so
// the classification is driven by which of these exists (W.2/W.3 shim,
// W.5 native). Both are the same dispatcher under the extension the policy
// classifies — on POSIX a shebang script named `herdr.exe` spawns fine.
const SHIM_STUB = join(STUB_DIR, "herdr.cmd");
const NATIVE_STUB = join(STUB_DIR, "herdr.exe");
const setLaunchKind = (kind: "shim" | "native" | "unresolvable") => {
	rmSync(SHIM_STUB, { force: true });
	rmSync(NATIVE_STUB, { force: true });
	if (kind === "shim") writeFileSync(SHIM_STUB, "@echo off\n", { mode: 0o755 });
	if (kind === "native") writeFileSync(NATIVE_STUB, `#!/usr/bin/env node\nrequire(process.env.WIN_STUB_SCRIPT);\n`, { mode: 0o755 });
};
/** process.env plus the launch-policy keys — the shim decision reads PATH and
 *  PATHEXT from the SAME env the child receives, so the stub's own WIN_*
 *  variables must stay in it. */
const envWithPathext = (pathext: string): NodeJS.ProcessEnv => ({
	...process.env,
	PATH: `${STUB_DIR}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
	PATHEXT: pathext,
});
/** Pure classification cases must not see the ambient PATH: a real herdr.exe
 *  elsewhere on it (the herdr install dir is often on PATH) would decide the
 *  policy and make the case host-dependent. */
const isolatedEnv = (pathext: string): NodeJS.ProcessEnv => ({
	...process.env,
	PATH: STUB_DIR,
	PATHEXT: pathext,
});
// Recorder: writes its argv (beyond node+script), prints a valid herdr JSON line, exits 0.
writeFileSync(
	join(STUB_DIR, "record.js"),
	[
		`const fs = require("node:fs");`,
		`fs.writeFileSync(process.env.WIN_ARGVFILE, JSON.stringify(process.argv.slice(2)));`,
		`process.stdout.write(JSON.stringify({ id: "s", result: { agent: { name: "ok", agent_status: "idle" } } }) + "\\n");`,
	].join("\n"),
);
// Stub cmd.exe: dual-mode.
//   exec mode (default): logs its raw argv, expects the `/d /s /c` shape,
//     de-quotes each following arg per the Windows convention (strip outer
//     quotes, "" → ") and executes the command with the parsed argv (what
//     real cmd.exe does).
//   hang mode (WIN_CMD_HANG=1, for W.3): when the launched command is
//     `herdr`, the stub BECOMES the hang fixture instead of exec'ing — it
//     writes its own pid (the pid production later passes to `taskkill /pid`),
//     traps SIGTERM (simulating a direct child that survives the first kill
//     — the exact case the escalation exists for), hangs forever. The
//     escalation's own cmd.exe call (command `taskkill`) always takes the
//     exec branch, so the tree-kill actually runs.
writeFileSync(
	join(STUB_DIR, "cmd.exe"),
	[
		`#!/usr/bin/env node`,
		`const fs = require("node:fs");`,
		`const argv = process.argv.slice(2);`,
		`if (process.env.WIN_CMD_HANG === "1" && argv[3] === "herdr") {`,
		`  fs.writeFileSync(process.env.WIN_PIDFILE, String(process.pid));`,
		`  process.on("SIGTERM", () => { fs.appendFileSync(process.env.WIN_PIDFILE, "\\nTRAPPED"); });`,
		`  setInterval(() => {}, 1 << 30);`,
		`} else {`,
		`  fs.appendFileSync(process.env.WIN_CMDLOG, JSON.stringify(argv) + "\\n");`,
		`  if (argv[0] !== "/d" || argv[1] !== "/s" || argv[2] !== "/c") process.exit(87);`,
		`  const { spawnSync } = require("node:child_process");`,
		`  const deq = (s) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) ? s.slice(1, -1).replace(/""/g, '"') : s;`,
		`  const cmd = deq(argv[3]);`,
		`  const rest = argv.slice(4).map(deq);`,
		`  const r = spawnSync(cmd, rest, { stdio: "inherit" });`,
		`  process.exit(r.status ?? 1);`,
		`}`,
	].join("\n"),
	{ mode: 0o755 },
);
// Stub taskkill: logs its argv and force-kills the /pid target (tree kill
// simulated by killing the recorded process directly).
writeFileSync(
	join(STUB_DIR, "taskkill"),
	[
		`#!/usr/bin/env node`,
		`const fs = require("node:fs");`,
		`const argv = process.argv.slice(2);`,
		`fs.appendFileSync(process.env.WIN_TKLOG, JSON.stringify(argv) + "\\n");`,
		`const i = argv.indexOf("/pid");`,
		`if (i !== -1 && argv[i + 1]) { try { process.kill(Number(argv[i + 1]), "SIGKILL"); } catch {} }`,
		`process.exit(0);`,
	].join("\n"),
	{ mode: 0o755 },
);
// PATH override BEFORE any spawn: runHerdr resolves `herdr`/`cmd.exe` at spawn time.
process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
process.env.WIN_STUB_SCRIPT = "";
process.env.WIN_ARGVFILE = ARGVFILE;
process.env.WIN_CMDLOG = CMDLOG;
process.env.WIN_TKLOG = TKLOG;
process.env.WIN_PIDFILE = PIDFILE;

const resetArtifacts = () => {
	for (const f of [ARGVFILE, CMDLOG, TKLOG, PIDFILE]) {
		try {
			rmSync(f, { force: true });
		} catch { /* absent is fine */ }
	}
};
const readJson = (path: string): unknown | null => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
};
const cmdLines = (): string[][] =>
	existsSync(CMDLOG)
		? readFileSync(CMDLOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as string[])
		: [];
const tkLines = (): string[][] =>
	existsSync(TKLOG)
		? readFileSync(TKLOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as string[])
		: [];
const stubPid = (): number | null => {
	try {
		const raw = readFileSync(PIDFILE, "utf8").split("\n")[0];
		return raw ? Number(raw) : null;
	} catch {
		return null;
	}
};
const stubAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const setStub = (name: string) => {
	process.env.WIN_STUB_SCRIPT = join(STUB_DIR, name);
	resetArtifacts();
};

async function run() {
	const T = 2_000;

	// W.1 — POSIX default policy: raw argv, no cmd.exe (regression pin)
	{
		setStub("record.js");
		const { stdout } = await runHerdr(["agent", "list", "--label", "hello world"], T);
		const { result } = parseHerdrResult(stdout);
		const argv = readJson(ARGVFILE);
		check(
			"W.1 default policy spawns `herdr` with the RAW argv (spaces stay one element)",
			JSON.stringify(argv) === JSON.stringify(["agent", "list", "--label", "hello world"]),
			`argv=${JSON.stringify(argv)}`,
		);
		check(
			"W.1 default policy result parses (unchanged herdr shape)",
			(result as { agent?: { agent_status?: string } })?.agent?.agent_status === "idle",
		);
		check("W.1 default policy never touches cmd.exe", cmdLines().length === 0, `cmd=${JSON.stringify(cmdLines())}`);
	}

	// W.2 — win32 launch, batch shim: cmd.exe /d /s /c herdr … with per-arg quoting
	{
		setStub("record.js");
		setLaunchKind("shim");
		const wArgs = ["agent", "list", "--label", "hello world", "--note", 'say "hi"'];
		const { stdout } = await runHerdr(wArgs, T, "win32", envWithPathext(".CMD"));
		const { result } = parseHerdrResult(stdout);
		const lines = cmdLines();
		check("W.2 win32 policy routes through exactly one cmd.exe call", lines.length === 1, `lines=${JSON.stringify(lines)}`);
		const shape = lines[0] ?? [];
		check(
			"W.2 cmd.exe receives /d /s /c then the command",
			shape[0] === "/d" && shape[1] === "/s" && shape[2] === "/c" && shape[3] === "herdr",
			`shape=${JSON.stringify(shape)}`,
		);
		check(
			"W.2 arg with spaces is quoted per-arg (one argv element with quotes)",
			shape.includes('"hello world"') && !shape.some((a) => a === "hello world"),
			`shape=${JSON.stringify(shape)}`,
		);
		const argv = readJson(ARGVFILE);
		check(
			"W.2 arg with spaces arrives as ONE argv element after de-quoting",
			JSON.stringify(argv) === JSON.stringify(["agent", "list", "--label", "hello world", "--note", 'say "hi"']),
			`argv=${JSON.stringify(argv)}`,
		);
		check(
			"W.2 embedded quotes round-trip through the quoting helper",
			(argv as string[] | null)?.includes('say "hi"') === true,
		);
		check(
			"W.2 win32 launch result parses (unchanged herdr shape)",
			(result as { agent?: { agent_status?: string } })?.agent?.agent_status === "idle",
		);
		const shimPolicy = resolveLaunch("herdr", wArgs, "win32", isolatedEnv(".CMD"));
		check(
			"W.2 batch-shim policy demands VERBATIM args (node must not re-quote the pre-quoted argv — 2026-10-27 incident)",
			shimPolicy.command === "cmd.exe" && shimPolicy.verbatimArgs === true,
			`policy=${JSON.stringify(shimPolicy)}`,
		);
	}

	// W.5 — win32 launch, native executable: cmd.exe is never involved and a
	// metacharacter-carrying argv element arrives BYTE-FOR-BYTE
	{
		setStub("record.js");
		setLaunchKind("native");
		const hostile = 'PING3 <verb> > out.txt | find "x" & echo %PATH% ^ caret';
		const wArgs = ["agent", "prompt", "probe", hostile, "--pct", "<0-100>"];
		const { stdout } = await runHerdr(wArgs, T, "win32", envWithPathext(".EXE"));
		const { result } = parseHerdrResult(stdout);
		check(
			"W.5 native policy spawns herdr DIRECTLY — cmd.exe is never involved",
			cmdLines().length === 0,
			`cmd=${JSON.stringify(cmdLines())}`,
		);
		const argv = readJson(ARGVFILE);
		check(
			"W.5 every argv element (incl. < > | & % ^ and \") reaches the child byte-for-byte",
			JSON.stringify(argv) === JSON.stringify(wArgs),
			`argv=${JSON.stringify(argv)}`,
		);
		check(
			"W.5 native launch result parses (unchanged herdr shape)",
			(result as { agent?: { agent_status?: string } })?.agent?.agent_status === "idle",
		);
	}

	// W.6 — resolveLaunch unit cases (pure: PATH + PATHEXT classification)
	{
		const args = ["agent", "prompt", "w", "Reply with <x> & |"];
		setLaunchKind("unresolvable");
		const unresolvable = resolveLaunch("herdr", args, "win32", isolatedEnv(".EXE"));
		check(
			"W.6 an unresolvable command keeps the shim (pre-fix failure surface)",
			unresolvable.command === "cmd.exe" && unresolvable.verbatimArgs === true,
			`policy=${JSON.stringify(unresolvable)}`,
		);
		setLaunchKind("shim");
		const batch = resolveLaunch("herdr", args, "win32", isolatedEnv(".CMD"));
		check(
			"W.6 a .cmd hit routes through cmd.exe with per-arg quoting, verbatim",
			batch.command === "cmd.exe" &&
				JSON.stringify(batch.args) === JSON.stringify(["/d", "/s", "/c", "herdr", "agent", "prompt", "w", '"Reply with <x> & |"']) &&
				batch.verbatimArgs === true,
			`policy=${JSON.stringify(batch)}`,
		);
		setLaunchKind("native");
		const native = resolveLaunch("herdr", args, "win32", isolatedEnv(".EXE"));
		check(
			"W.6 an .exe hit is spawned directly with the RAW argv and no verbatim flag",
			native.command === "herdr" &&
				JSON.stringify(native.args) === JSON.stringify(args) &&
				native.verbatimArgs === false,
			`policy=${JSON.stringify(native)}`,
		);
		check(
			"W.6 a path-shaped .cmd command is classified by its OWN extension (no PATH lookup)",
			resolveLaunch("C:\\tools\\herdr.cmd", args, "win32", isolatedEnv(".EXE")).command === "cmd.exe",
		);
		check(
			"W.6 a path-shaped .exe command is classified by its OWN extension (no PATH lookup)",
			resolveLaunch("C:\\tools\\herdr.exe", args, "win32", isolatedEnv(".CMD")).command === "C:\\tools\\herdr.exe",
		);
		const posix = resolveLaunch("herdr", args, "linux", isolatedEnv(".CMD"));
		check(
			"W.6 POSIX policy stays raw with no shim and no verbatim flag (regression pin)",
			posix.command === "herdr" &&
				JSON.stringify(posix.args) === JSON.stringify(args) &&
				posix.verbatimArgs === false,
			`policy=${JSON.stringify(posix)}`,
		);
	}

	// W.3 — win32 escalation: the direct child (cmd.exe stub, hang mode)
	// survives the timeout SIGTERM (traps it); the taskkill tree-kill must
	// still land with the direct child's pid, and the promise must reject with
	// the SAME shape as POSIX.
	{
		setStub("record.js");
		setLaunchKind("shim");
		process.env.WIN_CMD_HANG = "1";
		const t0 = Date.now();
		let rejectedAt = -1;
		let killedFlag: unknown;
		let signal: unknown;
		try {
			await runHerdr(["agent", "list"], T, "win32");
		} catch (err) {
			rejectedAt = Date.now() - t0;
			const cause = (err as { cause?: { killed?: boolean; signal?: string | null } }).cause;
			killedFlag = cause?.killed;
			signal = cause?.signal;
		}
		check(
			"W.3 hang stub rejects near the timeout (not after the escalation)",
			rejectedAt >= T && rejectedAt < T + 1_500,
			`rejectedAt=${rejectedAt}`,
		);
		check("W.3 rejection carries killed=true (same shape as POSIX)", killedFlag === true, `killed=${String(killedFlag)}`);
		check("W.3 rejection carries signal SIGTERM (same shape as POSIX)", signal === "SIGTERM", `signal=${String(signal)}`);
		// the escalation lands SIGKILL_GRACE_MS after the timeout — fire-and-
		// forget: give it the grace plus a small slop, then verify the shape.
		await new Promise((r) => setTimeout(r, SIGKILL_GRACE_MS + 1_000));
		process.env.WIN_CMD_HANG = "";
		const pid = stubPid();
		const trapped = pid !== null && readFileSync(PIDFILE, "utf8").includes("TRAPPED");
		check("W.3 cmd stub (direct child) actually trapped SIGTERM (fixture valid)", trapped, `pid=${pid}`);
		const tk = tkLines();
		check("W.3 escalation fires exactly one taskkill", tk.length === 1, `tk=${JSON.stringify(tk)}`);
		const tkArgs = tk[0] ?? [];
		check(
			"W.3 taskkill receives /pid <directChildPid> /T /F (tree + force)",
			JSON.stringify(tkArgs) === JSON.stringify(["/pid", String(pid), "/T", "/F"]),
			`tkArgs=${JSON.stringify(tkArgs)} pid=${pid}`,
		);
		check(
			"W.3 direct child is DEAD after the escalation window (tree kill landed)",
			pid === null || !stubAlive(pid),
			`pid=${pid} still alive`,
		);
	}

	// W.4 — winQuoteArg unit cases (space, quote, plain, empty)
	{
		check("W.4 plain arg passes through unchanged", winQuoteArg("agent") === "agent");
		check("W.4 arg with a space is wrapped in double quotes", winQuoteArg("hello world") === '"hello world"');
		check("W.4 arg with a tab is wrapped in double quotes", winQuoteArg("a\tb") === '"a\tb"');
		check("W.4 embedded quotes are doubled inside the wrapper", winQuoteArg('say "hi"') === '"say ""hi"""');
		check("W.4 empty arg stays empty (no space/tab/quote)", winQuoteArg("") === "");
	}

	// cleanup: no stub survivor may outlive the test
	const pid = stubPid();
	if (pid !== null && stubAlive(pid)) process.kill(pid, "SIGKILL");
	rmSync(ART, { recursive: true, force: true });

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error("driver error:", err);
	process.exit(1);
});
