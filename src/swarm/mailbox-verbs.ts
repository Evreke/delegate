/**
 * pi-delegate — src/swarm/mailbox-verbs.ts — the shared orchestrator
 * steer/answer core (issue #51, ARCHITECTURE §4.2.4, Law 4/6/8/11).
 *
 * MODULE_CONTRACT — the ONE implementation of the two orchestrator-side
 * mailbox mutations the session-hosted server exposes over HTTP:
 *
 *   steer  → an a-<name>.json envelope + a `steer` journal row
 *   answer → an a-<name>.json envelope + the pending-question archive +
 *            an `answer` journal row
 *
 * It is NOT a reimplementation: the envelope write, the console nudge, the
 * nudge-failed marker machinery and the question archive all go through
 * src/mailbox-store.ts's ONE posting core (postSteerAndNudge + archiveQuestion,
 * the functions the delegate_mailbox tool and the watcher already share).
 * The HTTP route and the tool therefore produce byte-identical mailbox files
 * (Law 9: one artifact, one implementation). The additive difference is the
 * journaling: every successful mutation appends its journal row through
 * ./storage.ts's appendSwarmEvent (the verb plumbing — the journal is the
 * truth, so a mutation that skipped it would be the write-path bypass #51
 * acceptance 6 forbids).
 *
 * Ownership gate (fail-closed, Law 8): the worker id resolves ONLY to a
 * worker whose manifest entry proves this session as owner
 * (src/watch-role.ts workerAudienceMatch — "mine"); a foreign or unknown id
 * refuses with E_SWARM_FORBIDDEN and is structurally incapable of writing a
 * mailbox file. The server never learns whether the id exists elsewhere.
 *
 * Ordering: the envelope is written/published FIRST and the journal row is
 * appended AFTER (the `report` kind precedent — the journal never announces
 * an unpublished artifact). The journal append is advisory (Law 8): in
 * "files" storage mode appendSwarmEvent returns null and no row is written,
 * exactly like every other verb (§4.1.3 — the Phase A/B truth switch is
 * untouched by this surface). The success envelope states HOW the mutation
 * confirms (#62 item 1): `confirmation: "confirmed"` when the journal row is
 * durably appended, `"unavailable"` in files mode (no row exists to wait
 * for — the client renders "delivered" honestly) or on an advisory append
 * failure.
 *
 * Dependencies: ../host.ts (Transport type via ../mailbox-store.ts's
 * SteerTransport), ../watch-role.ts (the canonical ownership verdict),
 * ../mailbox-store.ts (the ONE posting core + archive), ./storage.ts (the
 * verb journal plumbing). No herdr adapter import (Law 4); no sqlite driver
 * import (the journal module family owns that seam).
 *
 * Critical invariants:
 *   - total: every path returns a structured outcome; a write/nudge failure
 *     is an E_* result, never a throw into the HTTP core (Law 8);
 *   - fail-closed ownership: only a proven "mine" verdict mutates anything;
 *   - journal payload: {text} plus the additive {via} marker;
 *   - the operator token never appears in a payload, response or log.
 */

import { basename } from "node:path";
import {
	answerPathFor,
	archiveQuestion,
	postSteerAndNudge,
	writeAnswer,
	type SteerTransport,
} from "../mailbox-store.ts";
import { workerAudienceMatch, type OwnerFields, type SessionIdentity } from "../watch-role.ts";
import { appendSwarmEvent, type SwarmJournalOutcome } from "./storage.ts";

/** The manifest slice the ownership gate reads (untyped JSON at the edge). */
export interface OrchestratorVerbManifest {
	task?: unknown;
	dir?: unknown;
	masterSessionPath?: unknown;
	workers?: unknown;
}

/** Injected inputs of the mutation core. */
export interface OrchestratorVerbDeps {
	/** The read-model's manifest rows (the server's manifestSource scan). */
	manifests: ReadonlyArray<OrchestratorVerbManifest | null | undefined>;
	/** This session's identity (sessionFile is the ownership proof). */
	self: SessionIdentity;
	/** The session Transport's status/nudge half; absent → no console nudge,
	 *  the envelope is still posted (degraded-but-honest, Law 8). */
	transport?: Partial<SteerTransport>;
	/** Process environment (journal config/test hooks). */
	env?: NodeJS.ProcessEnv;
	/** Additive journal payload marker (the HTTP surface passes "http"). */
	via?: string;
}

export type OrchestratorVerbKind = "steer" | "answer";

export interface OrchestratorVerbRequest {
	kind: OrchestratorVerbKind;
	worker: string;
	text: string;
}

export interface OrchestratorVerbSuccess {
	ok: true;
	kind: OrchestratorVerbKind;
	worker: string;
	/** The task dir the mailbox file was written to. */
	dir: string;
	/** The posted a-<name>.json path. */
	answerPath: string;
	/** The journal outcome: null in files mode, else {seq} or {error}. */
	journal: SwarmJournalOutcome | null;
	/** How this mutation confirms (#62 item 1): "confirmed" when the journal
	 *  row is durably appended; "unavailable" when no journal row exists or
	 *  the advisory append failed (files mode per §4.1.3, or an error). */
	confirmation: "confirmed" | "unavailable";
	/** True when the console nudge was accepted (never on the no-transport path). */
	nudged: boolean;
	/** Human-readable nudge/outcome note ("" on the plain path). */
	note: string;
}

export interface OrchestratorVerbFailure {
	ok: false;
	code: string;
	message: string;
	hint: string;
}

export type OrchestratorVerbOutcome = OrchestratorVerbSuccess | OrchestratorVerbFailure;

/** A resolved owned target (the task dir + task name of the manifest row). */
interface OwnedTarget {
	dir: string;
	task: string;
}

function nonEmpty(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Resolve a worker id to a manifest row THIS session provably owns.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: manifests — the read-model's manifest rows; self — this session's
 *   identity; worker — the canonical worker name
 * Output: the target {dir, task} of the first row whose worker entry proves
 *   this session as owner ("mine"), or null (foreign, no-owner, no-self-id,
 *   unknown id, malformed rows)
 * Guarantees: total (tolerant of garbage rows); fail-closed — only the
 *   canonical "mine" verdict resolves; the shadow row of a foreign fleet
 *   never wins
 * Raises: never
 */
export function resolveOwnedTarget(
	manifests: ReadonlyArray<OrchestratorVerbManifest | null | undefined>,
	self: SessionIdentity,
	worker: string,
): OwnedTarget | null {
	for (const m of manifests ?? []) {
		if (m === null || typeof m !== "object") continue;
		const workers = m.workers;
		if (!Array.isArray(workers)) continue;
		for (const w of workers) {
			if (w === null || typeof w !== "object") continue;
			const entry = w as Record<string, unknown>;
			if (entry.name !== worker) continue;
			const fields: OwnerFields = {
				orchestratorSessionPath: nonEmpty(entry.orchestratorSessionPath),
				masterSessionPath: nonEmpty(m.masterSessionPath),
			};
			if (workerAudienceMatch(fields, self, { legacyFailOpen: false }) !== "mine") continue;
			const dir = nonEmpty(m.dir);
			if (dir === undefined) continue;
			return { dir, task: nonEmpty(m.task) ?? basename(dir) };
		}
	}
	return null;
}

/**
 * Run one orchestrator mailbox mutation: ownership gate → envelope
 * (postSteerAndNudge, the tool's core) → journal row.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — manifests/self/transport/env/via; req — kind + worker + text
 * Output: a structured success (path/journal/nudge) or a structured refusal
 * Guarantees:
 *   - fail-closed: a worker this session does not provably own → E_SWARM_FORBIDDEN
 *     with NO filesystem effect;
 *   - the a-file write goes through the SAME writeAnswer core as the tool
 *     (byte-identical mailbox format);
 *   - an `answer` archives the pending question after the envelope lands;
 *   - the journal row is appended after the publish ({text, via});
 *   - never throws (a write failure is E_SWARM_IO)
 * Raises: never
 */
export async function runOrchestratorVerb(
	deps: OrchestratorVerbDeps,
	req: OrchestratorVerbRequest,
): Promise<OrchestratorVerbOutcome> {
	const target = resolveOwnedTarget(deps.manifests, deps.self, req.worker);
	if (target === null) {
		return {
			ok: false,
			code: "E_SWARM_FORBIDDEN",
			// Id-free by design: a foreign id and an unknown id refuse with the
			// SAME body, so the gate never leaks whether an id exists elsewhere.
			message: "the worker id is not owned by this session",
			hint: "The mutation surface only reaches workers this session spawned; check the id or use the delegate_mailbox tool.",
		};
	}

	const t = deps.transport;
	const canNudge = typeof t?.getStatus === "function" && typeof t?.submitPrompt === "function";
	let answerPath: string;
	let nudged = false;
	let note = "";
	try {
		if (canNudge) {
			const steer = await postSteerAndNudge(
				t as SteerTransport,
				req.worker,
				target.dir,
				req.text,
				req.kind === "answer"
					? { afterPost: async () => { await archiveQuestion(target.dir, req.worker); } }
					: {},
			);
			answerPath = steer.answerPath;
			nudged = steer.nudged;
			note = steer.note;
		} else {
			// Degraded path (no console nudge available): still the ONE atomic
			// writer, so the mailbox bytes match the tool's exactly.
			answerPath = answerPathFor(target.dir, req.worker);
			await writeAnswer(answerPath, req.text);
			if (req.kind === "answer") await archiveQuestion(target.dir, req.worker);
		}
	} catch (err) {
		return {
			ok: false,
			code: "E_SWARM_IO",
			message: `mailbox write failed: ${err instanceof Error ? err.message : String(err)}`,
			hint: "The exchange dir may be unwritable; retry or use the delegate_mailbox tool.",
		};
	}

	const payload =
		deps.via === undefined || deps.via.length === 0
			? { text: req.text }
			: { text: req.text, via: deps.via };
	const journal = await appendSwarmEvent(
		{ task: target.task, worker: req.worker, dir: target.dir },
		req.kind,
		payload,
		deps.env ?? process.env,
	);
	// The journal append is advisory (Law 8) — the envelope is already
	// published either way. "confirmed" only when a row exists to confirm
	// against; "unavailable" is the honest files-mode answer (§4.1.3: the
	// journal receives no production writes in Phase A) and also covers an
	// advisory append failure (no row → no journal event will ever arrive).
	const confirmation: "confirmed" | "unavailable" =
		journal !== null && "seq" in journal ? "confirmed" : "unavailable";

	return {
		ok: true,
		kind: req.kind,
		worker: req.worker,
		dir: target.dir,
		answerPath,
		journal,
		confirmation,
		nudged,
		note,
	};
}
