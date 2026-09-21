/**
 * pi-delegate — src/swarm/events.ts — the `swarm events` orchestrator-side
 * read verb (issue #30, ARCHITECTURE §4.1.1/§4.1.2/Law 13).
 *
 * MODULE_CONTRACT — the incremental event-feed half of the read API: expose
 * the journal cursor reader `eventsAfter(cursor)` verbatim (§4.1.2: "swarm
 * events --after <seq> exposes this reader verbatim"). The stdout payload is
 * the success envelope (./result.ts) carrying the FROZEN v1 events contract:
 *
 *   { ok, verb: "events", schemaVersion, after, events[], journal{count,dbSizeBytes} }
 *
 *   - schemaVersion  — SWARM_EVENTS_SCHEMA_VERSION (Law 7; additive-only)
 *   - after          — the effective integer cursor (seq > after is returned;
 *                      a negative argument clamps to 0)
 *   - events[]       — journal rows verbatim ({seq, ts, kind, sessionId,
 *                      task, worker, payload} — ./journal-read.ts mapRow)
 *   - journal.count  — total rows in the database (DP7 retention visibility,
 *                      §4.1.2: surfaced through the read API, not just files)
 *   - journal.dbSizeBytes — the events.db file size in bytes (DP7)
 *
 * Identity: NONE required — this is an orchestrator-side read, not a worker
 * verb, so there is no SWARM_TASK/SWARM_WORKER gate (§4.1.1; the decision is
 * the #30 issue's). Bad flags still fail structured: a missing or non-integer
 * --after is E_SWARM_USAGE, never a silent default.
 *
 * Law 8 (never crashes): every journal read goes through the total reader —
 * an absent/corrupt/future-version database yields events: [] and
 * journal {count: 0, dbSizeBytes: 0} (a valid snapshot of an empty journal,
 * exit 0), never an E_* failure. The only failures are usage failures.
 *
 * Dependencies: ./args.ts (flagStr), ./journal-read.ts (the reader),
 * ./result.ts, ./storage.ts (the ONE db-path override spelling:
 * SWARM_JOURNAL_DB via resolveSwarmStorage). No herdr import (Law 4); no
 * sqlite driver import (the journal module family owns that seam).
 *
 * Critical invariants:
 *   - exactly one JSON object on stdout (the success envelope);
 *   - the reader is closed on every path (finally);
 *   - zero writes: the verb opens the journal read-only and appends nothing.
 */

import { flagStr, type ParsedArgs } from "./args.ts";
import { createJournalReader } from "./journal-read.ts";
import { emitSuccess, SwarmError } from "./result.ts";
import { resolveSwarmStorage } from "./storage.ts";

/** The events envelope's contract version (Law 7; additive-only evolution). */
export const SWARM_EVENTS_SCHEMA_VERSION = 1;

/**
 * Parse the --after cursor.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: raw — the --after flag value (undefined when absent)
 * Output: the effective non-negative integer cursor
 * Guarantees: absent → E_SWARM_USAGE (the cursor is the verb's one required
 *   input; a UI wanting everything passes --after 0); non-integer →
 *   E_SWARM_USAGE; a negative integer clamps to 0 (seq > -N ≡ seq > 0)
 * Raises: SwarmError E_SWARM_USAGE
 */
export function parseAfterCursor(raw: string | undefined): number {
	if (raw === undefined) {
		throw new SwarmError(
			"E_SWARM_USAGE",
			"events requires --after <seq> (the last consumed journal seq; pass 0 for all rows)",
		);
	}
	const trimmed = raw.trim();
	if (!/^-?\d+$/.test(trimmed)) {
		throw new SwarmError("E_SWARM_USAGE", `--after must be an integer journal seq cursor, got ${JSON.stringify(raw)}`);
	}
	return Math.max(0, Math.floor(Number(trimmed)));
}

/**
 * Run `swarm events --after <seq>`: emit the rows after the cursor plus the
 * DP7 retention envelope. Total on the journal side (Law 8) — see MODULE_CONTRACT.
 */
export function runEvents(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): void {
	const cursor = parseAfterCursor(flagStr(parsed, "after"));
	const cfg = resolveSwarmStorage(env);
	const reader = createJournalReader({ dbPath: cfg.dbPath });
	try {
		emitSuccess("events", {
			schemaVersion: SWARM_EVENTS_SCHEMA_VERSION,
			after: cursor,
			events: reader.eventsAfter(cursor),
			journal: { count: reader.count(), dbSizeBytes: reader.dbSizeBytes() },
		});
	} finally {
		reader.close();
	}
}
