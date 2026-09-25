/**
 * dashboard-ownership-check — issues #81 / #88 / #89 acceptance.
 *
 * #81 — the serving identity (the `/api/swarm/fleets` envelope's `self`) is
 *   wired into the read model: the own fleet is promoted, a foreign fleet is
 *   marked foreign (its degradations/asks never raise attention), and the
 *   attention strip renders an honest `scoping…` state while identity is
 *   unknown.
 * #88 — the events route and the WS tick cap a cursor read at the explicit
 *   page limit and page with `after=<lastSeq>`; the client event store is a
 *   bounded ring.
 * #89 — a non-2xx/`ok:false` envelope surfaces in the error banner
 *   (`role=alert` + operation label + code/message/hint + dismiss) with a
 *   per-region unavailable state, and the banner clears on the next
 *   successful read.
 *
 * The public modules run headlessly against a minimal fake document (the same
 * seam the other dashboard checks use). Fail-fast (AGENTS.md command
 * discipline): top-level watchdog; every wait has a deadline.
 */

const watchdog = setTimeout(() => {
	console.error("dashboard-ownership-check WATCHDOG TIMEOUT");
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

const publicUrl = (f: string): string => new URL(`../src/swarm-server/public/${f}`, import.meta.url).href;

// ---------------------------------------------------------------------------
// The minimal fake DOM seam (the renderers' document contract)
// ---------------------------------------------------------------------------
class FakeEl {
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
function fakeDoc(els: Record<string, any> = {}): any {
	return {
		createElement: (t: string) => new FakeEl(t),
		createTextNode: (t: string) => ({ textContent: t, childNodes: [] }),
		getElementById: (id: string) => (els[id] ??= new FakeEl("div")),
	};
}
function walk(n: any, out: any[] = []): any[] {
	out.push(n);
	for (const c of n.childNodes ?? []) walk(c, out);
	return out;
}
function byAttr(root: any, attr: string): any[] {
	return walk(root).filter((e) => e instanceof FakeEl && e.attributes[attr] !== undefined);
}

const OWN_ID = "own-sess";
const OWN_PATH = "/sessions/own.jsonl";
const FOREIGN_ID = "foreign-sess";
const FOREIGN_PATH = "/sessions/foreign.jsonl";
const NOW = Date.parse("2026-09-20T02:00:00.000Z");

/** One own fleet + one foreign fleet (the foreign one noisy on purpose). */
function fixture() {
	const graph = {
		schemaVersion: 1,
		available: true,
		sources: { journal: true, manifests: true, liveStatus: true, usage: true },
		nodes: [
			{ kind: "session", id: OWN_ID, sessionPath: OWN_PATH, role: "orchestrator", isWorker: false, ownsChildren: true, tasks: ["own-task"], degraded: [] },
			{ kind: "task", id: "own-task", workers: [{ name: "w1", sessionId: "own-w1", liveStatus: "working", degraded: [] }], degraded: [], depth: 0 },
			{ kind: "session", id: FOREIGN_ID, sessionPath: FOREIGN_PATH, role: "orchestrator", isWorker: false, ownsChildren: true, tasks: ["foreign-task"], degraded: [] },
			{ kind: "task", id: "foreign-task", workers: [{ name: "fw", sessionId: "foreign-w1", liveStatus: "working", degraded: [{ flag: "no-live-status" }] }], degraded: [{ flag: "no-live-status" }], depth: 0 },
		],
		edges: [
			{ kind: "spawned_by", from: "own-task", to: OWN_ID },
			{ kind: "spawned_by", from: "foreign-task", to: FOREIGN_ID },
		],
		orphans: [],
	};
	const events = [
		{ seq: 1, kind: "ask", worker: "fw", task: "foreign-task", payload: { question: "foreign question" } },
		{ seq: 2, kind: "progress", worker: "w1", task: "own-task", payload: { phase: "build", pct: 50 } },
	];
	return { graph, events };
}

async function main(): Promise<void> {
	const stateMod = (await import(publicUrl("state.js"))) as any;
	const attentionMod = (await import(publicUrl("attention.js"))) as any;
	const appMod = (await import(publicUrl("app.js"))) as any;
	const streamMod = (await import(publicUrl("stream.js"))) as any;
	const { createRouteTable } = (await import("../src/swarm-server/server.ts")) as any;
	const { graph, events } = fixture();

	// -- #81 — own/foreign ownership from the serving identity ---------------
	{
		const model = stateMod.buildDashboardState({ graph, events, ownSessionId: OWN_ID, nowMs: NOW });
		const ownGroup = model.rail.own.map((g: any) => g.session.id);
		const foreignGroup = model.rail.foreign.map((g: any) => g.session.id);
		check(
			"#81 the own fleet is promoted to rail.own and the foreign root is marked foreign (from ownSessionId)",
			ownGroup.includes(OWN_ID) && foreignGroup.includes(FOREIGN_ID) && model.byId.get(FOREIGN_ID).foreign === true && model.byId.get(OWN_ID).foreign === false,
			JSON.stringify({ own: ownGroup, foreign: foreignGroup }),
		);
		check(
			"#81 a foreign fleet's degradation + ask never raise attention (the own strip stays clear)",
			model.attention.clear === true && model.attention.items.every((i: any) => i.worker !== "fw" && i.nodeId !== FOREIGN_ID),
			JSON.stringify(model.attention.items),
		);
		const byPath = stateMod.buildDashboardState({ graph, events, ownSessionPath: OWN_PATH, nowMs: NOW });
		check(
			"#81 the ownSessionPath spelling (regression) marks the same foreign root",
			byPath.rail.foreign.map((g: any) => g.session.id).includes(FOREIGN_ID) && byPath.rail.own.map((g: any) => g.session.id).includes(OWN_ID),
		);
	}

	// -- #81 — the honest 'scoping…' strip while identity is unknown ---------
	{
		const model = stateMod.buildDashboardState({ graph, events, nowMs: NOW });
		const scopingRoot = fakeDoc().createElement("div");
		attentionMod.renderAttention(model, scopingRoot, fakeDoc(), { scoping: true });
		const knownRoot = fakeDoc().createElement("div");
		attentionMod.renderAttention(model, knownRoot, fakeDoc(), {});
		check(
			"#81 the attention strip renders 'scoping…' (and no chips) while the serving identity is unknown",
			byAttr(scopingRoot, "data-attention-scoping").length === 1 && scopingRoot.textContent.includes("scoping") && byAttr(scopingRoot, "data-attention-chip").length === 0,
			scopingRoot.textContent,
		);
		check("#81 with identity known the strip renders counts again (not scoping)", byAttr(knownRoot, "data-attention-scoping").length === 0 && byAttr(knownRoot, "data-attention-strip")[0]?.attributes["data-scoping"] === "0" && byAttr(knownRoot, "data-attention-strip").length === 1);
	}

	// -- #81 — the app wires the fleets envelope's `self` (and says 'scoping…' until then) --
	{
		const els: Record<string, any> = {};
		const doc = fakeDoc(els);
		let releaseFleets: () => void = () => {};
		const fleetsGate = new Promise<void>((r) => {
			releaseFleets = r;
		});
		const fetchImpl = async (url: string) => {
			if (url.includes("/api/swarm/fleets")) {
				await fleetsGate;
				return { ok: true, json: async () => ({ ok: true, self: { sessionId: OWN_ID, sessionPath: OWN_PATH }, fleets: [{ sessionId: OWN_ID, own: true, tasks: ["own-task"] }, { sessionId: FOREIGN_ID, own: false, tasks: ["foreign-task"] }] }) };
			}
			if (url.includes("/api/swarm/snapshot")) return { ok: true, json: async () => ({ ok: true, snapshot: graph }) };
			if (url.includes("/api/swarm/events")) return { ok: true, json: async () => ({ ok: true, events, journal: { count: 2, dbSizeBytes: 0 } }) };
			throw new Error(`unexpected fetch ${url}`);
		};
		const app = appMod.createFleetApp({
			doc,
			fetch: fetchImpl,
			storage: null,
			location: { protocol: "http:", host: "h", pathname: "/", search: "", hash: "" },
			stream: () => ({ state: { lastSeq: 0 }, close() {} }),
			consoleTail: () => ({ close() {} }),
			nowMs: () => NOW,
		});
		const started = app.start();
		const shell = els["fleet-tree"];
		const untilPaint = Date.now() + 2000;
		while (byAttr(shell, "data-attention-strip").length === 0 && Date.now() < untilPaint) await new Promise((r) => setTimeout(r, 20));
		check("#81 the app paints 'scoping…' while body.self is still unknown (no counts that retract)", byAttr(shell, "data-attention-scoping").length === 1 && byAttr(shell, "data-attention-chip").length === 0, shell.textContent);
		releaseFleets();
		await started;
		const untilResolved = Date.now() + 2000;
		while (byAttr(shell, "data-attention-scoping").length === 1 && Date.now() < untilResolved) await new Promise((r) => setTimeout(r, 20));
		check(
			"#81 createFleetApp derives the identity from body.self (foreign marked, own-first, strip not scoping)",
			app.state.byId.get(FOREIGN_ID).foreign === true && app.state.rail.foreign.map((g: any) => g.session.id).includes(FOREIGN_ID) && byAttr(shell, "data-attention-clear").length === 1 && byAttr(shell, "data-attention-scoping").length === 0,
			JSON.stringify({ foreign: app.state.byId.get(FOREIGN_ID).foreign }),
		);
		app.close();
	}

	// -- #88 — the client event store is a bounded ring ---------------------
	{
		let store: any[] = [];
		for (let i = 1; i <= 2500; i++) store = streamMod.foldEventStore(store, [{ seq: i }], 1000);
		const replayed = streamMod.foldEventStore(store, [{ seq: 2499 }, { seq: 2500 }], 1000);
		check(
			"#88 foldEventStore keeps only the last N rows, dedupes by seq and stays seq-monotone",
			store.length === 1000 && store[0].seq === 1501 && store[store.length - 1].seq === 2500 && replayed.length === 1000,
			`len=${store.length} first=${store[0]?.seq} last=${store[store.length - 1]?.seq}`,
		);
	}

	// -- #88 — the events route caps + pages the cursor read ----------------
	{
		const rows = Array.from({ length: 1200 }, (_, i) => ({ seq: i + 1, ts: "2026-01-01T00:00:00.000Z", kind: "progress", sessionId: "s", task: "t", worker: "w", payload: {} }));
		let seenLimit: number | null = null;
		const fakeJournal = {
			dbPath: ":memory:",
			eventsAfter(cursor: number, query?: { limit?: number }) {
				if (query && typeof query.limit === "number") seenLimit = query.limit;
				return rows.filter((r) => r.seq > cursor).slice(0, query && typeof query.limit === "number" ? query.limit : rows.length);
			},
			eventsForTask: () => [],
			eventsForWorker: () => [],
			count: () => rows.length,
			dbSizeBytes: () => 0,
			close: () => {},
		};
		const table = createRouteTable({ journal: fakeJournal, pollMs: 30 });
		const get = async (url: string) => JSON.parse((await table.onRequest({ method: "GET", path: "/api/swarm/events", query: new URLSearchParams(url), headers: {} })).body);
		const page1 = await get("after=0");
		const page2 = await get("after=500");
		const page3 = await get("after=1000");
		check(
			"#88 GET /api/swarm/events passes an explicit limit and pages with after=<lastSeq>",
			page1.events.length === 500 && page1.events[499].seq === 500 && page2.events.length === 500 && page2.events[0].seq === 501 && page3.events.length === 200 && page3.events[0].seq === 1001 && seenLimit === 500,
			JSON.stringify({ p1: page1.events.length, p2: page2.events[0]?.seq, p3: page3.events.length, seenLimit }),
		);
		check("#88 the events envelope shape is unchanged (ok/verb/schemaVersion/after/journal)", page1.ok === true && page1.verb === "events" && page1.schemaVersion === 1 && page1.after === 0 && page1.journal.count === 1200);

		// The WS tick pages too: one frame ≤ the limit, the next frame continues.
		const written: any[] = [];
		const socket: any = {
			destroyed: false,
			write: (buf: Buffer) => {
				const s = buf.toString("utf8");
				const i = s.indexOf("{");
				if (i >= 0) {
					try {
						written.push(JSON.parse(s.slice(i)));
					} catch {
						/* handshake bytes */
					}
				}
				return true;
			},
			on: () => {},
			destroy() {
				this.destroyed = true;
			},
			end: () => {},
		};
		table.onUpgrade({ method: "GET", path: "/api/swarm/stream", query: new URLSearchParams("after=0"), headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }, socket, Buffer.alloc(0));
		const deadline = Date.now() + 5000;
		while (written.filter((f) => f && f.type === "events").length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		const evFrames = written.filter((f) => f && f.type === "events");
		check(
			"#88 the WS tick caps each events frame at the page limit and the cursor advances to the next page",
			evFrames.length >= 2 && evFrames[0].events.length === 500 && evFrames[1].events.length === 500 && evFrames[1].events[0].seq === 501,
			JSON.stringify(evFrames.slice(0, 2).map((f) => [f.events.length, f.events[0]?.seq])),
		);
		table.close();
	}

	// -- #89 — the error banner + region states + recovery ------------------
	{
		const els: Record<string, any> = {};
		const doc = fakeDoc(els);
		let snapshotCalls = 0;
		const fetchImpl = async (url: string) => {
			if (url.includes("/api/swarm/fleets")) return { ok: true, json: async () => ({ ok: true, fleets: [] }) };
			if (url.includes("/api/swarm/snapshot")) {
				snapshotCalls++;
				if (snapshotCalls === 1) return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: "E_SWARM_INTERNAL", message: "boom", hint: "retry later" } }) };
				return { ok: true, json: async () => ({ ok: true, snapshot: graph }) };
			}
			if (url.includes("/api/swarm/events")) return { ok: true, json: async () => ({ ok: true, events: [], journal: { count: 0, dbSizeBytes: 0 } }) };
			throw new Error(`unexpected fetch ${url}`);
		};
		let captured: any = null;
		const app = appMod.createFleetApp({
			doc,
			fetch: fetchImpl,
			storage: null,
			location: { protocol: "http:", host: "h", pathname: "/", search: "", hash: "" },
			stream: (opts: any) => {
				captured = opts;
				return { state: { lastSeq: 0 }, close() {} };
			},
			consoleTail: () => ({ close() {} }),
			nowMs: () => NOW,
		});
		await app.start();
		const errEl = els["error"];
		const shell = els["fleet-tree"];
		check(
			"#89 a non-2xx envelope surfaces as role=alert with operation label + code/message/hint + dismiss",
			errEl.attributes.role === "alert" && byAttr(errEl, "data-error-op-label").length === 1 && errEl.textContent.includes("loading the fleet snapshot") && byAttr(errEl, "data-error-code")[0]?.textContent.includes("E_SWARM_INTERNAL") && errEl.textContent.includes("boom") && errEl.textContent.includes("retry later") && byAttr(errEl, "data-error-dismiss").length === 1,
			errEl.textContent,
		);
		check(
			"#89 a failed read renders the per-region 'cannot read' (unavailable) state, not a blank screen",
			byAttr(shell, "data-region-state").filter((e) => e.attributes["data-region-state"] === "unavailable").length >= 1 && byAttr(shell, "data-region-unavailable").length >= 1,
		);
		captured.onFrame({ type: "events", after: 0, events: [{ seq: 1, kind: "spawn", task: "own-task" }] }, "events");
		const deadline = Date.now() + 4000;
		while (snapshotCalls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		check(
			"#89 the banner auto-clears on the next successful snapshot (a structural frame refreshes it)",
			snapshotCalls >= 2 && errEl.getAttribute("hidden") === "1",
			`calls=${snapshotCalls} hidden=${errEl.getAttribute("hidden")}`,
		);
		app.close();
	}
}

await main()
	.then(() => {
		clearTimeout(watchdog);
		console.log(failures === 0 ? "\nALL DASHBOARD OWNERSHIP CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		clearTimeout(watchdog);
		console.error("dashboard-ownership-check CRASHED", err);
		process.exit(1);
	});
