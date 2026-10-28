/**
 * MODULE_CONTRACT
 * journal-receipt.ts — the receipt side-table writer of the journal module
 * family (`src/swarm/journal*.ts`): the closed receipt set, the receipt
 * contract, and the single-statement receipt append under the shared bounded
 * busy-retry.
 *
 * Why a own file: Law 5 (the 400-line decomposition ledger). Receipts are the
 * store design's G2 machinery — durable per-audience delivery/consume facts
 * ABOUT message rows (never message content, Law 9). The delivery axis
 * (watcher, mailbox) appends `delivered`/`consumed`/`failed` receipts through
 * this module; the message verbs append the sender's `sent` receipt.
 *
 * Writer authority (the store design §3, enforced HERE in code, not
 * convention): a receipt's writer-owned key is the writing process's OWN
 * session id — `writerSession` must equal `audienceSession`, else the append
 * refuses with E_JOURNAL_FORBIDDEN. Only the audience that sent, received,
 * consumed or failed a message records that fact.
 *
 * Dependencies: the driver TYPE only, the ClockPort type, and the shared
 * retry protocol (./journal-retry.ts). The failure-code union is imported
 * TYPE-ONLY from ./journal.ts (erased at runtime — the runtime import graph
 * stays acyclic: journal → journal-receipt → journal-retry). No herdr
 * adapter import (Law 4).
 *
 * Critical invariants:
 *   - the receipt set is closed (`sent` | `delivered` | `consumed` | `failed`,
 *     additive-only); an unknown state is refused, not stored;
 *   - the append is a short single-statement transaction under the bounded
 *     busy-retry (§4.1.2 cross-process rule);
 *   - total by contract: no path throws — every failure is a structured
 *     result (Law 8).
 */

import type { JournalDb } from "./journal-driver.ts";
import type { ClockPort } from "../clock.ts";
import { errorMessage, isBusyError, runWithBusyRetry, type JournalRetryOptions } from "./journal-retry.ts";
import type { JournalFailureCode } from "./journal.ts";

/** The closed receipt set (the store design §2 `message_receipts.receipt`).
 *  Additive-only: a new receipt state joins by addition, never rename. */
export const JOURNAL_RECEIPTS = ["sent", "delivered", "consumed", "failed"] as const;

export type JournalReceipt = (typeof JOURNAL_RECEIPTS)[number];

const JOURNAL_RECEIPT_SET: ReadonlySet<string> = new Set(JOURNAL_RECEIPTS);

/** One receipt fact to append. `writerSession` is the writing process's OWN
 *  session id — the API refuses (E_JOURNAL_FORBIDDEN) a receipt whose
 *  `audienceSession` is not exactly it (only the audience that sent, received,
 *  consumed or failed a message records that fact; store design §3). */
export interface JournalReceiptInput {
	/** The message row (events.seq) this fact is about. */
	msgSeq: number;
	/** WHICH console/session the fact is about (delivery is per-console). */
	audienceSession: string;
	receipt: JournalReceipt;
	/** Writer's own session id (the enforced writer-owned key). */
	writerSession: string;
	/** Override the stamped ts (tests); default the writer clock. */
	ts?: string;
	/** Failure text for `failed`; a transport note otherwise. */
	detail?: string | null;
}

export interface JournalReceiptSuccess {
	ok: true;
}

export interface JournalReceiptFailure {
	ok: false;
	code: JournalFailureCode;
	error: string;
	attempts: number;
}

export type JournalReceiptResult = JournalReceiptSuccess | JournalReceiptFailure;

/** The single-statement receipt append (bound params, never interpolated). */
const INSERT_RECEIPT_SQL =
	"INSERT INTO message_receipts(msg_seq, audience_session, receipt, ts, writer_session, detail) VALUES (?, ?, ?, ?, ?, ?)";

/**
 * Append one receipt fact for a message row.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: db — the OPEN journal database; input — the receipt fact;
 *   ctx — the injected clock/rng/retry protocol
 * Output: a structured result ({ok:true} or a coded failure)
 * Guarantees:
 *   - the closed receipt set and the writer-owned key are enforced HERE
 *     (E_JOURNAL_KIND / E_JOURNAL_FORBIDDEN) — before any statement runs;
 *   - the insert is a single statement under the bounded busy-retry;
 *   - total: never throws (a driver failure is E_JOURNAL_BUSY/E_JOURNAL_WRITE)
 * Raises: never
 */
export async function appendReceiptTo(
	db: JournalDb,
	input: JournalReceiptInput,
	ctx: { clock: ClockPort; rng: () => number; retry: Required<JournalRetryOptions> },
): Promise<JournalReceiptResult> {
	try {
		if (!JOURNAL_RECEIPT_SET.has(input.receipt)) {
			return {
				ok: false,
				code: "E_JOURNAL_KIND",
				error: `unknown journal receipt: ${String(input.receipt)}`,
				attempts: 0,
			};
		}
		// Writer authority (store design §3): only the audience that sent,
		// received, consumed or failed a message records that fact — the
		// writing process's own session id must equal the receipt's subject.
		if (input.audienceSession !== input.writerSession) {
			return {
				ok: false,
				code: "E_JOURNAL_FORBIDDEN",
				error: "receipt writer-owned key refused: writer_session must equal audience_session",
				attempts: 0,
			};
		}
		const ts = input.ts ?? new Date(ctx.clock.now()).toISOString();
		const detail = input.detail === undefined ? null : input.detail;
		const run = await runWithBusyRetry(
			() =>
				db.run(INSERT_RECEIPT_SQL, [
					Math.floor(Number(input.msgSeq)),
					input.audienceSession,
					input.receipt,
					ts,
					input.writerSession,
					detail,
				]),
			ctx,
		);
		if (run.ok) return { ok: true };
		const busy = isBusyError(run.lastError);
		return {
			ok: false,
			code: busy ? "E_JOURNAL_BUSY" : "E_JOURNAL_WRITE",
			error: errorMessage(run.lastError),
			attempts: run.attempts,
		};
	} catch (e) {
		// Structural advisory guarantee: no path out of appendReceiptTo() throws.
		return {
			ok: false,
			code: "E_JOURNAL_WRITE",
			error: errorMessage(e),
			attempts: 0,
		};
	}
}
