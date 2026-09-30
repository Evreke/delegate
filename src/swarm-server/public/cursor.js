/**
 * cursor.js — the dashboard's reconnect-cursor store (issue #66/#88).
 *
 * Extracted from app.js (Law 5: the #137 drag fix crossed the size cap). The
 * documented store is sessionStorage ONLY — the ONE persisted key is the
 * stream reconnect cursor (`swarm.dashboard.lastSeq`); best-effort on both
 * ends (private-mode storage may throw; a missing/corrupt cursor reads as 0).
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
