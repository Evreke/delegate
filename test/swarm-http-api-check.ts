/**
 * swarm-http-api-check — issue #55 acceptance 1 + 3 (ARCHITECTURE §4.2,
 * Law 7/Law 8/Law 10): the GOLDEN ENVELOPE SUITE of the session-hosted
 * HTTP/WS read + mutation surface. Every endpoint's success envelope AND
 * every structured-error shape is pinned against the frozen goldens in
 * ./swarm-http-goldens.ts (byte-exact; the additive discipline is exercised
 * by ./swarm-http-schema-diff-check.ts).
 *
 * Fixtures cover (brief #55 item 1): empty journal, multi-fleet, all four
 * degraded flags, herdr-unavailable console, foreign-fleet refusal, and
 * wrong/absent operator token.
 *
 * Covers:
 *   V  /api/version pinned; 404 E_SWARM_NOT_FOUND; 405 E_SWARM_USAGE;
 *      events 400 E_SWARM_USAGE (schemaVersion on every error — Law 7).
 *   S  snapshot envelope over the multi-fleet fixture: empty journal absent,
 *      all four degraded flags (no-live-status, no-session-path,
 *      legacy-orphan, usage-unavailable), orphan basket, multi-fleet.
 *   E  events envelope over the seeded journal; empty-journal mount.
 *   C  console frames: rpc live, captureless (herdr) unavailable, foreign
 *      refusal, bad offset.
 *   M  mutation: steer/answer success, absent + wrong token (byte-identical),
 *      foreign-fleet refusal, malformed body.
 *
 * Run with: bun test/swarm-http-api-check.ts   (from repo root)
 * Fail-fast: top-level watchdog; every fetch is bounded.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_VERSION } from "../src/version.ts";
import type { AgentStatusName } from "../src/host.ts";
import { additiveViolations, fixtureAnswerPath, fixtureConsoleGraph, fixtureConsoleWorkerId, fixtureForeignWorkerId, HTTP_GOLDENS, HTTP_STREAM_GOLDENS, render } from "./swarm-http-goldens.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-http-api-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-http-api-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
const ABSENT_DB = join(SANDBOX, "absent", "events.db");
mkdirSync(AGENT, { recursive: true });
mkdirSync(EX, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;
process.env.SWARM_FIXED_TS = "2026-06-01T00:00:00.000Z";

const SELF = "/sessions/orch.jsonl";
const TOKEN = "http-golden-token";
const FIXED_MS = Date.parse("2026-06-01T00:00:00.000Z");
/** Deterministic usage resolver (fixed session path → fixed summary) so no
 *  sandbox path enters a session-node id and the golden stays machine-
 *  independent; a path not in the map degrades to usage-unavailable. */
const usageResolver = (sessionPath: string) => (sessionPath === "/sessions/w1.jsonl" ? { outputTokens: 42, contextPct: 0 } : null);
/** JSON-escape a fragment for a golden template's in-string placeholder. */
const jstr = (s: string): string => JSON.stringify(s).slice(1, -1);

function writeManifest(task: string, masterSessionPath: string | undefined, workers: unknown[]): void {
	const dir = join(EX, task);
	mkdirSync(dir, { recursive: true });
	const m: Record<string, unknown> = { schemaVersion: 1, task, dir, description: `${task} fixture`, workers };
	if (masterSessionPath !== undefined) m.masterSessionPath = masterSessionPath;
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, "\t")}\n`, "utf8");
}

const P = { kind: "tab", checkoutPath: "/repo", backend: "herdr", placementRef: "herdr:pane:1" };
const base = {
	placement: P,
	briefPath: "/b.md",
	reportPath: "/r.json",
	provider: "p",
	model: "m",
	thinking: "low",
	startedAt: "2026-06-01T00:10:00.000Z",
	orchestratorSessionPath: SELF,
	depth: 0,
};
// Multi-fleet: alpha (mine: w1 usage, w2 no session path, w3 missing usage file),
// beta (foreign), orphan (no resolvable parent → legacy-orphan).
writeManifest("alpha-fleet", SELF, [
	{ ...base, name: "w1", sessionPath: "/sessions/w1.jsonl", placement: { ...P, placementRef: "herdr:pane:1" } },
	{ ...base, name: "w2", placement: { ...P, placementRef: "herdr:pane:2" } },
	{ ...base, name: "w3", sessionPath: "/sessions/absent-w3.jsonl", placement: { ...P, placementRef: "herdr:pane:3" } },
]);
writeManifest("beta-fleet", "/sessions/other.jsonl", [
	{ ...base, name: "foreign1", sessionPath: "/sessions/foreign1.jsonl", orchestratorSessionPath: "/sessions/other.jsonl" },
]);
writeManifest("orphan-fleet", undefined, [{ ...base, name: "orphan1", orchestratorSessionPath: undefined, placement: { ...P, placementRef: "herdr:pane:9" } }]);

type Handle = { stop(): void; port: number; address: string };

/** One console transport with a streamConsole backlog then an idle tail. */
function consoleTransport(chunks: string[], status: AgentStatusName = "working") {
	return {
		backendName: () => "rpc",
		listStatuses: async () => [{ name: "w1", status, placementRef: "rpc:1" }],
		streamConsole: (_name: string) => {
			let i = 0;
			const sub = {
				[Symbol.asyncIterator]() {
					return sub;
				},
				async next(): Promise<IteratorResult<{ workerName: string; seq: number; timestamp: number; kind: string; payload: string }>> {
					if (i < chunks.length) {
						const payload = chunks[i]!;
						i += 1;
						return { value: { workerName: "w1", seq: i, timestamp: FIXED_MS, kind: "raw", payload }, done: false };
					}
					return new Promise(() => {}); // idle live tail — the capture's drain stops here
				},
				unsubscribe: () => {},
			};
			return sub;
		},
	};
}

// ---------------------------------------------------------------------------
// A compact raw-TCP WebSocket client + a raw upgrade probe (the
// swarm-console-ws-check pattern): the WS goldens are pinned against REAL
// frames from the mounted server, never reconstructed from the source.
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Server frames are unmasked text frames; a non-101 answer rejects (the
 *  upgrade-refusal leg uses rawUpgrade instead to read the full body). */
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

	static connect(port: number, path: string): Promise<WsClient> {
		return new Promise((resolve, reject) => {
			const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
			const sock = net.connect(port, "127.0.0.1");
			const timer = setTimeout(() => {
				sock.destroy();
				reject(new Error("ws connect timeout"));
			}, 5_000);
			sock.on("connect", () =>
				sock.write(
					`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
				),
			);
			let head = Buffer.alloc(0);
			const onData = (d: Buffer) => {
				head = Buffer.concat([head, d]);
				const idx = head.indexOf("\r\n\r\n");
				if (idx === -1) return;
				sock.off("data", onData);
				clearTimeout(timer);
				const text = head.subarray(0, idx).toString();
				const accept = createHash("sha1")
					.update(key + WS_GUID)
					.digest("base64");
				if (!text.includes("101") || !text.includes(accept)) {
					sock.destroy();
					reject(new Error(`ws handshake refused: ${text.split("\r\n")[0]}`));
					return;
				}
				const client = new WsClient(sock);
				client.buf = Buffer.from(head.subarray(idx + 4));
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
				this.wake();
			} else if (opcode === 0x8) {
				this.closed = true;
				this.sock.end();
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

/** Send a WS upgrade request and read the FULL plain-HTTP answer (the refusal
 *  leg: no 101, the socket just ends after the error envelope). */
function rawUpgrade(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
		const sock = net.connect(port, "127.0.0.1");
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("upgrade probe timeout"));
		}, 5_000);
		const chunks: Buffer[] = [];
		sock.on("connect", () =>
			sock.write(
				`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
			),
		);
		sock.on("data", (d: Buffer) => chunks.push(d));
		sock.on("close", () => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString("utf8");
			const idx = text.indexOf("\r\n\r\n");
			resolve({ status: Number(text.slice(9, 12)), body: idx === -1 ? "" : text.slice(idx + 4) });
		});
		sock.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

async function main(): Promise<void> {
	const { createJournalWriter } = await import("../src/swarm/journal.ts");
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");

	const w = createJournalWriter({ dbPath: DB, clock: { now: () => FIXED_MS, delay: () => Promise.resolve() } });
	for (const r of [
		{ kind: "spawn", sessionId: "sess-alpha", task: "alpha-fleet", worker: "w1", payload: { backend: "herdr", placementRef: "herdr:pane:1", briefPath: "/b.md", briefText: "# b" } },
		{ kind: "progress", sessionId: "sess-alpha", task: "alpha-fleet", worker: "w1", payload: { phase: "build", pct: 50 } },
	] as const) {
		const res = await w.append(r);
		if (!res.ok) throw new Error(`seed failed: ${res.code}`);
	}
	w.close();

	const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
		const e: NodeJS.ProcessEnv = { ...process.env };
		delete e.SWARM_SERVER_ENABLED;
		delete e.SWARM_SERVER_PORT;
		return { ...e, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0", SWARM_STORAGE: "files", ...extra };
	};

	async function req(port: number, method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string } = {}): Promise<{ status: number; body: string }> {
		const headers: Record<string, string> = {};
		if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
		let body: string | undefined;
		if (opts.rawBody !== undefined) body = opts.rawBody;
		else if (opts.body !== undefined) {
			body = JSON.stringify(opts.body);
			headers["content-type"] = "application/json";
		}
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body, signal: AbortSignal.timeout(5_000) });
		return { status: res.status, body: await res.text() };
	}
	const get = (port: number, path: string) => req(port, "GET", path);

	/** Byte-exact golden + the additive discipline on the same bytes. */
	function golden(name: string, actual: { status: number; body: string }, expected: { status: number; body: string }) {
		const byteOk = actual.status === expected.status && actual.body === expected.body;
		let addOk = false;
		try {
			addOk = additiveViolations(JSON.parse(expected.body) as unknown, JSON.parse(actual.body) as unknown).length === 0;
		} catch {
			addOk = false;
		}
		check(name, byteOk && addOk, `status ${actual.status} (want ${expected.status}); body=${actual.body.slice(0, 200)}`);
	}

	/** Byte-exact pin for a WS frame body (the handshake has no HTTP status). */
	function goldenFrame(name: string, actualBody: string, expectedBody: string) {
		check(name, actualBody === expectedBody, actualBody === expectedBody ? "" : `got=${actualBody.slice(0, 200)}`);
	}

	// -----------------------------------------------------------------------
	// Mount A — read + mutation (files mode, no transport)
	// -----------------------------------------------------------------------
	const h = await mountSwarmServer({ sessionFile: SELF, env: env(), operatorToken: TOKEN, usage: usageResolver, pollMs: 40 });
	check("A0 main mount returns a handle", h !== null);
	if (!h) throw new Error("cannot continue without a mounted server");

	// --- V: version + error taxonomy --------------------------------------
	const versionGolden = render(HTTP_GOLDENS.version, { VERSION: EXTENSION_VERSION });
	golden("V1 GET /api/version → byte-exact frozen envelope", await get(h.port, "/api/version"), { status: 200, body: versionGolden });
	golden("V2 unknown path → 404 E_SWARM_NOT_FOUND (schemaVersion present)", await get(h.port, "/api/nope"), {
		status: 404,
		body: render(HTTP_GOLDENS.notFound, { PATH: "/api/nope" }),
	});
	golden("V3 POST on a GET path → 405 E_SWARM_USAGE", await req(h.port, "POST", "/api/version", { body: {} }), {
		status: 405,
		body: render(HTTP_GOLDENS.methodNotAllowed, { PATH: "/api/version" }),
	});
	golden("V4 events bad cursor → 400 E_SWARM_USAGE", await get(h.port, "/api/swarm/events?after=abc"), {
		status: 400,
		body: render(HTTP_GOLDENS.invalidAfter, { VALUE: "abc" }),
	});
	golden("V5 static-asset path with no file → 404 E_SWARM_NOT_FOUND (the generic 404 envelope)", await get(h.port, "/missing-widget.js"), {
		status: 404,
		body: render(HTTP_GOLDENS.staticNotFound, { PATH: "/missing-widget.js" }),
	});

	// --- E: events over the seeded journal --------------------------------
	const ev = await get(h.port, "/api/swarm/events?after=0");
	let dbSize = "";
	try {
		dbSize = String((JSON.parse(ev.body) as { journal: { dbSizeBytes: number } }).journal.dbSizeBytes);
	} catch {
		/* failure detail below */
	}
	golden("E1 events over the seeded journal → byte-exact golden (dbSize substituted)", ev, {
		status: 200,
		body: render(HTTP_GOLDENS.events, { DBSIZE: dbSize }),
	});

	// --- S: snapshot over the multi-fleet fixture -------------------------
	const snap = await get(h.port, "/api/swarm/snapshot");
	golden("S1 snapshot → byte-exact golden (sandbox paths substituted)", snap, {
		status: 200,
		body: render(HTTP_GOLDENS.snapshot, { EXPATH: EX }),
	});
	{
		const g = (JSON.parse(snap.body) as { snapshot: { nodes: Array<Record<string, unknown>>; orphans: Array<Record<string, unknown>> } }).snapshot;
		const flagText = JSON.stringify(g);
		const flags = ["no-live-status", "no-session-path", "legacy-orphan", "usage-unavailable"];
		check(
			"S2 all four degraded flags appear in the snapshot (Law 13 degraded-fields contract)",
			flags.every((f) => flagText.includes(`"${f}"`)),
			flagText.slice(0, 200),
		);
		const tasks = g.nodes.filter((n) => n.kind === "task").map((n) => n.id);
		check("S3 multi-fleet: three task nodes (alpha-fleet, beta-fleet, orphan-fleet)", tasks.join(",") === "alpha-fleet,beta-fleet,orphan-fleet", tasks.join(","));
		check(
			"S4 orphan basket carries the legacy-orphan entry",
			g.orphans.length === 1 && (g.orphans[0] as { reason?: string }).reason === "legacy-orphan" && (g.orphans[0] as { worker?: string }).worker === "orphan1",
			JSON.stringify(g.orphans),
		);
	}

	// --- W: WS /api/swarm/stream frames + the upgrade-refusal envelope -----
	{
		const wc = await WsClient.connect(h.port, "/api/swarm/stream?after=0");
		const frames = await wc.waitFrames(2);
		check("W1 WS stream connected (snapshot + events frames)", frames.length >= 2, `frames=${frames.length}`);
		goldenFrame("W1.1 WS snapshot frame → byte-exact golden (the S1 graph, stream wrapping)", frames[0] ?? "", HTTP_STREAM_GOLDENS.streamSnapshot({ EXPATH: EX }));
		goldenFrame("W1.2 WS events frame → byte-exact golden (after=0, the E1 rows)", frames[1] ?? "", render(HTTP_STREAM_GOLDENS.streamEvents, { AFTER: "0" }));
		wc.close();
	}
	{
		const refused = await rawUpgrade(h.port, "/api/nope");
		golden("W2 WS upgrade on a non-stream path → 400 refusal envelope, no 101 (http1.ts:288)", refused, { status: 400, body: HTTP_GOLDENS.upgradeRefused });
	}

	// --- F: D1 per-fleet URL contract (issue #65 item 3) -------------------
	// Own fleet = this server's session ("orch" 36f9edae, task alpha-fleet);
	// the beta fleet (ef2f5792) is FOREIGN (read-only) and has no rows of its
	// own — the two fixture fleets the "no cross-traffic" leg needs.
	{
		const ownFleet = "36f9edae";
		const otherFleet = "ef2f5792";
		golden("F1 GET /api/swarm/fleets → byte-exact index (self + one row per fleet, own flags)", await get(h.port, "/api/swarm/fleets"), {
			status: 200,
			body: HTTP_GOLDENS.fleets,
		});
		golden("F2 GET /fleets/<own>/api/swarm/events?after=0 → ONLY the own fleet's rows", await get(h.port, `/fleets/${ownFleet}/api/swarm/events?after=0`), {
			status: 200,
			body: render(HTTP_GOLDENS.fleetEvents, { DBSIZE: dbSize }),
		});
		golden("F3 GET /fleets/<foreign>/api/swarm/events?after=0 → empty-but-valid, NEVER the own fleet's rows (no cross-traffic)", await get(h.port, `/fleets/${otherFleet}/api/swarm/events?after=0`), {
			status: 200,
			body: render(HTTP_GOLDENS.fleetEventsEmpty, { DBSIZE: dbSize }),
		});
		golden("F4 GET /fleets/<unknown>/api/swarm/events → 404 E_SWARM_NOT_FOUND (never a fabricated fleet)", await get(h.port, "/fleets/deadbeef/api/swarm/events?after=0"), {
			status: 404,
			body: render(HTTP_GOLDENS.fleetNotFound, { ID: "deadbeef" }),
		});
		{
			const idx = await get(h.port, "/");
			check(
				"F5 GET / with SEVERAL fleets serves the fleet index (the v1 SPA — no redirect)",
				idx.status === 200 && idx.body.includes('id="fleet-tree"') && idx.body.includes('type="module"'),
				`${idx.status} ${idx.body.slice(0, 60)}`,
			);
			const fleetPage = await get(h.port, `/fleets/${ownFleet}/`);
			check("F6 GET /fleets/<own>/ serves the fleet view (the SPA)", fleetPage.status === 200 && fleetPage.body.includes('id="fleet-tree"'), `${fleetPage.status}`);
			const missing = await get(h.port, "/fleets/deadbeef/");
			golden("F7 GET /fleets/<unknown>/ → 404 E_SWARM_NOT_FOUND", missing, { status: 404, body: render(HTTP_GOLDENS.fleetNotFound, { ID: "deadbeef" }) });
		}
		// WS scoped stream: own fleet gets its own rows; the foreign fleet never does.
		{
			const wc = await WsClient.connect(h.port, `/fleets/${ownFleet}/api/swarm/stream?after=0`);
			const frames = await wc.waitFrames(2);
			check("F8 WS /fleets/<own>/api/swarm/stream → snapshot + the own fleet's events", frames.length >= 2, `frames=${frames.length}`);
			goldenFrame("F8.1 WS scoped snapshot frame → byte-exact (the S1 graph, stream wrapping)", frames[0] ?? "", HTTP_STREAM_GOLDENS.streamSnapshot({ EXPATH: EX }));
			goldenFrame("F8.2 WS scoped events frame → byte-exact (only the own fleet's rows)", frames[1] ?? "", render(HTTP_STREAM_GOLDENS.streamEvents, { AFTER: "0" }));
			wc.close();
		}
		{
			const wc = await WsClient.connect(h.port, `/fleets/${otherFleet}/api/swarm/stream?after=0`);
			const frames = await wc.waitFrames(2, 400);
			check(
				"F9 WS /fleets/<foreign>/api/swarm/stream carries the snapshot but ZERO foreign events (no cross-traffic)",
				frames.length === 1 && frames[0] === HTTP_STREAM_GOLDENS.streamSnapshot({ EXPATH: EX }),
				`frames=${frames.length}`,
			);
			wc.close();
		}
		{
			const refused = await rawUpgrade(h.port, "/fleets/deadbeef/api/swarm/stream?after=0");
			check(
				"F10 WS /fleets/<unknown>/api/swarm/stream → plain 404 E_SWARM_NOT_FOUND, no 101 (never a fabricated stream)",
				refused.status === 404 && refused.body.includes("E_SWARM_NOT_FOUND"),
				`${refused.status} ${refused.body.slice(0, 120)}`,
			);
		}
	}

	// --- C: console (separate mounts with injected fixture graphs) --------
	const consoleSelf = "/sessions/console-rpc.jsonl";
	const graph = fixtureConsoleGraph(consoleSelf);
	const nodeId = fixtureConsoleWorkerId();
	{
		const hc = await mountSwarmServer({ sessionFile: consoleSelf, transport: consoleTransport(["hello ", "world"]) as never, graph, env: env() });
		check("C0 console live mount returns a handle", hc !== null);
		if (hc) {
			golden("C1 console live frame → byte-exact envelope (state live)", await get(hc.port, `/api/workers/${nodeId}/console`), {
				status: 200,
				body: render(HTTP_GOLDENS.consoleLive, { NODEID: nodeId }),
			});
			{
				const wsc = await WsClient.connect(hc.port, `/api/workers/${nodeId}/console/stream?offset=0`);
				const cframes = await wsc.waitFrames(1);
				goldenFrame("C1.1 console WS frame → byte-exact (the SAME consoleFrame as REST)", cframes[0] ?? "", render(HTTP_GOLDENS.consoleLive, { NODEID: nodeId }));
				wsc.close();
			}
			golden("C2 console bad offset → 400 E_CONSOLE_USAGE", await get(hc.port, `/api/workers/${nodeId}/console?offset=abc`), {
				status: 400,
				body: HTTP_GOLDENS.consoleUsage,
			});
			hc.stop();
		}
	}
	{
		// Captureless (herdr-shaped) backend → 200 unavailable frame, never an error.
		const hHerdr = await mountSwarmServer({
			sessionFile: "/sessions/console-herdr.jsonl",
			transport: { backendName: () => "herdr", listStatuses: async () => [] as Array<{ name: string; status: AgentStatusName }> } as never,
			graph: fixtureConsoleGraph("/sessions/console-herdr.jsonl"),
			env: env(),
		});
		check("C3 herdr-unavailable console mount returns a handle", hHerdr !== null);
		if (hHerdr) {
			golden("C3.1 captureless backend → 200 state:unavailable + E_CONSOLE_UNAVAILABLE (never an HTTP error)", await get(hHerdr.port, `/api/workers/${nodeId}/console`), {
				status: 200,
				body: render(HTTP_GOLDENS.consoleUnavailable, { NODEID: nodeId }),
			});
			{
				const wsc = await WsClient.connect(hHerdr.port, `/api/workers/${nodeId}/console/stream?offset=0`);
				const cframes = await wsc.waitFrames(1);
				goldenFrame("C3.2 console WS captureless → byte-exact unavailable frame (the SAME consoleFrame as REST)", cframes[0] ?? "", render(HTTP_GOLDENS.consoleUnavailable, { NODEID: nodeId }));
				wsc.close();
			}
			hHerdr.stop();
		}
	}
	{
		const hc = await mountSwarmServer({ sessionFile: "/sessions/console-refuse.jsonl", transport: consoleTransport(["x"]) as never, graph: fixtureConsoleGraph("/sessions/console-refuse.jsonl"), env: env() });
		if (hc) {
			const unknown = "deadbeef";
			golden("C4 unknown console id → 404 E_CONSOLE_WORKER_REFUSED (fail-closed)", await get(hc.port, `/api/workers/${unknown}/console`), {
				status: 404,
				body: render(HTTP_GOLDENS.consoleRefused, { MESSAGE: jstr(`no worker session node "${unknown}" in the read-model`) }),
			});
			const foreignId = fixtureForeignWorkerId();
			golden("C5 foreign-fleet console id → 404 E_CONSOLE_WORKER_REFUSED (no existence oracle)", await get(hc.port, `/api/workers/${foreignId}/console`), {
				status: 404,
				body: render(HTTP_GOLDENS.consoleRefused, { MESSAGE: jstr(`worker "${foreignId}" is not owned by this session (verdict foreign)`) }),
			});
			hc.stop();
		}
	}

	// --- M: mutation surface (files storage: #62 item 1 forces the audit
	//        append, so the envelope still carries the journal seq) ----------
	const answerPath = fixtureAnswerPath(EX, "alpha-fleet", "w1");
	// The journal is seeded with two rows above (seq 1, 2), so this first
	// HTTP mutation is seq 3 and the answer below is seq 4.
	golden("M1 steer success → byte-exact mutation envelope (files mode journals the audit row, #62 item 1)", await req(h.port, "POST", "/api/workers/w1/steer", { token: TOKEN, body: { text: "carry on" } }), {
		status: 200,
		body: render(HTTP_GOLDENS.steerOk, { ANSWER_PATH: answerPath, SEQ: "3" }),
	});
	const noToken = await req(h.port, "POST", "/api/workers/w1/steer", { body: { text: "x" } });
	const wrongToken = await req(h.port, "POST", "/api/workers/w1/steer", { token: "wrong", body: { text: "x" } });
	golden("M2 absent token → 401 E_SWARM_AUTH", noToken, { status: 401, body: HTTP_GOLDENS.authRefused });
	check("M3 wrong token → byte-identical refusal (indistinguishable)", wrongToken.status === 401 && wrongToken.body === noToken.body, `wrong=${wrongToken.body}`);
	golden("M4 foreign-fleet id → 403 E_SWARM_FORBIDDEN (fail-closed)", await req(h.port, "POST", "/api/workers/foreign1/steer", { token: TOKEN, body: { text: "x" } }), {
		status: 403,
		body: HTTP_GOLDENS.forbidden,
	});
	golden("M5 malformed body → 400 E_SWARM_USAGE", await req(h.port, "POST", "/api/workers/w1/steer", { token: TOKEN, rawBody: "not json" }), {
		status: 400,
		body: render(HTTP_GOLDENS.mutationUsage, { MESSAGE: jstr('a JSON body with a non-empty string "text" is required') }),
	});
	{
		writeFileSync(join(EX, "alpha-fleet", "q-w1.json"), `${JSON.stringify({ worker: "w1", ts: "2026-06-01T00:00:00.000Z", question: "which color?" })}\n`, "utf8");
		golden("M6 answer success → byte-exact envelope, verb answer", await req(h.port, "POST", "/api/asks/w1/answer", { token: TOKEN, body: { text: "42" } }), {
			status: 200,
			body: render(HTTP_GOLDENS.answerOk, { ANSWER_PATH: answerPath, SEQ: "4" }),
		});
	}
	h.stop();

	// -----------------------------------------------------------------------
	// Mount C — empty-journal events envelope
	// -----------------------------------------------------------------------
	{
		const hE = await mountSwarmServer({ sessionFile: "/sessions/empty.jsonl", env: env({ SWARM_JOURNAL_DB: ABSENT_DB }) });
		check("E2.0 empty-journal mount returns a handle", hE !== null);
		if (hE) {
			golden("E2 events over an ABSENT journal → byte-exact empty-but-valid golden", await get(hE.port, "/api/swarm/events?after=0"), {
				status: 200,
				body: HTTP_GOLDENS.eventsEmpty,
			});
			hE.stop();
		}
	}
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

watchdog.close?.();
if (failures > 0) {
	console.error(`\nswarm-http-api-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-http-api-check: all checks passed");
process.exit(0);