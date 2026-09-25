/**
 * fleet-view-scope-check — issue #66 scope §7 / the #65 per-fleet interface.
 *
 * The regression this pins (found by two independent audits, #65 + #66): the
 * dashboard served at `/fleets/<sessionId>/` fetched the UNSCOPED
 * `/api/swarm/snapshot`, `/api/swarm/events` and `WS /api/swarm/stream`, so a
 * per-fleet view rendered EVERY fleet — the foreign fleet's nodes and its
 * attention. The server half already exists (#65: scoped events + scoped WS);
 * the CLIENT half — detect the serving base and consume only the own fleet —
 * is what this check drives RED first.
 *
 * The fixture carries TWO fleets: HOME (this page's fleet, task `home-task`)
 * and FOREIGN (task `foreign-task`). The `/fleets/<HOME>/` view must render
 * exactly HOME's nodes and exactly HOME's attention; the root view (`/`) keeps
 * the unscoped behavior (both fleets, foreign marked read-only, foreign
 * attention never raised).
 *
 * Snapshot scoping is client-side BY CONSTRUCTION, not by omission: the
 * snapshot envelope is the `swarm snapshot` CLI envelope VERBATIM (protocol
 * identity, ARCHITECTURE §4.2.2) and the scoped WS snapshot frame is a
 * byte-exact golden (`test/swarm-http-goldens.ts`, F8.1) — neither may carry a
 * filtered graph. The view therefore applies ONE client-side fleet filter (the
 * graph's own `spawned_by` tree under the fleet's root session node) to every
 * graph it folds, and never invents a per-fleet snapshot contract.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog 25s; no
 * unbounded waits.
 */

import { sessionIdFor } from "../src/swarm/nodes.ts";
import type { SwarmGraph } from "../src/swarm/graph.ts";

const watchdog = setTimeout(() => {
	console.error("fleet-view-scope-check WATCHDOG TIMEOUT");
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
// Two-fleet fixture
// ---------------------------------------------------------------------------

const HOME_PATH = "/sessions/home.jsonl";
const HOME_W1_PATH = "/sessions/home-w1.jsonl";
const FOREIGN_PATH = "/sessions/foreign.jsonl";
const FOREIGN_W1_PATH = "/sessions/foreign-w1.jsonl";
const HOME = sessionIdFor(HOME_PATH);
const HOME_W1 = sessionIdFor(HOME_W1_PATH);
const FOREIGN = sessionIdFor(FOREIGN_PATH);
const FOREIGN_W1 = sessionIdFor(FOREIGN_W1_PATH);
const HOST = "127.0.0.1:7331";

function sessionNode(spec: { id: string; path: string; task: string; depth: number; role: string; isWorker: boolean; ownsChildren: boolean; liveStatus?: string }) {
	return {
		kind: "session" as const,
		id: spec.id,
		sessionPath: spec.path,
		role: spec.role,
		isWorker: spec.isWorker,
		ownsChildren: spec.ownsChildren,
		tasks: [spec.task],
		depth: spec.depth,
		...(spec.liveStatus ? { liveStatus: spec.liveStatus } : {}),
		degraded: [] as Array<{ flag: string }>,
	};
}
function embodiment(name: string, path: string, task: string, depth: number) {
	return {
		name,
		run: 1,
		sessionId: sessionIdFor(path),
		sessionPath: path,
		depth,
		backend: "fake",
		liveStatus: "working",
		manifestRef: { task, worker: name, run: 1 },
		degraded: [] as Array<{ flag: string }>,
	};
}

function buildFixture(): { graph: SwarmGraph; events: Array<Record<string, unknown>> } {
	const graph = {
		schemaVersion: 1,
		available: true,
		sources: { journal: true, manifests: true, liveStatus: true, usage: true },
		nodes: [
			sessionNode({ id: HOME, path: HOME_PATH, task: "home-task", depth: 0, role: "orchestrator", isWorker: false, ownsChildren: true }),
			sessionNode({ id: HOME_W1, path: HOME_W1_PATH, task: "home-task", depth: 1, role: "worker", isWorker: true, ownsChildren: false, liveStatus: "working" }),
			{ kind: "task" as const, id: "home-task", dir: "/exchange/home-task", depth: 0, workers: [embodiment("hw1", HOME_W1_PATH, "home-task", 1)], degraded: [] },
			sessionNode({ id: FOREIGN, path: FOREIGN_PATH, task: "foreign-task", depth: 0, role: "orchestrator", isWorker: false, ownsChildren: true }),
			sessionNode({ id: FOREIGN_W1, path: FOREIGN_W1_PATH, task: "foreign-task", depth: 1, role: "worker", isWorker: true, ownsChildren: false, liveStatus: "working" }),
			{ kind: "task" as const, id: "foreign-task", dir: "/exchange/foreign-task", depth: 0, workers: [embodiment("fw1", FOREIGN_W1_PATH, "foreign-task", 1)], degraded: [] },
		],
		edges: [
			{ kind: "spawned_by", from: "home-task", to: HOME },
			{ kind: "spawned_by", from: HOME_W1, to: HOME },
			{ kind: "spawned_by", from: "foreign-task", to: FOREIGN },
			{ kind: "spawned_by", from: FOREIGN_W1, to: FOREIGN },
		],
		orphans: [],
	} as unknown as SwarmGraph;
	const events = [
		{ seq: 1, kind: "ask", worker: "hw1", task: "home-task", payload: { question: "own question?" } },
		{ seq: 2, kind: "ask", worker: "fw1", task: "foreign-task", payload: { question: "foreign question?" } },
	];
	return { graph, events };
}

// ---------------------------------------------------------------------------
// Fake DOM seam (the renderers' document contract)
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
	set textContent(v: string) {
		this.text = v;
		this.childNodes = [];
	}
	get textContent(): string {
		return this.text + this.childNodes.map((c) => c.textContent ?? "").join("");
	}
}
function fakeDoc(): any {
	const els: Record<string, any> = {};
	return {
		createElement: (t: string) => new FakeEl(t),
		createTextNode: (t: string) => ({ textContent: t, childNodes: [] }),
		getElementById: (id: string) => (els[id] ??= new FakeEl("div")),
		querySelectorAll: () => [],
		querySelector: () => null,
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

/** The graph-shaped fetch the dashboard consumes; records every URL. */
function makeFetch(graph: SwarmGraph, events: Array<Record<string, unknown>>, calls: string[], scoped: boolean) {
	return async (url: string) => {
		calls.push(url);
		if (url === "/api/swarm/snapshot") return { json: async () => ({ ok: true, verb: "snapshot", snapshot: graph }) };
		if (url.includes("/api/swarm/snapshot")) throw new Error(`no per-fleet snapshot contract exists: ${url}`);
		if (/\/api\/swarm\/events\?after=\d+$/.test(url)) {
			return { json: async () => ({ ok: true, events: scoped ? events.slice(0, 1) : events, journal: { count: 2, dbSizeBytes: 64 } }) };
		}
		if (url.includes("/console")) return { json: async () => ({ ok: false, error: { code: "E_CONSOLE_ERROR", message: "not exercised here" } }) };
		throw new Error(`unexpected fetch ${url}`);
	};
}

async function main(): Promise<void> {
	const appMod = (await import(publicUrl("app.js"))) as any;
	const { graph, events } = buildFixture();

	// -- R0 — the fleet-scope module (the ONE client scoping rule) ----------
	let scopeMod: any = null;
	try {
		scopeMod = await import(publicUrl("fleet-scope.js"));
	} catch {
		scopeMod = null;
	}
	check("R0 fleet-scope.js exists (the ONE client-side fleet-scope seam)", scopeMod !== null);
	if (scopeMod) {
		const path = `/fleets/${HOME}/`;
		const scoped = scopeMod.servingScope({ pathname: path, protocol: "http:", host: HOST });
		const root = scopeMod.servingScope({ pathname: "/", protocol: "http:", host: HOST });
		check("R0.1 servingScope reads the fleet id + base from `/fleets/<id>/`", scoped.fleetId === HOME && scoped.base === `/fleets/${HOME}`, JSON.stringify(scoped));
		check("R0.2 servingScope treats `/` (and a pathless location) as the root view", root.fleetId === null && root.base === "" && scopeMod.servingScope({}).fleetId === null);
		check("R0.3 scopedUrl prefixes only the API paths", scopeMod.scopedUrl(`/fleets/${HOME}`, "/api/swarm/events?after=0") === `/fleets/${HOME}/api/swarm/events?after=0` && scopeMod.scopedUrl("", "/api/swarm/events?after=0") === "/api/swarm/events?after=0");
		check("R0.4 streamUrlFor builds the scoped WS URL under `/fleets/<id>/` (and the v1 URL at root)", scopeMod.streamUrlFor({ protocol: "http:", host: HOST, pathname: path }) === `ws://${HOST}/fleets/${HOME}/api/swarm/stream` && scopeMod.streamUrlFor({ protocol: "https:", host: HOST }) === `wss://${HOST}/api/swarm/stream`);
		const filtered = scopeMod.scopeGraphToFleet(graph, HOME);
		const ids = filtered.nodes.map((n: any) => n.id).sort();
		check("R0.5 scopeGraphToFleet keeps the fleet root + its spawned_by subtree only", ids.join(",") === [HOME, HOME_W1, "home-task"].sort().join(","), ids.join(","));
		check("R0.6 scopeGraphToFleet drops every edge/orphan that leaves the fleet", filtered.edges.length === 2 && filtered.orphans.length === 0 && filtered.edges.every((e: any) => ids.includes(e.from) && ids.includes(e.to)), JSON.stringify(filtered.edges));
		check("R0.7 the root view is unscoped by construction (a null fleet id returns the graph identity)", scopeMod.scopeGraphToFleet(graph, null) === graph && scopeMod.scopeGraphToFleet(graph, undefined) === graph);
	}

	// -- R1 — the `/fleets/<id>/` view reads only the scoped doors ----------
	const scopedCalls: string[] = [];
	let scopedStream: any = null;
	const scopedApp = appMod.createFleetApp({
		doc: fakeDoc(),
		fetch: makeFetch(graph, events, scopedCalls, true),
		storage: null,
		location: { protocol: "http:", host: HOST, pathname: `/fleets/${HOME}/`, search: "", hash: "" },
		stream: (opts: any) => {
			scopedStream = opts;
			return { state: { lastSeq: 0 }, close() {} };
		},
		consoleTail: () => ({ close() {} }),
		ownSessionPath: HOME_PATH,
		nowMs: () => Date.parse("2026-09-25T12:00:00.000Z"),
	});
	await scopedApp.start();
	// The journal fold lands on the render timer (the app's 50 ms debounce).
	await new Promise((r) => setTimeout(r, 80));
	check(
		"R1.1 the per-fleet view pulls its events from the scoped route and opens the scoped WS stream",
		scopedCalls.includes(`/fleets/${HOME}/api/swarm/events?after=0`) && !scopedCalls.includes("/api/swarm/events?after=0") && scopedStream !== null && scopedStream.url === `ws://${HOST}/fleets/${HOME}/api/swarm/stream`,
		JSON.stringify({ calls: scopedCalls, url: scopedStream && scopedStream.url }),
	);
	check(
		"R1.2 the snapshot read stays the ONE protocol-identity route (no invented per-fleet snapshot contract)",
		scopedCalls.includes("/api/swarm/snapshot") && !scopedCalls.some((u) => u.includes("/fleets/") && u.includes("/snapshot")),
		JSON.stringify(scopedCalls),
	);
	check(
		"R1.3 the per-fleet view opens NO console for a foreign fleet's worker",
		scopedCalls.some((u) => u.includes(`/api/workers/${HOME_W1}/console`)) && !scopedCalls.some((u) => u.includes(`/api/workers/${FOREIGN_W1}/console`)),
		JSON.stringify(scopedCalls),
	);

	// -- R2 — the per-fleet view renders ONLY its own fleet -----------------
	{
		const state = scopedApp.state;
		const ids = [...state.byId.keys()].sort();
		check(
			"R2.1 the folded model carries the own fleet's nodes and NONE of the foreign fleet's",
			ids.join(",") === [HOME, HOME_W1, "home-task"].sort().join(",") && !state.byId.has(FOREIGN) && !state.byId.has(FOREIGN_W1) && !state.byId.has("foreign-task"),
			ids.join(","),
		);
		check(
			"R2.2 the rail groups exactly one fleet owner (the page's own session)",
			state.rail.groups.length === 1 && state.rail.groups[0].session.id === HOME && state.rail.groups[0].foreign === false,
			JSON.stringify(state.rail.groups.map((g: any) => g.session.id)),
		);
		check(
			"R2.3 the attention strip shows ONLY the own fleet's ask (the foreign ask is never counted)",
			state.attention.askCount === 1 && state.attention.items.every((i: any) => i.worker !== "fw1") && state.attention.items.some((i: any) => i.worker === "hw1"),
			JSON.stringify(state.attention.items.map((i: any) => i.worker)),
		);
		const doc = fakeDoc();
		const root = doc.createElement("div");
		const railMod = (await import(publicUrl("rail.js"))) as any;
		railMod.renderRail(state, root, doc, {});
		const rendered = byAttr(root, "data-node-id").map((e) => e.attributes["data-node-id"]).sort();
		check(
			"R2.4 the rendered rail DOM shows no foreign node id",
			rendered.length > 0 && rendered.every((id: string) => [HOME, HOME_W1, "home-task"].includes(id)),
			rendered.join(","),
		);
	}

	// -- R3 — the scoped WS snapshot frame (full graph) cannot leak ---------
	check("R3.1 the scoped stream delivered its snapshot frame", scopedStream !== null && typeof scopedStream.onFrame === "function");
	if (scopedStream) {
		scopedStream.onFrame({ ok: true, type: "snapshot", snapshot: graph }, "snapshot");
		const state = scopedApp.state;
		check(
			"R3.2 a snapshot frame carrying the FULL graph is filtered to the fleet (no cross-fleet leak)",
			![...state.byId.keys()].some((id) => [FOREIGN, FOREIGN_W1, "foreign-task"].includes(id)),
			[...state.byId.keys()].join(","),
		);
		scopedStream.onFrame({ ok: true, type: "events", after: 0, events: [{ seq: 3, kind: "progress", worker: "fw1", task: "foreign-task", payload: { phase: "foreign", pct: 10 } }] }, "events");
		check("R3.3 a foreign worker's event cannot add a node to the fleet view", state.byId.get(FOREIGN_W1) === undefined && state.byId.get(HOME_W1) !== undefined);
	}
	scopedApp.close();

	// -- R4 — the root view keeps the unscoped behavior ---------------------
	{
		const rootCalls: string[] = [];
		let rootStream: any = null;
		const rootApp = appMod.createFleetApp({
			doc: fakeDoc(),
			fetch: makeFetch(graph, events, rootCalls, false),
			storage: null,
			location: { protocol: "http:", host: HOST, pathname: "/", search: "", hash: "" },
			stream: (opts: any) => {
				rootStream = opts;
				return { state: { lastSeq: 0 }, close() {} };
			},
			consoleTail: () => ({ close() {} }),
			ownSessionPath: HOME_PATH,
			nowMs: () => Date.parse("2026-09-25T12:00:00.000Z"),
		});
		await rootApp.start();
		await new Promise((r) => setTimeout(r, 80));
		check(
			"R4.1 the root view keeps the v1 unscoped reads",
			rootCalls.includes("/api/swarm/snapshot") && rootCalls.includes("/api/swarm/events?after=0") && rootStream !== null && rootStream.url === `ws://${HOST}/api/swarm/stream`,
			JSON.stringify({ calls: rootCalls, url: rootStream && rootStream.url }),
		);
		check(
			"R4.2 the root view still renders both fleets (own + foreign read-only)",
			rootApp.state.byId.has(HOME) && rootApp.state.byId.has(FOREIGN) && rootApp.state.rail.groups.length === 2,
			JSON.stringify([...rootApp.state.byId.keys()]),
		);
		check("R4.3 a foreign fleet's ask raises no attention at root (unchanged)", rootApp.state.attention.askCount === 1 && rootApp.state.attention.items.every((i: any) => i.worker !== "fw1"));
		rootApp.close();
	}
}

await main()
	.then(() => {
		clearTimeout(watchdog);
		console.log(failures === 0 ? "\nALL FLEET-VIEW SCOPE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		clearTimeout(watchdog);
		console.error("fleet-view-scope-check CRASHED", err);
		process.exit(1);
	});
