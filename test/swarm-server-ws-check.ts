/**
 * swarm-server-ws-check — issue #50 acceptance 2 (ARCHITECTURE §4.2, Law 13):
 * `WS /api/swarm/stream?after=<seq>` — on connect ONE snapshot frame, then
 * event frames as the server's journal cursor advances; cursor-resume across
 * a client reconnect; ordering by seq preserved.
 *
 * Run with: bun test/swarm-server-ws-check.ts   (from repo root)
 *
 * The client is a hand-rolled raw-TCP WebSocket client (RFC 6455 handshake +
 * unmasked server-frame decode): bun's global WebSocket client and node:http
 * upgrade sockets both proved unreliable under the check runtime (bun 1.3.x
 * drops node:http upgraded-socket writes — probes 2026-09-23), so the check
 * speaks the wire protocol directly. Same reason the server itself is a
 * hand-rolled core (src/swarm-server/http1.ts).
 *
 * Covers:
 *   W1  connect (seeded journal, after=1): FIRST frame is exactly one
 *       snapshot frame {ok,schemaVersion,type:"snapshot",snapshot}; the next
 *       frame replays rows 2..4 as one events frame (seq-ordered).
 *   W2  journal advance → new events frame(s) deliver rows 5..6 in seq order
 *       (strictly increasing across frames; no duplicates, no gaps).
 *   W3  cursor-resume: reconnect with ?after=<last consumed seq> → snapshot
 *       frame, then ONLY rows with seq > cursor (no replay); ordering kept.
 *   W4  cold start: server mounted over an ABSENT journal still streams —
 *       the snapshot degrades (available true; sources.journal true — an
 *       absent db is an available EMPTY source), and
 *       once the database is created + written, events frames flow (the
 *       session reader reopens on the absence→presence transition); the
 *       plain events endpoint sees the rows through the SAME reader.
 *   W5  invalid ?after → the upgrade is refused with a plain HTTP 400
 *       E_SWARM_USAGE + schemaVersion envelope (no 101 handshake).
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every wait
 * has its own deadline. Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("swarm-server-ws-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 25_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-server-ws-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
mkdirSync(AGENT, { recursive: true });
mkdirSync(EX, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;

// ---------------------------------------------------------------------------
// The raw-TCP WS client (handshake + server-frame decode + close frame).
// ---------------------------------------------------------------------------

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WsClient {
	private sock: net.Socket;
	private buf: Buffer = Buffer.alloc(0);
	readonly frames: string[] = [];
	private waiters: Array<() => void> = [];
	private closed = false;

	private constructor(sock: net.Socket) {
		this.sock = sock;
		sock.on("data", (d: Buffer) => {
			this.buf = Buffer.concat([this.buf, d]);
			this.drain();
		});
		sock.on("close", () => {
			this.closed = true;
			this.wake();
		});
		sock.on("error", () => {
			this.closed = true;
			this.wake();
		});
	}

	/** Complete one handshake against the server; resolves on 101 or rejects. */
	static async connect(port: number, query: string): Promise<WsClient> {
		return new Promise((resolve, reject) => {
			const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
			const sock = net.connect(port, "127.0.0.1");
			const timer = setTimeout(() => {
				sock.destroy();
				reject(new Error("ws connect timeout"));
			}, 5_000);
			sock.on("connect", () => {
				sock.write(
					`GET /api/swarm/stream${query} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
				);
			});
			let head = Buffer.alloc(0);
			const onData = (d: Buffer) => {
				head = Buffer.concat([head, d]);
				const idx = head.indexOf("\r\n\r\n");
				if (idx === -1) return;
				sock.off("data", onData);
				const text = head.subarray(0, idx).toString();
				if (!text.includes("101")) {
					sock.destroy();
					clearTimeout(timer);
					reject(new WsRefused(text, head.subarray(idx + 4).toString()));
					return;
				}
				const { createHash } = require("node:crypto") as typeof import("node:crypto");
				const expect = createHash("sha1").update(key + GUID).digest("base64");
				if (!text.includes(expect)) {
					sock.destroy();
					clearTimeout(timer);
					reject(new Error("bad Sec-WebSocket-Accept"));
					return;
				}
				clearTimeout(timer);
				const client = new WsClient(sock);
				client.buf = Buffer.concat([client.buf, Buffer.from(head.subarray(idx + 4))]);
				client.drain();
				resolve(client);
			};
			sock.on("data", onData);
			sock.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
		});
	}

	/** Parse complete server (unmasked) frames out of the buffer. */
	private drain(): void {
		for (;;) {
			if (this.buf.length < 2) break;
			const b0 = this.buf[0];
			const b1 = this.buf[1];
			const opcode = b0 & 0x0f;
			let len = b1 & 0x7f;
			let off = 2;
			if (len === 126) {
				if (this.buf.length < 4) break;
				len = this.buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (this.buf.length < 10) break;
				const big = this.buf.readBigUInt64BE(2);
				len = Number(big);
				off = 10;
			}
			if (this.buf.length < off + len) break;
			const payload = this.buf.subarray(off, off + len);
			this.buf = this.buf.subarray(off + len);
			if (opcode === 0x1) {
				this.frames.push(payload.toString("utf8"));
				this.wake();
			} else if (opcode === 0x8) {
				this.closed = true;
				this.sock.end();
				this.wake();
				return;
			}
			// ping/pong/continuation: v1 clients see none — skip.
		}
	}

	private wake(): void {
		for (const w of this.waiters) w();
		this.waiters = [];
	}

	/** Wait until at least n text frames arrived (or the deadline). */
	async waitFrames(n: number, timeoutMs = 5_000): Promise<string[]> {
		const deadline = Date.now() + timeoutMs;
		while (this.frames.length < n && !this.closed && Date.now() < deadline) {
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, 25);
			});
		}
		return this.frames.slice();
	}

	/** Send a masked client close frame and end. */
	close(): void {
		if (this.closed) return;
		const mask = crypto.getRandomValues(new Uint8Array(4));
		this.sock.write(Buffer.concat([Buffer.from([0x88, 0x80]), Buffer.from(mask)]));
		this.sock.end();
	}
}

/** The server answered the upgrade with a plain HTTP error (W5). */
class WsRefused extends Error {
	constructor(readonly head: string, readonly body: string) {
		super("ws refused");
	}
}

// ---------------------------------------------------------------------------

type Handle = { stop(): void; port: number };

async function main(): Promise<void> {
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
	const { createJournalWriter } = await import("../src/swarm/journal.ts");

	const FIXED_MS = Date.parse("2026-06-01T00:00:00.000Z");
	const clock = { now: () => FIXED_MS, delay: () => Promise.resolve() };
	const seed = async (dbPath: string, n: number, offset = 0): Promise<void> => {
		const w = createJournalWriter({ dbPath, clock });
		try {
			for (let i = 1; i <= n; i++) {
				const res = await w.append({
					kind: "progress",
					sessionId: "sess-ws",
					task: "ws-fleet",
					worker: `w${i + offset}`,
					payload: { phase: `p${i + offset}`, pct: i },
				});
				if (!res.ok) throw new Error(`seed append failed: ${res.code}`);
			}
		} finally {
			w.close();
		}
	};

	const transport = { backendName: () => "herdr", listStatuses: async () => [] as Array<{ name: string; status: "idle"; placementRef?: string }> };
	const env = { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" } as NodeJS.ProcessEnv;

	// Seed rows 1..4 BEFORE the first mount.
	await seed(DB, 4);
	const h = await mountSwarmServer({ sessionFile: "/sessions/ws-a.jsonl", transport, env, pollMs: 40 });
	check("W0 mount returns a handle", h !== null);
	if (!h) return;

	// --- W1: first frame is ONE snapshot; then the after=1 replay -----------
	const c1 = await WsClient.connect(h.port, "?after=1");
	const first = await c1.waitFrames(2);
	check("W1.1 connected and received frames", first.length >= 2, `frames=${first.length}`);
	if (first.length >= 2) {
		const snap = JSON.parse(first[0]) as Record<string, unknown>;
		check(
			'W1.2 FIRST frame is a snapshot frame {ok,schemaVersion,type:"snapshot",snapshot}',
			snap.ok === true && snap.schemaVersion === 1 && snap.type === "snapshot" && typeof snap.snapshot === "object",
			first[0].slice(0, 160),
		);
		const ev = JSON.parse(first[1]) as Record<string, unknown>;
		const rows = (ev.events ?? []) as Array<Record<string, unknown>>;
		check(
			"W1.3 second frame replays rows 2..4 after the cursor, seq-ordered, verbatim row shape",
			ev.type === "events" && ev.after === 1 && rows.map((r) => r.seq).join(",") === "2,3,4" && Object.keys(rows[0]).join(",") === "seq,ts,kind,sessionId,task,worker,payload",
			first[1].slice(0, 200),
		);
		// W2: append rows 5..6 — must arrive in seq order, no dup/gap.
		const baseline = c1.frames.length; // exclude the W1 replay from W2's window
		await seed(DB, 2, 4);
		const after = await c1.waitFrames(baseline + 1);
		const evFrames = after.slice(baseline).map((f) => JSON.parse(f) as { type?: string; events?: Array<{ seq: number }> });
		const seqs = evFrames.flatMap((f) => (f.events ?? []).map((r) => r.seq));
		const strictlyIncreasing = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
		check(
			"W2 journal advance → event frames deliver rows 5..6 in seq order (no dup/gap)",
			seqs.join(",") === "5,6" && strictlyIncreasing && evFrames.every((f) => f.type === "events"),
			JSON.stringify(seqs),
		);
		const snapCount = after.filter((f) => (JSON.parse(f) as { type?: string }).type === "snapshot").length;
		check("W1.4 exactly ONE snapshot frame per connection (all later frames are events)", snapCount === 1, `snapshot frames=${snapCount}`);
		c1.close();
	}

	// --- W3: cursor-resume across a reconnect -------------------------------
	await seed(DB, 1, 6); // row 7 while disconnected
	const c2 = await WsClient.connect(h.port, "?after=6");
	const resumed = await c2.waitFrames(2);
	check("W3.1 reconnect with ?after=6 connected and framed", resumed.length >= 2, `frames=${resumed.length}`);
	if (resumed.length >= 2) {
		const snap = JSON.parse(resumed[0]) as { type?: string };
		const evFrames = resumed.slice(1).map((f) => JSON.parse(f) as { type?: string; after?: number; events?: Array<{ seq: number }> });
		const seqs = evFrames.flatMap((f) => (f.events ?? []).map((r) => r.seq));
		check(
			"W3.2 resume: snapshot frame first, then ONLY seq>6 rows (no replay of consumed rows)",
			snap.type === "snapshot" && seqs.every((s) => s > 6) && seqs.includes(7) && evFrames.every((f) => f.type === "events"),
			JSON.stringify({ first: resumed[0].slice(0, 60), seqs }),
		);
		c2.close();
	}
	h.stop();

	// --- W4: cold start over an ABSENT journal ------------------------------
	const DB2 = join(SANDBOX, "journal2", "events.db");
	const h2 = await mountSwarmServer({ sessionFile: "/sessions/ws-b.jsonl", transport, env: { ...env, SWARM_JOURNAL_DB: DB2 }, pollMs: 40 });
	check("W4.1 cold mount (absent journal) returns a handle", h2 !== null);
	if (h2) {
		const c3 = await WsClient.connect(h2.port, "?after=0");
		const cold = await c3.waitFrames(1);
		check("W4.2 cold connect still delivers a (degraded) snapshot frame", cold.length >= 1 && (JSON.parse(cold[0]) as { type?: string }).type === "snapshot", cold[0]?.slice(0, 120) ?? "no frame");
		if (cold.length >= 1) {
			const snap = JSON.parse(cold[0]) as { snapshot?: { sources?: Record<string, unknown>; available?: boolean } };
			check(
				"W4.3 the cold snapshot is a valid graph over the empty reader (available true; sources.journal true — an absent db is an available EMPTY source, the read-model's pinned A7 semantics)",
				snap.snapshot?.available === true && snap.snapshot?.sources?.journal === true,
				cold[0].slice(0, 160),
			);
		}
		await seed(DB2, 3); // database created AFTER the server mounted
		const flowed = await c3.waitFrames(2);
		const seqs = flowed.slice(1).flatMap((f) => ((JSON.parse(f) as { events?: Array<{ seq: number }> }).events ?? []).map((r) => r.seq));
		check(
			"W4.4 absence→presence: once the journal exists, events frames flow (session reader reopened)",
			seqs.join(",") === "1,2,3",
			JSON.stringify(seqs),
		);
		c3.close();
		const http = await fetch(`http://127.0.0.1:${h2.port}/api/swarm/events?after=0`);
		const body = (await http.json()) as { events?: Array<{ seq: number }> };
		check(
			"W4.5 the plain events endpoint sees the rows through the SAME reopened reader",
			http.status === 200 && (body.events ?? []).map((r) => r.seq).join(",") === "1,2,3",
			JSON.stringify(body.events?.map((r) => r.seq)),
		);
		h2.stop();
	}

	// --- W5: invalid ?after → plain HTTP 400, no 101 -------------------------
	if (h2) {
		// h2 was stopped — remount for the refusal leg.
		const h3 = await mountSwarmServer({ sessionFile: "/sessions/ws-c.jsonl", transport, env: { ...env, SWARM_JOURNAL_DB: DB2 }, pollMs: 40 });
		check("W5.0 refusal-leg mount returns a handle", h3 !== null);
		if (h3) {
			let refused: WsRefused | null = null;
			try {
				await WsClient.connect(h3.port, "?after=notanint");
			} catch (err) {
				if (err instanceof WsRefused) refused = err;
			}
			check(
				"W5.1 invalid ?after → plain HTTP 400 with E_SWARM_USAGE + schemaVersion (no 101 handshake)",
				refused !== null && refused.head.includes("400") && refused.body.includes("E_SWARM_USAGE") && refused.body.includes('"schemaVersion":1'),
				refused ? `${refused.head.split("\r\n")[0]} ${refused.body.slice(0, 120)}` : "handshake unexpectedly succeeded",
			);
			h3.stop();
		}
	}
}


await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

if (failures > 0) {
	console.error(`\nswarm-server-ws-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-server-ws-check: all checks passed");
process.exit(0);
