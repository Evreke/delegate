/**
 * cursor.js — the dashboard's persisted read cursor (#66, #88).
 *
 * The last seen journal seq lives in sessionStorage (the documented cursor
 * store — pin T1.22) so a reload resumes the stream where the tab left off.
 * Split out of app.js (Law 5 size cap); total and pure, best-effort writes
 * (private-mode storage may throw and never breaks page start).
 */

const STORAGE_KEY = "swarm.dashboard.lastSeq";

/** Read the persisted cursor (sessionStorage only — the documented store). */
export function readCursor(storage) {
	try {
		const raw = storage ? storage.getItem(STORAGE_KEY) : null;
		const n = Number(raw);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

/** Persist the cursor (best effort — private-mode storage may throw). */
export function writeCursor(storage, seq) {
	try {
		if (storage) storage.setItem(STORAGE_KEY, String(seq));
	} catch {
		/* persistence is best effort */
	}
}
