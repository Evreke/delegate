/**
 * journal.js — the dashboard's journal-event fold (issue #66).
 *
 * `foldJournal(events)` reduces the journal rows the stream delivers into the
 * worker-indexed facts the dashboard renders: open asks (an `answer` clears
 * its worker's ask), dead-reboot marks (a later collect/retire closes a
 * death), the latest progress ping, and the collect/retire stamps. Pure and
 * total — a malformed row is skipped, never thrown on.
 *
 * Split out of `./state.js` (Law 5: state.js owns the node model, this module
 * owns the event fold).
 */

/** Humanize a millisecond span deterministically (no locale, no clock read). */
export function humanizeDuration(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Fold journal rows into the worker-indexed facts.
 * <p>
 * FUNCTION_CONTRACT: Input — journal rows ({seq, kind, worker, payload}).
 * Output — { asks, dead, progress, collect, retire } — Maps keyed by worker
 * name; `asks` is an open-ask map (an `answer` clears it). Total; never throws.
 */
export function foldJournal(events) {
	const asks = new Map();
	const dead = new Map();
	const progress = new Map();
	const collect = new Map();
	const retire = new Map();
	for (const e of Array.isArray(events) ? events : []) {
		if (!e || typeof e.worker !== "string" || typeof e.seq !== "number") continue;
		const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
		if (e.kind === "ask") {
			asks.set(e.worker, {
				worker: e.worker,
				question: typeof payload.question === "string" ? payload.question : "",
				context: typeof payload.context === "string" ? payload.context : null,
				options: Array.isArray(payload.options) ? payload.options.slice() : [],
				seq: e.seq,
			});
		} else if (e.kind === "answer") {
			asks.delete(e.worker);
		} else if (e.kind === "dead-reboot") {
			dead.set(e.worker, { seq: e.seq, detectedAt: payload.detectedAt ?? e.ts ?? null });
		} else if (e.kind === "collect") {
			collect.set(e.worker, { seq: e.seq, at: payload.collectedAt ?? e.ts ?? null });
		} else if (e.kind === "retire") {
			retire.set(e.worker, { seq: e.seq, at: payload.retiredAt ?? e.ts ?? null });
		} else if (e.kind === "progress") {
			progress.set(e.worker, {
				seq: e.seq,
				phase: typeof payload.phase === "string" ? payload.phase : "",
				pct: typeof payload.pct === "number" && Number.isFinite(payload.pct) ? payload.pct : null,
				note: typeof payload.note === "string" ? payload.note : null,
				ts: e.ts ?? null,
			});
		}
	}
	// A later collect/retire closes a death (the worker came back and finished).
	for (const [worker, row] of dead) {
		const closed = collect.get(worker) ?? retire.get(worker);
		if (closed && closed.seq > row.seq) dead.delete(worker);
	}
	return { asks, dead, progress, collect, retire };
}
