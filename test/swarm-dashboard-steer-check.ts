/**
 * swarm-dashboard-steer-check — issue #54 acceptance 1–7 (ARCHITECTURE §4.2.7):
 * the dashboard's console panel + steering controls.
 *
 * Run with: bun test/swarm-dashboard-steer-check.ts   (from repo root)
 *
 * The client modules are plain ES modules under src/swarm-server/public/ and
 * are imported headlessly (no build step). The check covers the five
 * pre-agreed seams:
 *   P1 console tail state machine — live / ended / ended-with-retained-backlog
 *      / unavailable are DISTINCT, honest banners; backlog preload + offset
 *      continuity.
 *   P2 console WS client — connects at an offset, stops reconnecting on a
 *      terminal state, reconnects while live.
 *   P3 steer confirmation — optimistic pending, confirmed ONLY on the matching
 *      journal `steer` event, failed on a structured error; `via` visible.
 *   P4 pending asks — folded from `ask`-without-`answer` journal events.
 *   P5 token handling — sessionStorage only, Bearer, structured 401.
 *   P6 honesty — controls disabled-with-reason for foreign fleet / ended worker,
 *      still enabled when the console is merely `unavailable`.
 *   P7 a real mounted-server round trip (console REST preload, steer POST with
 *      the token, journal row, pending-ask answer).
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every fetch is
 * loopback and bounded. Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FidelityStore } from "../src/stream-seam/fidelity-store.ts";
import { sessionIdFor } from "../src/swarm/nodes.ts";
import type { SwarmGraph } from "../src/swarm/graph.ts";
import type { AgentStatusName } from "../src/host.ts";
import type { ExchangeManifest } from "../src/manifest-store.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-dashboard-steer-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-dashboard-steer-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
mkdirSync(AGENT, { recursive: true });
mkdirSync(EX, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;
process.env.SWARM_STORAGE = "journal";
process.env.SWARM_SESSION_ID = "sess-54";
process.env.SWARM_FIXED_TS = "2026-08-01T00:00:00.000Z";

const publicUrl = (f: string): string => new URL(`../src/swarm-server/public/${f}`, import.meta.url).href;

const SELF = "/sessions/orch.jsonl";
const OTHER = "/sessions/other.jsonl";
const W1 = "/sessions/w1.jsonl";
const W2 = "/sessions/w2.jsonl";
const TOKEN = "test-token-54-xyz";

/** A minimal DOM seam (the renderer's document contract) shared by the DOM
 *  checks below. */
class FakeEl {
	attributes: Record<string, string> = {};
	childNodes: any[] = [];
	text = "";
	constructor(readonly tagName: string) {}
	setAttribute(k: string, v: string) { this.attributes[k] = String(v); }
	getAttribute(k: string) { return this.attributes[k] ?? null; }
	removeAttribute(k: string) { delete this.attributes[k]; }
	appendChild(c: any) { this.childNodes.push(c); return c; }
	removeChild(c: any) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; }
	get firstChild() { return this.childNodes[0] ?? null; }
	set className(v: string) { this.attributes.class = v; }
	get className() { return this.attributes.class ?? ""; }
	set textContent(v: string) { this.text = v; this.childNodes = []; }
	get textContent() { return this.text + this.childNodes.map((c) => c.textContent ?? "").join(""); }
}
function fakeDoc(els: Record<string, any> = {}): any {
	return {
		createElement: (t: string) => new FakeEl(t),
		createTextNode: (t: string) => ({ textContent: t, childNodes: [] }),
		getElementById: (id: string) => (els[id] ??= new FakeEl("div")),
	};
}
function walkEl(n: any, out: any[] = []): any[] {
	out.push(n);
	for (const c of n.childNodes ?? []) walkEl(c, out);
	return out;
}
function findEl(root: any, pred: (e: any) => boolean): any[] {
	return walkEl(root).filter((e) => e instanceof FakeEl && pred(e));
}

/** A worker fixture graph: w1 owned by SELF, w2 owned by OTHER. */
function fixtureGraph(): SwarmGraph {
	const orchId = sessionIdFor(SELF);
	const otherId = sessionIdFor(OTHER);
	const w1Id = sessionIdFor(W1);
	const w2Id = sessionIdFor(W2);
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
			session(orchId, SELF, false),
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

const MANIFESTS: ExchangeManifest[] = [
	{
		schemaVersion: 1,
		task: "alpha",
		dir: join(EX, "alpha"),
		masterSessionPath: SELF,
		workers: [
			{
				name: "w1",
				placement: { kind: "tab", backend: "fake", placementRef: "fake:1", checkoutPath: "/checkouts/w1" },
				briefPath: join(EX, "alpha", "brief-w1.md"),
				reportPath: join(EX, "alpha", "report-w1.json"),
				provider: "p",
				model: "m",
				thinking: "off",
				startedAt: "2026-08-01T00:00:00.000Z",
				orchestratorSessionPath: SELF,
			},
		],
	},
];

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
	async getStatus() {
		return { name: "w1", status: "idle" as AgentStatusName };
	}
	async submitPrompt() {
		/* the nudge is accepted */
	}
}

const capturelessTransport = () => ({
	backendName: () => "herdr",
	listStatuses: async () => [] as Array<{ name: string; status: AgentStatusName; placementRef?: string }>,
	async getStatus() {
		return { name: "w1", status: "idle" as AgentStatusName };
	},
	async submitPrompt() {},
});

/** Minimal in-memory sessionStorage seam (the documented token store). */
function fakeStorage(): Storage {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, String(v)),
		removeItem: (k: string) => void m.delete(k),
		clear: () => m.clear(),
		key: (i: number) => [...m.keys()][i] ?? null,
		get length() {
			return m.size;
		},
	} as unknown as Storage;
}

async function main(): Promise<void> {
	const consoleMod = (await import(publicUrl("console.js"))) as any;
	const steer = (await import(publicUrl("steer.js"))) as any;

	// -- P1 — console state machine + honest banners ------------------------
	{
		let st = consoleMod.initialConsoleState(0);
		check("P1.1 initial state is loading at the requested offset", st.status === "loading" && st.nextOffset === 0 && st.text === "");
		st = consoleMod.reduceConsoleFrame(st, { ok: true, worker: "w1", nodeId: "n1", state: "live", chunk: "hello ", nextOffset: 6, oldestOffset: 0, dropped: false });
		st = consoleMod.reduceConsoleFrame(st, { ok: true, worker: "w1", nodeId: "n1", state: "live", chunk: "world", nextOffset: 11, oldestOffset: 0, dropped: false });
		check("P1.2 live frames append the tail and advance nextOffset", st.status === "live" && st.text === "hello world" && st.nextOffset === 11, JSON.stringify(st));
		const live = consoleMod.consoleBanner(st);
		check("P1.3 live banner", live.label === "live" && live.retained === false);

		const endedRetained = consoleMod.reduceConsoleFrame(st, { ok: true, worker: "w1", nodeId: "n1", state: "ended-with-retained-backlog", chunk: "!", nextOffset: 12, oldestOffset: 0, dropped: false });
		const ended = consoleMod.reduceConsoleFrame(st, { ok: true, worker: "w1", nodeId: "n1", state: "ended", chunk: "", nextOffset: 0, oldestOffset: 0, dropped: false });
		const unavailable = consoleMod.reduceConsoleFrame(st, {
			ok: true,
			worker: "w1",
			nodeId: "n1",
			state: "unavailable",
			chunk: "",
			nextOffset: 0,
			oldestOffset: 0,
			dropped: false,
			error: { code: "E_CONSOLE_UNAVAILABLE", message: "backend exposes no console stream" },
		});
		const bRet = consoleMod.consoleBanner(endedRetained);
		const bEnd = consoleMod.consoleBanner(ended);
		const bUn = consoleMod.consoleBanner(unavailable);
		check("P1.4 ended-with-retained-backlog is marked retained and shows the backlog", bRet.retained === true && endedRetained.text === "hello world!" && endedRetained.status === "ended-with-retained-backlog");
		check("P1.5 the three end/unavailable banners are distinct and honest", new Set([bRet.label, bEnd.label, bUn.label]).size === 3 && bRet.detail.length > 0 && bEnd.detail.length > 0 && bUn.detail.length > 0, JSON.stringify([bRet, bEnd, bUn]));

		const refused = consoleMod.reduceConsoleFrame(st, { ok: false, schemaVersion: 1, error: { code: "E_CONSOLE_WORKER_REFUSED", message: "not owned" } });
		check("P1.6 a refusal error envelope degrades to the foreign/unowned state", refused.status === "refused" && consoleMod.consoleBanner(refused).detail.length > 0, JSON.stringify(refused));

		check(
			"P1.7 REST preload + WS urls target the documented console routes by session node id",
			consoleMod.consoleRestUrl("n1", 0) === "/api/workers/n1/console?offset=0" &&
				consoleMod.consoleStreamUrlFor({ protocol: "http:", host: "127.0.0.1:7331" }, "n1", 12) === "ws://127.0.0.1:7331/api/workers/n1/console/stream?offset=12",
			consoleMod.consoleStreamUrlFor({ protocol: "http:", host: "h" }, "n1", 12),
		);

		// Tail is bounded (never an unbounded DOM text node).
		let big = consoleMod.initialConsoleState(0);
		for (let i = 0; i < 40; i++) big = consoleMod.reduceConsoleFrame(big, { ok: true, state: "live", chunk: "x".repeat(2000), nextOffset: (i + 1) * 2000, oldestOffset: 0, dropped: false });
		check("P1.8 the retained tail is character-capped", big.text.length <= consoleMod.CONSOLE_TAIL_MAX_CHARS, `len=${big.text.length}`);
	}

	// -- P2 — console WS client --------------------------------------------
	{
		const urls: string[] = [];
		const sockets: any[] = [];
		let scheduled: (() => void) | null = null;
		const mk = (): any => {
			const s: any = { closed: false, close() { this.closed = true; } };
			sockets.push(s);
			return s;
		};
		const frames: any[] = [];
		const tail = consoleMod.createConsoleTail({
			url: "ws://h/api/workers/n1/console/stream",
			offset: 5,
			connect: (u: string) => {
				urls.push(u);
				return mk();
			},
			schedule: (fn: () => void) => {
				scheduled = fn;
				return 0;
			},
			onFrame: (f: any) => frames.push(f),
		});
		check("P2.1 connects at the resume offset", urls[0] === "ws://h/api/workers/n1/console/stream?offset=5", urls[0]);
		sockets[0].onmessage({ data: JSON.stringify({ ok: true, state: "live", chunk: "abc", nextOffset: 8, oldestOffset: 0, dropped: false }) });
		check("P2.2 a valid frame is delivered", frames.length === 1 && frames[0].chunk === "abc");
		sockets[0].onclose();
		check("P2.3 a live disconnect schedules a reconnect", scheduled !== null);
		if (scheduled) (scheduled as () => void)();
		check("P2.4 reconnect resumes from the last nextOffset", urls[1] === "ws://h/api/workers/n1/console/stream?offset=8", urls[1]);
		sockets[1].onmessage({ data: JSON.stringify({ ok: true, state: "ended-with-retained-backlog", chunk: "!", nextOffset: 9, oldestOffset: 0, dropped: false }) });
		scheduled = null;
		sockets[1].onclose();
		check("P2.5 an ended state stops reconnecting", scheduled === null);
		tail.close();
	}

	// -- P3 — optimistic-with-confirmation steer ---------------------------
	{
		const pending = steer.newPending("steer", "w1", "hold on", 10);
		check("P3.1 a post starts pending", steer.pendingView(pending).status === "pending");
		const unrelated = [{ seq: 11, kind: "progress", worker: "w1", payload: {} }];
		check("P3.2 an unrelated event does not confirm", steer.reducePending([pending], unrelated)[0].status === "pending");
		const early = [{ seq: 10, kind: "steer", worker: "w1", payload: { text: "hold on", via: "http" } }];
		check("P3.3 an event at/before the base seq does not confirm", steer.reducePending([pending], early)[0].status === "pending");
		const wrongWorker = [{ seq: 12, kind: "steer", worker: "w2", payload: { text: "hold on", via: "http" } }];
		check("P3.4 a different worker does not confirm", steer.reducePending([pending], wrongWorker)[0].status === "pending");
		const match = [{ seq: 12, kind: "steer", worker: "w1", payload: { text: "hold on", via: "http" } }];
		const confirmed = steer.reducePending([pending], match)[0];
		const cv = steer.pendingView(confirmed);
		check("P3.5 the matching journal `steer` event confirms", confirmed.status === "confirmed" && confirmed.confirmedSeq === 12);
		check("P3.6 the confirmation detail shows via:http", cv.detail.includes('via:"http"') || cv.detail.includes("via:http") || cv.via === "http", cv.detail);
		check("P3.7 a confirmed pending is idempotent", steer.reducePending([confirmed], [{ seq: 13, kind: "steer", worker: "w1", payload: { text: "hold on" } }])[0].status === "confirmed");
		const failed = steer.failPending(pending, "E_SWARM_FORBIDDEN: not owned");
		check("P3.8 a structured error marks the pending failed", failed.status === "failed" && failed.error.includes("FORBIDDEN"));
	}

	// -- P4 — pending-ask fold ---------------------------------------------
	{
		const events: any[] = [
			{ seq: 1, kind: "ask", worker: "w1", payload: { worker: "w1", question: "which port?", options: ["7331", "0"] } },
			{ seq: 2, kind: "steer", worker: "w1", payload: { text: "hi" } },
			{ seq: 3, kind: "answer", worker: "w2", payload: { text: "unrelated" } },
		];
		const asks = steer.pendingAsks(events);
		check("P4.1 an unanswered ask is pending", asks.length === 1 && asks[0].worker === "w1" && asks[0].question === "which port?" && asks[0].options.length === 2, JSON.stringify(asks));
		const cleared = steer.pendingAsks(events.concat([{ seq: 4, kind: "answer", worker: "w1", payload: { text: "7331", via: "http" } }]));
		check("P4.2 the answer event clears it", cleared.length === 0, JSON.stringify(cleared));
		const again = steer.pendingAsks(events.concat([{ seq: 4, kind: "answer", worker: "w1", payload: { text: "7331" } }, { seq: 5, kind: "ask", worker: "w1", payload: { worker: "w1", question: "again?" } }]));
		check("P4.3 a later question re-opens the pending ask", again.length === 1 && again[0].question === "again?");
	}

	// -- P5 — token handling -----------------------------------------------
	{
		const storage = fakeStorage();
		check("P5.1 no token initially", steer.readToken(storage) === null);
		steer.writeToken(storage, "t0k");
		check("P5.2 the token round-trips through sessionStorage only", steer.readToken(storage) === "t0k" && storage.getItem(steer.TOKEN_KEY) === "t0k");
		steer.clearToken(storage);
		check("P5.3 clearToken removes it", steer.readToken(storage) === null);

		const calls: Array<{ url: string; init: any }> = [];
		const fetchImpl = async (url: string, init: any) => {
			calls.push({ url, init });
			return { status: 200, json: async () => ({ ok: true, verb: "steer", worker: "w1", via: "http" }) };
		};
		const ok = await steer.postMutation({ fetch: fetchImpl, token: "t0k", kind: "steer", id: "n1", text: "go" });
		check("P5.4 steer posts Bearer to the mutation route", ok.ok === true && calls[0].url === "/api/workers/n1/steer" && calls[0].init.headers.authorization === "Bearer t0k" && JSON.parse(calls[0].init.body).text === "go", JSON.stringify(calls[0]));
		check("P5.5 the token never enters the URL", !calls[0].url.includes("t0k"));

		const unauthorized = await steer.postMutation({ fetch: async () => ({ status: 401, json: async () => ({ ok: false, error: { code: "E_SWARM_AUTH" } }) }), token: "bad", kind: "steer", id: "n1", text: "go" });
		check("P5.6 a structured 401 asks for a re-prompt", unauthorized.ok === false && unauthorized.authRequired === true);
		const forbidden = await steer.postMutation({ fetch: async () => ({ status: 403, json: async () => ({ ok: false, error: { code: "E_SWARM_FORBIDDEN" } }) }), token: "t0k", kind: "answer", id: "n1", text: "go" });
		check("P5.7 a 403 is structured and also flagged for re-prompt", forbidden.ok === false && forbidden.authRequired === true && forbidden.envelope.error.code === "E_SWARM_FORBIDDEN");
		const down = await steer.postMutation({ fetch: async () => { throw new Error("offline"); }, token: "t0k", kind: "steer", id: "n1", text: "go" });
		check("P5.8 a network failure is total (never throws)", down.ok === false && down.status === 0);

		// -- #65 item 2: the `#t=<token>` fragment bootstrap ------------------
		const bootstrap = (await import(publicUrl("auth-bootstrap.js"))) as any;
		const fStorage = fakeStorage();
		const stripped: string[] = [];
		const loc = { hash: "#t=frag-token-65", pathname: "/fleets/sess-54/", search: "" };
		const hist = {
			replaceState: (_s: unknown, _t: string, url: string) => {
				stripped.push(url);
				loc.hash = "";
			},
		};
		const moved = bootstrap.bootstrapFragmentToken({ location: loc, history: hist, storage: fStorage });
		check(
			"P5.9 a `#t=` fragment moves the token to the sessionStorage store and strips the address bar",
			moved === "frag-token-65" && steer.readToken(fStorage) === "frag-token-65" && stripped.length === 1 && stripped[0] === "/fleets/sess-54/",
			JSON.stringify({ moved, stripped }),
		);
		check(
			"P5.10 a bookmark WITHOUT a fragment bootstraps nothing (the manual prompt stays the fallback)",
			bootstrap.bootstrapFragmentToken({ location: { hash: "" }, history: hist, storage: fakeStorage() }) === null &&
				bootstrap.parseFragmentToken("#x=1") === null &&
				bootstrap.parseFragmentToken("#t=") === null,
		);
		check(
			"P5.11 the fragment reader is total: a throwing storage / missing seams never break page start",
			bootstrap.bootstrapFragmentToken({}) === null &&
				bootstrap.bootstrapFragmentToken({ location: { hash: "#t=x" }, history: null, storage: { setItem() { throw new Error("private mode"); } } }) === "x",
		);
	}

	// -- P6 — controls honesty ---------------------------------------------
	{
		const foreign = steer.controlsView({ worker: "w2", consoleStatus: "refused" });
		check("P6.1 a foreign-fleet card disables controls with a stated reason", foreign.disabled === true && foreign.reason.length > 0, JSON.stringify(foreign));
		const ended = steer.controlsView({ worker: "w1", consoleStatus: "ended" });
		check("P6.2 an ended worker disables controls with a stated reason", ended.disabled === true && ended.reason.length > 0, JSON.stringify(ended));
		const unavailable = steer.controlsView({ worker: "w1", consoleStatus: "unavailable" });
		check("P6.3 an unavailable console keeps steering enabled (acceptance 5)", unavailable.disabled === false);
		const live = steer.controlsView({ worker: "w1", consoleStatus: "live" });
		check("P6.4 a live owned worker is enabled", live.disabled === false);
		const withAsk = steer.controlsView({ worker: "w1", consoleStatus: "live", pendingAsk: { worker: "w1", question: "q?" } });
		check("P6.5 a pending ask exposes the answer form", withAsk.pendingAsk !== null && withAsk.pendingAsk.question === "q?");
	}

	// -- P6b — the panel + controls DOM contract (renderer) -----------------
	{
		const treeMod = (await import(publicUrl("tree.js"))) as any;
		const doc = fakeDoc();
		const view = {
			available: true,
			roots: [{ id: "alpha", kind: "task", workers: [{ name: "w1", run: 1, sessionId: "n1", liveStatus: "working", degraded: [] }], children: [], orphans: [], degraded: [], depth: 0 }],
			edges: [],
			nodeCount: 1,
		};
		const liveState = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), { ok: true, state: "live", chunk: "hello", nextOffset: 5, oldestOffset: 0, dropped: false });
		const extras = {
			panelOf: (w: any) => ({ ...consoleMod.consoleBanner(w.name === "w1" ? liveState : consoleMod.initialConsoleState(0)), worker: w.name, nodeId: w.sessionId }),
			controlsOf: (w: any) => ({ ...steer.controlsView({ worker: w.name, consoleStatus: "live" }), pendingAsk: null, draft: "" }),
		};
		const root = doc.createElement("section");
		treeMod.renderTree(view, root, doc, extras);
		const panel = findEl(root, (e) => e.attributes["data-console-for"] === "w1")[0];
		const tail = findEl(root, (e) => e.attributes["data-console-tail"] === "1")[0];
		const controls = findEl(root, (e) => e.attributes["data-steer-worker"] === "w1")[0];
		check("P6b.1 the worker card renders a live console panel with the tail", panel !== undefined && panel.attributes["data-console-state"] === "live" && tail.textContent === "hello", panel ? panel.textContent : "no panel");
		check("P6b.2 a live owned worker's controls are enabled", controls.attributes["data-steer-disabled"] === "0");

		const refusedState = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), { ok: false, error: { code: "E_CONSOLE_WORKER_REFUSED", message: "not owned" } });
		const root2 = doc.createElement("section");
		treeMod.renderTree(view, root2, doc, {
			panelOf: (w: any) => ({ ...consoleMod.consoleBanner(refusedState), worker: w.name, nodeId: w.sessionId }),
			controlsOf: (w: any) => ({ ...steer.controlsView({ worker: w.name, consoleStatus: "refused" }), pendingAsk: null, draft: "" }),
		});
		const controls2 = findEl(root2, (e) => e.attributes["data-steer-worker"] === "w1")[0];
		const reason = findEl(root2, (e) => e.attributes["data-disabled-reason"])[0];
		const input2 = findEl(root2, (e) => e.attributes["data-steer-input"] === "1")[0];
		check("P6b.3 a foreign card is disabled-with-reason (never hidden) and the input carries disabled", controls2.attributes["data-steer-disabled"] === "1" && reason.textContent.length > 0 && input2.getAttribute("disabled") === "disabled", reason ? reason.textContent : "no reason");

		const retainedState = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), { ok: true, state: "ended-with-retained-backlog", chunk: "history", nextOffset: 7, oldestOffset: 0, dropped: false });
		const root3 = doc.createElement("section");
		treeMod.renderTree(view, root3, doc, { panelOf: (w: any) => ({ ...consoleMod.consoleBanner(retainedState), worker: w.name, nodeId: w.sessionId }) });
		const panel3 = findEl(root3, (e) => e.attributes["data-console-for"] === "w1")[0];
		check("P6b.4 an ended-with-retained-backlog panel is marked retained and shows the backlog", panel3.attributes["data-console-retained"] === "1" && panel3.textContent.includes("history") && panel3.textContent.includes("retained"));
	}

	// -- P7 — real mounted-server round trip --------------------------------
	{
		const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
		const { createJournalWriter } = await import("../src/swarm/journal.ts");
		const t = new FakeConsoleTransport();
		t.add("w1");
		t.store.append("w1", "raw", "booting");
		const h = await mountSwarmServer({
			sessionFile: SELF,
			transport: t as never,
			graph: fixtureGraph(),
			manifests: { scan: () => MANIFESTS } as never,
			operatorToken: TOKEN,
			env: { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" },
		});
		check("P7.0 mount returns a handle", h !== null);
		if (!h) throw new Error("mount failed");
		const base = `http://127.0.0.1:${h.port}`;
		// The browser resolves the client's relative URLs against the page origin;
		// the headless check simulates that with an origin-prefixing wrapper.
		const browserFetch = ((url: string, init?: RequestInit) => fetch(`${base}${url}`, init)) as typeof fetch;
		const w1Id = sessionIdFor(W1);

		// console preload (REST) then live WS frame through the client reducer
		const rest = await fetch(`${base}${consoleMod.consoleRestUrl(w1Id, 0)}`);
		const frame = (await rest.json()) as any;
		let st = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), frame);
		check("P7.1 console REST preload renders a live tail", rest.status === 200 && st.status === "live" && st.text === "booting", JSON.stringify(st));
		t.store.append("w1", "raw", "…ready");
		const more = (await (await fetch(`${base}${consoleMod.consoleRestUrl(w1Id, st.nextOffset)}`)).json()) as any;
		st = consoleMod.reduceConsoleFrame(st, more);
		check("P7.2 offset continuity appends only the new bytes", st.text === "booting…ready", st.text);

		// foreign worker console preload → refused → controls disabled
		const w2Id = sessionIdFor(W2);
		const refused = (await (await fetch(`${base}${consoleMod.consoleRestUrl(w2Id, 0)}`)).json()) as any;
		const refusedState = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), refused);
		const foreignControls = steer.controlsView({ worker: "w2", consoleStatus: refusedState.status });
		check("P7.3 a foreign worker's console is refused and its controls disabled", refusedState.status === "refused" && foreignControls.disabled === true);

		// steer POST with the token → journal row → confirmation
		const post = await steer.postMutation({ fetch: browserFetch, token: TOKEN, kind: "steer", id: "w1", text: "please continue" });
		check("P7.4 a token-authenticated steer succeeds over HTTP", post.ok === true && post.envelope.via === "http", JSON.stringify(post.envelope));
		const events = (await (await fetch(`${base}/api/swarm/events?after=0`)).json()) as any;
		const pending = steer.newPending("steer", "w1", "please continue", 0);
		const confirmed = steer.reducePending([pending], events.events)[0];
		check("P7.5 the journal `steer` event confirms the pending mutation", confirmed.status === "confirmed" && steer.pendingView(confirmed).detail.includes("http"), JSON.stringify(events.events.map((e: any) => e.kind)));

		// no token → 401 structured
		const noAuth = await steer.postMutation({ fetch: browserFetch, token: "", kind: "steer", id: "w1", text: "x" });
		check("P7.6 an absent token is refused with a re-prompt signal", noAuth.ok === false && noAuth.authRequired === true && noAuth.envelope.error.code === "E_SWARM_AUTH");

		// ask → pending ask → answer clears it
		const writer = createJournalWriter({ dbPath: DB });
		const res = await writer.append({ kind: "ask", sessionId: "sess-54", task: "alpha", worker: "w1", payload: { worker: "w1", question: "continue?" } });
		writer.close();
		check("P7.7 the pending ask journal row committed", res.ok);
		const withAsk = (await (await fetch(`${base}/api/swarm/events?after=0`)).json()) as any;
		const asks = steer.pendingAsks(withAsk.events);
		check("P7.8 the streamed ask events surface a pending ask", asks.some((a: any) => a.worker === "w1" && a.question === "continue?"), JSON.stringify(asks));
		const answer = await steer.postMutation({ fetch: browserFetch, token: TOKEN, kind: "answer", id: "w1", text: "yes, continue" });
		check("P7.9 the answer POST succeeds over HTTP", answer.ok === true && answer.envelope.verb === "answer", JSON.stringify(answer.envelope));
		const after = (await (await fetch(`${base}/api/swarm/events?after=0`)).json()) as any;
		check("P7.10 the journal `answer` event clears the pending ask", steer.pendingAsks(after.events).length === 0, JSON.stringify(steer.pendingAsks(after.events)));

		h.stop();

		// captureless (herdr-shaped) backend: console unavailable, steering works
		const h2 = await mountSwarmServer({
			sessionFile: SELF,
			transport: capturelessTransport() as never,
			graph: fixtureGraph(),
			manifests: { scan: () => MANIFESTS } as never,
			operatorToken: TOKEN,
			env: { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" },
		});
		check("P7.11 second mount returns a handle", h2 !== null);
		if (h2) {
			const h2base = `http://127.0.0.1:${h2.port}`;
			const browserFetch2 = ((url: string, init?: RequestInit) => fetch(`${h2base}${url}`, init)) as typeof fetch;
			const unavailableFrame = (await (await fetch(`${h2base}${consoleMod.consoleRestUrl(w1Id, 0)}`)).json()) as any;
			const unavailableState = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), unavailableFrame);
			const controls = steer.controlsView({ worker: "w1", consoleStatus: unavailableState.status });
			check("P7.12 a captureless backend shows `unavailable` honestly and keeps steering enabled", unavailableState.status === "unavailable" && controls.disabled === false, JSON.stringify(unavailableState));
			const steerRes = await steer.postMutation({ fetch: browserFetch2, token: TOKEN, kind: "steer", id: "w1", text: "still here" });
			check("P7.13 steering still works on a console-unavailable backend", steerRes.ok === true, JSON.stringify(steerRes.envelope));
			h2.stop();
		}
	}

	// -- P9 — app wiring: console panel + steer confirmation -----------------
	{
		const appMod = (await import(publicUrl("app.js"))) as any;
		const streamMod = (await import(publicUrl("stream.js"))) as any;
		const els: Record<string, any> = {};
		const doc = fakeDoc(els);
		const graph = {
			available: true,
			sources: { journal: true, manifests: true, liveStatus: true, usage: false },
			nodes: [
				{ kind: "session", id: "s1", role: "orchestrator", isWorker: false, ownsChildren: true, tasks: ["t1"], degraded: [] },
				{ kind: "task", id: "t1", workers: [{ name: "w1", run: 1, sessionId: "n1", sessionPath: W1, liveStatus: "working", degraded: [] }], degraded: [] },
			],
			edges: [{ kind: "spawned_by", from: "t1", to: "s1" }],
			orphans: [],
		};
		let journalRows: any[] = [];
		let fakeSocket: any = null;
		let tailOpts: any = null;
		const fetchImpl = async (url: string, init?: any) => {
			if (init && init.method === "POST" && url.includes("/api/workers/")) return { status: 200, json: async () => ({ ok: true, verb: "steer", worker: "w1", via: "http" }) };
			if (url.startsWith("/api/swarm/snapshot")) return { json: async () => ({ ok: true, snapshot: graph }) };
			if (url.startsWith("/api/swarm/events")) {
				const after = Number(new URL(`http://h${url}`).searchParams.get("after") || "0");
				return { json: async () => ({ ok: true, events: journalRows.filter((e) => e.seq > after), journal: { count: journalRows.length, dbSizeBytes: 0 } }) };
			}
			if (url.includes("/console")) return { json: async () => ({ ok: true, worker: "w1", nodeId: "n1", state: "live", chunk: "hi", nextOffset: 2, oldestOffset: 0, dropped: false }) };
			throw new Error(`unexpected fetch ${url}`);
		};
		const storage = fakeStorage();
		storage.setItem(steer.TOKEN_KEY, TOKEN);
		const app = appMod.createFleetApp({
			doc,
			fetch: fetchImpl,
			storage,
			location: { protocol: "http:", host: "h" },
			// The REAL stream state machine over a fake socket: it advances
			// lastSeq BEFORE invoking onFrame (exactly like production), so the
			// exclusive-after cursor race (B1) is reproducible here.
			stream: (opts: any) =>
				streamMod.createSwarmStream({
					...opts,
					connect: () => (fakeSocket = { close() {} }),
					schedule: () => 0,
				}),
			consoleTail: (opts: any) => {
				tailOpts = opts;
				return { close() {} };
			},
			prompt: () => TOKEN,
		});
		await app.start();
		await new Promise((r) => setTimeout(r, 200));
		const panel = findEl(els["fleet-tree"], (e) => e.attributes["data-console-for"] === "w1")[0];
		check("P9.1 start() renders the worker console panel with the preloaded tail", panel !== undefined && panel.attributes["data-console-state"] === "live" && panel.textContent.includes("hi"), panel ? panel.textContent : "no panel");
		check("P9.2 the live tail follows the preload offset", tailOpts !== null && tailOpts.offset === 2, JSON.stringify(tailOpts && tailOpts.offset));
		const controls = findEl(els["fleet-tree"], (e) => e.attributes["data-steer-worker"] === "w1")[0];
		check("P9.3 an owned live worker enables the steer controls", controls.attributes["data-steer-disabled"] === "0");

		await app.sendSteer("w1", "go");
		check("P9.4 a steer POST shows pending before confirmation", app.pending.length === 1 && app.pending[0].status === "pending", JSON.stringify(app.pending));
		journalRows = [{ seq: 1, kind: "steer", worker: "w1", payload: { text: "go", via: "http" } }];
		// Drive a real `events` frame carrying the confirming row. The stream has
		// already advanced lastSeq to 1, and the REST refetch is exclusive
		// (?after=1 returns nothing) — only folding the frame's OWN rows confirms.
		fakeSocket.onmessage({ data: JSON.stringify({ ok: true, type: "events", after: 0, events: journalRows }) });
		await new Promise((r) => setTimeout(r, 200));
		check("P9.5 the `steer` row arriving ON the frame itself confirms the pending mutation (no exclusive-after gap)", app.pending[0].status === "confirmed" && app.pending[0].detail.includes("http"), JSON.stringify(app.pending));

		// F2: a worker with no session id gets an honest terminal reason, not a
		// forever-pending "checking ownership…".
		const noSession = steer.controlsView({ worker: "wX", hasSession: false });
		check("P9.6 no session id → the honest 'no session id' disabled reason (never 'checking ownership…')", noSession.disabled === true && noSession.reasonCode === "no-session" && noSession.reason.includes("no session id"), JSON.stringify(noSession));
		app.close();

		// F1: a rejected token re-prompts at most MAX_AUTH_RETRIES times and NEVER
		// stacks a second pending marker (the old recursive submit did both).
		{
			const authEls: Record<string, any> = {};
			let authPosts = 0;
			let prompts = 0;
			const authFetch = async (url: string, init?: any) => {
				if (init && init.method === "POST" && url.includes("/api/workers/")) {
					authPosts++;
					return { status: 401, json: async () => ({ ok: false, error: { code: "E_SWARM_AUTH", message: "bad token" } }) };
				}
				if (url.startsWith("/api/swarm/snapshot")) return { json: async () => ({ ok: true, snapshot: graph }) };
				if (url.startsWith("/api/swarm/events")) return { json: async () => ({ ok: true, events: [], journal: { count: 0, dbSizeBytes: 0 } }) };
				if (url.includes("/console")) return { json: async () => ({ ok: true, worker: "w1", nodeId: "n1", state: "live", chunk: "hi", nextOffset: 2, oldestOffset: 0, dropped: false }) };
				throw new Error(`unexpected fetch ${url}`);
			};
			const authStorage = fakeStorage();
			authStorage.setItem(steer.TOKEN_KEY, TOKEN);
			const authApp = appMod.createFleetApp({
				doc: fakeDoc(authEls),
				fetch: authFetch,
				storage: authStorage,
				location: { protocol: "http:", host: "h" },
				stream: () => streamMod.createSwarmStream({ url: "ws://h/api/swarm/stream", connect: () => ({ close() {} }), schedule: () => 0 }),
				consoleTail: () => ({ close() {} }),
				prompt: () => {
					prompts++;
					return TOKEN;
				},
			});
			await authApp.start();
			await authApp.sendSteer("w1", "retry me");
			check("P9.7 a rejected token caps re-prompts (1 POST + MAX_AUTH_RETRIES) and stacks ONE pending marker", authPosts === appMod.MAX_AUTH_RETRIES + 1 && prompts === appMod.MAX_AUTH_RETRIES && authApp.pending.length === 1, JSON.stringify({ authPosts, prompts, pending: authApp.pending }));
			check("P9.8 the capped token state is terminal ('rejected'), not an infinite prompt loop", authApp.pending[0].status === "failed" && authEls["token-state"].attributes["data-token-state"] === "rejected", JSON.stringify({ pending: authApp.pending[0], token: authEls["token-state"].attributes }));
			authApp.close();
		}
	}

	// The dashboard shell references the new modules (no build step).
	{
		const { readFileSync } = await import("node:fs");
		const idx = readFileSync(join(import.meta.dir, "..", "src", "swarm-server", "public", "index.html"), "utf8");
		const app = readFileSync(join(import.meta.dir, "..", "src", "swarm-server", "public", "app.js"), "utf8");
		check("P8.1 app.js imports the console + steer modules", app.includes("./console.js") && app.includes("./steer.js"));
		check("P8.2 the shell carries a token prompt affordance", idx.includes("operator-token") || idx.includes("data-token"));
	}
}

await main()
	.then(() => {
		clearTimeout(watchdog);
		console.log(failures === 0 ? "\nALL DASHBOARD STEER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		clearTimeout(watchdog);
		console.error("swarm-dashboard-steer-check CRASHED", err);
		process.exit(1);
	});