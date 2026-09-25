/**
 * stream.js — the dashboard's WS client state machine (issue #53).
 *
 * The stream endpoint pushes one `snapshot` frame on connect, then `events`
 * frames. This module also owns the shared wire helpers the app's HTTP read
 * doors use: `readEnvelope` (#89 — non-2xx/`ok:false` becomes a structured
 * error) and the bounded event store `foldEventStore` (#88).
 *
 * `reduceFrame` is a pure reducer (never mutates): it folds a frame
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

/** The bounded client event store size (issue #88): the fold keeps only the
 *  last N journal rows instead of growing without bound. */
export const MAX_EVENT_STORE = 1000;

/** The structural journal kinds (issue #88): a frame carrying one of these
 *  changes the graph's node set, so the app refreshes the full snapshot; every
 *  other kind patches the existing model in place. */
export const STRUCTURAL_EVENT_KINDS = Object.freeze(["spawn", "collect", "retire"]);

/** Does an events frame carry a structural kind? */
export function isStructuralEventFrame(rows) {
	return Array.isArray(rows) && rows.some((row) => row && typeof row === "object" && STRUCTURAL_EVENT_KINDS.includes(row.kind));
}

/**
 * Fold a batch into a BOUNDED event store (issue #88): append-only, dedup by
 * `seq` against the store's last row, keep at most `max` rows. Pure; returns a
 * NEW array (the input is never mutated). Rows are seq-ascending per batch
 * (the wire orders them), so no full re-sort is needed.
 * <p>
 * FUNCTION_CONTRACT: Input — existing (array), rows (array), max (number).
 * Output — the bounded next store. Guarantees: seq monotone, no duplicates,
 * never longer than `max`; a malformed row is skipped; never throws.
 */
export function foldEventStore(existing, rows, max = MAX_EVENT_STORE) {
	const out = Array.isArray(existing) ? existing.slice() : [];
	let last = out.length > 0 && typeof out[out.length - 1].seq === "number" ? out[out.length - 1].seq : -Infinity;
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!row || typeof row.seq !== "number" || row.seq <= last) continue;
		out.push(row);
		last = row.seq;
	}
	return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * Read one HTTP read-door response into a validated envelope (issue #89): a
 * non-2xx status or an `ok:false` body becomes a structured Error carrying the
 * server envelope's code/message/hint plus the operation label. Total — a
 * non-JSON body is a structured error too, never a silent blank screen.
 * <p>
 * FUNCTION_CONTRACT: Input — res (fetch Response-like), op (operation label).
 * Output — { body, error } (exactly one of the two is meaningful).
 */
export async function readEnvelope(res, op) {
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (res && res.ok !== false && body && body.ok === true) return { body, error: null };
	const env = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : {};
	const err = new Error([op, env.code, env.message, env.hint].filter(Boolean).join(" \u2014 ") || `${op || "request"} failed (HTTP ${res && res.status})`);
	err.op = op || "request";
	err.code = typeof env.code === "string" ? env.code : null;
	err.hint = typeof env.hint === "string" ? env.hint : null;
	err.status = res ? res.status : null;
	return { body, error: err };
}

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