/**
 * console.js — the dashboard's worker-console panel client (issue #54).
 *
 * `reduceConsoleFrame(state, frame)` is a PURE reducer over the #52 console
 * envelope (src/swarm-server/console.ts): it appends the read `chunk` to a
 * character-capped tail, advances the offset cursor and records the transport
 * derived state. `consoleBanner(state)` maps each state to a DISTINCT, honest
 * visual: live, ended, ended-with-retained-backlog (backlog shown, marked
 * retained), unavailable (an honest message, never a fake terminal) and the
 * fail-closed refusal (foreign/unknown worker). `consoleRestUrl` /
 * `consoleStreamUrlFor` are the two documented console routes; the REST read
 * is the backlog preload, the WS is the live tail.
 *
 * `createConsoleTail(opts)` drives the WS over an injectable `connect` seam,
 * reconnecting at the last `nextOffset` while live and STOPPING on a terminal
 * state (ended / ended-with-retained-backlog / unavailable / refused) — a
 * captureless backend sends exactly one frame, so a reconnect would only
 * re-fetch it. No framework, plain ES module.
 */

/** The retained tail's character cap (the server's byte window is the truth;
 *  this only bounds the DOM text node). */
export const CONSOLE_TAIL_MAX_CHARS = 20_000;

/** The terminal console states: reconnecting can never yield new bytes. */
export function isTerminalConsoleStatus(status) {
	return status === "ended" || status === "ended-with-retained-backlog" || status === "unavailable" || status === "refused";
}

/** `GET /api/workers/:id/console?offset=` — the backlog preload route. */
export function consoleRestUrl(nodeId, offset = 0) {
	return `/api/workers/${encodeURIComponent(nodeId)}/console?offset=${offset}`;
}

/** The live-tail WS URL for the current page origin. */
export function consoleStreamUrlFor(location, nodeId, offset = 0) {
	const proto = location && location.protocol === "https:" ? "wss:" : "ws:";
	const host = location ? location.host : "127.0.0.1:7331";
	return `${proto}//${host}/api/workers/${encodeURIComponent(nodeId)}/console/stream?offset=${offset}`;
}

/** The initial (pre-first-frame) console state. */
export function initialConsoleState(offset = 0) {
	return {
		status: "loading",
		worker: null,
		nodeId: null,
		text: "",
		nextOffset: typeof offset === "number" && offset >= 0 ? offset : 0,
		oldestOffset: 0,
		dropped: false,
		retained: false,
		error: null,
	};
}

/**
 * Fold one console frame into the panel state.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: state — a console panel state; frame — a decoded console frame OR a
 *   structured error envelope (or null/garbage)
 * Output: the next state (a NEW object; the input is never mutated)
 * Guarantees:
 *   - `ok:false` errors map to `refused` (E_CONSOLE_WORKER_REFUSED) or
 *     `error`; never a fabricated tail;
 *   - a valid frame appends `chunk`, advances `nextOffset`, records state /
 *     dropped / retained / error;
 *   - the retained tail never exceeds CONSOLE_TAIL_MAX_CHARS, dropping the
 *     OLDEST characters;
 *   - unknown/malformed input is a no-op; never throws.
 * Raises: never
 */
export function reduceConsoleFrame(state, frame) {
	const cur = state && typeof state === "object" ? state : initialConsoleState(0);
	if (!frame || typeof frame !== "object") return cur;
	if (frame.ok !== true) {
		const code = frame.error && typeof frame.error.code === "string" ? frame.error.code : "E_CONSOLE_ERROR";
		const message = frame.error && typeof frame.error.message === "string" ? frame.error.message : "console request failed";
		return { ...cur, status: code === "E_CONSOLE_WORKER_REFUSED" ? "refused" : "error", error: { code, message } };
	}
	const chunk = typeof frame.chunk === "string" ? frame.chunk : "";
	let text = cur.text + chunk;
	if (text.length > CONSOLE_TAIL_MAX_CHARS) text = text.slice(text.length - CONSOLE_TAIL_MAX_CHARS);
	const status = typeof frame.state === "string" ? frame.state : cur.status;
	const error = frame.error && typeof frame.error === "object" ? { code: frame.error.code, message: frame.error.message } : null;
	return {
		...cur,
		status,
		worker: typeof frame.worker === "string" ? frame.worker : cur.worker,
		nodeId: typeof frame.nodeId === "string" ? frame.nodeId : cur.nodeId,
		text,
		nextOffset: typeof frame.nextOffset === "number" ? frame.nextOffset : cur.nextOffset,
		oldestOffset: typeof frame.oldestOffset === "number" ? frame.oldestOffset : cur.oldestOffset,
		dropped: frame.dropped === true,
		retained: status === "ended-with-retained-backlog",
		error,
	};
}

/** The honest banner for a console state (label + detail, never a fake terminal). */
export function consoleBanner(state) {
	const s = state && typeof state === "object" ? state : initialConsoleState(0);
	const message = s.error && typeof s.error.message === "string" ? s.error.message : "";
	if (s.status === "live") return { state: s.status, label: "live", detail: "", retained: false, text: s.text || "" };
	if (s.status === "ended") return { state: s.status, label: "ended", detail: "worker ended; the backend retains no console history", retained: false, text: s.text || "" };
	if (s.status === "ended-with-retained-backlog") return { state: s.status, label: "ended (backlog retained)", detail: "worker ended; the backend still retains its console history", retained: true, text: s.text || "" };
	if (s.status === "unavailable") return { state: s.status, label: "unavailable", detail: message || "the backend exposes no console stream", retained: false, text: s.text || "" };
	if (s.status === "refused") return { state: s.status, label: "unavailable", detail: "not owned by this session (foreign fleet or unknown worker)", retained: false, text: s.text || "" };
	if (s.status === "error") return { state: s.status, label: "error", detail: message || "console read failed", retained: false, text: s.text || "" };
	return { state: "loading", label: "loading", detail: "", retained: false, text: s.text || "" };
}

/**
 * Drive the live-tail WebSocket with offset resume.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts — {url (query-less console stream URL), offset, connect(url) →
 *   WebSocket-like, schedule(fn, ms), delayMs, onFrame(frame), onState(state)}
 * Output: { get state(), get offset(), close(), _reconnect() }
 * Guarantees: every valid text frame is parsed and handed to onFrame; the
 *   socket reconnects at the last nextOffset after a close while non-terminal;
 *   a terminal state stops reconnecting; close() is final; never throws out
 *   of a socket callback.
 * Raises: never
 */
export function createConsoleTail(opts) {
	const baseUrl = opts.url;
	const delayMs = typeof opts.delayMs === "number" ? opts.delayMs : 1000;
	const connect = opts.connect || ((target) => new WebSocket(target));
	const schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
	const onFrame = opts.onFrame || (() => {});
	const onState = opts.onState || (() => {});
	let offset = typeof opts.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
	let status = "connecting";
	let socket = null;
	let closed = false;

	const emit = (next) => {
		status = next;
		try {
			onState(next);
		} catch {
			/* a listener failure never breaks the tail */
		}
	};

	const open = () => {
		if (closed) return;
		emit("connecting");
		let ws;
		try {
			ws = connect(`${baseUrl}?offset=${offset}`);
		} catch {
			emit("closed");
			schedule(open, delayMs);
			return;
		}
		socket = ws;
		ws.onopen = () => emit("open");
		ws.onmessage = (event) => {
			let frame = null;
			try {
				frame = JSON.parse(event && event.data);
			} catch {
				return;
			}
			if (!frame || typeof frame !== "object") return;
			if (frame.ok === true && typeof frame.nextOffset === "number") offset = frame.nextOffset;
			const nextStatus = frame.ok !== true && frame.error && frame.error.code === "E_CONSOLE_WORKER_REFUSED" ? "refused" : frame.ok === true ? frame.state : "error";
			emit(nextStatus);
			try {
				onFrame(frame);
			} catch {
				/* a listener failure never breaks the tail */
			}
		};
		ws.onclose = () => {
			if (closed || isTerminalConsoleStatus(status)) return;
			emit("closed");
			schedule(open, delayMs);
		};
		ws.onerror = () => {
			/* onclose owns the reconnect */
		};
	};

	open();

	return {
		get state() {
			return status;
		},
		get offset() {
			return offset;
		},
		close() {
			closed = true;
			if (socket && typeof socket.close === "function") {
				try {
					socket.close();
				} catch {
					/* already closed */
				}
			}
		},
		/** Test seam: invoke the pending reconnect now. */
		_reconnect: open,
	};
}