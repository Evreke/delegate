/**
 * pi-delegate — src/herdr/cli.ts (the herdr CLI subprocess runner).
 *
 * MODULE_CONTRACT — one responsibility: launch one `herdr <args>` subprocess
 * with a hard time bound, preserve the historical exec error shape, and parse
 * herdr's stdout result line. Extracted verbatim from src/herdr/host.ts
 * (ARCHITECTURE.md Law 5 decomposition); the FUNCTION_CONTRACTs and
 * BUG_FIX_CONTEXTs below are its contract and travel with the code.
 *
 * Dependencies: node:child_process ONLY — no seam import, no other src/
 * module. This layer speaks EXEC-SHAPED errors (killed/signal/code/stdout/
 * stderr); mapping them into the E_* taxonomy is the caller's job
 * (HerdrTransport), which is what keeps the CLI runner reusable and the seam
 * bottom-of-graph (pinned by test/herdr-split-check.ts).
 *
 * Windows launch policy (TZ §3.6): on win32 the herdr CLI is typically an npm
 * shim (`herdr.cmd`), which modern Node refuses to spawn shell-less
 * (CVE-2024-27980 → EINVAL) and a bare spawn does not resolve at all (ENOENT).
 * The win32 launch therefore resolves ONE policy per call (resolveLaunch): a
 * native executable is spawned DIRECTLY, and only a batch shim goes through
 * `cmd.exe /d /s /c` with per-argument quoting (winQuoteArg) passed verbatim —
 * the argv stays an array end-to-end, never a pre-joined shell string. The
 * shim is the sole reason cmd.exe is involved at all, and its quoting must not
 * be re-quoted by node (BUG_FIX_CONTEXT on resolveLaunch). The platform is
 * injectable (optional trailing `platform` parameter, module-level default
 * DEFAULT_PLATFORM) so tests on a POSIX host drive the win32 branch without a
 * real Windows machine (ARCHITECTURE.md Law 1: the platform is the API). The
 * POSIX default path is byte-identical to the pre-1.17 spawn shape. Windows
 * kill escalation uses
 * `taskkill /pid <pid> /T /F` (tree kill — herdr's own child processes die
 * too) instead of child.kill("SIGKILL"), which on Windows kills only the
 * direct child and leaves agent orphans. These herdr CLI/OS details never leak
 * above the adapter (src/herdr/).
 *
 * Critical invariants carried over verbatim: the always-settling call (timeout
 * SIGTERM + stdio destruction + SIGKILL escalation after SIGKILL_GRACE_MS),
 * exec-parity failure shape (callers' message regexes unchanged), the
 * tolerant last-JSON-line stdout parse.
 *
 * DOCUMENTED DEVIATION (ARCHITECTURE.md Law 8): runHerdr is the single place
 * in this extension where a raw `throw new Error` is allowed — the parity
 * wrapper that keeps the historical exec error text for the callers' matchers.
 * It never crosses the seam: HerdrTransport wraps every CLI failure into a
 * structured E_* DelegateError.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

/** Per-CLI-call timeout for mutating/fast commands (ms). */
const CLI_TIMEOUT_MS = 30_000;

/** Grace between the timeout SIGTERM and the SIGKILL escalation (ms). A herdr
 *  build with a graceful-shutdown SIGTERM handler must not be able to turn the
 *  exec timeout into a permanently hung child + permanently hung promise. */
export const SIGKILL_GRACE_MS = 5_000;

/** Per-stream output cap mirroring node's execFile default maxBuffer. */
const EXEC_MAX_BUFFER = 1024 * 1024;

/** Module-level platform default for the spawn/kill policy (TZ §3.6): every
 *  spawn-policy-taking function defaults to this, so production behavior is
 *  the process's own platform and tests inject "win32" explicitly. Mirrors
 *  the optional-trailing-param pattern of src/expaths.ts builders. */
const DEFAULT_PLATFORM: NodeJS.Platform = process.platform;

/** Extensions Node refuses to spawn shell-less (CVE-2024-27980): the ONLY
 *  reason the win32 launch ever needs the cmd.exe shim. */
const BATCH_SHIM_EXTS = new Set([".bat", ".cmd"]);

/** PATHEXT fallback for hosts whose environment does not carry one (POSIX test
 *  hosts driving the injected win32 policy). */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Windows argument quoting for the cmd.exe launch policy.
 * <p>
 * Why it exists (and stays here, per-argument): the "never shell strings"
 * law forbids handing cmd.exe one pre-joined opaque command line built from
 * call-site data. Instead the argv stays an array end-to-end and quoting
 * happens HERE, per argument, in one unit-tested helper — an argument with
 * spaces/quotes survives the cmd.exe layer as ONE argv element on the other
 * side. Windows convention implemented: wrap in double quotes when the arg
 * contains a space, tab or quote; double the quotes inside
 * (`say "hi"` → `"say ""hi"""`). Private to the adapter — the quoting rule
 * is a herdr/OS-launch detail that must never leak above the seam; exported
 * solely so the transport tests can pin its convention.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: arg — one raw argv element (never contains a newline here; herdr
 *   CLI args do not)
 * Output: the cmd.exe-safe spelling of that element
 * Guarantees:
 *   - plain args (no space/tab/quote) pass through UNCHANGED (byte-identical,
 *     so `taskkill /pid 123 /T /F` shapes stay clean)
 *   - quoting is idempotent-safe for the round-trip test: quote-wrap + ""-doubling
 *     is reversible by the documented cmd de-quoting (strip outer quotes, "" → ")
 * Raises: never
 */
export function winQuoteArg(arg: string): string {
	if (!/[ \t"]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '""')}"`;
}

/** One platform-resolved launch: the command to spawn, its argv, and whether
 *  that argv must reach the child byte-for-byte (the cmd.exe shim path).
 *  Adapter-internal — the win32 shape never crosses the seam. */
export interface SpawnPolicy {
	command: string;
	args: string[];
	/** true → spawn() must be told `windowsVerbatimArguments: true`, because the
	 *  args already carry their cmd.exe quoting and a second Node-applied quoting
	 *  pass would desynchronise cmd's parser (BUG_FIX_CONTEXT below). */
	verbatimArgs: boolean;
}

/**
 * Does launching `command` on win32 need the cmd.exe shim?
 * <p>
 * Node refuses to spawn .cmd/.bat shell-less (CVE-2024-27980 → EINVAL), so a
 * batch shim is the ONE case the shim exists for. A native executable
 * (herdr.exe, taskkill.exe) is spawned DIRECTLY: routing arbitrary text through
 * cmd.exe adds a re-parsing layer that mangles command-line metacharacters even
 * when the per-argument quoting is correct (BUG_FIX_CONTEXT below).
 * <p>
 * The decision is a PATH+PATHEXT lookup — the same lookup the loader performs —
 * resolved against `env` so the injected win32 policy is testable on a POSIX
 * host. A command that resolves to nothing keeps the shim: its failure surface
 * (an ENOENT-shaped exec error from cmd.exe) is the pre-fix behavior.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: command — binary name or path; env — the launching environment
 *   (PATH/PATHEXT source; an env without PATH resolves to the shim)
 * Output: true → launch through cmd.exe; false → launch directly
 * Guarantees:
 *   - pure lookup: no process is started, nothing is written
 *   - a path-shaped command is classified by its OWN extension
 *   - the first hit in PATH order wins; extensions are supplied in PATHEXT
 *     order, and a bare name match inside a directory is probed first
 * Raises: never
 */
export function needsCmdShim(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const commandExt = extname(command).toLowerCase();
	if (command.includes("/") || command.includes("\\")) return BATCH_SHIM_EXTS.has(commandExt);
	const exts = (env.PATHEXT ?? DEFAULT_PATHEXT)
		.split(";")
		.map((e) => e.trim().toLowerCase())
		.filter((e) => e.length > 0);
	for (const dir of (env.PATH ?? "").split(delimiter).filter((d) => d.length > 0)) {
		// A bare name has no Windows meaning on PATH (CreateProcess needs an
		// extension), so the direct probe applies only to an already-extended
		// command such as `herdr.exe`.
		if (commandExt.length > 0 && existsSync(join(dir, command))) return BATCH_SHIM_EXTS.has(commandExt);
		for (const ext of exts) {
			if (existsSync(join(dir, command + ext))) return BATCH_SHIM_EXTS.has(ext);
		}
	}
	return true;
}

/**
 * Apply the platform spawn policy to one CLI launch (TZ §3.6.3).
 * <p>
 * BUG_FIX_CONTEXT (cmd.exe double-quoting, field incident 2026-10-27):
 * symptom — on a Windows host with a native `herdr.exe` on PATH EVERY worker
 * spawn ended in E_PROMPT_STALLED: the worker pane started and showed the
 * resolved tier, but the fixed delegate prompt never arrived, and herdr's
 * stderr carried cmd.exe's ERROR_FILE_NOT_FOUND instead of any herdr output.
 * Root cause — the win32 launch quoted every argument itself (winQuoteArg, cmd
 * convention `"…"` with `""` doubling) and then handed the ALREADY-QUOTED array
 * to node's spawn, which quoted each element a second time for the C runtime
 * (`"` → `\"`); cmd.exe is not a C-runtime argument parser, so its quote state
 * desynchronised and the `<`/`>` characters of the prompt became redirection
 * operators — cmd tried to OPEN A FILE named after the token following `<` and
 * died before herdr ran. The delegate prompt is fixed text and always contains
 * `<verb>` / `--pct <0-100>`, so the failure was total, not intermittent; a
 * 32-byte prompt containing `<x>` reproduced it and the same prompt with `[x]`
 * did not (length was irrelevant). Why the suite missed it —
 * test/transport-win-check.ts modelled the stub cmd.exe as an argv-array
 * consumer, but real cmd.exe re-parses ONE command-line string, so no check
 * ever exercised the reparse.
 * What was done, in two parts: (1) a native executable is now spawned DIRECTLY,
 * removing cmd.exe from the path entirely — the metacharacter class cannot
 * reach the child at all; (2) when a batch shim genuinely requires cmd.exe, the
 * pre-quoted argv is passed with `windowsVerbatimArguments: true` so node adds
 * no second quoting pass. Residual, documented: on the shim path cmd.exe still
 * performs its own `%VAR%` expansion inside quotes; that residual cannot occur
 * on the direct path, which is the only path a native herdr.exe takes.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: command — the CLI binary name as invoked on POSIX ("herdr",
 *   "taskkill"); args — the raw argv array; platform — the (possibly
 *   injected) platform; env — PATH/PATHEXT source for the shim decision
 * Output: the spawn policy for THAT platform
 * Guarantees:
 *   - POSIX: { command, args } returned UNCHANGED with verbatimArgs false
 *     (byte-identical launch — the regression pin for the pre-1.17 shape)
 *   - win32 + native executable: { command, args } returned UNCHANGED with
 *     verbatimArgs false — the argv meets node's own C-runtime quoting, which
 *     is what a native Windows executable expects
 *   - win32 + batch shim (or an unresolvable command): `cmd.exe /d /s /c`
 *     followed by the per-argument-quoted command and argv (argv stays an
 *     array; winQuoteArg does the quoting) with verbatimArgs true
 * Raises: never
 */
export function resolveLaunch(
	command: string,
	args: string[],
	platform: NodeJS.Platform = DEFAULT_PLATFORM,
	env: NodeJS.ProcessEnv = process.env,
): SpawnPolicy {
	if (platform !== "win32") return { command, args, verbatimArgs: false };
	if (!needsCmdShim(command, env)) return { command, args, verbatimArgs: false };
	return {
		command: "cmd.exe",
		args: ["/d", "/s", "/c", winQuoteArg(command), ...args.map(winQuoteArg)],
		verbatimArgs: true,
	};
}

/** The spawn() options the policy demands beyond stdio/windowsHide. Split out
 *  so the win32 branch has ONE spelling at both call sites (launch + tree-kill)
 *  and the POSIX branch stays byte-identical to the pre-1.17 shape. */
function verbatimArgOption(policy: SpawnPolicy): { windowsVerbatimArguments?: true } {
	return policy.verbatimArgs ? { windowsVerbatimArguments: true } : {};
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

export interface HerdrRunResult {
	stdout: string;
	stderr: string;
}

/**
 * Run one `herdr <args>` CLI call with a hard time bound and SIGKILL escalation.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - args: herdr CLI argv (array — never shell strings)
 *   - timeoutMs: hard bound on the call (default CLI_TIMEOUT_MS = 30_000)
 * Output: { stdout, stderr } of a zero-exit run
 * Guarantees:
 *   - the promise ALWAYS settles: at timeoutMs the child gets SIGTERM (execFile
 *     parity), its stdio is destroyed (parity with node's exec timeout), and
 *     after a further SIGKILL_GRACE_MS it gets SIGKILL — so a herdr build with
 *     a graceful-shutdown SIGTERM handler cannot hang this promise forever
 *     (BUG_FIX_CONTEXT below). The promise rejects AT timeoutMs, not when the
 *     escalated kill lands.
 *   - failure shape preserved from the promisified-execFile implementation:
 *     the thrown error carries .killed/.signal/.code/.stdout/.stderr and its
 *     message carries stderr text — callers match error text (isNotFound,
 *     agent_name_taken, agent_prompt_stalled regexes) against it unchanged
 *   - the child is reaped even when it dies AFTER the rejection (external or
 *     escalated SIGKILL): the parent's loop reaps it via the still-open libuv
 *     process handle — no zombie while the loop is healthy
 * Raises:
 *   - Error (wrapped by callers) for non-zero exit, spawn failure (ENOENT),
 *     maxBuffer overrun, or timeout
 * EXTERNAL_DEPENDENCY: `herdr` CLI binary on PATH (resolved at spawn time).
 *   On the injected win32 policy additionally: cmd.exe (the Windows command
 *   interpreter — the launch shim for npm .cmd shims) and, on kill escalation,
 *   taskkill.exe (the Windows tree-kill) via the same policy.
 * <p>
 * BUG_FIX_CONTEXT (SIGKILL escalation, 2026-09-09 herdr incident follow-up):
 * symptom — the promisified execFile timeout sends SIGTERM only; a herdr build
 * with a graceful-shutdown SIGTERM handler survives it forever, the promise
 * NEVER settles (leak-probe sig.log; re-reproduced with a silent-trap stub:
 * pending past the 30s timeout mark), and via the serialized-mutations queue
 * in HerdrTransport every later mutating op (place/start/prompt/teardown)
 * stalls behind it while read-only ops and the event loop stay healthy
 * (h3-queue-stall repro). Why SIGTERM-only did not work: node's exec timeout
 * cannot recover a child that ignores SIGTERM, and D-state children would
 * ignore it too. What was done: kept the SIGTERM-at-timeout contract, then
 * escalated to SIGKILL after SIGKILL_GRACE_MS (armed at spawn, cleared on
 * close); the promise rejects at the timeout mark. Side-effect fix: the old
 * implementation RESOLVED ok-with-empty-stdout when the direct child had
 * already exited but a descendant kept the stdio pipes open (the timeout
 * "kill" hit a dead pid and node's close-on-timeout surfaced as success) —
 * the spawn-based escalation destroys stdio at timeout and rejects properly.
 * Exported for tests (transport-sigkill.ts drives it with stub CLIs).
 * <p>
 * FUNCTION_CONTRACT (Windows policy, TZ §3.6):
 * Input:
 *   - platform: optional trailing NodeJS.Platform (default DEFAULT_PLATFORM —
 *     the process's own platform). "win32" switches BOTH the launch and the
 *     kill escalation to the Windows shape; tests on a POSIX host inject it
 *     to drive the win32 branch without a real Windows machine.
 * Guarantees (win32 branch):
 *   - launch: cmd.exe /d /s /c <quoted herdr argv> — an npm .cmd shim is
 *     reachable where a shell-less spawn would fail EINVAL (CVE-2024-27980)
 *     or ENOENT; stdio/windowsHide identical to the POSIX branch
 *   - kill escalation: taskkill /pid <childPid> /T /F (tree kill — herdr's
 *     agent children die with the CLI process) instead of child.kill("SIGKILL"),
 *     which on Windows terminates only the direct child
 *   - the timeout rejection shape (killed:true, signal SIGTERM) is IDENTICAL
 *     to POSIX — callers' E_* mapping and message regexes are platform-blind
 */
export async function runHerdr(
	args: string[],
	timeoutMs: number = CLI_TIMEOUT_MS,
	platform: NodeJS.Platform = DEFAULT_PLATFORM,
	env?: NodeJS.ProcessEnv,
): Promise<HerdrRunResult> {
	try {
		return await spawnHerdr(args, timeoutMs, platform, env);
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown };
		const details = [e.stderr?.trim(), e.stdout?.trim(), e.message].filter(Boolean).join("\n");
		throw new Error(`herdr ${args[0]} ${args[1] ?? ""} failed\n${details}`.trim(), { cause: err });
	}
}

/** Exec-like error: parity with what promisified execFile used to throw so the
 *  runHerdr wrapper's detail-shaping (and callers' message regexes) keep working. */
function herdrSpawnError(args: string[], fields: { message: string; code?: unknown; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string }): Error {
	const err = new Error(fields.message) as Error & {
		code?: unknown; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string;
	};
	err.code = fields.code;
	err.killed = fields.killed ?? false;
	err.signal = fields.signal ?? null;
	err.stdout = fields.stdout ?? "";
	err.stderr = fields.stderr ?? "";
	return err;
}

/**
 * Spawn one `herdr <args>` CLI call under the platform spawn/kill policy and
 * wait for it with the execFile-parity timeout shape.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - args: herdr CLI argv (array — never shell strings)
 *   - timeoutMs: hard bound on the call
 *   - platform: spawn/kill policy selector (default DEFAULT_PLATFORM);
 *     injected "win32" in tests drives the Windows branch on a POSIX host
 * Output: { stdout, stderr } of a zero-exit run
 * Guarantees:
 *   - POSIX (default): the spawn is BYTE-IDENTICAL to the pre-1.17 shape —
 *     spawn("herdr", args, { stdio: ["ignore","pipe","pipe"], windowsHide:
 *     true }); escalation stays SIGTERM → (SIGKILL_GRACE_MS) → SIGKILL and
 *     is cleared when the child closes, exactly as before
 *   - win32 (injected): a native executable is launched DIRECTLY (node's own
 *     quoting — BUG_FIX_CONTEXT above); a batch shim goes through
 *     cmd.exe /d /s /c with per-argument quoting passed verbatim
 *     (winQuoteArg + windowsVerbatimArguments, so no second quoting pass);
 *     kill escalation via
 *     `taskkill /pid <pid> /T /F` fire-and-forget, no second grace timer,
 *     SIGKILL_GRACE_MS unchanged; the escalation SURVIVES the direct child's
 *     close (the timeout SIGTERM = TerminateProcess kills only the direct
 *     child — the herdr tree may outlive it and needs the tree-kill)
 *   - spawn errors (EINVAL/ENOENT) flow through herdrSpawnError so callers'
 *     E_* mapping and message regexes keep working on BOTH branches
 * Raises:
 *   - exec-like Error (see herdrSpawnError) — never a raw child-process error
 * EXTERNAL_DEPENDENCY (win32): cmd.exe — the Windows command interpreter used
 *   as the launch shim (modern Node refuses to spawn .cmd/.bat shims
 *   shell-less: CVE-2024-27980); taskkill.exe — the Windows tree-kill used by
 *   the escalation (child.kill("SIGKILL") cannot reach herdr's own children).
 */
function spawnHerdr(args: string[], timeoutMs: number, platform: NodeJS.Platform = DEFAULT_PLATFORM, env?: NodeJS.ProcessEnv): Promise<HerdrRunResult> {
	return new Promise((resolve, reject) => {
		// Platform policy applied HERE and in armSigkill only — the rest of the
		// lifecycle (timeout shape, stdio destruction, error mapping) is shared.
		// The shim decision reads the launching environment when the caller
		// supplies one (PATH lives there), the process environment otherwise.
		const policy = resolveLaunch("herdr", args, platform, env ?? process.env);
		// Issue #25: an explicit env (the spawn flow's swarm identity) replaces
		// the inherited process environment for this CLI call; absent → inherit.
		const child = spawn(policy.command, policy.args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			...verbatimArgOption(policy),
			...(env ? { env } : {}),
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let overBuffer: string | null = null;
		let settled = false;
		let sigkillTimer: NodeJS.Timeout | undefined;

		const clearEscalation = () => {
			if (sigkillTimer !== undefined) {
				clearTimeout(sigkillTimer);
				sigkillTimer = undefined;
			}
		};
		// SIGKILL escalation: armed whenever we demand shutdown (timeout or
		// maxBuffer); cleared on close. Fire-and-forget — the promise has already
		// rejected by the time it lands; this only makes sure the child dies.
		// BUG_FIX_CONTEXT (Windows tree-kill, TZ §3.6.2): symptom — on Windows the
		// escalation's child.kill("SIGKILL") maps to TerminateProcess of the DIRECT
		// child only, so herdr's own child processes (the spawned agents) survive
		// as orphans; also, Windows Node has no graceful SIGTERM window (documented
		// behavior: both SIGTERM and SIGKILL terminate unconditionally), so the
		// first-step child.kill("SIGTERM") at timeout already hard-terminates — it
		// is KEPT as the first step precisely because of that documented shape.
		// Why the old escalation did not work on Windows: a direct-child-only kill
		// leaks the whole agent tree. What was done: on the injected win32 policy
		// the escalation fires `taskkill /pid <childPid> /T /F` (tree + force)
		// through the same spawn-policy machinery (array argv, windowsHide,
		// winQuoteArg where needed) instead of child.kill("SIGKILL"). Fire-and-
		// forget semantics preserved exactly (the promise has already rejected;
		// no second grace timer; SIGKILL_GRACE_MS unchanged). The escalation is
		// NOT cleared on the direct child's close on win32 (see the close handler):
		// the first TerminateProcess kills only cmd.exe, the herdr tree survives
		// it, and the tree-kill is exactly what must still land. POSIX branch is
		// byte-identical to the pre-1.17 SIGKILL escalation.
		const armSigkill = () => {
			clearEscalation();
			sigkillTimer = setTimeout(() => {
				if (platform === "win32") {
					// EXTERNAL_DEPENDENCY: taskkill.exe (Windows tree-kill). The pid may
					// be undefined when the spawn itself failed — nothing to escalate.
					const pid = child.pid;
					if (pid !== undefined) {
						const tk = resolveLaunch("taskkill", ["/pid", String(pid), "/T", "/F"], platform);
						const killer = spawn(tk.command, tk.args, {
							stdio: "ignore",
							windowsHide: true,
							...verbatimArgOption(tk),
						});
						// Fire-and-forget: a failed taskkill must never crash the process
						// with an unhandled 'error' event — the promise is already settled.
						killer.on("error", () => {});
					}
					return;
				}
				child.kill("SIGKILL");
			}, SIGKILL_GRACE_MS);
			(sigkillTimer as unknown as { unref?: () => void }).unref?.();
		};

		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (err) {
				reject(err);
			} else {
				resolve({ stdout, stderr });
			}
		};

		const failLike = (fields: Parameters<typeof herdrSpawnError>[1]) => {
			finish(herdrSpawnError(args, { ...fields, stdout, stderr }));
		};

		// Hard bound: SIGTERM (execFile parity) + stdio destruction (exec parity:
		// a trap handler writing to a destroyed pipe dies EPIPE instead of hanging)
		// + reject NOW (do not wait for the escalated kill to land), then arm SIGKILL.
		// The SIGKILL timer is NOT cleared here — it must survive the rejection;
		// it is cleared when the child actually closes (or fires on a dead pid,
		// which is a harmless no-op).
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			child.stdout?.destroy();
			child.stderr?.destroy();
			armSigkill();
			failLike({ message: `Command timed out after ${timeoutMs}ms: herdr ${args.join(" ")}`, killed: true, signal: "SIGTERM" });
		}, timeoutMs);
		(timer as unknown as { unref?: () => void }).unref?.();

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > EXEC_MAX_BUFFER && !overBuffer) {
				overBuffer = "stdout";
				child.kill("SIGTERM");
				child.stdout?.destroy();
				child.stderr?.destroy();
				armSigkill();
			}
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
			if (stderr.length > EXEC_MAX_BUFFER && !overBuffer) {
				overBuffer = "stderr";
				child.kill("SIGTERM");
				child.stdout?.destroy();
				child.stderr?.destroy();
				armSigkill();
			}
		});

		// spawn failure (ENOENT: no herdr on PATH) — err carries .code. Flows
		// through herdrSpawnError (exec-like shape) so callers' E_* mapping and
		// message regexes keep working on both platform branches.
		child.on("error", (err) => {
			clearTimeout(timer);
			clearEscalation();
			const e = err as NodeJS.ErrnoException;
			failLike({ message: e.message, code: e.code });
		});

		// 'close' = exited AND stdio settled — the execFile settlement point.
		child.on("close", (code, signal) => {
			// Runs even after a timeout/maxBuffer rejection: reap bookkeeping ends here.
			clearTimeout(timer);
			// POSIX: the child closing means it is dead — the SIGKILL escalation is
			// moot, clear it. win32: KEEP the escalation armed — the timeout step's
			// child.kill("SIGTERM") is documented-Node TerminateProcess of the DIRECT
			// child (cmd.exe) only, so the herdr tree (the CLI shim's node process and
			// its agent children) can outlive the close event; the taskkill tree-kill
			// is exactly what must still land. A taskkill on a pid whose whole tree
			// already died is a harmless fire-and-forget no-op (same no-op contract
			// as the POSIX SIGKILL-on-dead-pid).
			if (platform !== "win32") clearEscalation();
			if (overBuffer) {
				failLike({ message: `${overBuffer} maxBuffer length exceeded`, code: null, killed: true, signal });
				return;
			}
			if (code === 0) {
				finish();
				return;
			}
			failLike({ message: `Command failed: herdr ${args.join(" ")}\n${stderr}`, code, killed: false, signal });
		});
	});
}

/**
 * Parse herdr stdout: take the last non-empty line, JSON.parse it, return
 * `.result`. Tolerant: non-JSON output resolves to `null` with the raw text
 * carried alongside so callers can attach it to errors.
 */
export function parseHerdrResult(stdout: string): { result: unknown; raw: string } {
	const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	const last = lines[lines.length - 1] ?? "";
	try {
		const parsed = JSON.parse(last) as { result?: unknown };
		return { result: parsed.result !== undefined ? parsed.result : parsed, raw: stdout };
	} catch {
		return { result: null, raw: stdout };
	}
}
