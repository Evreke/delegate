/**
 * pi-delegate — src/swarm/read-brief.ts — the `swarm read-brief` verb.
 *
 * MODULE_CONTRACT — read the worker's brief and return its full text as the
 * verb's JSON result. The brief path is validated through the ONE exchange
 * validator (context.openExchangeDir → ensureExchangeDir), so a foreign or
 * missing brief fails E_BRIEF before any read.
 *
 * Dependencies: node:fs, ./context.ts, ./result.ts. No herdr adapter import.
 *
 * Critical invariants:
 *   - the returned `briefPath` is the validator-normalized absolute path;
 *   - the returned `text` is the file's bytes decoded as UTF-8, verbatim.
 */

import { readFileSync } from "node:fs";
import { openExchangeDir, type SwarmContext } from "./context.ts";
import { emitSuccess, SwarmError } from "./result.ts";

/** Run `swarm read-brief`: validate the brief path, emit its text. */
export function runReadBrief(ctx: SwarmContext): void {
	const d = openExchangeDir(ctx.briefPath);
	let text: string;
	try {
		text = readFileSync(d.briefPath, "utf8");
	} catch (err) {
		throw new SwarmError("E_BRIEF", `brief not readable at ${d.briefPath}: ${(err as Error).message}`);
	}
	emitSuccess("read-brief", { briefPath: d.briefPath, task: d.task, worker: ctx.worker, text });
}
