/**
 * MODULE_CONTRACT
 * journal-retry.ts — the bounded SQLITE_BUSY retry protocol of the journal
 * module family (`src/swarm/journal*.ts`): the retry options, the bounded
 * jittered backoff, the busy-error classification, and the ONE retry loop
 * shared by every write operation (the event append and the receipt append).
 *
 * Why a own file: Law 5 (the 400-line decomposition ledger) and Law 9 (one
 * spelling): the §4.1.2 cross-process rule — `busy_timeout = 5000` ms plus a
 * bounded backoff-plus-jitter retry — is written ONCE and imported by every
 * writer operation, never re-implemented per call site.
 *
 * Dependencies: the ClockPort type only (the delay injection). No driver
 * import, no herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - the retry is BOUNDED: `attempts` caps the loop; the delay is capped by
 *     `maxMs` (pinned by journal-check J8.1);
 *   - only busy-shaped errors retry (SQLITE_BUSY / SQLITE_LOCKED / the
 *     "database is locked" message); anything else fails on the first try;
 *   - the loop never throws — the caller classifies the last error.
 */

import type { ClockPort } from "../clock.ts";

/** Bounded SQLITE_BUSY retry budget: attempts, base/exponential ms, and max ms. */
export interface JournalRetryOptions {
	attempts?: number;
	baseMs?: number;
	maxMs?: number;
}

export const JOURNAL_RETRY_DEFAULTS: Required<JournalRetryOptions> = {
	attempts: 4,
	baseMs: 20,
	maxMs: 400,
};

/**
 * Bounded jittered backoff for attempt index `attempt` (0-based).
 * FUNCTION_CONTRACT: Input — attempt, rng (jitter in [0,1)), opts. Output —
 * a delay in [0, maxMs]. Pure given rng; never throws.
 */
export function journalBackoffMs(
	attempt: number,
	rng: () => number = Math.random,
	opts: JournalRetryOptions = {},
): number {
	const base = opts.baseMs ?? JOURNAL_RETRY_DEFAULTS.baseMs;
	const max = opts.maxMs ?? JOURNAL_RETRY_DEFAULTS.maxMs;
	const cap = Math.min(max, base * 2 ** Math.max(0, attempt));
	const jitter = 0.5 + 0.5 * Math.min(1, Math.max(0, rng()));
	return Math.max(0, Math.floor(cap * jitter));
}

/** Normalize any thrown value into a message string. */
export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return typeof e === "string" ? e : JSON.stringify(e);
}

/** Busy-shaped errors (the only ones worth retrying) — driver-code first,
 *  message fallback second. */
export function isBusyError(e: unknown): boolean {
	const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
	if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
	return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(errorMessage(e));
}

/** The ONE retry loop (§4.1.2): run `op` under the bounded jittered backoff.
 *  Never throws; the caller classifies `lastError` (busy vs write). */
export async function runWithBusyRetry<T>(
	op: () => T,
	ctx: { clock: ClockPort; rng: () => number; retry: Required<JournalRetryOptions> },
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; lastError: unknown; attempts: number }> {
	let lastError: unknown = null;
	let attempts = 0;
	for (let attempt = 0; attempt < ctx.retry.attempts; attempt++) {
		attempts = attempt + 1;
		try {
			return { ok: true, value: op(), attempts };
		} catch (e) {
			lastError = e;
			if (!isBusyError(e) || attempt >= ctx.retry.attempts - 1) break;
			await ctx.clock.delay(journalBackoffMs(attempt, ctx.rng, ctx.retry));
		}
	}
	return { ok: false, lastError, attempts };
}
