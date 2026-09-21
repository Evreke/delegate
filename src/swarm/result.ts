/**
 * pi-delegate — src/swarm/result.ts — the swarm CLI result/error envelope.
 *
 * MODULE_CONTRACT — the worker-verb RESULT CONTRACT (ARCHITECTURE.md §4.1.1,
 * Law 8): a verb succeeds with exit 0 plus a JSON result on stdout, and fails
 * with a non-zero exit plus a structured stdout error carrying an E_* code and
 * a recovery hint. This module owns that envelope, the CLI's error class and
 * the E_* taxonomy ADDITION the verbs need.
 *
 * Taxonomy addition (never redefinition): the three existing seam codes the
 * verbs reuse keep their host.ts meaning — E_BRIEF (brief unreadable/invalid),
 * E_NAME (worker-name shape), E_REPORT_INVALID (report fails validation). The
 * four new codes are CLI-local by design: this is a separate bun process, not
 * a tool result, so the union in src/host.ts is deliberately untouched. They
 * join the E_* taxonomy by addition and are named E_SWARM_* to keep the
 * process boundary visible:
 *   - E_SWARM_USAGE    — malformed invocation (unknown verb, missing flag value)
 *   - E_SWARM_IDENTITY — SWARM_TASK/SWARM_WORKER absent and not overridden
 *   - E_SWARM_SCHEMA   — the brief-declared report schema did not resolve
 *   - E_SWARM_IO       — a filesystem read/write failed
 *
 * Dependencies: node:process ONLY (bottom of the swarm graph — never imports
 * another src/ module, so the envelope stays a leaf).
 *
 * Critical invariants:
 *   - every failure carries a non-empty hint (the recovery sentence a worker
 *     model can act on);
 *   - stdout carries EXACTLY ONE JSON object per invocation (machine-readable;
 *     diagnostics never mix into it);
 *   - the failure object's `ok:false` is the single discriminator.
 */

/** E_* codes the swarm CLI can emit. Existing seam codes are reused with
 *  their host.ts meaning; E_SWARM_* codes are this process's additions. */
export type SwarmErrorCode =
	| "E_BRIEF"
	| "E_NAME"
	| "E_REPORT_INVALID"
	| "E_SWARM_USAGE"
	| "E_SWARM_IDENTITY"
	| "E_SWARM_SCHEMA"
	| "E_SWARM_IO";

/** Recovery hints (the CLI's own guidance table — the seam dictionary in
 *  src/host.ts stays the tool-side source; this process is not a tool). */
export const SWARM_GUIDANCE: Record<SwarmErrorCode, string> = {
	E_BRIEF: "Fix the brief path or its content, then retry the verb.",
	E_NAME: "Use a canonical worker name: [a-z][a-z0-9_-]{0,31}.",
	E_REPORT_INVALID: "Fix the report JSON so it satisfies the base report contract and the brief-declared schema, then retry write-report.",
	E_SWARM_USAGE: "Run the swarm CLI with a known verb and the flags that verb requires.",
	E_SWARM_IDENTITY: "Export SWARM_TASK and SWARM_WORKER (set by the spawn flow), or pass --task/--worker as an explicit override.",
	E_SWARM_SCHEMA: "Fix the brief's reportSchema declaration (or the schema-library file it names), then retry write-report.",
	E_SWARM_IO: "Check the exchange dir exists and is writable, then retry the verb.",
};

/** A structured verb failure. Verbs throw it; the CLI entry renders it as the
 *  stdout error object and exits non-zero. */
export class SwarmError extends Error {
	readonly code: SwarmErrorCode;
	readonly hint: string;

	constructor(code: SwarmErrorCode, message: string, hint?: string) {
		super(message);
		this.name = "SwarmError";
		this.code = code;
		this.hint = hint ?? SWARM_GUIDANCE[code];
	}
}

/** Emit the success envelope: one JSON object + newline on stdout. */
export function emitSuccess(verb: string, fields: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ ok: true, verb, ...fields })}\n`);
}

/** Emit the failure envelope: one JSON object + newline on stdout. */
export function emitFailure(verb: string | null, error: SwarmError): void {
	process.stdout.write(
		`${JSON.stringify({ ok: false, verb, error: { code: error.code, message: error.message, hint: error.hint } })}\n`,
	);
}
