/**
 * app.js — the dashboard bootstrap (issues #53 + #54).
 *
 * Wires the pure modules into a page: fetch the snapshot and render the tree,
 * preload each worker's console (REST) then live-tail it (WS), fetch the
 * journal for the footer + the pending-ask / mutation-confirmation graph, then
 * open the swarm WS stream and apply frames live (snapshot frames re-render
 * the tree; event frames advance the cursor, confirm pending mutations and
 * refresh the tree — a refresh, never a page reload).
 *
 * Steering (#54) is OPTIMISTIC-WITH-CONFIRMATION: a POST creates a pending
 * marker confirmed only when the matching journal `steer`/`answer` event
 * arrives over the read stream; a structured 401/403 re-prompts for the
 * operator token (sessionStorage only — never localStorage, a URL or a log).
 *
 * `createFleetApp(env)` takes its browser seams (doc/fetch/storage/location/
 * stream/prompt) so the wiring is testable headlessly; the module also
 * self-starts when a document is present.
 */

import { buildTreeView, renderTree } from "./tree.js";
import { createSwarmStream } from "./stream.js";
import { consoleBanner, consoleRestUrl, consoleStreamUrlFor, createConsoleTail, initialConsoleState, isTerminalConsoleStatus, reduceConsoleFrame } from "./console.js";
import { clearToken, controlsView, failPending, newPending, pendingAsks, pendingView, postMutation, readToken, reducePending, writeToken } from "./steer.js";

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
 * Input: env — { doc, fetch, storage, location, stream, consoleTail, prompt,
 *   delayMs } overrides (all default to the browser globals)
 * Output: { start(), close(), get view(), get lastSeq(), sendSteer(),
 *   sendAnswer(), get pending() }
 * Guarantees: a fetch/render failure is surfaced in #error and never throws
 *   out of start(); the tree re-renders from a fresh snapshot on every event
 *   batch (no page reload); a mutation without a token prompts, and a
 *   structured 401/403 clears + re-prompts; the token never leaves
 *   sessionStorage except in the Authorization header.
 * Raises: never
 */
export function createFleetApp(env = {}) {
	const doc = env.doc || (typeof document !== "undefined" ? document : null);
	const fetchImpl = env.fetch || ((...args) => fetch(...args));
	const storage = env.storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
	const location = env.location || (typeof window !== "undefined" ? window.location : null);
	const streamFactory = env.stream || createSwarmStream;
	const consoleTailFactory = env.consoleTail || createConsoleTail;
	const promptImpl = env.prompt || (typeof window !== "undefined" && typeof window.prompt === "function" ? window.prompt.bind(window) : null);

	const treeEl = doc ? doc.getElementById("fleet-tree") : null;
	const connEl = doc ? doc.getElementById("connection-state") : null;
	const countEl = doc ? doc.getElementById("journal-count") : null;
	const bytesEl = doc ? doc.getElementById("journal-bytes") : null;
	const errorEl = doc ? doc.getElementById("error") : null;
	const tokenEl = doc ? doc.getElementById("token-state") : null;

	let view = null;
	let stream = null;
	let refreshTimer = null;
	let renderTimer = null;
	const consoles = new Map(); // graph session node id → console panel state
	const tails = new Map(); // graph session node id → live-tail handle
	let journalEvents = [];
	let pendingList = [];
	let asks = [];
	const drafts = new Map(); // worker name → unsent steer draft

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

	const setTokenState = (state) => {
		if (!tokenEl) return;
		tokenEl.setAttribute("data-token-state", state);
		tokenEl.textContent = `token: ${state}`;
	};

	const currentSeq = () => (stream ? stream.state.lastSeq : journalEvents.reduce((m, e) => Math.max(m, e.seq), 0));

	const panelFor = (worker) => {
		const state = consoles.get(worker.sessionId);
		if (!state) return null;
		return { ...consoleBanner(state), worker: worker.name, nodeId: worker.sessionId };
	};

	const controlsFor = (worker) => {
		const state = consoles.get(worker.sessionId);
		const pending = [...pendingList].reverse().find((p) => p.kind === "steer" && p.worker === worker.name);
		const ctl = controlsView({
			worker: worker.name,
			consoleStatus: state ? state.status : undefined,
			pendingAsk: asks.find((a) => a.worker === worker.name) || null,
		});
		return { ...ctl, draft: drafts.get(worker.name) || "", pending: pending ? pendingView(pending) : null };
	};

	const wireControls = () => {
		if (!doc || typeof doc.querySelectorAll !== "function") return;
		for (const el of doc.querySelectorAll("[data-steer-worker]")) {
			const name = el.getAttribute("data-steer-worker");
			const input = el.querySelector("[data-steer-input]");
			const send = el.querySelector("[data-steer-send]");
			if (input && typeof input.addEventListener === "function") input.addEventListener("input", () => drafts.set(name, input.value));
			if (send && typeof send.addEventListener === "function") send.addEventListener("click", () => void sendSteer(name, input ? input.value : ""));
			const aInput = el.querySelector("[data-answer-input]");
			const aSend = el.querySelector("[data-answer-send]");
			if (aSend && typeof aSend.addEventListener === "function") aSend.addEventListener("click", () => void sendAnswer(name, aInput ? aInput.value : ""));
		}
	};

	const render = () => {
		view = buildTreeView(lastSnapshot);
		if (treeEl) renderTree(view, treeEl, doc, { panelOf: panelFor, controlsOf: controlsFor });
		wireControls();
	};
	let lastSnapshot = null;
	const rerender = (graph) => {
		lastSnapshot = graph;
		render();
	};
	const scheduleRender = () => {
		if (renderTimer !== null || !lastSnapshot) return;
		renderTimer = setTimeout(() => {
			renderTimer = null;
			render();
		}, 50);
	};

	// ------------------------------------------------------------------
	// Console panels
	// ------------------------------------------------------------------

	const applyConsole = (nodeId, frame) => {
		const prev = consoles.get(nodeId) || initialConsoleState(0);
		const next = reduceConsoleFrame(prev, frame);
		consoles.set(nodeId, next);
		if (next.status !== prev.status) scheduleRender();
		else if (doc && typeof doc.querySelector === "function") patchConsoleTail(nodeId, next);
	};

	const patchConsoleTail = (nodeId, state) => {
		const panel = doc.querySelector(`[data-console-node="${nodeId}"]`);
		if (!panel) return;
		const banner = consoleBanner(state);
		const tail = panel.querySelector("[data-console-tail]");
		if (tail) tail.textContent = banner.text;
	};

	const startConsole = (worker) => {
		if (!worker.sessionId || consoles.has(worker.sessionId) || tails.has(worker.sessionId)) return;
		consoles.set(worker.sessionId, initialConsoleState(0));
		void preloadConsole(worker);
	};

	const preloadConsole = async (worker) => {
		const nodeId = worker.sessionId;
		try {
			const res = await fetchImpl(consoleRestUrl(nodeId, 0));
			const body = await res.json();
			applyConsole(nodeId, body);
		} catch (err) {
			applyConsole(nodeId, { ok: false, error: { code: "E_CONSOLE_ERROR", message: String((err && err.message) || err) } });
		}
		const state = consoles.get(nodeId) || initialConsoleState(0);
		if (isTerminalConsoleStatus(state.status)) return;
		try {
			const tail = consoleTailFactory({
				url: consoleStreamUrlFor(location, nodeId, state.nextOffset),
				offset: state.nextOffset,
				delayMs: env.delayMs,
				onFrame: (frame) => applyConsole(nodeId, frame),
			});
			tails.set(nodeId, tail);
		} catch (err) {
			showError(err);
		}
	};

	// ------------------------------------------------------------------
	// Journal + optimistic mutations
	// ------------------------------------------------------------------

	const foldEvents = (rows) => {
		if (!Array.isArray(rows) || rows.length === 0) return;
		const merged = new Map(journalEvents.map((e) => [e.seq, e]));
		for (const e of rows) if (e && typeof e.seq === "number") merged.set(e.seq, e);
		journalEvents = [...merged.values()].sort((a, b) => a.seq - b.seq);
		asks = pendingAsks(journalEvents);
		pendingList = reducePending(pendingList, journalEvents);
		scheduleRender();
	};

	const refreshSnapshot = async () => {
		const res = await fetchImpl("/api/swarm/snapshot");
		const body = await res.json();
		rerender(body.snapshot);
		for (const node of (body.snapshot && body.snapshot.nodes) || []) {
			for (const worker of node.workers || []) startConsole(worker);
		}
	};

	const refreshJournal = async (after) => {
		const res = await fetchImpl(`/api/swarm/events?after=${after}`);
		const body = await res.json();
		if (countEl) countEl.textContent = String((body.journal && body.journal.count) || 0);
		if (bytesEl) bytesEl.textContent = String((body.journal && body.journal.dbSizeBytes) || 0);
		foldEvents(body.events);
	};

	const scheduleRefresh = () => {
		if (refreshTimer !== null) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refreshSnapshot().catch(showError);
		}, 50);
	};

	// ------------------------------------------------------------------
	// Token + mutations
	// ------------------------------------------------------------------

	const ensureToken = (reason) => {
		const existing = readToken(storage);
		if (existing) {
			setTokenState("set");
			return existing;
		}
		if (!promptImpl) return null;
		const answer = promptImpl(reason || "operator token (printed on the session's stderr at mount):");
		if (typeof answer !== "string" || answer.trim().length === 0) return null;
		writeToken(storage, answer.trim());
		setTokenState("set");
		return answer.trim();
	};

	const errorText = (res) => (res && res.envelope && res.envelope.error ? `${res.envelope.error.code}: ${res.envelope.error.message}` : "mutation failed");

	const submit = async (kind, worker, text, token) => {
		const pending = newPending(kind, worker, text, currentSeq());
		pendingList = [...pendingList, pending];
		scheduleRender();
		const res = await postMutation({ fetch: fetchImpl, token, kind, id: worker, text });
		if (!res.ok) {
			if (res.authRequired) {
				clearToken(storage);
				setTokenState("re-prompt");
				const fresh = ensureToken("operator token rejected — re-enter it:");
				if (fresh) return submit(kind, worker, text, fresh);
			}
			pendingList = pendingList.map((p) => (p === pending ? failPending(p, errorText(res)) : p));
			scheduleRender();
		}
		return res;
	};

	const sendSteer = async (worker, text) => {
		if (typeof text !== "string" || text.trim().length === 0) return null;
		const token = ensureToken();
		if (!token) return null;
		drafts.delete(worker);
		return submit("steer", worker, text, token);
	};

	const sendAnswer = async (worker, text) => {
		if (typeof text !== "string" || text.trim().length === 0) return null;
		const token = ensureToken();
		if (!token) return null;
		return submit("answer", worker, text, token);
	};

	setTokenState(readToken(storage) ? "set" : "absent");

	return {
		get view() {
			return view;
		},
		get lastSeq() {
			return stream ? stream.state.lastSeq : readCursor(storage);
		},
		get pending() {
			return pendingList.map(pendingView);
		},
		async start() {
			const cursor = readCursor(storage);
			setConnection("connecting");
			try {
				await refreshSnapshot();
				await refreshJournal(0);
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
						rerender(frame.snapshot);
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
		sendSteer,
		sendAnswer,
		close() {
			if (refreshTimer !== null) clearTimeout(refreshTimer);
			if (renderTimer !== null) clearTimeout(renderTimer);
			for (const tail of tails.values()) tail.close();
			tails.clear();
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