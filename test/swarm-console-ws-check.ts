/**
 * swarm-console-ws-check — issue #52 acceptance 1/2/3/4 (ARCHITECTURE §4.2.4,
 * Law 7/Law 8): the worker-console WebSocket live tail
 * `WS /api/workers/:id/console/stream?offset=<n>` as observed by a raw-TCP
 * RFC 6455 client (the same hand-rolled client pattern as
 * test/swarm-server-ws-check.ts — bun's global WebSocket client is unreliable
 * under the check runtime).
 *
 * Run with: bun test/swarm-console-ws-check.ts   (from repo root)
 *
 * Covers:
 *   S1  live tail: the first frame is a console frame (same envelope as
 *       REST, schemaVersion 1); appended events arrive as later frames; the
 *       frames reassemble the transcript with no duplication.
 *   S2  cursor-resume: reconnecting with the previous nextOffset yields an
 *       immediate frame carrying no replayed bytes, then only new text.
 *   S3  state transition: worker end → the next frame carries
 *       ended-with-retained-backlog (live→ended transitions flow).
 *   S4  fail-closed refusal: a foreign worker id is refused with a plain
 *       HTTP 404 + E_CONSOLE_WORKER_REFUSED (no 101 handshake).
 *   S5  backend honesty over WS: a captureless transport still upgrades and
 *       sends ONE frame with state "unavailable" + E_CONSOLE_UNAVAILABLE.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every wait
 * has its own deadline. Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { FidelityStore } from "../src/stream-seam/fidelity-store.ts";
import { sessionIdFor } from "../src/swarm/nodes.ts";
import type { SwarmGraph } from "../src/swarm/graph.ts";
import type { AgentStatusName } from "../src/host.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-console-ws-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-console-ws-"));
const AGENT = join(SANDBOX, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.SWARM_JOURNAL_DB = join(SANDBOX, "journal", "events.db");

const ORCH = "/sessions/ws-orch.jsonl";
const OTHER = "/sessions/ws-other.jsonl";
const W1 = "/sessions/ws-w1.jsonl";
const W2 = "/sessions/ws-w2.jsonl";
const w1Id = sessionIdFor(W1);
const w2Id = sessionIdFor(W2);

function fixtureGraph(): SwarmGraph {
	const orchId = sessionIdFor(ORCH);
	const otherId = sessionIdFor(OTHER);
	const session = (id: string, path: string, isWorker: boolean) => ({
		kind: "session" as const,
		id,
		sessionPath: path,
		role: isWorker ? ("worker" as const) : ("orchestrator" as const),
		isWorker,
		ownsChildren: !isWorker,
		tasks: ["alpha"],
		degraded: [],
	});
	return {
		schemaVersion: 1,
		available: true,
		sources: { journal: true, manifests: true, liveStatus: true, usage: false },
		nodes: [
			session(orchId, ORCH, false),
			session(otherId, OTHER, false),
			session(w1Id, W1, true),
			session(w2Id, W2, true),
			{
				kind: "task",
				id: "alpha",
				workers: [
					{ name: "w1", run: 1, sessionId: w1Id, sessionPath: W1, manifestRef: { task: "alpha", worker: "w1", run: 1 }, degraded: [] },
					{ name: "w2", run: 1, sessionId: w2Id, sessionPath: W2, manifestRef: { task: "alpha", worker: "w2", run: 1 }, degraded: [] },
				],
				degraded: [],
			},
		],
		edges: [
			{ kind: "spawned_by", from: w1Id, to: orchId },
			{ kind: "spawned_by", from: w2Id, to: otherId },
			{ kind: "spawned_by", from: "alpha", to: orchId },
		],
		orphans: [],
	};
}

class FakeConsoleTransport {
	readonly store = new FidelityStore({ cap: 100 });
	readonly names = new Set<string>();
	statuses: Array<{ name: string; status: AgentStatusName; placementRef?: string }> = [];
	backendName() {
		return "fake";
	}
	add(name: string) {
		this.names.add(name);
		this.statuses.push({ name, status: "working", placementRef: `fake:${name}` });
	}
	end(name: string) {
		this.statuses = this.statuses.map((s) => (s.name === name ? { ...s, status: "done" as AgentStatusName } : s));
		this.store.close(name);
	}
	async listStatuses() {
		return this.statuses.map((s) => ({ ...s }));
	}
	async readConsole(name: string) {
		if (!this.names.has(name)) throw new Error(`no live agent ${name}`);
		return this.store.snapshot(name, 4000) ?? "";
	}
	streamConsole(name: string, opts?: { afterSeq?: number }) {
		if (!this.names.has(name)) throw new Error(`no live agent ${name}`);
		return this.store.subscribe(name, { fromCursor: opts?.afterSeq ?? 0 });
	}
}

// ---------------------------------------------------------------------------
// Raw-TCP WS client (handshake + unmasked server-frame decode)
// ---------------------------------------------------------------------------

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WsRefused extends Error {
	constructor(readonly head: string, readonly body: string) {
		super("ws refused");
	}
}

class WsClient {
	private buf = Buffer.alloc(0);
	readonly frames: string[] = [];
	private waiters: Array<() => void> = [];
	private closed = false;

	private constructor(private readonly sock: net.Socket) {
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

	static async connect(port: number, path: string, query: string): Promise<WsClient> {
		return new Promise((resolve, reject) => {
			const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
			const sock = net.connect(port, "127.0.0.1");
			const timer = setTimeout(() => {
				sock.destroy();
				reject(new Error("ws connect timeout"));
			}, 5_000);
			sock.on("connect", () => {
				sock.write(
					`GET ${path}${query} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
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

	private drain(): void {
		for (;;) {
			if (this.buf.length < 2) break;
			const opcode = this.buf[0]! & 0x0f;
			let len = this.buf[1]! & 0x7f;
			let off = 2;
			if (len === 126) {
				if (this.buf.length < 4) break;
				len = this.buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (this.buf.length < 10) break;
				len = Number(this.buf.readBigUInt64BE(2));
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
		}
	}

	private wake(): void {
		for (const w of this.waiters) w();
		this.waiters = [];
	}

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

	close(): void {
		if (this.closed) return;
		const mask = crypto.getRandomValues(new Uint8Array(4));
		this.sock.write(Buffer.concat([Buffer.from([0x88, 0x80]), Buffer.from(mask)]));
		this.sock.end();
	}
}

interface Frame {
	ok: boolean;
	schemaVersion: number;
	worker: string;
	nodeId: string;
	state: string;
	chunk: string;
	nextOffset: number;
	oldestOffset: number;
	dropped: boolean;
	error?: { code?: string; hint?: string };
}

const pathFor = (id: string) => `/api/workers/${encodeURIComponent(id)}/console/stream`;

async function main(): Promise<void> {
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
	const env = { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" } as NodeJS.ProcessEnv;
	const handles: Array<{ stop(): void }> = [];
	const mount = async (transport: unknown) => {
		const h = await mountSwarmServer({ sessionFile: ORCH, transport: transport as never, graph: fixtureGraph(), env, pollMs: 40 });
		if (!h) throw new Error("mount failed");
		handles.push(h);
		return h;
	};

	// S1/S2/S3 — live tail, resume, transition
	{
		const t = new FakeConsoleTransport();
		t.add("w1");
		t.store.append("w1", "raw", "one");
		const h = await mount(t);

		const c1 = await WsClient.connect(h.port, pathFor(w1Id), "?offset=0");
		const first = await c1.waitFrames(1);
		const f1 = first.length > 0 ? (JSON.parse(first[0]!) as Frame) : null;
		check(
			"S1.1 first frame is the console envelope (schemaVersion 1, state live, resumed bytes)",
			f1 !== null && f1.ok === true && f1.schemaVersion === 1 && f1.worker === "w1" && f1.nodeId === w1Id && f1.state === "live" && f1.chunk === "one" && f1.nextOffset === 3,
			first[0] ?? "no frame",
		);

		t.store.append("w1", "raw", "two");
		const more = await c1.waitFrames(2);
		const f2 = more.length > 1 ? (JSON.parse(more[1]!) as Frame) : null;
		check("S1.2 appended events arrive as a later frame (live tail)", f2 !== null && f2.chunk === "two" && f2.nextOffset === 6, more[1] ?? "no second frame");
		check("S1.3 frames reassemble the transcript with no duplication", `${f1?.chunk ?? ""}${f2?.chunk ?? ""}` === "onetwo", `${f1?.chunk}|${f2?.chunk}`);
		c1.close();

		// S2 — cursor resume: no replayed bytes, then only new text.
		const c2 = await WsClient.connect(h.port, pathFor(w1Id), "?offset=6");
		const resumed = await c2.waitFrames(1);
		const r0 = resumed.length > 0 ? (JSON.parse(resumed[0]!) as Frame) : null;
		check("S2.1 reconnect at nextOffset → an immediate frame with NO replayed bytes", r0 !== null && r0.chunk === "" && r0.nextOffset === 6, resumed[0] ?? "no frame");
		t.store.append("w1", "raw", "three");
		const resumed2 = await c2.waitFrames(2);
		const r1 = resumed2.length > 1 ? (JSON.parse(resumed2[1]!) as Frame) : null;
		check("S2.2 resume continues with only the new text", r1 !== null && r1.chunk === "three" && r1.nextOffset === 11, resumed2[1] ?? "no frame");

		// S3 — state transition live → ended-with-retained-backlog
		t.end("w1");
		const ended = await c2.waitFrames(3);
		const e0 = ended.length > 2 ? (JSON.parse(ended[2]!) as Frame) : null;
		check("S3.1 worker end → a frame carries ended-with-retained-backlog", e0 !== null && e0.state === "ended-with-retained-backlog", ended[2] ?? "no transition frame");
		c2.close();
		h.stop();
	}

	// S4 — fail-closed refusal over WS
	{
		const t = new FakeConsoleTransport();
		t.add("w1");
		const h = await mount(t);
		let refused: WsRefused | null = null;
		try {
			await WsClient.connect(h.port, pathFor(w2Id), "?offset=0");
		} catch (err) {
			if (err instanceof WsRefused) refused = err;
		}
		check(
			"S4.1 foreign worker id → plain HTTP 404 + E_CONSOLE_WORKER_REFUSED (no 101)",
			refused !== null && refused.head.includes("404") && refused.body.includes("E_CONSOLE_WORKER_REFUSED") && refused.body.includes('"schemaVersion":1'),
			refused ? `${refused.head.split("\r\n")[0]} ${refused.body.slice(0, 120)}` : "handshake unexpectedly succeeded",
		);
		h.stop();
	}

	// S5 — unavailable backend over WS
	{
		const h = await mount({ backendName: () => "herdr", listStatuses: async () => [] as Array<{ name: string; status: AgentStatusName; placementRef?: string }> });
		const c = await WsClient.connect(h.port, pathFor(w1Id), "?offset=0");
		const frames = await c.waitFrames(1);
		const f = frames.length > 0 ? (JSON.parse(frames[0]!) as Frame) : null;
		check(
			"S5.1 captureless backend → ONE frame, state unavailable + E_CONSOLE_UNAVAILABLE + hint",
			f !== null && f.state === "unavailable" && f.chunk === "" && f.error?.code === "E_CONSOLE_UNAVAILABLE" && typeof f.error?.hint === "string",
			frames[0] ?? "no frame",
		);
		c.close();
		h.stop();
	}

	for (const h of handles) h.stop();
}

await main()
	.then(() => {
		clearTimeout(watchdog);
		console.log(failures === 0 ? "\nALL CONSOLE WS CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		clearTimeout(watchdog);
		console.error("swarm-console-ws-check CRASHED", err);
		process.exit(1);
	});