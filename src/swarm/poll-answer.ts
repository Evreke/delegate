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
 * The reader is tolerant by contract: absent/unreadable → absent, torn or
 * corrupt JSON → invalid, wrong/future schemaVersion → invalid (never a
 * misparse). The answer file is NOT consumed or deleted — the report's mtime
 * postdating the answer is the extension's consume rule (src/exchange.ts).
 *
 * Dependencies: node:fs, ../expaths.ts (answerPathFor — the ONE path builder),
 * ../manifest-store.ts (schema-version gate), ../host.ts (AnswerEnvelope type
 * ONLY), ./args.ts, ./context.ts, ./result.ts. No herdr adapter import.
 *
 * Critical invariants:
 *   - never throws for a missing/corrupt answer (that is a state, not an
 *     error); only an invalid numeric flag is E_SWARM_USAGE;
 *   - the poll loop is bounded by the deadline (no unbounded wait).
 */

import { readFileSync } from "node:fs";
import { answerPathFor } from "../expaths.ts";
import type { AnswerEnvelope } from "../host.ts";
import { EXCHANGE_SCHEMA_VERSION, isSupportedSchemaVersion } from "../manifest-store.ts";
import { flagStr, type ParsedArgs } from "./args.ts";
import type { SwarmContext } from "./context.ts";
import { emitSuccess, SwarmError } from "./result.ts";

/** The result-plane read of an answer file. */
export type AnswerRead =
	| { state: "absent" }
	| { state: "invalid"; error: string }
	| { state: "valid"; answer: AnswerEnvelope };

/** Synchronous bounded sleep (Atomics on a throwaway buffer). */
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Tolerant answer-file read (never throws). */
export function readAnswerFile(path: string): AnswerRead {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { state: "absent" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { state: "invalid", error: `not valid JSON (${(err as Error).message})` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { state: "invalid", error: "JSON is not an answer envelope" };
	}
	const o = parsed as Record<string, unknown>;
	if (!isSupportedSchemaVersion(o.schemaVersion)) {
		return {
			state: "invalid",
			error: `unsupported answer envelope schemaVersion (${String(o.schemaVersion)} — this build reads version ${EXCHANGE_SCHEMA_VERSION})`,
		};
	}
	if (o.from !== "orchestrator" || typeof o.ts !== "string" || typeof o.answer !== "string") {
		return { state: "invalid", error: "JSON is not an answer envelope (from, ts and answer are expected)" };
	}
	return { state: "valid", answer: parsed as AnswerEnvelope };
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
