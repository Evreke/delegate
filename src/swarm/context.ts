/**
 * pi-delegate — src/swarm/context.ts — worker identity + exchange-dir paths.
 *
 * MODULE_CONTRACT — resolves a verb invocation's worker identity and its
 * exchange paths. Identity travels by ONE canonical mechanism (§4.1.1): the
 * spawn flow exports SWARM_TASK / SWARM_WORKER into the worker's environment;
 * the `--task` / `--worker` flags are an explicit override only. Every BUILT
 * path goes through src/expaths.ts (the ONE path builder) — the task dir is
 * assembled from the exchange root plus the task slug, and the report /
 * question / answer / progress leaf names come from the expaths builders, so
 * no file-name convention is re-implemented here.
 *
 * The brief path is an INPUT, not a built convention: the worker prompt carries
 * it (`--brief`, or the `read-brief <path>` positional). When it is absent the
 * canonical sibling name `brief-<worker>.md` is derived — the ONLY name
 * spelling in the swarm family, kept here because src/expaths.ts owns no brief
 * builder and is read-only for this issue.
 *
 * Dependencies: node:path, ../exchange.ts (exchangeRoot + ensureExchangeDir —
 * the ONE brief validator), ../host.ts (WORKER_NAME_RE ONLY), ./args.ts,
 * ./result.ts. No herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - a worker name must satisfy WORKER_NAME_RE or the verb fails E_NAME;
 *   - a brief path, when supplied, is validated by ensureExchangeDir (absolute,
 *     directly under <exchangeRoot>/<task>/, non-empty) — E_BRIEF otherwise;
 *   - paths are separator-native (node:path), never hand-assembled strings.
 */

import { join } from "node:path";
import { ensureExchangeDir, exchangeRoot } from "../exchange.ts";
import { WORKER_NAME_RE } from "../host.ts";
import { flagStr, type ParsedArgs } from "./args.ts";
import { SwarmError } from "./result.ts";

export interface SwarmContext {
	/** Task slug (the exchange dir basename). */
	task: string;
	/** Canonical worker name. */
	worker: string;
	/** Absolute exchange dir: <exchangeRoot>/<task>. */
	dir: string;
	/** Absolute brief path (supplied or the canonical sibling name). */
	briefPath: string;
}

/** Validate + normalize a brief path through the ONE exchange validator,
 *  mapping its typed E_BRIEF into the CLI result envelope. */
export function openExchangeDir(briefPath: string): { dir: string; task: string; briefPath: string } {
	try {
		const d = ensureExchangeDir(briefPath);
		return { dir: d.dir, task: d.task, briefPath: d.briefPath };
	} catch (err) {
		const e = err as { code?: string; message?: string };
		throw new SwarmError("E_BRIEF", e.message ?? String(err));
	}
}

/**
 * Resolve identity + paths for a verb invocation.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - parsed: the parsed argv
 *   - env: the process environment (SWARM_TASK / SWARM_WORKER)
 *   - positionalBrief: an optional positional brief path (read-brief shorthand)
 * Output: the resolved SwarmContext
 * Guarantees:
 *   - worker from --worker / SWARM_WORKER; required + WORKER_NAME_RE-checked
 *   - brief from --brief / positionalBrief; when present, the dir + task come
 *     from ensureExchangeDir (the brief wins over a conflicting --task)
 *   - otherwise task from --task / SWARM_TASK; dir = exchangeRoot()/<task> and
 *     the brief path is the canonical sibling `brief-<worker>.md`
 * Raises: SwarmError (E_SWARM_IDENTITY, E_NAME, E_BRIEF)
 */
export function resolveContext(parsed: ParsedArgs, env: NodeJS.ProcessEnv, positionalBrief?: string): SwarmContext {
	const worker = flagStr(parsed, "worker") ?? env.SWARM_WORKER ?? "";
	if (!worker) {
		throw new SwarmError(
			"E_SWARM_IDENTITY",
			"worker identity is missing (no --worker flag and no SWARM_WORKER environment variable)",
		);
	}
	if (!WORKER_NAME_RE.test(worker)) {
		throw new SwarmError("E_NAME", `worker name "${worker}" is not canonical (expected [a-z][a-z0-9_-]{0,31})`);
	}

	const taskFlag = flagStr(parsed, "task") ?? env.SWARM_TASK ?? "";
	const briefArg = flagStr(parsed, "brief") ?? positionalBrief;
	if (briefArg) {
		const d = openExchangeDir(briefArg);
		return { task: taskFlag || d.task, worker, dir: d.dir, briefPath: d.briefPath };
	}

	if (!taskFlag) {
		throw new SwarmError(
			"E_SWARM_IDENTITY",
			"task identity is missing (no --brief path, no --task flag and no SWARM_TASK environment variable)",
		);
	}
	const dir = join(exchangeRoot(), taskFlag);
	return { task: taskFlag, worker, dir, briefPath: join(dir, `brief-${worker}.md`) };
}
