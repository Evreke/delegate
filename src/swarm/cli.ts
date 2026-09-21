#!/usr/bin/env bun
/**
 * pi-delegate — src/swarm/cli.ts — the `swarm` worker-verb CLI.
 *
 * MODULE_CONTRACT — the entry point and dispatcher of the `swarm` bun script
 * shipped with the extension (ARCHITECTURE.md §4.1.1). It exposes exactly the
 * FIVE worker verbs — `read-brief`, `write-report`, `ask`,
 * `poll-answer`, `write-progress` — and nothing else. Phase A writes today's
 * exchange files byte-identically (Law 7). Phase B (issue #23, §4.1.3):
 * under `swarm.storage: "journal"` every verb write appends its journal
 * event FIRST (journal = truth) and then writes the byte-frozen file
 * projection — the journal append is advisory (Law 8: a journal failure is
 * recorded in the success envelope's `journal` field, never a verb failure);
 * the default remains "files" (no journal write at all) this release.
 *
 * Worker identity travels by ONE canonical mechanism: the spawn flow exports
 * SWARM_TASK / SWARM_WORKER; `--task` / `--worker` are explicit overrides
 * (./context.ts). Every BUILT path goes through src/expaths.ts; the brief path
 * is an input (`--brief` / the read-brief positional) or the canonical sibling
 * name derived in ./context.ts.
 *
 * Result contract (Law 8): success = exit 0 + a JSON result on stdout; failure
 * = non-zero exit + a structured stdout error object carrying an E_* code and
 * a hint (./result.ts).
 *
 * Dependencies: ./args.ts, ./context.ts, the five verb modules, ./result.ts,
 * ./storage.ts (the Phase B journal plumbing the verbs call). No herdr
 * adapter import (Law 4).
 *
 * Critical invariants:
 *   - the verb set is closed: an unknown verb fails E_SWARM_USAGE;
 *   - importing this module never runs the CLI (import.meta.main guard), so
 *     tests can import `main` directly;
 *   - exactly one JSON object reaches stdout per invocation.
 */

import { parseArgs, type ParsedArgs } from "./args.ts";
import { resolveContext } from "./context.ts";
import { runAsk } from "./ask.ts";
import { runPollAnswer } from "./poll-answer.ts";
import { runReadBrief } from "./read-brief.ts";
import { runWriteProgress } from "./write-progress.ts";
import { runWriteReport } from "./write-report.ts";
import { emitFailure, SwarmError } from "./result.ts";

/** The frozen worker verb set (section 3 frozen-surface addition). */
export const WORKER_VERBS: ReadonlyArray<string> = ["read-brief", "write-report", "ask", "poll-answer", "write-progress"];

const USAGE = `swarm <verb> [flags]

Verbs:
  read-brief      <briefPath> | --brief <path>
  write-report    [--brief <path>] [--file <path>] [--schema-dir <dir>]   (report JSON on stdin when --file is absent)
  ask             --question <text> [--context <text>] [--option <o>]... [--options a,b,c]
  poll-answer     [--wait <ms>] [--interval <ms>]
  write-progress  --phase <label> [--pct <0-100>] [--note <text>]

Identity: SWARM_TASK / SWARM_WORKER (--task / --worker override).
`;

/** Dispatch one parsed invocation; the write verbs are async in Phase B
 *  (the journal append precedes the projection write). */
async function dispatch(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<void> {
	switch (parsed.verb) {
		case "read-brief":
			// Fail-fast: read-brief accepts at most ONE positional (the brief path).
			if (parsed.positionals.length > 1) {
				throw new SwarmError(
					"E_SWARM_USAGE",
					`read-brief takes at most one positional brief path, got ${parsed.positionals.length}: ${parsed.positionals.join(" ")}`,
				);
			}
			runReadBrief(resolveContext(parsed, env, parsed.positionals[0]));
			return;
		case "write-report":
			await runWriteReport(resolveContext(parsed, env), parsed, env);
			return;
		case "ask":
			await runAsk(resolveContext(parsed, env), parsed, env);
			return;
		case "poll-answer":
			runPollAnswer(resolveContext(parsed, env), parsed);
			return;
		case "write-progress":
			await runWriteProgress(resolveContext(parsed, env), parsed, env);
			return;
		default:
			throw new SwarmError("E_SWARM_USAGE", `unknown verb ${JSON.stringify(parsed.verb)} — known verbs: ${WORKER_VERBS.join(", ")}`);
	}
}

/** CLI entry: parse, dispatch, render success/failure. Pure-ish (fs through
 *  the verbs); resolves with the exit code instead of calling process.exit so
 *  stdout drains before the process ends. */
export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (err) {
		if (err instanceof SwarmError) {
			emitFailure(null, err);
			return 1;
		}
		throw err;
	}

	if (parsed.bools.has("help") || parsed.verb === "help") {
		process.stdout.write(USAGE);
		return 0;
	}

	try {
		await dispatch(parsed, env);
		return 0;
	} catch (err) {
		if (err instanceof SwarmError) {
			emitFailure(parsed.verb, err);
			return 1;
		}
		emitFailure(parsed.verb, new SwarmError("E_SWARM_IO", err instanceof Error ? err.message : String(err)));
		return 1;
	}
}

if (import.meta.main) {
	void main(process.argv.slice(2), process.env).then((code) => {
		process.exitCode = code;
	});
}
