/**
 * swarm-http-e2e-check — issue #55 acceptance 2 (ARCHITECTURE §4.2,
 * Law 7/Law 8/Law 10): the END-TO-END loop of the session-hosted HTTP/WS
 * surface, as a headless client drives it against a REAL mounted server (the
 * same `mountSwarmServer` the session_start hook calls) over a scripted
 * fixture fleet:
 *
 *   snapshot → WS stream (snapshot frame) → reconnect with cursor →
 *   POST steer → the steer row arrives on the stream (journal-confirmed) →
 *   GET console chunk.
 *
 * The server is the real module (no mock of the transport/router); the
 * client is a raw-TCP HTTP + RFC 6455 WebSocket client (bun's global
 * WebSocket is unreliable in this repo's check runtime — the ws-check
 * precedent). Storage is journal mode so the mutation is provably journaled
 * and the stream observes it live.
 *
 * Run with: bun test/swarm-http-e2e-check.ts   (from repo root)
 * Fail-fast: top-level watchdog; every wait has its own deadline.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { AgentStatusName } from "../src/host.ts";
import { fixtureConsoleGraph, fixtureConsoleWorkerId } from "./swarm-http-goldens.ts";
import type { SwarmStorageConfig } from "../src/swarm/storage.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-http-e2e-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 30_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-http-e2e-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
const ALPHA = join(EX, "alpha-fleet");
mkdirSync(AGENT, { recursive: true });
mkdirSync(ALPHA, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;
process.env.SWARM_STORAGE = "journal";
process.env.SWARM_SESSION_ID = "sess-e2e";
process.env.SWARM_FIXED_TS = "2026-06-01T00:00:00.000Z";

const SELF = "/sessions/e2e-orch.jsonl";
const W1_PATH = "/sessions/e2e-w1.jsonl";
const TOKEN = "e2e-operator-token";

// ---------------------------------------------------------------------------
// A compact raw-TCP WebSocket client (the dashboard/ws-check pattern).
// ---------------------------------------------------------------------------
class WsClient {
	private buf = Buffer.alloc(0);
	frames: string[] = [];
	closed = false;
	private waiters: Array<() => void> = [];
	constructor(private sock: net.Socket) {
		sock.on("data", (d: Buffer) => {
			this.buf = Buffer.concat([this.buf, d]);
			this.drain();
		});
		sock.on("close", () => (this.closed = true));
		sock.on("error", () => (this.closed = true));
	}
	static async connect(port: number, path: string): Promise<WsClient> {
		return new Promise((res, rej) => {
			const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
			const sock = net.connect(port, "127.0.0.1");
			const timer = setTimeout(() => {
				sock.destroy();
				rej(new Error("ws connect timeout"));
			}, 5_000);
			sock.on("connect", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
			let head = Buffer.alloc(0);
			const onData = (d: Buffer) => {
				head = Buffer.concat([head, d]);
				const idx = head.indexOf("\r\n\r\n");
				if (idx === -1) return;
				sock.off("data", onData);
				clearTimeout(timer);
				const client = new WsClient(sock);
				client.buf = Buffer.from(head.subarray(idx + 4));
				client.drain();
				res(client);
			};
			sock.on("data", onData);
			sock.on("error", (e) => {
				clearTimeout(timer);
				rej(e);
			});
		});
	}
	private drain() {
		for (;;) {
			if (this.buf.length < 2) return;
			const opcode = this.buf[0]! & 0x0f;
			let len = this.buf[1]! & 0x7f;
			let off = 2;
			if (len === 126) {
				if (this.buf.length < 4) return;
				len = this.buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (this.buf.length < 10) return;
				len = Number(this.buf.readBigUInt64BE(2));
				off = 10;
			}
			if (this.buf.length < off + len) return;
			const payload = this.buf.subarray(off, off + len);
			this.buf = this.buf.subarray(off + len);
			if (opcode === 0x1) {
				this.frames.push(payload.toString("utf8"));
				for (const w of this.waiters.splice(0)) w();
			} else if (opcode === 0x8) {
				this.closed = true;
				this.sock.end();
				return;
			}
		}
	}
	async waitFor(predicate: (frames: string[]) => boolean, timeoutMs = 6_000): Promise<string[]> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate(this.frames)) return this.frames;
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, 25);
			});
		}
		return this.frames;
	}
	close() {
		this.sock.destroy();
	}
}

/** Journal-mode manifest fixture (drives the mutation ownership gate). */
function fixtureManifests() {
	return {
		scan: () => [
			{
				schemaVersion: 1,
				task: "alpha-fleet",
				dir: ALPHA,
				masterSessionPath: SELF,
				workers: [
					{
						name: "w1",
						placement: { kind: "tab", backend: "rpc", placementRef: "rpc:1", checkoutPath: "/checkouts/w1" },
						briefPath: join(ALPHA, "brief-w1.md"),
						reportPath: join(ALPHA, "report-w1.json"),
						provider: "p",
						model: "m",
						thinking: "off",
						startedAt: "2026-06-01T00:10:00.000Z",
						sessionPath: W1_PATH,
						orchestratorSessionPath: SELF,
					},
				],
			},
		],
	};
}

async function main(): Promise<void> {
	const { createJournalWriter } = await import("../src/swarm/journal.ts");
	const { swarmSessionIdFor } = await import("../src/swarm/storage.ts");
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");

	// Seed the fixture fleet as a journal-mode manifest replay (spawn row with
	// the entry) so the SERVER's snapshot shows the scripted fleet.
	const cfg: SwarmStorageConfig = { storage: "journal", projection: false, warnings: [] };
	const sid = swarmSessionIdFor(ALPHA, cfg);
	const FIXED_MS = Date.parse("2026-06-01T00:00:00.000Z");
	const w = createJournalWriter({ dbPath: DB, clock: { now: () => FIXED_MS, delay: () => Promise.resolve() } });
	const seed = await w.append({
		kind: "spawn",
		sessionId: sid,
		task: "alpha-fleet",
		worker: "w1",
		payload: {
			backend: "rpc",
			placementRef: "rpc:1",
			briefPath: "/b.md",
			briefText: "# b",
			entry: {
				name: "w1",
				placement: { kind: "tab", backend: "rpc", placementRef: "rpc:1", checkoutPath: "/checkouts/w1" },
				briefPath: join(ALPHA, "brief-w1.md"),
				reportPath: join(ALPHA, "report-w1.json"),
				provider: "p",
				model: "m",
				thinking: "off",
				startedAt: "2026-06-01T00:10:00.000Z",
				sessionPath: W1_PATH,
				orchestratorSessionPath: SELF,
				depth: 0,
			},
		},
	});
	w.close();
	check("E2E.0 the fixture fleet spawn row committed", seed.ok, JSON.stringify(seed));

	const consoleTransport = {
		backendName: () => "rpc",
		listStatuses: async () => [{ name: "w1", status: "working" as AgentStatusName, placementRef: "rpc:1" }],
		streamConsole: (_name: string) => {
			let sent = false;
			const sub = {
				[Symbol.asyncIterator]() {
					return sub;
				},
				async next(): Promise<IteratorResult<{ workerName: string; seq: number; timestamp: number; kind: string; payload: string }>> {
					if (!sent) {
						sent = true;
						return { value: { workerName: "w1", seq: 1, timestamp: FIXED_MS, kind: "raw", payload: "boot log\n" }, done: false };
					}
					return new Promise(() => {});
				},
				unsubscribe: () => {},
			};
			return sub;
		},
	};

	const h = await mountSwarmServer({
		sessionFile: SELF,
		transport: consoleTransport as never,
		manifests: fixtureManifests() as never,
		graph: fixtureConsoleGraph(SELF),
		operatorToken: TOKEN,
		pollMs: 50,
		env: { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" },
	});
	check("E2E.1 the real server mounts (session_start hook) on a loopback port", h !== null && h.address === "127.0.0.1" && h.port > 0);
	if (!h) throw new Error("cannot continue without a mounted server");

	// --- 1. snapshot -------------------------------------------------------
	const snapRes = await fetch(`http://127.0.0.1:${h.port}/api/swarm/snapshot`, { signal: AbortSignal.timeout(5_000) });
	const snap = (await snapRes.json()) as { ok: boolean; snapshot: { available: boolean; nodes: Array<Record<string, unknown>> } };
	const fleet = snap.snapshot.nodes.find((n) => n.kind === "task" && n.id === "alpha-fleet") as { workers?: Array<{ name: string }> } | undefined;
	check("E2E.2 snapshot: available + the scripted fleet is present (journal-replayed manifest)", snapRes.status === 200 && snap.ok === true && snap.snapshot.available === true && fleet !== undefined, JSON.stringify(snap).slice(0, 200));

	// --- 2. stream (snapshot frame) ---------------------------------------
	const ws = await WsClient.connect(h.port, "/api/swarm/stream?after=0");
	await ws.waitFor((f) => f.length >= 1);
	const frame0 = JSON.parse(ws.frames[0] ?? "{}") as { ok?: boolean; schemaVersion?: number; type?: string; snapshot?: unknown };
	check("E2E.3 stream: the FIRST frame is the snapshot frame (schemaVersion 1)", frame0.ok === true && frame0.schemaVersion === 1 && frame0.type === "snapshot" && frame0.snapshot !== undefined, JSON.stringify(frame0).slice(0, 120));

	// --- 3. steer (journal-confirmed via the stream) ----------------------
	const steerRes = await fetch(`http://127.0.0.1:${h.port}/api/workers/w1/steer`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ text: "keep going" }),
		signal: AbortSignal.timeout(5_000),
	});
	const steer = (await steerRes.json()) as { ok: boolean; via?: string; journal?: { seq?: number } | null };
	check("E2E.4 POST steer → 200 via:http with a journaled seq (journal storage)", steerRes.status === 200 && steer.ok === true && steer.via === "http" && typeof steer.journal?.seq === "number", JSON.stringify(steer));

	const frames = await ws.waitFor((all) => all.some((raw) => raw.includes('"type":"events"') && raw.includes('"via":"http"')));
	const evFrame = frames.map((r) => JSON.parse(r) as { type?: string; events?: Array<Record<string, unknown>> }).find((f) => f.type === "events" && (f.events ?? []).some((e) => (e.payload as Record<string, unknown> | undefined)?.via === "http"));
	const steerRow = evFrame?.events?.find((e) => e.kind === "steer");
	check("E2E.5 stream: the steer journal row arrives live (journal-confirmed, via:http)", steerRow !== undefined && (steerRow.payload as Record<string, unknown>).text === "keep going", JSON.stringify(evFrame).slice(0, 200));
	const lastSeq = Math.max(0, ...(evFrame?.events ?? []).map((e) => (typeof e.seq === "number" ? e.seq : 0)));
	ws.close();

	// --- 4. stream reconnect with the cursor ------------------------------
	const ws2 = await WsClient.connect(h.port, `/api/swarm/stream?after=${lastSeq}`);
	await ws2.waitFor((f) => f.length >= 1);
	const reFrame = JSON.parse(ws2.frames[0] ?? "{}") as { type?: string };
	check("E2E.6 stream reconnect with ?after=<lastSeq> resumes (snapshot frame first, no replay of the consumed row)", lastSeq > 0 && reFrame.type === "snapshot" && !ws2.frames.some((r) => r.includes(`"seq":${lastSeq}`)), `after=${lastSeq} frames=${JSON.stringify(ws2.frames).slice(0, 120)}`);
	ws2.close();

	// --- 5. console chunk -------------------------------------------------
	const consoleRes = await fetch(`http://127.0.0.1:${h.port}/api/workers/${fixtureConsoleWorkerId()}/console`, { signal: AbortSignal.timeout(5_000) });
	const consoleFrame = (await consoleRes.json()) as { state?: string; chunk?: string; nextOffset?: number; error?: unknown };
	check(
		"E2E.7 console: live frame with the transcript chunk (state live, no fabricated error)",
		consoleRes.status === 200 && consoleFrame.state === "live" && consoleFrame.chunk === "boot log\n" && consoleFrame.nextOffset === 9 && consoleFrame.error === undefined,
		JSON.stringify(consoleFrame),
	);

	h.stop();
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

watchdog.close?.();
if (failures > 0) {
	console.error(`\nswarm-http-e2e-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-http-e2e-check: all checks passed");
process.exit(0);