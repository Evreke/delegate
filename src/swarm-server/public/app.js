/**
 * app.js — the v1 dashboard bootstrap (issues #53, #54, #66).
 *
 * ONE screen, no tabs and no mode switchers: the shell mounts the attention
 * strip, the left rail, the center SVG canvas and the right detail panel
 * inside `#fleet-tree`, then keeps them live. Data enters ONLY through the
 * documented read doors — `GET /api/swarm/snapshot`, the
 * `WS /api/swarm/stream?after=<seq>` cursor stream and the console endpoints;
 * mutations go through `./mutations.js` (optimistic-with-confirmation, #54).
 * Per-fleet view (#66 scope §7): `/fleets/<sessionId>/` reads the SCOPED
 * events/stream base and folds only its OWN graph subtree (`./fleet-scope.js`);
 * the root view keeps the v1 unscoped behavior.
 *
 * The heavy halves live in their own modules: `./state.js` folds the read model,
 * `./layout.js` places the graph, `./ui.js` owns UI state, `./panels.js` the
 * console registry, `./mutations.js` steering. A snapshot frame re-renders; an
 * event frame patches status/progress IN PLACE (#88). Ownership (#81): the
 * serving identity is the fleets envelope's `self` (ownSessionId/ownSessionPath),
 * with console refusals as the per-worker refinement — the server's verdict.
 */

import { buildDashboardState } from "./state.js";
import { createStatusChrome } from "./status.js";
import { bootstrapFragmentToken } from "./auth-bootstrap.js";
import { scopedUrl, scopeGraphToFleet, servingIdentity, servingScope, streamUrlFor } from "./fleet-scope.js";
import { computeLayout } from "./layout.js";
import { createUiState, uiReducer } from "./ui.js";
import { renderAttention, renderErrorBanner, clearErrorBanner, regionStateView, renderRegionState } from "./attention.js";
import { renderRail } from "./rail.js";
import { renderCanvas, patchCanvas, attachCanvasControls } from "./canvas.js";
import { renderDetail, resolveDetailSubject, pickWorker } from "./detail.js";
import { createSwarmStream, readEnvelope, foldEventStore, MAX_EVENT_STORE, isStructuralEventFrame } from "./stream.js";
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

/** The shell regions, created inside the #fleet-tree shell root. */
const REGIONS = [["attention", "attention-strip"], ["rail", "rail"], ["canvas", "center-canvas"], ["detail", "detail"]];

/**
 * Build the dashboard app over injectable browser seams.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: env — { doc, fetch, storage, location, stream, consoleTail, prompt,
 *   delayMs, ownSessionId, ownSessionPath, nowMs } overrides
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
	// #66 scope §7: `/fleets/<id>/` reads only that fleet (./fleet-scope.js).
	const { fleetId, base: readBase } = servingScope(location);
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
	let journalEvents = [];
	let readError = null;
	let fleetsBody = [];
	// #81: the serving identity — from the fleets envelope's `self` once it resolves, else the env seam; `scopeKnown` gates the honest 'scoping…' strip.
	let ownSessionId = env.ownSessionId ?? null;
	let ownSessionPath = env.ownSessionPath ?? null;
	let scopeKnown = Boolean(env.ownSessionId || env.ownSessionPath);
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
			regions[name] = shell.appendChild(node);
		}
	}
	const byId = (id) => (doc && typeof doc.getElementById === "function" ? doc.getElementById(id) : null);
	const errorEl = byId("error");
	// #79/#82/#86: the static-frame chrome (connection pill, token pill, journal
	// health footer, ticker, scope) lives in one factory behind this byId seam.
	const chrome = createStatusChrome({ doc, byId, nowMs });
	chrome.setScope(fleetId, []);
	const showError = (err, op) => { if (errorEl) renderErrorBanner(errorEl, err, doc, { op, onDismiss: () => clearErrorBanner(errorEl) }); };
	const noteFailure = (err) => { readError = err; renderRegionStates(); showError(err); };
	const noteSuccess = () => { readError = null; if (errorEl) clearErrorBanner(errorEl); };
	const renderRegionStates = () => { const view = regionStateView(readError); for (const name of ["rail", "canvas", "detail"]) renderRegionState(regions[name], view, doc); };
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
		onTokenState: (state) => chrome.setToken(state),
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
	chrome.setToken(mutations.tokenState);

	// --- model + render ----------------------------------------------------
	const refreshModel = () => {
		if (!lastSnapshot) return;
		const foreign = new Set(env.foreignSessionIds || []);
		if (panels) for (const id of panels.foreignIds()) foreign.add(id);
		dash = buildDashboardState({
			graph: lastSnapshot,
			events: journalEvents,
			ownSessionId,
			ownSessionPath,
			foreignSessionIds: foreign,
			// #92: the read model accepts the UI's expansion Set (it used to drop it).
			expansion: ui.expansion,
			nowMs: nowMs(),
		});
		layout = computeLayout(dash, { expansion: ui.expansion });
		stateVersion = Number.isFinite(lastSnapshot.schemaVersion) ? lastSnapshot.schemaVersion : 1;
	};

	const updateStatusbar = () => chrome.renderStatus(dash, stateVersion);

	const detailView = () => {
		const subject = resolveDetailSubject(dash, ui);
		if (!subject) return null;
		const worker = pickWorker(subject, ui);
		const workerName = worker ? worker.name : null;
		const sessionId = worker ? worker.sessionId : subject.kind === "session" ? subject.id : null;
		const consoleState = sessionId && panels ? panels.get(sessionId) : null;
		const ask = (worker && worker.ask) || subject.ask || null;
		// #85: a non-worker node keeps a VISIBLE controls box with its disabled reason.
		const ctl = worker
			? controlsView({
					worker: workerName,
					consoleStatus: consoleState ? consoleState.status : undefined,
					hasSession: Boolean(sessionId),
					pendingAsk: ask ? { worker: workerName, question: ask.question } : null,
				})
			: { disabled: true, reasonCode: "not-a-worker", reason: "disabled: this node is not a steerable worker", pendingAsk: ask };
		return {
			subject,
			worker: workerName,
			workerSessionId: sessionId,
			console: consoleState && sessionId ? { ...consoleBanner(consoleState), worker: workerName, nodeId: sessionId } : null,
			controls: ctl,
			pending: workerName ? mutations.latestPending(workerName, "steer") : null,
			answerPending: workerName ? mutations.latestPending(workerName, "answer") : null,
			ask,
			draft: workerName ? drafts.get(workerName) || "" : "",
			answerDraft: workerName ? drafts.get(`${workerName}:answer`) || "" : "",
			tab: ui.detailTab,
		};
	};

	// #85c/#93: the panel talks back through these seams (no post-render DOM query).
	const sendMutation = (kind, worker, text) => (kind === "answer" ? mutations.sendAnswer(worker, text) : mutations.sendSteer(worker, text));
	const detailOpts = () => ({ dispatch, onSend: sendMutation, onDraft: (key, text) => drafts.set(key, text) });

	// #91: the queue overlay is a modal dialog — focus on open, restore on close, Escape closes.
	let restoreFocus = null;
	const syncFocus = () => {
		const overlay = ui.overlay && regions.attention && typeof doc.querySelector === "function" ? doc.querySelector("[data-attention-overlay]") : null;
		if (!overlay) {
			if (restoreFocus) { restoreFocus.focus?.(); restoreFocus = null; }
			return;
		}
		if (!restoreFocus && doc.activeElement && doc.activeElement !== doc.body) restoreFocus = doc.activeElement;
		overlay.focus?.();
	};
	const onKeydown = (event) => { if (event && event.key === "Escape" && ui.overlay) dispatch({ type: "dismiss-overlay" }); };
	if (doc && typeof doc.addEventListener === "function") doc.addEventListener("keydown", onKeydown);

	const viewport = () => ({ width: 1200, height: 720 });
	const onView = (view) => { ui = uiReducer(ui, { type: "view", view }); renderRegions(); };
	const renderRegions = () => {
		if (regions.rail) renderRail(dash, regions.rail, doc, { dispatch, selection: ui.selection });
		if (regions.canvas) {
			canvasIndex = renderCanvas(dash, layout, regions.canvas, doc, { dispatch, spotlight: ui.spotlight, view: ui.view, viewport, onView });
			attachCanvasControls(canvasIndex, doc, { getView: () => ui.view, onView, viewport });
		}
		if (regions.detail) renderDetail(detailView(), regions.detail, doc, detailOpts());
		if (regions.attention) renderAttention(dash, regions.attention, doc, { dispatch, overlay: ui.overlay, scoping: !scopeKnown });
		syncFocus();
	};
	const render = () => {
		refreshModel();
		if (!dash) { renderRegionStates(); return; }
		renderRegions();
		updateStatusbar();
	};

	/** An event frame patches status/progress in place — no relayout, no canvas rebuild. */
	const renderLive = () => {
		refreshModel();
		if (!dash) return;
		if (canvasIndex) patchCanvas(canvasIndex, dash, doc, { spotlight: ui.spotlight });
		if (regions.rail) renderRail(dash, regions.rail, doc, { dispatch, selection: ui.selection });
		if (regions.detail) renderDetail(detailView(), regions.detail, doc, detailOpts());
		if (regions.attention) renderAttention(dash, regions.attention, doc, { dispatch, overlay: ui.overlay, scoping: !scopeKnown });
		syncFocus();
		updateStatusbar();
	};

	const rerender = (graph) => {
		// The ONE graph choke point (HTTP snapshot + WS frame): the fleet filter.
		lastSnapshot = scopeGraphToFleet(graph, fleetId);
		render();
	};
	const scheduleRender = () => {
		if (renderTimer !== null || !lastSnapshot) return;
		renderTimer = setTimeout(() => { renderTimer = null; render(); }, 50);
	};

	// --- journal -----------------------------------------------------------
	const foldEvents = (rows) => {
		journalEvents = foldEventStore(journalEvents, rows, MAX_EVENT_STORE);
		if (journalEvents.length === 0) return;
		mutations.fold(journalEvents);
		chrome.setLatestEvent(journalEvents[journalEvents.length - 1] ?? null);
	};

	const refreshFleets = async () => {
		try {
			const { body, error } = await readEnvelope(await fetchImpl("/api/swarm/fleets"), "loading the fleet index");
			if (error) throw error;
			fleetsBody = Array.isArray(body.fleets) ? body.fleets : [];
			const identity = servingIdentity(body, env);
			ownSessionId = identity.sessionId ?? ownSessionId;
			ownSessionPath = identity.sessionPath ?? ownSessionPath;
			chrome.setScope(fleetId, fleetsBody);
		} catch { /* the index is advisory — identity stays unknown until the strip says so */ }
		scopeKnown = true;
		if (lastSnapshot) scheduleRender();
	};

	const refreshSnapshot = async () => {
		const { body, error } = await readEnvelope(await fetchImpl("/api/swarm/snapshot"), "loading the fleet snapshot");
		if (error) throw error;
		rerender(body.snapshot);
		chrome.markUpdated();
		noteSuccess();
		for (const node of (lastSnapshot && lastSnapshot.nodes) || []) for (const worker of node.workers || []) panels.start(worker);
	};

	const refreshJournal = async (after) => {
		const { body, error } = await readEnvelope(await fetchImpl(scopedUrl(readBase, `/api/swarm/events?after=${after}`)), "loading the journal");
		if (error) throw error;
		chrome.setJournal(body.journal);
		chrome.markUpdated();
		foldEvents(body.events);
		noteSuccess();
		scheduleRender();
		return journalEvents.length > 0 ? journalEvents[journalEvents.length - 1].seq : after;
	};

	const scheduleRefresh = () => {
		if (refreshTimer !== null) return;
		refreshTimer = setTimeout(() => { refreshTimer = null; refreshSnapshot().catch(showError); }, 50);
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
			chrome.setConnection("connecting");
			renderRegionStates();
			// #81: identity and the first snapshot load CONCURRENTLY — the graph paints immediately with an honest 'scoping…' strip until `self` resolves, instead of counts that then retract.
			const fleets = refreshFleets();
			let streamAfter = cursor;
			try {
				await refreshSnapshot();
				streamAfter = await refreshJournal(0);
			} catch (err) {
				noteFailure(err);
			}
			await fleets.catch(() => {});
			writeCursor(storage, streamAfter);
			stream = streamFactory({
				url: streamUrlFor(location),
				after: streamAfter,
				delayMs: env.delayMs,
				onState: (state) => {
					chrome.setConnection(state);
					if (state === "open") noteSuccess();
				},
				onFrame: (frame, kind) => {
					if (kind === "snapshot") {
						rerender(frame.snapshot);
						return;
					}
					if (kind === "events") {
						foldEvents(frame.events);
						renderLive();
						writeCursor(storage, stream ? stream.state.lastSeq : cursor);
						if (isStructuralEventFrame(frame.events)) scheduleRefresh();
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
			if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("keydown", onKeydown);
			chrome.close();
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
