/**
 * pi-delegate — src/swarm-server/http1.ts — a minimal, dependency-free
 * HTTP/1.1 server core on node:net for the session-hosted swarm read server
 * (issue #50, ARCHITECTURE §4.2).
 *
 * MODULE_CONTRACT — the transport substrate under src/swarm-server/server.ts:
 * accept TCP connections on 127.0.0.1 ONLY (the §4.2 loopback trust model is
 * a CONSTANT here, not an option — fail-closed), parse one HTTP/1.1 request
 * head per connection, hand it to the injected request handler (plain
 * requests) or upgrade hook (WebSocket), and write one JSON response per
 * request with `Connection: close` semantics (one request per connection in
 * v1 — the read API's clients poll or stream; keep-alive is not negotiated).
 *
 * WHY hand-rolled (Law 1 "import, never reimplement" does not apply — the
 * platform offers no server-side WebSocket): node:http's `upgrade` event
 * writes are silently DROPPED under bun 1.3.x (the repo's check runtime —
 * probes 2026-09-23: the 101 handshake never reaches the client), while the
 * same code is green under node 22 (the extension runtime). A hand-rolled
 * core over node:net is the ONE spelling that runs identically in both; the
 * alternative (the `ws` npm package) is an avoidable runtime dependency
 * (repo rule: dependencies only when zero-dep is genuinely impossible). The
 * protocol subset is bounded: GET-only routes, no request bodies, one
 * response per connection, no chunked encoding, no keep-alive.
 *
 * Dependencies: node:net, node:crypto (nothing above src/ — a leaf).
 *
 * Critical invariants:
 *   - binds 127.0.0.1 ONLY (loopback constant; no host parameter exists);
 *   - TOTAL at the boundary: a malformed/oversized request head yields a
 *     structured 400/431 response and a closed socket, never a crash of the
 *     server process (Law 8 — the server is advisory to the pipeline);
 *   - every plain response carries Content-Length + Connection: close and
 *     the socket closes after the write drains;
 *   - an upgrade hook that returns false gets a 400 response and a closed
 *     socket (the WS module owns everything after a true return).
 */

import { createServer, type Server, type Socket } from "node:net";

/** The loopback bind constant (§4.2 trust model — not configurable). */
export const SWARM_SERVER_BIND_HOST = "127.0.0.1";

/** One parsed HTTP/1.1 request head (no body parsing — the API is GET-only). */
export interface Http1Request {
	method: string;
	/** The request-target path (before "?"). */
	path: string;
	/** The decoded query string (never null). */
	query: URLSearchParams;
	/** Header names lowercased, values verbatim (last write wins). */
	headers: Record<string, string>;
}

/** A handler response: status + optional body (already-serialized JSON). */
export interface Http1Response {
	status: number;
	body?: string;
	contentType?: string;
}

export interface Http1ServerHandle {
	/** The bound port (an OS-assigned number when 0 was requested). */
	port: number;
	/** Always 127.0.0.1 (the loopback constant). */
	address: string;
	/** Close the listener and destroy every open socket (idempotent). */
	close(): void;
}

/** Request-head cap: a bigger head is a 431 + close, never a buffer risk. */
const MAX_HEAD_BYTES = 16 * 1024;

/** Idle-socket deadline: a connection that sends nothing gets destroyed. */
const IDLE_TIMEOUT_MS = 30_000;

export interface Http1ServerOptions {
	/** Requested port; 0 = OS-assigned. */
	port: number;
	/** Plain-request router (sync or async; every response is JSON-shaped). */
	onRequest: (req: Http1Request) => Http1Response | Promise<Http1Response>;
	/** Upgrade hook: return true when the socket was taken over (WS); false
	 *  → the core writes a 400 and closes. Absent → every upgrade 400s. */
	onUpgrade?: (req: Http1Request, socket: Socket, head: Buffer) => boolean;
}

function statusText(status: number): string {
	switch (status) {
		case 200:
			return "OK";
		case 400:
			return "Bad Request";
		case 404:
			return "Not Found";
		case 405:
			return "Method Not Allowed";
		case 431:
			return "Request Header Fields Too Large";
		case 500:
			return "Internal Server Error";
		default:
			return "Status";
	}
}

/** Serialize + send one plain response, then half-close the socket. */
function writeResponse(socket: Socket, res: Http1Response): void {
	const body = res.body ?? "";
	const head =
		`HTTP/1.1 ${res.status} ${statusText(res.status)}\r\n` +
		`Content-Type: ${res.contentType ?? "application/json"}\r\n` +
		`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
		`Connection: close\r\n\r\n`;
	socket.write(head + body, "utf8", () => {
		socket.end();
	});
}

/** Parse a request head (head = everything before \r\n\r\n). Returns null on malformed. */
export function parseRequestHead(head: string): Http1Request | null {
	const lines = head.split("\r\n");
	const requestLine = lines[0] ?? "";
	const parts = requestLine.split(" ");
	if (parts.length !== 3 || parts[0].length === 0 || !parts[2].startsWith("HTTP/")) return null;
	const method = parts[0];
	const target = parts[1];
	const qAt = target.indexOf("?");
	const path = qAt === -1 ? target : target.slice(0, qAt);
	const query = new URLSearchParams(qAt === -1 ? "" : target.slice(qAt + 1));
	const headers: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		if (line.length === 0) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) return null;
		headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
	}
	return { method, path, query, headers };
}

/**
 * Start the loopback HTTP/1.1 core.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts — port + the request router + the optional upgrade hook
 * Output: the bound handle { port, address, close() }
 * Guarantees:
 *   - resolves ONLY after the listener is bound on 127.0.0.1; rejects on any
 *     bind failure (the mount layer decides fallback/abort — advisory, Law 8)
 *   - never throws into the process: per-socket failures destroy that socket
 * Raises: rejects with the underlying Error on listen failure
 */
export function startHttp1Server(opts: Http1ServerOptions): Promise<Http1ServerHandle> {
	const sockets = new Set<Socket>();
	let closed = false;

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());

		let headBuf = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			if (closed) return;
			headBuf = Buffer.concat([headBuf, chunk]);
			const sep = headBuf.indexOf("\r\n\r\n");
			if (sep === -1) {
				if (headBuf.length > MAX_HEAD_BYTES) {
					writeResponse(socket, { status: 431, body: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_USAGE","message":"request head too large","hint":"The read API accepts small GET request heads only."}}' });
				}
				return;
			}
			const head = headBuf.subarray(0, sep).toString("utf8");
			const rest = Buffer.from(headBuf.subarray(sep + 4));
			socket.removeAllListeners("data");
			const req = parseRequestHead(head);
			if (req === null) {
				writeResponse(socket, { status: 400, body: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_USAGE","message":"malformed HTTP request head","hint":"The read API accepts well-formed HTTP/1.1 GET request heads only."}}' });
				return;
			}
			const wantsUpgrade =
				(req.headers.upgrade ?? "").toLowerCase().includes("websocket") &&
				(req.headers.connection ?? "").toLowerCase().includes("upgrade");
			if (wantsUpgrade && opts.onUpgrade) {
				const taken = opts.onUpgrade(req, socket, rest);
				if (!taken) {
					writeResponse(socket, { status: 400, body: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_USAGE","message":"websocket upgrade refused","hint":"Only /api/swarm/stream speaks WebSocket; other paths are plain GET."}}' });
				}
				return;
			}
			if (wantsUpgrade && !opts.onUpgrade) {
				writeResponse(socket, { status: 400, body: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_USAGE","message":"websocket upgrade refused","hint":"Only /api/swarm/stream speaks WebSocket; other paths are plain GET."}}' });
				return;
			}
			void Promise.resolve(opts.onRequest(req))
				.then((res) => writeResponse(socket, res))
				.catch(() =>
					writeResponse(socket, {
						status: 500,
						body: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_IO","message":"internal server error","hint":"The read server could not serve this request; retry or check the orchestrator log."}}',
					}),
				);
		});
	});

	return new Promise<Http1ServerHandle>((resolve, reject) => {
		server.once("error", (err: Error) => reject(err));
		server.listen(opts.port, SWARM_SERVER_BIND_HOST, () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
			resolve({
				port,
				address: SWARM_SERVER_BIND_HOST,
				close() {
					if (closed) return;
					closed = true;
					for (const s of sockets) s.destroy();
					sockets.clear();
					server.close(() => {
						/* advisory — close completion is not awaited by callers */
					});
				},
			});
		});
	});
}
