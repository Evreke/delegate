/**
 * pi-delegate — src/swarm/write-progress.ts — the `swarm write-progress` verb.
 *
 * MODULE_CONTRACT — append one progress ping to p-<worker>.jsonl next to the
 * brief, in the FROZEN ProgressEvent wire shape (src/host.ts: worker, ts,
 * phase, pct?, note?). The file is append-only JSONL — one compact JSON object
 * per line, the shape readLastProgress (src/exchange.ts) scans backwards for
 * the last valid ping. The verb name is `write-` per operator decision DV1
 * ("report" is the strict terminal-artifact noun of write-report).
 *
 * Dependencies: node:fs, node:path (dirname), ../expaths.ts (progressPathFor —
 * the ONE path builder), ../host.ts (ProgressEvent type ONLY), ./args.ts,
 * ./context.ts, ./serialize.ts, ./result.ts. No herdr adapter import.
 *
 * Critical invariants:
 *   - phase is required (E_SWARM_USAGE otherwise); pct, when given, is a
 *     0–100 number (E_SWARM_USAGE otherwise);
 *   - exactly one line is appended per invocation, always newline-terminated;
 *   - optional fields are omitted (never null) when absent.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { progressPathFor } from "../expaths.ts";
import type { ProgressEvent } from "../host.ts";
import { flagStr, type ParsedArgs } from "./args.ts";
import type { SwarmContext } from "./context.ts";
import { emitSuccess, SwarmError } from "./result.ts";
import { serializeJsonLine } from "./serialize.ts";

/** Run `swarm write-progress`: append one ping line. */
export function runWriteProgress(ctx: SwarmContext, parsed: ParsedArgs): void {
	const phase = flagStr(parsed, "phase");
	if (phase === undefined || phase.trim().length === 0) {
		throw new SwarmError("E_SWARM_USAGE", "write-progress requires --phase <label>");
	}

	const event: ProgressEvent = { worker: ctx.worker, ts: new Date().toISOString(), phase };
	const pctRaw = flagStr(parsed, "pct");
	if (pctRaw !== undefined) {
		const pct = Number(pctRaw);
		if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
			throw new SwarmError("E_SWARM_USAGE", `--pct must be a number between 0 and 100, got "${pctRaw}"`);
		}
		event.pct = pct;
	}
	const note = flagStr(parsed, "note");
	if (note !== undefined && note.length > 0) event.note = note;

	const path = progressPathFor(ctx.dir, ctx.worker);
	const line = serializeJsonLine(event);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, line, "utf8");
	} catch (err) {
		throw new SwarmError("E_SWARM_IO", `progress not appendable at ${path}: ${(err as Error).message}`);
	}
	emitSuccess("write-progress", { path, line: line.trimEnd() });
}
