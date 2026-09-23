/**
 * pi-delegate — src/spawn-policy.ts — the ONE OS process launch policy.
 *
 * MODULE_CONTRACT: how a CLI launch must be shaped on the host OS, expressed
 * once and applied by every host backend. Before this module the policy lived
 * inside `src/herdr/cli.ts`; the rpc backend needed the same policy (a bare
 * `pi` does not resolve on Windows — npm ships `pi.cmd`) and the OS strings it
 * carries are not herdr vocabulary: `cmd.exe` and `taskkill` name the OS, not
 * a backend. Moving them here is what lets the herdr adapter keep its
 * vocabulary confinement (the S6 pin) while both adapters share one launch and
 * one tree-kill implementation.
 *
 * Dependencies: NONE (pure functions over an injected platform — the bottom of
 * the src/ import graph, beside src/expaths.ts).
 *
 * Critical invariants:
 *   - POSIX launches are byte-identical to the pre-1.17 shape: the policy
 *     returns command + argv UNCHANGED, so a backend's POSIX spawn arguments
 *     do not move when it adopts the policy.
 *   - The "never shell strings" law holds: argv stays an array end-to-end and
 *     cmd.exe receives the per-argument-quoted form (winQuoteArg) — never one
 *     pre-joined opaque command line built from call-site data.
 *   - A Windows kill is a TREE kill: TerminateProcess of the direct child only
 *     would leave the agent tree alive (with the cmd.exe wrapper it kills the
 *     wrapper and orphans the real process). `treeKillCommand` is the single
 *     spelling of that recipe.
 *   - POSIX has no tree-kill policy: signal escalation owns it there, so
 *     `treeKillCommand` returns undefined and the caller keeps its
 *     SIGTERM→SIGKILL path (byte-identical).
 */

/** One platform-resolved launch: the command to spawn and its argv.
 *  Backend-internal — the win32 shape never crosses the seam. */
export interface SpawnPolicy {
	command: string;
	args: string[];
}

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
 * (`say "hi"` → `"say ""hi"""`).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: arg — one raw argv element (never contains a newline here; CLI args
 *   of both backends do not)
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

/**
 * Apply the platform spawn policy to one CLI launch (TZ §3.6.3).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: command — the CLI binary name as invoked on POSIX ("herdr", "pi",
 *   "taskkill"); args — the raw argv array; platform — the (possibly
 *   injected) platform
 * Output: the spawn policy for THAT platform
 * Guarantees:
 *   - POSIX: { command, args } returned UNCHANGED (byte-identical launch —
 *     the regression pin for the pre-1.17 shape)
 *   - win32: `cmd.exe /d /s /c` followed by the per-argument-quoted command
 *     and argv (argv stays an array; winQuoteArg does the quoting)
 * Raises: never
 */
export function spawnPolicyCommand(command: string, args: string[], platform: NodeJS.Platform): SpawnPolicy {
	if (platform === "win32") {
		return {
			command: "cmd.exe",
			args: ["/d", "/s", "/c", winQuoteArg(command), ...args.map(winQuoteArg)],
		};
	}
	return { command, args };
}

/**
 * The OS tree-kill for one process id — one spelling for every backend.
 * <p>
 * EXTERNAL_DEPENDENCY: taskkill.exe (ships with Windows).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: pid — a live child pid; platform — the (possibly injected) platform
 * Output: win32 → the `taskkill /pid <pid> /T /F` launch shaped through the
 *   same cmd.exe policy as every other Windows launch; POSIX → `undefined`
 *   ("no tree-kill policy — signals own the escalation there")
 * Guarantees:
 *   - /T kills the WHOLE tree: the direct-child kill that POSIX signals map
 *     to on Windows (TerminateProcess) leaves the agent's own children alive,
 *     and behind the cmd.exe wrapper it kills only the wrapper.
 *   - The recipe is spelled once: no backend repeats the flag sequence.
 * Raises: never (the caller spawns the result fire-and-forget; a taskkill on a
 *   pid whose tree already exited is a benign no-op)
 */
export function treeKillCommand(pid: number, platform: NodeJS.Platform): SpawnPolicy | undefined {
	if (platform !== "win32") return undefined;
	return spawnPolicyCommand("taskkill", ["/pid", String(pid), "/T", "/F"], platform);
}
