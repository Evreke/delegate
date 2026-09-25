/**
 * swarm-dashboard-check — issue #53 acceptance 1–6 (ARCHITECTURE §4.2):
 * the read-only fleet dashboard — static shell serving, WS stream apply +
 * cursor-resume reconnect, the degradation vocabulary, and the live tree
 * refresh through the app shell.
 *
 * Run with: bun test/swarm-dashboard-check.ts   (from repo root)
 *
 * The client modules are plain ES modules under src/swarm-server/public/ and
 * are imported headlessly (no build step, no framework). DOM rendering is
 * exercised through a minimal fake document seam (app.createFleetApp({ doc }))
 * — the same app shell the browser runs. The WS wire is covered end-to-end by
 * test/swarm-server-ws-check.ts; this check drives the dashboard's own client
 * state machine (reduceFrame + createSwarmStream reconnect) plus one real-wire
 * smoke against a mounted server.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every wait has
 * its own deadline. Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { serveStaticFile, resolveStaticPath, mimeForPath } from "../src/swarm-server/static.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-dashboard-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-dashboard-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
mkdirSync(AGENT, { recursive: true });
mkdirSync(EX, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;

const ROOT = resolve(import.meta.dir ?? ".", "..");
const publicUrl = (f: string): string => new URL(`../src/swarm-server/public/${f}`, import.meta.url).href;

// ---------------------------------------------------------------------------
// The headless DOM seam (the renderer's own document contract)
// ---------------------------------------------------------------------------

class FakeElement {
	attributes: Record<string, string> = {};
	childNodes: any[] = [];
	text = "";
	constructor(readonly tagName: string) {}
	setAttribute(k: string, v: string) {
		this.attributes[k] = String(v);
	}
	getAttribute(k: string) {
		return this.attributes[k] ?? null;
	}
	removeAttribute(k: string) {
		delete this.attributes[k];
	}
	appendChild(c: any) {
		this.childNodes.push(c);
		return c;
	}
	removeChild(c: any) {
		const i = this.childNodes.indexOf(c);
		if (i >= 0) this.childNodes.splice(i, 1);
		return c;
	}
	get firstChild() {
		return this.childNodes[0] ?? null;
	}
	set className(v: string) {
		this.attributes.class = v;
	}
	get className() {
		return this.attributes.class ?? "";
	}
	set textContent(v: string) {
		this.text = v;
		this.childNodes = [];
	}
	get textContent(): string {
		return this.text + this.childNodes.map((c) => c.textContent ?? "").join("");
	}
}
function walk(node: any, out: any[] = []): any[] {
	out.push(node);
	for (const c of node.childNodes ?? []) walk(c, out);
	return out;
}
function find(root: any, pred: (e: any) => boolean): any[] {
	return walk(root).filter((e) => e instanceof FakeElement && pred(e));
}

// ---------------------------------------------------------------------------
// A compact raw-TCP WebSocket client (the ws-check pattern, trimmed).
// ---------------------------------------------------------------------------
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
class WsClient {
	buf = Buffer.alloc(0);
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
	static async connect(port: number, query: string): Promise<WsClient> {
		return new Promise((res, rej) => {
			const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
			const sock = net.connect(port, "127.0.0.1");
			const timer = setTimeout(() => {
				sock.destroy();
				rej(new Error("ws connect timeout"));
			}, 5_000);
			sock.on("connect", () =>
				sock.write(
					`GET /api/swarm/stream${query} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
				),
			);
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
			const opcode = this.buf[0] & 0x0f;
			let len = this.buf[1] & 0x7f;
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
	close() {
		if (!this.closed) this.sock.end();
	}
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const stream = (await import(publicUrl("stream.js"))) as any;
	const degrade = (await import(publicUrl("degrade.js"))) as any;
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
	const { createJournalWriter } = await import("../src/swarm/journal.ts");

	// -- S1 — the static shell (seam 1) ------------------------------------
	{
		const pub = join(SANDBOX, "pub");
		mkdirSync(pub, { recursive: true });
		writeFileSync(join(pub, "index.html"), "<!doctype html><div id=\"fleet-tree\"></div>", "utf8");
		writeFileSync(join(pub, "app.js"), "export const x = 1;\n", "utf8");
		writeFileSync(join(pub, "app.css"), "body{}\n", "utf8");
		writeFileSync(join(SANDBOX, "secret.txt"), "nope", "utf8");

		check("S1.1 resolveStaticPath maps / to index.html", resolveStaticPath("/", pub) === join(pub, "index.html"));
		check("S1.2 resolveStaticPath keeps an asset under the root", resolveStaticPath("/app.js", pub) === join(pub, "app.js"));
		check("S1.3 traversal refused (.., backslash, absolute escape)", resolveStaticPath("/../secret.txt", pub) === null && resolveStaticPath("/a\\b.js", pub) === null && resolveStaticPath("//etc/passwd", pub) === null);
		const html = serveStaticFile("/", pub);
		const js = serveStaticFile("/app.js", pub);
		const css = serveStaticFile("/app.css", pub);
		check(
			"S1.4 MIME set html/js/css served with raw bytes",
			Boolean(html?.status === 200 && html.contentType?.startsWith("text/html") && js?.contentType?.startsWith("text/javascript") && css?.contentType?.startsWith("text/css")),
			JSON.stringify({ html: html?.contentType, js: js?.contentType, css: css?.contentType }),
		);
		check("S1.5 non-served extension falls through (null → 404)", serveStaticFile("/notes.txt", pub) === null && serveStaticFile("/missing.js", pub) === null);
		check("S1.6 mimeForPath ignores a dot before the last slash", mimeForPath("/dir.d/file") === undefined);
	}

	// -- seed a fixture fleet (manifest + journal) -------------------------
	const dir = join(EX, "dash-fleet");
	mkdirSync(dir, { recursive: true });
	const manifest = {
		task: "dash-fleet",
		dir,
		masterSessionPath: "/sessions/dash-orch.jsonl",
		description: "dashboard fixture fleet",
		workers: [
			{
				name: "w1",
				placement: { kind: "tab", checkoutPath: "/repo", backend: "herdr", placementRef: "herdr:pane:11" },
				briefPath: join(dir, "brief-w1.md"),
				reportPath: join(dir, "report-w1.json"),
				provider: "p",
				model: "m",
				thinking: "low",
				startedAt: "2026-06-01T00:10:00.000Z",
				collectedAt: "2026-06-01T00:20:00.000Z",
				sessionPath: "/sessions/dash-w1.jsonl",
				orchestratorSessionPath: "/sessions/dash-orch.jsonl",
				depth: 0,
			},
			{
				name: "w2",
				placement: { kind: "tab", checkoutPath: "/repo", backend: "herdr", placementRef: "herdr:pane:12" },
				briefPath: join(dir, "brief-w2.md"),
				reportPath: join(dir, "report-w2.json"),
				startedAt: "2026-06-01T00:11:00.000Z",
				sessionPath: "/sessions/dash-w2.jsonl",
				orchestratorSessionPath: "/sessions/dash-orch.jsonl",
				depth: 1,
			},
		],
	};
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");

	const FIXED_MS = Date.parse("2026-06-01T00:00:00.000Z");
	const clock = { now: () => FIXED_MS, delay: () => Promise.resolve() };
	{
		const w = createJournalWriter({ dbPath: DB, clock });
		for (const r of [
			{ kind: "spawn", sessionId: "sess-dash", task: "dash-fleet", worker: "w1", payload: { backend: "herdr", placementRef: "herdr:pane:11" } },
			{ kind: "progress", sessionId: "sess-dash", task: "dash-fleet", worker: "w1", payload: { phase: "build", pct: 50 } },
		] as const) {
			const res = await w.append(r);
			if (!res.ok) throw new Error(`seed append failed: ${res.code}`);
		}
		w.close();
	}

	const transport = { backendName: () => "herdr", listStatuses: async () => [{ name: "w1", status: "working" as const, placementRef: "herdr:pane:11" }] };
	const env: NodeJS.ProcessEnv = { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" };

	const h = await mountSwarmServer({ sessionFile: "/sessions/dash-server.jsonl", transport, env, pollMs: 40 });
	check("S0 mount returns a handle", h !== null);
	if (!h) throw new Error("mount failed");

	// -- S1i — the shell is served by the mounted server --------------------
	{
		const idx = await fetch(`http://127.0.0.1:${h.port}/`);
		const idxBody = await idx.text();
		const jsRes = await fetch(`http://127.0.0.1:${h.port}/app.js`);
		const cssRes = await fetch(`http://127.0.0.1:${h.port}/app.css`);
		const nope = await fetch(`http://127.0.0.1:${h.port}/notes.txt`);
		check(
			"S1.7 GET / serves index.html with the tree root + module script",
			idx.status === 200 && (idx.headers.get("content-type") ?? "").startsWith("text/html") && idxBody.includes('id="fleet-tree"') && idxBody.includes('type="module"') && idxBody.includes("/app.js"),
			`${idx.status} ${(idx.headers.get("content-type") ?? "")}`,
		);
		check("S1.8 GET /app.js + /app.css serve source (no build step)", jsRes.status === 200 && cssRes.status === 200 && (await jsRes.text()).includes("import"), `${jsRes.status}/${cssRes.status}`);
		check("S1.9 unknown path still 404s with the structured envelope", nope.status === 404 && (await nope.text()).includes("E_SWARM_NOT_FOUND"));
		// #65 item 3 (D1): with ONE fleet session present, `GET /` redirects to
		// that fleet's view (an injected single-session graph makes the branch
		// deterministic; the multi-fleet index leg is pinned by the API check).
		const soloGraph = {
			schemaVersion: 1,
			available: true,
			sources: { journal: true, manifests: true, liveStatus: false, usage: false },
			nodes: [{ kind: "session", id: "solo-sess", role: "orchestrator", isWorker: false, ownsChildren: false, tasks: ["solo-task"], degraded: [] }],
			edges: [],
			orphans: [],
		};
		const hSolo = await mountSwarmServer({ sessionFile: "/sessions/solo.jsonl", transport, env, pollMs: 40, graph: soloGraph as never });
		if (hSolo) {
			const redirect = await fetch(`http://127.0.0.1:${hSolo.port}/`, { redirect: "manual" });
			const fleetView = await fetch(`http://127.0.0.1:${hSolo.port}/fleets/solo-sess/`);
			check(
				"S1.10 GET / redirects to the single fleet view (302 → /fleets/<id>/) and that view serves the SPA",
				redirect.status === 302 && (redirect.headers.get("location") ?? "") === "/fleets/solo-sess/" && fleetView.status === 200 && (await fleetView.text()).includes('id="fleet-tree"'),
				`${redirect.status} ${redirect.headers.get("location")}`,
			);
			hSolo.stop();
		}
	}

	// -- S4 — the degradation vocabulary (seam 4) ---------------------------
	{
		check("S4.1 the vocabulary is the four closed flags", degrade.DEGRADED_FLAGS.length === 4 && degrade.DEGRADED_FLAGS.join(",") === "no-session-path,no-live-status,legacy-orphan,usage-unavailable");
		const classes = degrade.DEGRADED_FLAGS.map((f: string) => degrade.degradeClass(f));
		check("S4.2 the four flags map to four distinct class strings", new Set(classes).size === 4, JSON.stringify(classes));
	}

	// -- S3 — stream reducer + cursor-resume reconnect (seam 3+6) -----------
	{
		let st = stream.initialStreamState(0);
		st = stream.reduceFrame(st, { ok: true, type: "snapshot", snapshot: { available: true, nodes: [], edges: [], orphans: [] } });
		check("S3.1 a snapshot frame opens the stream and replaces the snapshot", st.state === "open" && st.snapshot !== null);
		st = stream.reduceFrame(st, { ok: true, type: "events", after: 0, events: [{ seq: 1 }, { seq: 2 }] });
		st = stream.reduceFrame(st, { ok: true, type: "events", after: 2, events: [{ seq: 2 }, { seq: 3 }] });
		st = stream.reduceFrame(st, { ok: true, type: "events", after: 3, events: [{ seq: 1 }, { seq: 3 }] });
		check("S3.2 event frames dedup by seq — no duplicates, no rewinds", st.lastSeq === 3 && st.events.map((e: any) => e.seq).join(",") === "1,2,3", JSON.stringify(st.events));
		const ignored = stream.reduceFrame(st, { ok: false, type: "events", events: [{ seq: 9 }] });
		check("S3.3 a malformed/not-ok frame is a no-op", ignored === st);

		const urls: string[] = [];
		const sockets: any[] = [];
		let scheduled: (() => void) | null = null;
		let scheduleCount = 0;
		const fakeSocket = () => {
			const s: any = { closed: false, close() { this.closed = true; } };
			sockets.push(s);
			return s;
		};
		const client = stream.createSwarmStream({
			url: "ws://127.0.0.1:1/api/swarm/stream",
			after: 0,
			connect: (u: string) => {
				urls.push(u);
				return fakeSocket();
			},
			schedule: (fn: () => void) => {
				scheduled = fn;
				scheduleCount++;
				return 0;
			},
			onState: () => {},
		});
		check("S3.4 first connect resumes from the stored cursor (after=0)", urls[0] === "ws://127.0.0.1:1/api/swarm/stream?after=0", urls[0]);
		sockets[0].onmessage({ data: JSON.stringify({ ok: true, type: "snapshot", snapshot: { available: true, nodes: [], edges: [], orphans: [] } }) });
		sockets[0].onmessage({ data: JSON.stringify({ ok: true, type: "events", after: 0, events: [{ seq: 1 }, { seq: 2 }] }) });
		sockets[0].onclose();
		check("S3.5 disconnect schedules a reconnect", scheduleCount === 1 && scheduled !== null, `count=${scheduleCount}`);
		if (scheduled) (scheduled as () => void)();
		check("S3.6 reconnect resumes with after=<lastSeq> (cursor-resume)", urls[1] === "ws://127.0.0.1:1/api/swarm/stream?after=2", urls[1]);
		sockets[1].onmessage({ data: JSON.stringify({ ok: true, type: "events", after: 2, events: [{ seq: 3 }] }) });
		const seqs = client.state.events.map((e: any) => e.seq);
		check("S3.7 no duplicated and no lost updates across the reconnect", seqs.join(",") === "1,2,3" && client.state.lastSeq === 3, JSON.stringify(seqs));
		client.close();
		sockets[1].onclose();
		check("S3.8 close() stops reconnecting", scheduleCount === 1, `count=${scheduleCount}`);
	}

	// -- S6 — real WS wire smoke (seam 3) -----------------------------------
	{
		const c = await WsClient.connect(h.port, "?after=0");
		const first = await c.waitFrames(2);
		const snapFrame = JSON.parse(first[0] ?? "{}") as any;
		const evFrame = JSON.parse(first[1] ?? "{}") as any;
		check(
			"S6.1 a real stream connect delivers the snapshot frame then an events frame",
			snapFrame.type === "snapshot" && evFrame.type === "events" && (evFrame.events ?? []).length === 2,
			`${first[0]?.slice(0, 60)} | ${first[1]?.slice(0, 60)}`,
		);
		const applied = stream.reduceFrame(stream.reduceFrame(stream.initialStreamState(0), snapFrame), evFrame);
		check("S6.2 the dashboard reducer applies the real frames (stream + tree source)", applied.snapshot !== null && applied.events.length === 2 && applied.lastSeq === 2);
		// Append one more event while connected; the frame must advance the cursor.
		const w = createJournalWriter({ dbPath: DB, clock });
		const res = await w.append({ kind: "progress", sessionId: "sess-dash", task: "dash-fleet", worker: "w2", payload: { phase: "collect", pct: 100 } });
		w.close();
		check("S6.3 the live append committed", res.ok);
		const live = await c.waitFrames(3);
		const liveEv = JSON.parse(live[2] ?? "{}") as any;
		const advanced = stream.reduceFrame(applied, liveEv);
		check("S6.4 the live event frame advances the cursor without loss (2 → 3)", liveEv.type === "events" && (liveEv.events ?? []).some((r: any) => r.seq === 3) && advanced.lastSeq === 3, live[2]?.slice(0, 120));
		c.close();
	}

	// -- S7 — app wiring: event batches refresh the tree without reload ------
	{
		const app = (await import(publicUrl("app.js"))) as any;
		const makeGraph = (n: number) => ({
			available: true,
			sources: { journal: true, manifests: true, liveStatus: true, usage: true },
			nodes: [
				{ kind: "session", id: "s1", role: "orchestrator", isWorker: false, ownsChildren: true, tasks: ["t1"], degraded: [] },
				...(n > 1 ? [{ kind: "task", id: `t${n}`, workers: [], degraded: [] }] : []),
			],
			edges: n > 1 ? [{ kind: "spawned_by", from: `t${n}`, to: "s1" }] : [],
			orphans: [],
		});
		const els: Record<string, FakeElement> = {};
		const doc = {
			createElement: (t: string) => new FakeElement(t),
			createTextNode: (t: string) => ({ textContent: t, childNodes: [] }),
			getElementById: (id: string) => (els[id] ??= new FakeElement("div")),
		};
		let snapshotCalls = 0;
		const fetchImpl = async (url: string) => {
			if (url.startsWith("/api/swarm/snapshot")) {
				snapshotCalls++;
				return { json: async () => ({ ok: true, verb: "snapshot", snapshot: makeGraph(snapshotCalls) }) };
			}
			if (url.startsWith("/api/swarm/events")) return { json: async () => ({ ok: true, journal: { count: 7, dbSizeBytes: 1234 } }) };
			throw new Error(`unexpected fetch ${url}`);
		};
		let captured: any = null;
		const streamFactory = (opts: any) => {
			captured = opts;
			return { state: { lastSeq: 0 }, close() {} };
		};
		const appInstance = app.createFleetApp({ doc, fetch: fetchImpl, storage: null, location: { protocol: "http:", host: "127.0.0.1:7331" }, stream: streamFactory });
		await appInstance.start();
		const nodeCount = () => find(els["fleet-tree"], (e) => "data-node-id" in e.attributes).length;
		check("S7.1 start() renders the snapshot tree and the journal footer", nodeCount() === 1 && els["journal-count"].textContent === "7" && els["journal-bytes"].textContent === "1234", `nodes=${nodeCount()}`);
		captured.onFrame({ type: "snapshot", snapshot: makeGraph(1) }, "snapshot");
		check("S7.2 a snapshot frame re-renders in place", nodeCount() === 1);
		captured.onFrame({ type: "events", after: 0, events: [{ seq: 1, kind: "progress", worker: "w1", payload: { phase: "build" } }] }, "events");
		await new Promise((r) => setTimeout(r, 150));
		check("S7.3 an events batch patches in place without a full snapshot re-fetch (#88)", snapshotCalls === 1 && nodeCount() === 1, `calls=${snapshotCalls} nodes=${nodeCount()}`);
		captured.onFrame({ type: "events", after: 1, events: [{ seq: 2, kind: "spawn", worker: "w9", task: "t2" }] }, "events");
		await new Promise((r) => setTimeout(r, 150));
		check("S7.3b a STRUCTURAL event frame does refresh the full snapshot (new node appears, #88)", snapshotCalls === 2 && nodeCount() === 2, `calls=${snapshotCalls} nodes=${nodeCount()}`);
		captured.onState("open");
		const pill = els["connection-state"];
		check(
			"S7.4 the connection-state indicator carries the raw token, the human label and the colour class (#79)",
			pill.attributes["data-connection-state"] === "open" && pill.textContent === "live" && pill.attributes.class === "conn conn-open",
			JSON.stringify({ text: pill.textContent, class: pill.attributes.class }),
		);
		captured.onState("closed");
		check(
			"S7.4b a closed stream flips the pill to 'disconnected' + the closed colour class (never a frozen 'connecting')",
			pill.attributes["data-connection-state"] === "closed" && pill.textContent === "disconnected" && pill.attributes.class === "conn conn-closed",
			JSON.stringify({ text: pill.textContent, class: pill.attributes.class }),
		);
		appInstance.close();
	}

	h.stop();
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

if (failures > 0) {
	console.error(`\nswarm-dashboard-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-dashboard-check: all checks passed");
process.exit(0);