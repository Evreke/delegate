/**
 * pi-delegate — src/swarm-server/stream.ts — the WS stream endpoint
 * `/api/swarm/stream?after=<seq>` (issue #50, ARCHITECTURE §4.2, Law 13).
 *
 * MODULE_CONTRACT — the push half of the read API. On connect: ONE snapshot
 * frame (the same graph the HTTP snapshot route builds — one spelling), then
 * event frames as the session journal's cursor advances: a shared poll timer
 * (pollMs, default 500 ms) reads the session's ONE long-lived reader
 * (./journal-session.ts) per connection cursor and pushes every new row.
 * Frame protocol (v1, additive-only, Law 7 — every frame is a JSON envelope
 * carrying schemaVersion):
 *
 *   {"ok":true,"schemaVersion":1,"type":"snapshot","snapshot":{…SwarmGraph}}
 *   {"ok":true,"schemaVersion":1,"type":"events","after":N,"events":[…rows]}
 *
 * `after` in an events frame is the cursor the rows FOLLOW (the connection's
 * cursor before this batch — the same semantics as the events endpoint's
 * `after`). Ordering by `seq` is preserved per connection: the reader orders
 * ascending and the cursor never rewinds. Cursor-resume: a client reconnects
 * with `?after=<last consumed seq>` and receives exactly the rows after it.
 *
 * Client frames: PING → PONG; CLOSE → CLOSE + socket end; TEXT/BINARY are
 * parsed and ignored (v1 defines no client→server messages). Malformed
 * frames close the connection (never the server — Law 8).
 *
 * Dependencies: ./ws.ts (codec), ./http1.ts (types only), ../swarm/graph.ts
 * (emptyGraph — the never-throws snapshot fallback), ../swarm/events.ts
 * (parseAfterCursor — the ONE cursor spelling). Fleet state enters ONLY via
 * the read-model builder injected by the caller (Law 13).
 *
 * Critical invariants:
 *   - ONE snapshot frame per connection, always the FIRST frame;
 *   - a connection's event batches are strictly seq-increasing, no replays;
 *   - a throwing/absent journal degrades to "no event frames" (the snapshot
 *     still flows) — never a disconnect, never a server crash;
 *   - hub.close() stops the timer; sockets are owned/closed by the http1
 *     core's close (the hub only drops its registrations).
 */

import type { Socket } from "node:net";
import type { Http1Request } from "./http1.ts";
import { errorEnvelope, SWARM_FLEET_NOT_FOUND_HINT, SWARM_HTTP_SCHEMA_VERSION, writeHttp1Response } from "./http1.ts";
import { decodeClientFrame, encodeCloseFrame, encodePongFrame, encodeTextFrame, wsHandshakeResponse } from "./ws.ts";
import { emptyGraph } from "../swarm/graph.ts";
import { JOURNAL_EVENTS_PAGE_LIMIT } from "../swarm/journal-read.ts";
import { parseAfterCursor } from "../swarm/events.ts";
import { SwarmError } from "../swarm/result.ts";

interface StreamConnection {
	socket: Socket;
	/** This connection's consumed cursor (seq of the last delivered row). */
	cursor: number;
	/** Fleet scope (issue #65 item 3): the tasks of the fleet a scoped stream
	 *  serves; `null` for the v1 unscoped `/api/swarm/stream`. A scoped
	 *  connection never emits a foreign fleet's event (attention never crosses
	 *  fleets — the per-audience cursor precedent). */
	tasks: ReadonlySet<string> | null;
}

/** The fleet-scoped stream path shape (issue #65 item 3). */
export const FLEET_STREAM_RE = /^\/fleets\/([^/]+)\/api\/swarm\/stream$/;

export interface StreamHubDeps {
	/** The session's ONE long-lived journal reader (absent → no event frames). */
	journal?: { eventsAfter(cursor: number, query?: { sessionId?: string; task?: string; worker?: string; limit?: number }): Array<{ seq: number; task?: string }> };
	/** Builds the snapshot payload (the HTTP snapshot route's own builder). */
	buildSnapshot: () => Promise<unknown>;
	/** Cursor poll interval (default 500 ms; tests tighten it). */
	pollMs?: number;
	/** Resolve a fleet's task set for a scoped stream path (issue #65 item 3).
	 *  Returns null when the fleet is unknown (the connection is refused). */
	scopeFor?: (sessionId: string) => Promise<ReadonlySet<string> | null> | ReadonlySet<string> | null;
}

/** The default poll interval — documented in README (§ stream). */
export const STREAM_DEFAULT_POLL_MS = 500;

export class StreamHub {
	private readonly deps: StreamHubDeps;
	private readonly connections = new Set<StreamConnection>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	constructor(deps: StreamHubDeps) {
		this.deps = deps;
	}

	/**
	 * Handle one upgrade request. Returns true when the socket was taken
	 * over (101 written); false → the http1 core answers 400 + closes.
	 * <p>
	 * FUNCTION_CONTRACT:
	 * Input: req — the parsed upgrade request head; socket; head bytes
	 * Output: true (stream taken over) | false (not the stream path, bad
	 *   cursor, or missing key — refused)
	 * Guarantees: never throws; a refused socket is NOT written to here
	 * Raises: never
	 */
	handleUpgrade(req: Http1Request, socket: Socket, _head: Buffer): boolean {
		if (this.closed) return false;
		const unscoped = req.path === "/api/swarm/stream";
		const fleet = unscoped ? null : FLEET_STREAM_RE.exec(req.path);
		if (!unscoped && (fleet === null || this.deps.scopeFor === undefined)) return false;
		let cursor: number;
		try {
			cursor = parseAfterCursor(req.query.get("after") ?? undefined);
		} catch (err) {
			if (err instanceof SwarmError) return false;
			return false;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string" || key.length === 0) return false;

		if (fleet !== null) {
			// The fleet scope needs the read-model (Law 13) — resolve it BEFORE the
			// 101 handshake; an unknown fleet is a plain HTTP 404 (never a
			// fabricated stream).
			void this.attachScoped(socket, cursor, decodeURIComponent(fleet[1]), key);
			return true;
		}

		this.register(socket, cursor, null, key);
		return true;
	}

	/** Deferred scoped attach: resolve the fleet's tasks, then handshake. */
	private async attachScoped(socket: Socket, cursor: number, sessionId: string, key: string): Promise<void> {
		let tasks: ReadonlySet<string> | null = null;
		try {
			tasks = (await this.deps.scopeFor?.(sessionId)) ?? null;
		} catch {
			tasks = null;
		}
		if (tasks === null) {
			if (!socket.destroyed) {
				writeHttp1Response(socket, errorEnvelope(404, "E_SWARM_NOT_FOUND", `no such fleet ${JSON.stringify(sessionId)}`, SWARM_FLEET_NOT_FOUND_HINT));
			}
			return;
		}
		if (this.closed) {
			socket.destroy();
			return;
		}
		this.register(socket, cursor, tasks, key);
	}

	/** Write the handshake, register the connection and start the poll timer. */
	private register(socket: Socket, cursor: number, tasks: ReadonlySet<string> | null, key: string): void {
		socket.write(wsHandshakeResponse(key));
		const conn: StreamConnection = { socket, cursor, tasks };
		this.connections.add(conn);
		socket.on("close", () => this.connections.delete(conn));
		socket.on("error", () => {
			this.connections.delete(conn);
			socket.destroy();
		});
		socket.on("data", (chunk: Buffer) => this.onClientData(conn, chunk));

		void this.sendSnapshotFrame(conn);
		this.ensureTimer();
	}

	/** Stop the poll timer and drop registrations (idempotent). */
	close(): void {
		this.closed = true;
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.connections.clear();
	}

	private ensureTimer(): void {
		if (this.timer !== null || this.closed) return;
		this.timer = setInterval(() => this.tick(), this.deps.pollMs ?? STREAM_DEFAULT_POLL_MS);
		// The timer must never hold the session open on its own (stop() clears it;
		// unref keeps an otherwise-idle process exitable).
		this.timer.unref?.();
	}

	private async sendSnapshotFrame(conn: StreamConnection): Promise<void> {
		let snapshot: unknown;
		try {
			snapshot = await this.deps.buildSnapshot();
		} catch {
			snapshot = emptyGraph(); // the never-throws fallback (graph.ts)
		}
		this.writeFrame(conn, { ok: true, schemaVersion: SWARM_HTTP_SCHEMA_VERSION, type: "snapshot", snapshot });
	}

	private tick(): void {
		const journal = this.deps.journal;
		if (!journal) return;
		for (const conn of this.connections) {
			try {
				// #88: one frame never carries the whole journal — page the cursor by
				// the explicit read limit; the next tick continues from `last`.
				const raw = journal.eventsAfter(conn.cursor, { limit: JOURNAL_EVENTS_PAGE_LIMIT });
				if (raw.length === 0) continue;
				const last = raw[raw.length - 1].seq;
				// Fleet scope (issue #65 item 3): the cursor advances past EVERY raw
				// row, but only this fleet's rows are ever written to the socket —
				// attention never crosses fleets.
				const rows = conn.tasks === null ? raw : raw.filter((r) => typeof r.task === "string" && conn.tasks?.has(r.task));
				const after = conn.cursor;
				conn.cursor = last;
				if (rows.length === 0) continue;
				this.writeFrame(conn, { ok: true, schemaVersion: SWARM_HTTP_SCHEMA_VERSION, type: "events", after, events: rows });
			} catch {
				// one connection's read failure never touches the others (Law 8)
			}
		}
	}

	private writeFrame(conn: StreamConnection, frame: Record<string, unknown>): void {
		if (conn.socket.destroyed || this.closed) return;
		conn.socket.write(encodeTextFrame(JSON.stringify(frame)));
	}

	private onClientData(conn: StreamConnection, chunk: Buffer): void {
		let buf = chunk;
		for (;;) {
			const decoded = decodeClientFrame(buf);
			if (decoded === null) return;
			if (decoded === "malformed") {
				this.connections.delete(conn);
				conn.socket.destroy();
				return;
			}
			buf = buf.subarray(decoded.consumed);
			if (decoded.opcode === 0x9) {
				if (!conn.socket.destroyed) conn.socket.write(encodePongFrame(decoded.payload));
			} else if (decoded.opcode === 0x8) {
				this.connections.delete(conn);
				if (!conn.socket.destroyed) conn.socket.write(encodeCloseFrame());
				conn.socket.end();
				return;
			}
			// text/binary/continuation from the client: parsed, ignored (v1)
		}
	}
}
