/**
 * win-quote-check — pins the cmd.exe argument-quoting contract of
 * src/spawn-policy.ts (winQuoteArg).
 *
 * Run with: bun test/win-quote-check.ts   (from repo root)
 *
 * Why this file exists (PR #159 review, Major): winQuoteArg quoted only
 * space/tab/quote, so an argument carrying a cmd.exe metacharacter (`& | < >
 * ^ %`) without spaces reached the command line UNQUOTED — `&` split it into
 * two commands (injection vector). The helper now quotes every metacharacter
 * carrier; this check pins the split-proof with a real cmd.exe round-trip.
 *
 * Watchdog (fail-fast discipline): a hung check must exit non-zero on its
 * own, never hold the runner.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { winQuoteArg } from "../src/spawn-policy.ts";

const WATCHDOG_MS = 20_000;
setTimeout(() => {
	console.error(`WATCHDOG: win-quote-check exceeded ${WATCHDOG_MS}ms — exiting non-zero`);
	process.exit(1);
}, WATCHDOG_MS).unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// Q1 plain args pass through byte-identical (the taskkill shape stays clean).
for (const arg of ["taskkill", "/pid", "123", "/T", "/F", "hello", "C:\\bin\\tool.cmd"]) {
	check(`Q1 plain arg passes through byte-identical: ${arg}`, winQuoteArg(arg) === arg, JSON.stringify(winQuoteArg(arg)));
}

// Q2 every cmd.exe metacharacter forces quoting.
for (const m of ["&", "|", "<", ">", "^", "%"]) {
	const out = winQuoteArg(`a${m}b`);
	check(`Q2 metacharacter ${m} forces quoting`, out.startsWith(`"`) && out.endsWith(`"`), JSON.stringify(out));
}

// Q3 internal quotes double (the cmd de-quoting convention).
check(`Q3 internal quotes double: say "hi" → "say ""hi"""`, winQuoteArg(`say "hi"`) === `"say ""hi"""`, JSON.stringify(winQuoteArg(`say "hi"`)));

// Q4 space still forces quoting.
check("Q4 space forces quoting", winQuoteArg("hello world") === '"hello world"', JSON.stringify(winQuoteArg("hello world")));

// Q5 REAL cmd.exe round-trip (win32 hosts only): a metacharacter arg survives
// as ONE argv element — echo prints it verbatim, quotes included. The
// pre-fix spelling (unquoted) would split at `&`: stdout would lose everything
// past it. On POSIX hosts the pure legs Q1-Q4 already ran; the round-trip is
// the live proof and is skipped with an explicit marker (transport-socket
// pattern).
if (process.platform === "win32") {
	const arg = "a&b|c";
	// The delivery contract (Q6): policy args reach cmd.exe VERBATIM — the
	// winQuoteArg spelling IS the final spelling. spawnSync with
	// windowsVerbatimArguments:true reproduces the production delivery exactly.
	const r = spawnSync("cmd.exe", ["/d", "/s", "/c", "echo", winQuoteArg(arg)], { encoding: "utf8", windowsVerbatimArguments: true });
	const out = (r.stdout ?? "").trim();
	check(
		"Q5 cmd.exe round-trip: a metacharacter arg survives as ONE element (no command split)",
		out === `"${arg}"`,
		JSON.stringify({ out, status: r.status, stderr: (r.stderr ?? "").slice(0, 200) }),
	);
} else {
	console.log("SKIP  Q5 cmd.exe round-trip — not a win32 host (pure legs Q1-Q4 all ran)");
}

// Q6 the delivery contract is really wired: both adapters spawn the policy
// result verbatim — without this node's own quoting double-escapes the
// winQuoteArg spelling and re-opens the metacharacter split (the PR #159
// review caught exactly this gap).
for (const [file, who] of [["src/herdr/cli.ts", "herdr"], ["src/host/rpc.ts", "rpc"]] as const) {
	const src = readFileSync(join(process.cwd(), file), "utf8");
	check(`Q6 ${who} adapter spawns the policy args with windowsVerbatimArguments: true`, src.includes("windowsVerbatimArguments: true"), `${file} — the verbatim delivery is missing, the quoting layer is dead code there`);
}

console.log(failures === 0 ? "\nwin-quote-check: all checks passed" : `\nwin-quote-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
