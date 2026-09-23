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
import { SWARM_HTTP_SCHEMA_VERSION } from "./http1.ts";
import { decodeClientFrame, encodeCloseFrame, encodePongFrame, encodeTextFrame, wsHandshakeResponse } from "./ws.ts";
import { emptyGraph } from "../swarm/graph.ts";
import { parseAfterCursor } from "../swarm/events.ts";
import { SwarmError } from "../swarm/result.ts";

interface StreamConnection {
	socket: Socket;
	/** This connection's consumed cursor (seq of the last delivered row). */
	cursor: number;
}

export interface StreamHubDeps {
	/** The session's ONE long-lived journal reader (absent → no event frames). */
	journal?: { eventsAfter(cursor: number): Array<{ seq: number }> };
	/** Builds the snapshot payload (the HTTP snapshot route's own builder). */
	buildSnapshot: () => Promise<unknown>;
	/** Cursor poll interval (default 500 ms; tests tighten it). */
	pollMs?: number;
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
		if (req.path !== "/api/swarm/stream") return false;
		let cursor: number;
		try {
			cursor = parseAfterCursor(req.query.get("after") ?? undefined);
		} catch (err) {
			if (err instanceof SwarmError) return false;
			return false;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string" || key.length === 0) return false;

		socket.write(wsHandshakeResponse(key));
		const conn: StreamConnection = { socket, cursor };
		this.connections.add(conn);
		socket.on("close", () => this.connections.delete(conn));
		socket.on("error", () => {
			this.connections.delete(conn);
			socket.destroy();
		});
		socket.on("data", (chunk: Buffer) => this.onClientData(conn, chunk));

		void this.sendSnapshotFrame(conn);
		this.ensureTimer();
		return true;
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
				const rows = journal.eventsAfter(conn.cursor);
				if (rows.length === 0) continue;
				const after = conn.cursor;
				conn.cursor = rows[rows.length - 1].seq;
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
