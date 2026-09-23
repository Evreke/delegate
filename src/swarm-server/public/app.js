/**
 * app.js — the dashboard bootstrap (issue #53).
 *
 * Wires the three pure modules into a page: fetch the snapshot and render the
 * tree, fetch the journal health for the footer, then open the WS stream and
 * apply frames live (snapshot frames re-render the tree; event frames persist
 * the cursor and refresh the tree — a refresh, never a page reload). Only GET
 * requests and the WS stream are used: the client is read-only.
 *
 * `createFleetApp(env)` takes its browser seams (doc/fetch/storage/location/
 * stream) so the wiring is testable headlessly; the module also self-starts
 * when a document is present.
 */

import { buildTreeView, renderTree } from "./tree.js";
import { createSwarmStream } from "./stream.js";

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

/** The WS URL for the current page origin. */
export function streamUrlFor(location) {
	const proto = location && location.protocol === "https:" ? "wss:" : "ws:";
	const host = location ? location.host : "127.0.0.1:7331";
	return `${proto}//${host}/api/swarm/stream`;
}

/**
 * Build the dashboard app over injectable browser seams.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: env — { doc, fetch, storage, location, stream, delayMs } overrides
 *   (all default to the browser globals)
 * Output: { start(), close(), get view(), get lastSeq() }
 * Guarantees: only GET + WS; a fetch/render failure is surfaced in #error and
 *   never throws out of start(); the tree is re-rendered from a fresh snapshot
 *   on every event batch (no page reload)
 * Raises: never
 */
export function createFleetApp(env = {}) {
	const doc = env.doc || (typeof document !== "undefined" ? document : null);
	const fetchImpl = env.fetch || ((...args) => fetch(...args));
	const storage = env.storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
	const location = env.location || (typeof window !== "undefined" ? window.location : null);
	const streamFactory = env.stream || createSwarmStream;

	const treeEl = doc ? doc.getElementById("fleet-tree") : null;
	const connEl = doc ? doc.getElementById("connection-state") : null;
	const countEl = doc ? doc.getElementById("journal-count") : null;
	const bytesEl = doc ? doc.getElementById("journal-bytes") : null;
	const errorEl = doc ? doc.getElementById("error") : null;

	let view = null;
	let stream = null;
	let refreshTimer = null;

	const setConnection = (state) => {
		if (!connEl) return;
		connEl.setAttribute("data-connection-state", state);
		connEl.textContent = state;
	};

	const showError = (err) => {
		if (!errorEl) return;
		errorEl.removeAttribute("hidden");
		errorEl.textContent = String((err && err.message) || err);
	};

	const render = (graph) => {
		view = buildTreeView(graph);
		if (treeEl) renderTree(view, treeEl, doc);
	};

	const refreshSnapshot = async () => {
		const res = await fetchImpl("/api/swarm/snapshot");
		const body = await res.json();
		render(body.snapshot);
	};

	const refreshJournal = async (after) => {
		const res = await fetchImpl(`/api/swarm/events?after=${after}`);
		const body = await res.json();
		if (countEl) countEl.textContent = String((body.journal && body.journal.count) || 0);
		if (bytesEl) bytesEl.textContent = String((body.journal && body.journal.dbSizeBytes) || 0);
	};

	const scheduleRefresh = () => {
		if (refreshTimer !== null) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refreshSnapshot().catch(showError);
		}, 50);
	};

	return {
		get view() {
			return view;
		},
		get lastSeq() {
			return stream ? stream.state.lastSeq : readCursor(storage);
		},
		async start() {
			const cursor = readCursor(storage);
			setConnection("connecting");
			try {
				await refreshSnapshot();
				await refreshJournal(cursor);
			} catch (err) {
				showError(err);
			}
			stream = streamFactory({
				url: streamUrlFor(location),
				after: cursor,
				delayMs: env.delayMs,
				onState: setConnection,
				onFrame: (frame, kind) => {
					if (kind === "snapshot") {
						render(frame.snapshot);
						return;
					}
					if (kind === "events") {
						const seq = stream ? stream.state.lastSeq : cursor;
						writeCursor(storage, seq);
						refreshJournal(seq).catch(showError);
						scheduleRefresh();
					}
				},
			});
			return this;
		},
		close() {
			if (refreshTimer !== null) clearTimeout(refreshTimer);
			if (stream) stream.close();
		},
	};
}

// Self-start in a browser (a document exists); the module stays importable
// headlessly (the check imports createFleetApp without a document).
if (typeof document !== "undefined" && typeof window !== "undefined") {
	createFleetApp()
		.start()
		.catch(() => {
			/* start() already surfaces failures in #error */
		});
}