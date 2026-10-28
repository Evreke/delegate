/**
 * pi-delegate — src/swarm/poll-answer.ts — the `swarm poll-answer` verb.
 *
 * MODULE_CONTRACT — read the orchestrator's answer a-<worker>.json next to the
 * brief. One read by default; `--wait <ms>` polls at `--interval <ms>` until an
 * answer lands or the deadline passes (bounded, synchronous — the verb is a
 * one-shot process the worker re-invokes between steps). Three read states are
 * reported, mirroring the mailbox store's result-plane rule: ABSENT (no usable
 * answer yet), INVALID (a file exists but is corrupt / not an answer envelope),
 * VALID (the parsed envelope). All three exit 0 — the read itself succeeded and
 * the state is the result the worker acts on.
 *
 * The reader is tolerant by contract (readAnswerFile, src/mailbox-store.ts —
 * the ONE answer-envelope read): absent/unreadable → absent, torn or corrupt
 * JSON → invalid, wrong/future schemaVersion → invalid (never a misparse).
 * The answer file is NOT consumed or deleted — the report's mtime postdating
 * the answer is the extension's consume rule (src/exchange.ts).
 *
 * Dependencies: ../expaths.ts (answerPathFor — the ONE path builder),
 * ../mailbox-store.ts (readAnswerFile — the ONE tolerant answer read),
 * ./args.ts, ./context.ts, ./result.ts. No herdr adapter import.
 *
 * Critical invariants:
 *   - never throws for a missing/corrupt answer (that is a state, not an
 *     error); only an invalid numeric flag is E_SWARM_USAGE;
 *   - the poll loop is bounded by the deadline (no unbounded wait).
 */

import { answerPathFor } from "../expaths.ts";
import { readAnswerFile, type AnswerRead } from "../mailbox-store.ts";
import { flagStr, type ParsedArgs } from "./args.ts";
import type { SwarmContext } from "./context.ts";
import { emitSuccess, SwarmError } from "./result.ts";

/** Synchronous bounded sleep (Atomics on a throwaway buffer). */
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Parse a non-negative integer flag, or E_SWARM_USAGE. */
function intFlag(parsed: ParsedArgs, key: string, fallback: number): number {
	const raw = flagStr(parsed, key);
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		throw new SwarmError("E_SWARM_USAGE", `--${key} must be a non-negative number, got "${raw}"`);
	}
	return n;
}

/** Run `swarm poll-answer`. */
export function runPollAnswer(ctx: SwarmContext, parsed: ParsedArgs): void {
	const waitMs = intFlag(parsed, "wait", 0);
	const intervalMs = intFlag(parsed, "interval", 500);
	const path = answerPathFor(ctx.dir, ctx.worker);
	const deadline = Date.now() + waitMs;

	for (;;) {
		const read = readAnswerFile(path);
		if (read.state !== "absent") {
			emitSuccess("poll-answer", { answerPath: path, ...read });
			return;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			emitSuccess("poll-answer", { answerPath: path, state: "absent" });
			return;
		}
		sleepSync(Math.min(intervalMs, remaining));
	}
}
