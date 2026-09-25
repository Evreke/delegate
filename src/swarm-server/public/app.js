/**
 * app.js — the v1 dashboard bootstrap (issues #53, #54, #66).
 *
 * ONE screen, no tabs and no mode switchers: the shell mounts the attention
 * strip, the left rail, the center SVG canvas and the right detail panel
 * inside `#fleet-tree`, then keeps them live. Data enters ONLY through the
 * documented read doors — `GET /api/swarm/snapshot`, the
 * `WS /api/swarm/stream?after=<seq>` cursor stream and the console endpoints;
 * mutations go through `./mutations.js` (optimistic-with-confirmation, #54).
 *
 * The heavy halves live in their own modules: `./state.js` folds the read
 * model, `./layout.js` places the graph, `./ui.js` owns ephemeral UI state,
 * `./panels.js` owns the console registry, `./mutations.js` owns steering.
 * A snapshot frame re-renders; an event frame patches node status/progress IN
 * PLACE (positions are stable for stable topology).
 *
 * Ownership: a fleet is own unless the console gate refuses its session
 * (`refused`) or `env.ownSessionPath` / `env.foreignSessionIds` say otherwise
 * — the server's ownership verdict is the authority, never a guess.
 */

import { buildDashboardState } from "./state.js";
import { bootstrapFragmentToken } from "./auth-bootstrap.js";
import { computeLayout } from "./layout.js";
import { createUiState, uiReducer } from "./ui.js";
import { renderAttention } from "./attention.js";
import { renderRail } from "./rail.js";
import { renderCanvas, patchCanvas, attachCanvasControls } from "./canvas.js";
import { renderDetail, resolveDetailSubject, pickWorker } from "./detail.js";
import { createSwarmStream } from "./stream.js";
import { consoleBanner, createConsoleTail } from "./console.js";
import { createPanels } from "./panels.js";
import { createMutations, MAX_AUTH_RETRIES } from "./mutations.js";
import { controlsView } from "./steer.js";

export { MAX_AUTH_RETRIES };

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

/** The shell regions, created inside the #fleet-tree shell root. */
const REGIONS = [
	["attention", "attention-strip"],
	["rail", "rail"],
	["canvas", "center-canvas"],
	["detail", "detail"],
];

/**
 * Build the dashboard app over injectable browser seams.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: env — { doc, fetch, storage, location, stream, consoleTail, prompt,
 *   delayMs, ownSessionPath, nowMs } overrides
 * Output: { start(), close(), get state(), get ui(), get lastSeq(),
 *   sendSteer(), sendAnswer(), get pending(), dispatch() }
 * Guarantees: a fetch/render failure is surfaced in #error and never throws
 *   out of start(); the shell renders one screen with no mode switcher; an
 *   event frame patches the canvas without relayout.
 * Raises: never
 */
export function createFleetApp(env = {}) {
	const doc = env.doc || (typeof document !== "undefined" ? document : null);
	const fetchImpl = env.fetch || ((...args) => fetch(...args));
	const storage = env.storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
	const location = env.location || (typeof window !== "undefined" ? window.location : null);
	const streamFactory = env.stream || createSwarmStream;
	const promptImpl = env.prompt || (typeof window !== "undefined" && typeof window.prompt === "function" ? window.prompt.bind(window) : null);
	const nowMs = typeof env.nowMs === "function" ? env.nowMs : () => Date.now();
	// #65 item 2: a `#t=<token>` link fragment bootstraps the operator token
	// (sessionStorage) and is stripped from the address bar before any request.
	bootstrapFragmentToken({ location, history: env.history || (typeof window !== "undefined" ? window.history : null), storage });

	let ui = createUiState();
	let dash = null;
	let layout = null;
	let canvasIndex = null;
	let lastSnapshot = null;
	let stream = null;
	let refreshTimer = null;
	let renderTimer = null;
	let stateVersion = 1;
	let activity = "";
	let journalEvents = [];
	const drafts = new Map();

	// --- shell ------------------------------------------------------------
	const shell = doc ? doc.getElementById("fleet-tree") : null;
	const regions = {};
	if (shell) {
		while (shell.firstChild) shell.removeChild(shell.firstChild);
		for (const [name, cls] of REGIONS) {
			const node = doc.createElement("div");
			node.setAttribute("class", `region region-${cls}`);
			node.setAttribute("data-region", name);
			shell.appendChild(node);
			regions[name] = node;
		}
	}
	const byId = (id) => (doc && typeof doc.getElementById === "function" ? doc.getElementById(id) : null);
	const connectionEl = byId("connection-state");
	const tokenEl = byId("token-state");
	const countEl = byId("journal-count");
	const bytesEl = byId("journal-bytes");
	const schemaEl = byId("schema-version");
	const tickerEl = byId("activity-ticker");
	const errorEl = byId("error");

	const setConnection = (state) => {
		if (!connectionEl) return;
		connectionEl.setAttribute("data-connection-state", state);
		connectionEl.textContent = state;
	};
	const setTokenState = (state) => {
		if (!tokenEl) return;
		tokenEl.setAttribute("data-token-state", state);
		tokenEl.textContent = `token: ${state}`;
	};
	const showError = (err) => {
		if (!errorEl) return;
		errorEl.removeAttribute("hidden");
		errorEl.textContent = String((err && err.message) || err);
	};
	const dispatch = (action) => {
		ui = uiReducer(ui, action);
		render();
	};

	// --- panels + mutations ------------------------------------------------
	let panels = null;
	const mutations = createMutations({
		fetch: fetchImpl,
		storage,
		prompt: promptImpl,
		currentSeq: () => (stream ? stream.state.lastSeq : journalEvents.reduce((m, e) => Math.max(m, e.seq), 0)),
		onTokenState: setTokenState,
		onChange: () => scheduleRender(),
		onError: showError,
	});
	panels = createPanels({
		fetch: fetchImpl,
		location,
		consoleTail: env.consoleTail || createConsoleTail,
		doc,
		delayMs: env.delayMs,
		onError: showError,
		onChange: (nodeId, prev, next) => {
			if (next.status !== prev.status) scheduleRender();
			else panels.patchTail(nodeId);
		},
	});
	setTokenState(mutations.tokenState);

	// --- model + render ----------------------------------------------------
	const foreignSessionIds = () => {
		const ids = new Set(env.foreignSessionIds || []);
		if (panels) for (const id of panels.foreignIds()) ids.add(id);
		return ids;
	};

	const refreshModel = () => {
		if (!lastSnapshot) return;
		const ids = foreignSessionIds();
		dash = buildDashboardState({
			graph: lastSnapshot,
			events: journalEvents,
			ownSessionPath: env.ownSessionPath ?? null,
			foreignSessionIds: ids,
			nowMs: nowMs(),
		});
		layout = computeLayout(dash, { expansion: ui.expansion });
		stateVersion = Number.isFinite(lastSnapshot.schemaVersion) ? lastSnapshot.schemaVersion : 1;
	};

	const updateStatusbar = () => {
		if (schemaEl) schemaEl.textContent = String(stateVersion);
		if (tickerEl) tickerEl.textContent = activity || "\u2014";
	};

	const detailView = () => {
		const subject = resolveDetailSubject(dash, ui);
		if (!subject) return null;
		const worker = pickWorker(subject, ui);
		const workerName = worker ? worker.name : null;
		const sessionId = worker ? worker.sessionId : subject.kind === "session" ? subject.id : null;
		const consoleState = sessionId && panels ? panels.get(sessionId) : null;
		const ask = (worker && worker.ask) || subject.ask || null;
		const ctl = worker
			? controlsView({
					worker: workerName,
					consoleStatus: consoleState ? consoleState.status : undefined,
					hasSession: Boolean(sessionId),
					pendingAsk: ask ? { worker: workerName, question: ask.question } : null,
				})
			: null;
		return {
			subject,
			worker: workerName,
			workerSessionId: sessionId,
			console: consoleState && sessionId ? { ...consoleBanner(consoleState), worker: workerName, nodeId: sessionId } : null,
			controls: ctl,
			pending: workerName ? mutations.latestPending(workerName, "steer") : null,
			ask,
			draft: workerName ? drafts.get(workerName) || "" : "",
			tab: ui.detailTab,
		};
	};

	const viewport = () => ({ width: 1200, height: 720 });
	const onView = (view) => {
		ui = uiReducer(ui, { type: "view", view });
		renderRegions();
	};
	const renderRegions = () => {
		if (regions.rail) renderRail(dash, regions.rail, doc, { dispatch, selection: ui.selection });
		if (regions.canvas) {
			canvasIndex = renderCanvas(dash, layout, regions.canvas, doc, { dispatch, spotlight: ui.spotlight, view: ui.view, viewport, onView });
			attachCanvasControls(canvasIndex, doc, { getView: () => ui.view, onView, viewport });
		}
		if (regions.detail) renderDetail(detailView(), regions.detail, doc, { dispatch });
		if (regions.attention) renderAttention(dash, regions.attention, doc, { dispatch, overlay: ui.overlay });
	};
	const render = () => {
		refreshModel();
		if (!dash) return;
		renderRegions();
		wireControls();
		updateStatusbar();
	};

	/** An event frame patches status/progress in place — no relayout, no canvas rebuild. */
	const renderLive = () => {
		refreshModel();
		if (!dash) return;
		if (canvasIndex) patchCanvas(canvasIndex, dash, doc, { spotlight: ui.spotlight });
		if (regions.rail) renderRail(dash, regions.rail, doc, { dispatch, selection: ui.selection });
		if (regions.detail) renderDetail(detailView(), regions.detail, doc, { dispatch });
		if (regions.attention) renderAttention(dash, regions.attention, doc, { dispatch, overlay: ui.overlay });
		wireControls();
		updateStatusbar();
	};

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

	const wireControls = () => {
		if (!doc || typeof doc.querySelectorAll !== "function") return;
		for (const el of doc.querySelectorAll("[data-steer-worker]")) {
			const name = el.getAttribute("data-steer-worker");
			const input = el.querySelector("[data-steer-input]");
			const send = el.querySelector("[data-steer-send]");
			if (input && typeof input.addEventListener === "function") input.addEventListener("input", () => drafts.set(name, input.value));
			if (send && typeof send.addEventListener === "function") send.addEventListener("click", () => void mutations.sendSteer(name, input ? input.value : ""));
			const aInput = el.querySelector("[data-answer-input]");
			const aSend = el.querySelector("[data-answer-send]");
			if (aSend && typeof aSend.addEventListener === "function") aSend.addEventListener("click", () => void mutations.sendAnswer(name, aInput ? aInput.value : ""));
		}
	};

	// --- journal -----------------------------------------------------------
	const foldEvents = (rows) => {
		if (!Array.isArray(rows) || rows.length === 0) return;
		const merged = new Map(journalEvents.map((e) => [e.seq, e]));
		for (const e of rows) if (e && typeof e.seq === "number") merged.set(e.seq, e);
		journalEvents = [...merged.values()].sort((a, b) => a.seq - b.seq);
		mutations.fold(journalEvents);
		const newest = journalEvents[journalEvents.length - 1];
		if (newest) activity = `${newest.kind} #${newest.seq}${newest.worker ? ` ${newest.worker}` : ""}`;
		scheduleRender();
	};

	const refreshSnapshot = async () => {
		const res = await fetchImpl("/api/swarm/snapshot");
		const body = await res.json();
		rerender(body.snapshot);
		for (const node of (body.snapshot && body.snapshot.nodes) || []) {
			for (const worker of node.workers || []) panels.start(worker);
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

	return {
		get state() {
			return dash;
		},
		get ui() {
			return ui;
		},
		get view() {
			return dash;
		},
		get lastSeq() {
			return stream ? stream.state.lastSeq : readCursor(storage);
		},
		get pending() {
			return mutations.pending;
		},
		dispatch,
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
						foldEvents(frame.events);
						renderLive();
						writeCursor(storage, stream ? stream.state.lastSeq : cursor);
						refreshJournal(stream ? stream.state.lastSeq : cursor).catch(showError);
						scheduleRefresh();
					}
				},
			});
			return this;
		},
		sendSteer: (worker, text) => mutations.sendSteer(worker, text),
		sendAnswer: (worker, text) => mutations.sendAnswer(worker, text),
		close() {
			if (refreshTimer !== null) clearTimeout(refreshTimer);
			if (renderTimer !== null) clearTimeout(renderTimer);
			if (panels) panels.close();
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
