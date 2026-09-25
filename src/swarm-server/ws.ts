/**
 * pi-delegate — src/swarm-server/ws.ts — a minimal RFC 6455 server-side
 * WebSocket codec (issue #50, ARCHITECTURE §4.2).
 *
 * MODULE_CONTRACT — the wire half of the stream endpoint: the 101 handshake
 * response builder and the TEXT/CLOSE frame encoder for SERVER→CLIENT frames
 * (unmasked, RFC 6455 §5.1), plus a tolerant decoder for CLIENT→SERVER
 * frames (masked). The protocol surface is deliberately narrow: the stream
 * endpoint only PUSHES (snapshot + events frames); the only client frames it
 * must understand are PING (answered with PONG by the caller) and CLOSE
 * (acknowledged + socket closed). Client TEXT/BINARY frames are parsed and
 * ignored — v1 defines no client→server messages.
 *
 * WHY hand-rolled: the platform offers no server-side WebSocket (Law 1 does
 * not apply), node:http upgrade sockets silently drop writes under bun 1.3.x
 * (see ./http1.ts), and the `ws` npm package is an avoidable dependency for
 * a server-push-only surface.
 *
 * Dependencies: node:crypto, node:util (inspect for debug only). A leaf.
 *
 * Critical invariants:
 *   - encodeTextFrame produces well-formed unmasked frames (7/16/64-bit
 *     lengths; no fragmentation — every frame carries FIN);
 *   - decodeClientFrame NEVER throws: incomplete → null (need more bytes),
 *     protocol violations → "malformed" (the caller closes the socket);
 *   - the codec holds no I/O of its own — the caller owns the socket.
 */

import { createHash } from "node:crypto";

/** RFC 6455 §1.3 — the fixed handshake GUID. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Compute Sec-WebSocket-Accept from the client's Sec-WebSocket-Key. */
export function wsAcceptKey(key: string): string {
	return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** The full 101 Switching Protocols response head for one key. */
export function wsHandshakeResponse(key: string): string {
	return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`;
}

/** One complete server→client frame: FIN + opcode, unmasked payload. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const len = payload.length;
	let head: Buffer;
	if (len < 126) {
		head = Buffer.from([0x80 | opcode, len]);
	} else if (len < 65536) {
		head = Buffer.alloc(4);
		head[0] = 0x80 | opcode;
		head[1] = 126;
		head.writeUInt16BE(len, 2);
	} else {
		head = Buffer.alloc(10);
		head[0] = 0x80 | opcode;
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([head, payload]);
}

/** Encode one UTF-8 TEXT frame (the stream endpoint's push unit). */
export function encodeTextFrame(text: string): Buffer {
	return encodeFrame(0x1, Buffer.from(text, "utf8"));
}

/** Encode one CLOSE frame (opcode 8, empty payload = code 1005). */
export function encodeCloseFrame(): Buffer {
	return encodeFrame(0x8, Buffer.alloc(0));
}

/** Encode one PONG frame (the answer to a client PING). */
export function encodePongFrame(payload: Buffer): Buffer {
	return encodeFrame(0xa, payload);
}

/** One decoded client frame (payload already unmasked). */
export interface DecodedClientFrame {
	opcode: number;
	payload: Buffer;
	/** Bytes consumed from the head of the buffer (the caller slices). */
	consumed: number;
}

/**
 * Decode ONE masked client frame from the head of a buffer.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: buf — accumulated socket bytes
 * Output: the decoded frame (payload unmasked) + consumed; null when more
 *   bytes are needed; "malformed" on a protocol violation (unmasked client
 *   frame, reserved length, absurd 64-bit length)
 * Guarantees: never throws; no allocation beyond the unmasked payload
 * Raises: never
 */
export function decodeClientFrame(buf: Buffer): DecodedClientFrame | null | "malformed" {
	if (buf.length < 2) return null;
	const opcode = buf[0] & 0x0f;
	const masked = (buf[1] & 0x80) !== 0;
	let len = buf[1] & 0x7f;
	let off = 2;
	if (len === 126) {
		if (buf.length < 4) return null;
		len = buf.readUInt16BE(2);
		off = 4;
	} else if (len === 127) {
		if (buf.length < 10) return null;
		const big = buf.readBigUInt64BE(2);
		if (big > BigInt(16 * 1024 * 1024)) return "malformed";
		len = Number(big);
		off = 10;
	}
	if (!masked) return "malformed"; // RFC 6455 §5.1: client frames MUST be masked
	if (buf.length < off + 4 + len) return null;
	const mask = buf.subarray(off, off + 4);
	const maskedPayload = buf.subarray(off + 4, off + 4 + len);
	const payload = Buffer.allocUnsafe(len);
	for (let i = 0; i < len; i++) payload[i] = maskedPayload[i] ^ mask[i % 4];
	return { opcode, payload, consumed: off + 4 + len };
}

// ---------------------------------------------------------------------------
// Upgrade refusals (issue #94)
// ---------------------------------------------------------------------------

/** The plain journal-stream WS paths this classification knows about. The
 *  console stream (./console-ws.ts) writes its own cause-specific refusals
 *  and never falls through here. */
const STREAM_PATH = "/api/swarm/stream";
const FLEET_STREAM_PATH = /^\/fleets\/[^/]+\/api\/swarm\/stream$/;

/** The unknown-path hint (unchanged from the pre-#94 fallback — the path
 *  really is not a WebSocket endpoint). */
export const UPGRADE_UNKNOWN_PATH_HINT = "Only /api/swarm/stream speaks WebSocket; other paths are plain JSON requests.";
/** The missing-key hint (the path is right; the RFC 6455 handshake is not). */
export const UPGRADE_KEY_HINT = "A WebSocket upgrade must carry a Sec-WebSocket-Key header (RFC 6455 handshake); browsers send it automatically.";
/** The bad-cursor hint (the path is right; ?after is absent or not an integer). */
export const UPGRADE_CURSOR_HINT = "?after is required and must be an integer journal seq cursor — e.g. /api/swarm/stream?after=0.";

/**
 * Classify why a WebSocket upgrade fell through to the core's 400 refusal.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: path — the request path; after — the raw ?after value (undefined =
 *   absent); key — the raw Sec-WebSocket-Key header
 * Output: the 400 E_SWARM_USAGE refusal {message, hint}, with a hint specific
 *   to the cause (unknown path / missing key / non-integer ?after)
 * Guarantees: never throws; the check order mirrors StreamHub.handleUpgrade
 *   (path → cursor → key), so the reported cause is the FIRST one the hub hit
 * Raises: never
 */
export function upgradeRefusal(path: string, after: string | undefined, key: string | undefined): { message: string; hint: string } {
	const isStreamPath = path === STREAM_PATH || FLEET_STREAM_PATH.test(path);
	if (!isStreamPath) return { message: "websocket upgrade refused", hint: UPGRADE_UNKNOWN_PATH_HINT };
	if (after === undefined || !/^-?\d+$/.test(after.trim())) return { message: "websocket upgrade refused", hint: UPGRADE_CURSOR_HINT };
	if (typeof key !== "string" || key.length === 0) return { message: "websocket upgrade refused", hint: UPGRADE_KEY_HINT };
	// The path, cursor and handshake were all well-formed, yet the hub refused
	// (e.g. the hub is closing) — do not send debugging to a wrong path.
	return { message: "websocket upgrade refused", hint: "The WebSocket stream is unavailable right now; retry shortly." };
}
