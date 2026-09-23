/**
 * pi-delegate — src/swarm-server/console-ws.ts — the worker-console WebSocket
 * hub (issue #52, ARCHITECTURE §4.2.4, Law 7/Law 8).
 *
 * MODULE_CONTRACT — the push half of the console endpoint
 * (`WS /api/workers/:id/console/stream?offset=<n>`): once per connection it
 * resolves the worker through the SAME fail-closed gate as the REST route
 * (./console.ts), writes the RFC 6455 handshake itself, then pushes the SAME
 * frame as REST whenever new transcript text appears or the state changes.
 *
 *   {ok, schemaVersion, worker, nodeId, task?, state, chunk, nextOffset,
 *    oldestOffset, dropped, error?}
 *
 * Refusals and usage errors are answered with a PLAIN HTTP error envelope
 * (no 101) so a client sees the structured E_* code; the FIRST frame always
 * flows (a captureless backend gets exactly one `state:"unavailable"` frame
 * with `E_CONSOLE_UNAVAILABLE`, then silence — never a fabricated stream).
 * Frames are emitted by one shared poll timer; the emit path is fully
 * guarded — a failing frame is a dropped frame, never a crash (advisory,
 * Law 8). Client PING → PONG and CLOSE → CLOSE per RFC 6455.
 *
 * Split out of ./console.ts (Law 5: the REST route and the WS hub are two
 * responsibilities); it reuses the route's resolution/frame helpers so there
 * is ONE spelling of the gate and the envelope (Law 9).
 */

import type { Socket } from "node:net";
import type { Http1Request } from "./http1.ts";
import { errorEnvelope, writeHttp1Response } from "./http1.ts";
import { decodeClientFrame, encodeCloseFrame, encodePongFrame, encodeTextFrame, wsHandshakeResponse } from "./ws.ts";
import { ConsoleCapture } from "./console-buffer.ts";
import {
	CONSOLE_REFUSED_HINT,
	CONSOLE_UNAVAILABLE_HINT,
	CONSOLE_USAGE_HINT,
	buildGraphFor,
	consoleFrame,
	deriveState,
	matchConsoleStreamPath,
	parseConsoleOffset,
	resolveConsoleTarget,
	type ConsoleRouteDeps,
	type ConsoleState,
	type ConsoleTarget,
} from "./console.ts";

/** Default poll interval (ms) — frames are pushed only when text or state
 *  changed, so this is a liveness cadence, not a bandwidth knob. */
export const CONSOLE_STREAM_DEFAULT_POLL_MS = 500;

interface ConsoleConnection {
	socket: Socket;
	target: ConsoleTarget;
	offset: number;
	state: ConsoleState;
	/** True once any frame was written (the first frame always flows). */
	framed: boolean;
	busy: boolean;
}

export interface ConsoleHubDeps {
	deps: ConsoleRouteDeps;
	capture: ConsoleCapture;
	pollMs?: number;
}

/**
 * The console WebSocket hub: one registration per client, pushed the SAME
 * frame as the REST route whenever new transcript text appears or the state
 * changes.
 */
export class ConsoleHub {
	private readonly connections = new Set<ConsoleConnection>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	constructor(private readonly hub: ConsoleHubDeps) {}

	/** Take over a console upgrade socket. Returns false when the path is not
	 *  ours (the core then 400s); true once this hub owns the socket. */
	handleUpgrade(req: Http1Request, socket: Socket, _head: Buffer): boolean {
		if (this.closed) return false;
		const rawId = matchConsoleStreamPath(req.path);
		if (rawId === null) return false;
		void this.serve(req, socket, rawId);
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

	private async serve(req: Http1Request, socket: Socket, rawId: string): Promise<void> {
		const readId = decodeURIComponent(rawId);
		const offset = parseConsoleOffset(req.query.get("offset") ?? undefined);
		if (offset === null) {
			writeHttp1Response(socket, errorEnvelope(400, "E_CONSOLE_USAGE", "invalid ?offset= value", CONSOLE_USAGE_HINT));
			socket.destroy();
			return;
		}
		const graph = await buildGraphFor(this.hub.deps);
		const resolved = resolveConsoleTarget(graph, readId, this.hub.deps.sessionFile, this.hub.deps.platform);
		if (!resolved.ok) {
			writeHttp1Response(socket, errorEnvelope(404, "E_CONSOLE_WORKER_REFUSED", resolved.message, CONSOLE_REFUSED_HINT));
			socket.destroy();
			return;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string" || key.length === 0) {
			writeHttp1Response(socket, errorEnvelope(400, "E_CONSOLE_USAGE", "missing Sec-WebSocket-Key", CONSOLE_USAGE_HINT));
			socket.destroy();
			return;
		}
		socket.write(wsHandshakeResponse(key));
		const conn: ConsoleConnection = { socket, target: resolved.target, offset, state: "unavailable", framed: false, busy: false };
		this.connections.add(conn);
		socket.on("close", () => this.connections.delete(conn));
		socket.on("error", () => {
			this.connections.delete(conn);
			socket.destroy();
		});
		socket.on("data", (chunk: Buffer) => this.onClientData(conn, chunk));
		await this.emit(conn);
		this.ensureTimer();
	}

	/** Send the next frame when there is anything new for this connection. */
	private async emit(conn: ConsoleConnection): Promise<void> {
		if (conn.busy || this.closed) return;
		conn.busy = true;
		try {
			const transport = this.hub.deps.transport;
			let state: ConsoleState;
			let chunk = "";
			let nextOffset = conn.offset;
			let oldestOffset = 0;
			let dropped = false;
			if (!transport || !ConsoleCapture.canCapture(transport)) {
				state = "unavailable";
			} else {
				state = await deriveState(transport, conn.target.name);
				if (state !== "ended") {
					const backlog = await this.hub.capture.ensure(conn.target.name);
					if (backlog === null) {
						state = "unavailable";
					} else {
						const read = backlog.read(conn.offset);
						chunk = read.chunk;
						nextOffset = read.nextOffset;
						oldestOffset = read.oldestOffset;
						dropped = read.dropped;
					}
				}
			}
			const changed = !conn.framed || chunk.length > 0 || dropped || state !== conn.state;
			if (!changed) return;
			conn.offset = nextOffset;
			conn.state = state;
			conn.framed = true;
			conn.socket.write(
				encodeTextFrame(
					consoleFrame(
						conn.target,
						state,
						{ chunk, nextOffset, oldestOffset, dropped },
						state === "unavailable" ? { code: "E_CONSOLE_UNAVAILABLE", message: "backend exposes no console stream" } : undefined,
					),
				),
			);
		} catch {
			// advisory — a failing frame is a dropped frame, never a crash
		} finally {
			conn.busy = false;
		}
	}

	private ensureTimer(): void {
		if (this.timer !== null || this.closed) return;
		this.timer = setInterval(() => {
			for (const conn of [...this.connections]) void this.emit(conn);
		}, this.hub.pollMs ?? CONSOLE_STREAM_DEFAULT_POLL_MS);
		this.timer.unref?.();
	}

	private onClientData(conn: ConsoleConnection, chunk: Buffer): void {
		const frame = decodeClientFrame(chunk);
		if (frame === null || frame === "malformed") return;
		if (frame.opcode === 0x9) conn.socket.write(encodePongFrame(frame.payload));
		else if (frame.opcode === 0x8) {
			conn.socket.write(encodeCloseFrame());
			conn.socket.end();
			this.connections.delete(conn);
		}
	}
}

