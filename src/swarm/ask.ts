/**
 * pi-delegate — src/swarm/ask.ts — the `swarm ask` verb.
 *
 * MODULE_CONTRACT — write the worker's pending question to q-<worker>.json
 * next to the brief, in the FROZEN QuestionEnvelope wire shape
 * (src/host.ts: worker, ts, question, context?, options?). The file is written
 * through the extension's ONE atomic writer (atomicWriteFileSync) with the
 * frozen JSON-file serialization, so a verb-written question is byte-identical
 * to one the extension itself would write. The answer arrives in
 * a-<worker>.json (see poll-answer).
 *
 * Phase B (issue #23, §4.1.3): under `swarm.storage: "journal"` the verb
 * appends the journal event (kind `ask`, payload = the QuestionEnvelope
 * verbatim) BEFORE writing the file projection; the append is advisory
 * (Law 8) and surfaces in the success envelope's `journal` field.
 *
 * Dependencies: node:fs, ../expaths.ts (questionPathFor — the ONE path
 * builder), ../manifest-store.ts (atomicWriteFileSync — the ONE atomic writer),
 * ../host.ts (QuestionEnvelope type ONLY), ./args.ts, ./context.ts,
 * ./serialize.ts, ./result.ts. No herdr adapter import.
 *
 * Critical invariants:
 *   - the question text is required (E_SWARM_USAGE otherwise);
 *   - the envelope is stamped with the CLI's clock and the canonical worker
 *     name; optional context/options are omitted (never null) when absent;
 *   - no schemaVersion field is stamped: the question envelope's frozen v1
 *     wire shape predates the versioned a-/release- writers, and readers
 *     tolerate its absence as legacy v1.
 */

import { mkdirSync } from "node:fs";
import { questionPathFor } from "../expaths.ts";
import type { QuestionEnvelope } from "../host.ts";
import { atomicWriteFileSync } from "../manifest-store.ts";
import { flagList, flagStr, type ParsedArgs } from "./args.ts";
import type { SwarmContext } from "./context.ts";
import { emitSuccess, SwarmError } from "./result.ts";
import { serializeJsonFile } from "./serialize.ts";
import { appendSwarmEvent, verbTimestamp } from "./storage.ts";

/** Collect the question's option list from repeated --option and the
 *  comma-separated --options twin (empty entries dropped). */
function collectOptions(parsed: ParsedArgs): string[] {
	const raw = [...flagList(parsed, "option")];
	const csv = flagStr(parsed, "options");
	if (csv !== undefined) raw.push(...csv.split(","));
	return raw.map((o) => o.trim()).filter((o) => o.length > 0);
}

/** Run `swarm ask`: journal event first (journal mode), then the
 *  pending-question envelope atomically (the byte-frozen projection). */
export async function runAsk(ctx: SwarmContext, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<void> {
	const question = flagStr(parsed, "question");
	if (question === undefined || question.trim().length === 0) {
		throw new SwarmError("E_SWARM_USAGE", "ask requires --question <text>");
	}

	const envelope: QuestionEnvelope = {
		worker: ctx.worker,
		ts: verbTimestamp(env),
		question,
	};
	const context = flagStr(parsed, "context");
	if (context !== undefined && context.length > 0) envelope.context = context;
	const options = collectOptions(parsed);
	if (options.length > 0) envelope.options = options;

	// Phase B ordering (§4.1.3): journal = truth, appended FIRST; the file is
	// the projection. A journal failure is advisory (Law 8) — the projection
	// write below proceeds regardless.
	const journal = await appendSwarmEvent({ task: ctx.task, worker: ctx.worker, dir: ctx.dir }, "ask", envelope, env);

	const path = questionPathFor(ctx.dir, ctx.worker);
	const content = serializeJsonFile(envelope);
	try {
		mkdirSync(ctx.dir, { recursive: true });
		atomicWriteFileSync(path, content);
	} catch (err) {
		throw new SwarmError("E_SWARM_IO", `question not writable at ${path}: ${(err as Error).message}`);
	}
	emitSuccess("ask", { path, bytes: Buffer.byteLength(content, "utf8"), ...(journal ? { journal } : {}) });
}
