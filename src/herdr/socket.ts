/**
 * pi-delegate — src/herdr/socket.ts (NDJSON-over-unix-socket herdr client).
 *
 * Extracted verbatim from src/herdr/host.ts (ARCHITECTURE.md Law 5
 * decomposition). The section MODULE_CONTRACT below — timeout invariants, the
 * one-request-per-connection lifecycle and reconnect-once rule, the
 * HerdrSocketError code set — is this module's contract and moved with the
 * code, unchanged.
 *
 * Dependencies: node:net, node:os, node:path only — zero src/ imports, so the
 * socket client can never drag the seam or the CLI layer into a caller
 * (pinned by test/herdr-split-check.ts).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { connect as netConnect, type Socket } from "node:net";

// ============================================================================
// SECTION — herdr socket client (W3 read-only transport path)
// ============================================================================

/** NDJSON-over-unix-socket client for the herdr server's raw API.
 *
 * MODULE_CONTRACT (productionized from the leak-probe prototype, live-validated
 * against herdr 0.8.2):
 * Dependencies: node:net, node:os, node:path only.
 * Protocol (per /tmp/herdr-socket-api.mdx + live validation): newline-delimited
 *   JSON over ~/.config/herdr/herdr.sock; request {"id","method","params"};
 *   response {"id","result"} or {"id","error":{code,message}}; pushed events
 *   arrive as lines carrying an "event" key with the payload under "data".
 * Critical invariants:
 *   - every request has a hard timeout (default SOCKET_REQUEST_TIMEOUT_MS) — a
 *     hung server rejects the request, it can never hang a caller forever
 *   - connection establishment is bounded by SOCKET_CONNECT_TIMEOUT_MS
 *   - ZERO subprocesses: a frozen/dead server costs a bounded per-call error —
 *     never a spawned CLI child (the 2026-09-09 pile-up ammunition)
 *   - the server is ONE-REQUEST-PER-CONNECTION for plain requests (answers,
 *     then closes; only subscriptions keep a connection open — verified: a
 *     pipelined request #2 is never answered, the client sees ECONNRESET), so
 *     a plain-request close is the NORMAL lifecycle: the client transparently
 *     reconnects and retries exactly once; subscriptions live on their own
 *     connection state and a close there is a genuine failure (surfaced via
 *     onClose, never silently retried)
 * Error modes: HerdrSocketError with a stable `code` (connect_timeout,
 *   connect_error, request_timeout, connection_closed, or the server's own
 *   code, e.g. not_found) — mapped by callers into the E_* taxonomy.
 * EXTERNAL_DEPENDENCY: the herdr server's unix socket — $HERDR_SOCKET_PATH
 *   (herdr's documented low-level override) or ~/.config/herdr/herdr.sock.
 */

/** Default socket location (herdr docs; named sessions live under sessions/<name>/). */
export const DEFAULT_HERDR_SOCK = join(homedir(), ".config", "herdr", "herdr.sock");

/** Kill-switch for the W3 socket read-only path: HERDR_SOCKET_TRANSPORT=cli
 *  restores the all-CLI legacy behavior; unset/"auto"/"socket" → read-only ops
 *  (agent list/get) go over the unix socket with zero subprocesses. */
export const HERDR_SOCKET_TRANSPORT_ENV = "HERDR_SOCKET_TRANSPORT";

/** Per-request hard timeout (ms). A hung server rejects; it can never hang a caller. */
export const SOCKET_REQUEST_TIMEOUT_MS = 5_000;

/** Connection-establishment timeout (ms). */
export const SOCKET_CONNECT_TIMEOUT_MS = 5_000;

/** Error shape mirroring the E_* taxonomy style: typed, stable `code`, never a
 *  raw throw past the mapping layer (HerdrTransport maps these into E_*). */
export class HerdrSocketError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`herdr socket: ${code}: ${message}`);
		this.name = "HerdrSocketError";
		this.code = code;
	}
}

export interface HerdrSocketClientOptions {
	/** Unix socket path. Default: $HERDR_SOCKET_PATH or DEFAULT_HERDR_SOCK. */
	socketPath?: string;
	/** Per-request timeout in ms. Default SOCKET_REQUEST_TIMEOUT_MS. */
	requestTimeoutMs?: number;
	/** Connection-establishment timeout in ms. Default SOCKET_CONNECT_TIMEOUT_MS. */
	connectTimeoutMs?: number;
}

type SocketPendingEntry = {
	resolve: (value: unknown) => void;
	reject: (err: HerdrSocketError) => void;
	timer: NodeJS.Timeout;
};

type SocketEventHandler = (eventName: string, data: unknown) => void;

export class HerdrSocketClient {
	private readonly socketPath: string;
	private readonly requestTimeoutMs: number;
	private readonly connectTimeoutMs: number;
	private socket: Socket | null = null;
	private nextId = 1;
	private readonly pending = new Map<string, SocketPendingEntry>();
	private readonly eventHandlers = new Set<SocketEventHandler>();
	private buffer = "";
	private connecting: Promise<void> | null = null;
	private closedByUs = false;

	/** Liveness callback: fired once when a connection carrying subscriptions is
	 *  ended by the server (subscriptions are connection state — they die with
	 *  the connection; the owner must re-subscribe). */
	onSubscriptionLost: (() => void) | null = null;

	constructor(opts: HerdrSocketClientOptions = {}) {
		this.socketPath = opts.socketPath ?? process.env.HERDR_SOCKET_PATH ?? DEFAULT_HERDR_SOCK;
		this.requestTimeoutMs = opts.requestTimeoutMs ?? SOCKET_REQUEST_TIMEOUT_MS;
		this.connectTimeoutMs = opts.connectTimeoutMs ?? SOCKET_CONNECT_TIMEOUT_MS;
	}

	/** Establish (or reuse) the connection. Concurrent callers share one
	 *  in-flight connect (idempotent); bounded by connectTimeoutMs.
	 * Raises: HerdrSocketError "connect_timeout" / "connect_error". */
	connect(): Promise<void> {
		if (this.socket && !this.socket.destroyed) return Promise.resolve();
		if (this.connecting) return this.connecting;
		this.closedByUs = false;
		this.connecting = new Promise<void>((resolve, reject) => {
			const sock = netConnect(this.socketPath);
			const connectTimer = setTimeout(() => {
				sock.destroy();
				this.connecting = null;
				reject(new HerdrSocketError("connect_timeout", `no connection to ${this.socketPath} within ${this.connectTimeoutMs}ms`));
			}, this.connectTimeoutMs);
			(connectTimer as unknown as { unref?: () => void }).unref?.();
			sock.once("connect", () => {
				clearTimeout(connectTimer);
				this.socket = sock;
				this.buffer = "";
				sock.setEncoding("utf8");
				sock.on("data", (chunk: string) => this.onData(chunk));
				sock.on("error", (err: Error) => this.onSocketError(err));
				sock.on("close", () => this.onSocketClose());
				this.connecting = null;
				resolve();
			});
			sock.once("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(connectTimer);
				this.connecting = null;
				reject(new HerdrSocketError("connect_error", `${err.code ?? "error"} on ${this.socketPath}`));
			});
		});
		return this.connecting;
	}

	/** Send one request and await its response (multiplexed by id).
	 *
	 * FUNCTION_CONTRACT:
	 * Input: method — dot-notation herdr method ("agent.list", "agent.get"…);
	 *   params — request params; timeoutMs — hard per-request cap
	 * Output: the parsed `result` payload of the matching response
	 * Guarantees:
	 *   - NEVER hangs: settles on response / timeout / error response /
	 *     connection loss; the pending entry is always cleaned up
	 *   - one transparent reconnect+retry when the server ends the one-shot
	 *     plain-request lifecycle (connection_closed without an acked
		*     subscription) — including the write-races-close window
	 * Raises:
	 *   - HerdrSocketError "request_timeout" — no response within timeoutMs
	 *   - HerdrSocketError "<server code>" — server error body (e.g. not_found)
	 *   - HerdrSocketError "connection_closed" — socket dropped
	 */
	async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			await this.connect();
			const sock = this.socket;
			if (!sock || sock.destroyed) throw new HerdrSocketError("connection_closed", "socket not open");
			const id = `rq-${this.nextId++}`;
			const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
			try {
				return await new Promise<T>((resolve, reject) => {
					const timer = setTimeout(() => {
						this.pending.delete(id);
						reject(new HerdrSocketError("request_timeout", `${method} got no response within ${effectiveTimeout}ms`));
					}, effectiveTimeout);
					(timer as unknown as { unref?: () => void }).unref?.();
					this.pending.set(id, {
						resolve: (v) => {
							clearTimeout(timer);
							resolve(v as T);
						},
						reject: (e) => {
							clearTimeout(timer);
							reject(e);
						},
						timer,
					});
					sock.write(JSON.stringify({ id, method, params }) + "\n");
				});
			} catch (err) {
				// One-shot plain-request lifecycle (see section invariant): a
				// connection_closed on a subscription-less connection is NORMAL —
				// transparently reconnect and retry exactly once. With an active
				// subscription the connection is supposed to persist, so a close there
				// is a genuine failure and is NOT retried. Covers subscribe() too: its
				// handler is registered before the send, but no ack arrived → the
				// subscription does not exist server-side and the resend is safe.
				const closed = err instanceof HerdrSocketError && err.code === "connection_closed";
				if (closed && attempt === 0 && this.eventHandlers.size === 0) {
					this.socket = null;
					continue;
				}
				throw err;
			}
		}
	}

	/** events.subscribe: open a subscription; pushed events go to onEvent. The
	 *  subscription lives on the connection (server-side state) — if the server
	 *  ends it, onSubscriptionLost fires once and handlers are cleared.
	 * Raises: same as request() (subscribe IS a request; its ack is bounded by
	 *  the per-request timeout). NOTE (live-validated): the server REJECTS a
	 *  subscription entry missing fields the type requires — e.g.
	 *  pane.agent_status_changed needs pane_id even though the bundled schema
	 *  marks it optional; broad types (pane.updated, …) need only {type}. */
	async subscribe(subscriptions: Array<{ type: string; pane_id?: string }>, onEvent: SocketEventHandler): Promise<unknown> {
		// Connect FIRST: plain-request connections are one-shot, so the subscribe
		// must go out on a connection that is alive NOW — otherwise the send races
		// the already-closed socket.
		await this.connect();
		this.eventHandlers.add(onEvent);
		try {
			return await this.request("events.subscribe", { subscriptions });
		} catch (err) {
			this.eventHandlers.delete(onEvent);
			throw err;
		}
	}

	/** Close the connection; in-flight requests reject with "connection_closed". */
	close(): void {
		this.closedByUs = true;
		this.socket?.destroy();
		this.socket = null;
	}

	// -- internals ---------------------------------------------------------------

	private onData(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (line.length === 0) continue;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue; // tolerate non-JSON noise
			}
			// Pushed event envelope (live-validated): key `event` (underscore form),
			// payload under `data`.
			if (typeof msg.event === "string") {
				for (const h of this.eventHandlers) {
					try {
						h(msg.event, msg.data);
					} catch {
						// a throwing handler must not kill the connection
					}
				}
				continue;
			}
			const entry = this.pending.get(String(msg.id));
			if (!entry) continue;
			this.pending.delete(String(msg.id));
			if (msg.error !== undefined && msg.error !== null) {
				const e = msg.error as { code?: string; message?: string };
				entry.reject(new HerdrSocketError(e.code ?? "unknown", e.message ?? JSON.stringify(msg.error)));
			} else {
				entry.resolve(msg.result);
			}
			// BUG_FIX_CONTEXT (one-shot lifecycle race, caught by transport-socket.ts):
			// the server answers ONE request per connection and closes it. A request
			// issued before the client processes that close used to be written onto a
			// connection the server had already end()ed — the response was lost and
			// only the retry round-trip saved it (and the stub server logged
			// ERR_STREAM_WRITE_AFTER_END). Fix: once a plain (subscription-less)
			// response lands, the connection is SPENT — the client destroys it
			// immediately so every following request reconnects deterministically.
			// Subscription connections are exempt: they legitimately stay open.
			if (this.eventHandlers.size === 0 && this.socket && !this.socket.destroyed) {
				const spent = this.socket;
				this.socket = null;
				spent.destroy();
			}
		}
	}

	private onSocketError(err: Error): void {
		// EPIPE/ECONNRESET on an ESTABLISHED socket is the server ending the
		// one-shot request lifecycle — map to connection_closed so request()'s
		// retry path engages. No pending requests → swallow (an unhandled 'error'
		// event would crash the process; a post-response close is normal).
		const e = new HerdrSocketError("connection_closed", err.message);
		for (const [, entry] of this.pending) entry.reject(e);
		this.pending.clear();
	}

	private onSocketClose(): void {
		this.socket = null;
		const hadSubscriptions = this.eventHandlers.size > 0;
		const e = new HerdrSocketError(
			"connection_closed",
			this.closedByUs ? "closed by client" : "server closed the connection",
		);
		for (const [, entry] of this.pending) entry.reject(e);
		this.pending.clear();
		if (hadSubscriptions && !this.closedByUs) {
			this.eventHandlers.clear();
			try {
				this.onSubscriptionLost?.();
			} catch {
				// a throwing owner callback must not break the close path
			}
		}
	}
}
