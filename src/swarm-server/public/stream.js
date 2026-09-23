/**
 * stream.js — the dashboard's WS client state machine (issue #53).
 *
 * The stream endpoint pushes one `snapshot` frame on connect, then `events`
 * frames. `reduceFrame` is a pure reducer (never mutates): it folds a frame
 * into { snapshot, events, lastSeq, state }, deduplicating strictly by `seq`
 * so a batch is never applied twice and a gap is never invented. `createSwarmStream`
 * drives a WebSocket over an injectable `connect` seam, exposes the live
 * connection state, and on disconnect RECONNECTS with `after=<lastSeq>` —
 * cursor-resume: no duplicated and no lost updates, by construction.
 *
 * No framework, plain ES module.
 *
 * VERSION NEGOTIATION (issue #55, Law 7): the server stamps every frame with
 * `schemaVersion: 1` and only ever ADDS fields. This client therefore
 * (a) ignores unknown fields and (b) checks `schemaVersion` — a frame whose
 * version this build does not support is ignored (a no-op), never applied or
 * half-read; a missing `schemaVersion` is legacy v1 and stays accepted (the
 * repo's on-disk tolerance convention).
 */

/** The stream frame contract version this client supports (Law 7). */
export const SUPPORTED_STREAM_SCHEMA_VERSION = 1;

/** The initial state for a stream resuming after `after` (default 0). */
export function initialStreamState(after = 0) {
	return { snapshot: null, events: [], lastSeq: typeof after === "number" && after > 0 ? after : 0, state: "connecting" };
}

function parseFrame(data) {
	if (typeof data !== "string") return null;
	try {
		const frame = JSON.parse(data);
		return frame && typeof frame === "object" ? frame : null;
	} catch {
		return null;
	}
}

/**
 * Fold one stream frame into the state.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: state — a stream state; frame — a decoded frame (or null/garbage)
 * Output: the next state (a NEW object; the input is never mutated)
 * Guarantees:
 *   - a malformed/unknown frame is a no-op (the input state);
 *   - `snapshot` frames replace the snapshot and open the stream;
 *   - `events` frames append only rows with seq > lastSeq, dedup by seq —
 *     no duplicates, no reordering, lastSeq is monotone;
 *   - never throws.
 * Raises: never
 */
export function reduceFrame(state, frame) {
	if (!frame || typeof frame !== "object" || frame.ok !== true) return state;
	if (frame.schemaVersion !== undefined && frame.schemaVersion !== SUPPORTED_STREAM_SCHEMA_VERSION) return state; // unsupported version: ignore (never half-read)
	if (frame.type === "snapshot") {
		return { ...state, snapshot: frame.snapshot, state: "open" };
	}
	if (frame.type === "events") {
		const rows = Array.isArray(frame.events) ? frame.events : [];
		let last = state.lastSeq;
		const added = [];
		for (const row of rows) {
			if (!row || typeof row.seq !== "number" || row.seq <= last) continue;
			last = row.seq;
			added.push(row);
		}
		if (added.length === 0) return { ...state, state: "open" };
		return { ...state, lastSeq: last, events: state.events.concat(added), state: "open" };
	}
	return state;
}

/** The absolute URL for a cursor (the reconnect spelling). */
export function streamUrl(baseUrl, after) {
	const sep = baseUrl.includes("?") ? "&" : "?";
	return `${baseUrl}${sep}after=${after}`;
}

/**
 * Drive a WebSocket with cursor-resume.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts —
 *   url: the stream endpoint (query-less or with its own query);
 *   after: the initial cursor;
 *   connect(url) → a WebSocket-like object (default: global WebSocket);
 *   onState(state) — connection-state callback (connect/connecting/open/closed);
 *   onFrame(frame, kind) — every valid frame ("snapshot" | "events");
 *   schedule(fn, ms) → a handle (default: setTimeout) for the reconnect delay;
 *   delayMs: reconnect delay (default 1000)
 * Output: { state (live getter), close(), _reconnect() (test seam) }
 * Guarantees: reconnect preserves the cursor; close() stops reconnecting;
 *   never throws out of socket callbacks
 * Raises: never
 */
export function createSwarmStream(opts) {
	const url = opts.url;
	const delayMs = typeof opts.delayMs === "number" ? opts.delayMs : 1000;
	const connect = opts.connect || ((target) => new WebSocket(target));
	const schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
	const onState = opts.onState || (() => {});
	const onFrame = opts.onFrame || (() => {});
	let state = initialStreamState(opts.after);
	let socket = null;
	let closed = false;

	const emitState = (next) => {
		state = { ...state, state: next };
		try {
			onState(next, state);
		} catch {
			/* a listener failure never breaks the stream */
		}
	};

	const open = () => {
		if (closed) return;
		emitState(state.snapshot ? "reconnecting" : "connecting");
		let ws;
		try {
			ws = connect(streamUrl(url, state.lastSeq));
		} catch {
			emitState("closed");
			schedule(open, delayMs);
			return;
		}
		socket = ws;
		ws.onopen = () => emitState("open");
		ws.onmessage = (event) => {
			const frame = parseFrame(event && event.data);
			if (frame === null) return;
			const next = reduceFrame(state, frame);
			if (next === state) return;
			state = next;
			try {
				onFrame(frame, frame.type);
			} catch {
				/* a listener failure never breaks the stream */
			}
		};
		ws.onclose = () => {
			if (closed) return;
			emitState("closed");
			schedule(open, delayMs);
		};
		ws.onerror = () => {
			/* onclose owns the reconnect */
		};
	};

	open();

	return {
		get state() {
			return state;
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