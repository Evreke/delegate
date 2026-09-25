/**
 * panels.js — the dashboard's worker-console panel registry (issue #54/#66).
 *
 * One registry per app: per session node it holds the console state
 * (`./console.js` reducer over the #52 envelope), preloads the REST backlog
 * and then live-tails the console WS at the last offset. The registry is
 * browser-fetch/WS only through injected seams, so the app wiring stays
 * headless-testable and app.js stays a shell.
 *
 * No DOM here except the optional in-place tail patch (a `pre` text node);
 * the renderers read the state through `get()`.
 */

import { consoleBanner, consoleRestUrl, consoleStreamUrlFor, initialConsoleState, isTerminalConsoleStatus, reduceConsoleFrame } from "./console.js";

/**
 * Create the panel registry.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts — { fetch, location, consoleTail (factory), doc, onChange(nodeId, prev, next) }
 * Output: { start(worker), get(nodeId), apply(nodeId, frame), close(), size() }
 * Guarantees: exactly one preload + at most one live tail per session node;
 *   a terminal console state never reconnects; a refused frame is retained
 *   honestly (never retried into a fake live tail). Never throws out of a
 *   callback.
 */
export function createPanels(opts) {
	const fetchImpl = opts.fetch;
	const doc = opts.doc;
	const consoleTailFactory = opts.consoleTail;
	const onChange = opts.onChange || (() => {});
	const states = new Map();
	const tails = new Map();

	const apply = (nodeId, frame) => {
		const prev = states.get(nodeId) || initialConsoleState(0);
		const next = reduceConsoleFrame(prev, frame);
		states.set(nodeId, next);
		onChange(nodeId, prev, next);
	};

	const patchTail = (nodeId) => {
		const state = states.get(nodeId);
		if (!state || !doc || typeof doc.querySelector !== "function") return;
		const panel = doc.querySelector(`[data-console-node="${nodeId}"]`);
		if (!panel) return;
		const tail = panel.querySelector("[data-console-tail]");
		if (tail) tail.textContent = consoleBanner(state).text;
	};

	const preload = async (worker) => {
		const nodeId = worker.sessionId;
		try {
			const res = await fetchImpl(consoleRestUrl(nodeId, 0));
			const body = await res.json();
			apply(nodeId, body);
		} catch (err) {
			apply(nodeId, { ok: false, error: { code: "E_CONSOLE_ERROR", message: String((err && err.message) || err) } });
		}
		const state = states.get(nodeId) || initialConsoleState(0);
		if (isTerminalConsoleStatus(state.status)) return;
		try {
			tails.set(
				nodeId,
				consoleTailFactory({
					url: consoleStreamUrlFor(opts.location, nodeId, state.nextOffset),
					offset: state.nextOffset,
					delayMs: opts.delayMs,
					onFrame: (frame) => apply(nodeId, frame),
				}),
			);
		} catch (err) {
			if (typeof opts.onError === "function") opts.onError(err);
		}
	};

	return {
		start(worker) {
			if (!worker || !worker.sessionId || states.has(worker.sessionId) || tails.has(worker.sessionId)) return;
			states.set(worker.sessionId, initialConsoleState(0));
			void preload(worker);
		},
		get(nodeId) {
			return states.get(nodeId) || null;
		},
		apply,
		patchTail,
		foreignIds() {
			const ids = new Set();
			for (const [id, state] of states) if (state.status === "refused") ids.add(id);
			return ids;
		},
		size() {
			return states.size;
		},
		close() {
			for (const tail of tails.values()) tail.close();
			tails.clear();
		},
	};
}
