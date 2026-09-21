/**
 * SwarmGraph projector check — swarm-core-v1 issue #29 (ARCHITECTURE §4.1.5,
 * Law 13).
 *
 * Run with: bun test/swarm-graph-check.ts   (from repo root)
 *
 * Checks:
 *   G1  flat fleet: sessions + spawn/collect/retire edges + role labels.
 *   G2  depth-2 fleet (5 leads × 4 workers): 26 session nodes, the 5 leads
 *       labelled worker-orchestrator, depths 0/1, 26 spawned_by edges.
 *   G3  legacy manifest without sessionPath → orphans + legacy-orphan /
 *       no-session-path degradation, no edges, no session nodes.
 *   G4  same-name retry → two embodiments with distinct manifestRefs.
 *   G5  each input source degraded one at a time (journal / manifests /
 *       transport / usage).
 *   G6  deterministic output: two runs serialize byte-equal.
 *   G7  SessionId parity with the watcherKey convention (watch-store.ts).
 *   G8  never throws: every input failing still yields a valid graph.
 *
 * Fail-fast (AGENTS.md command discipline): a top-level watchdog exits
 * non-zero no matter what.
 *
 * Exit 0 only if all checks pass.
 */

import { createMemoryManifestStore, type ExchangeManifest, type ManifestWorker, type ManifestStore } from "../src/manifest-store.ts";
import { watcherKeyFor } from "../src/watch-store.ts";
import {
	buildSwarmGraph,
	emptyGraph,
	serializeSwarmGraph,
	SWARM_GRAPH_SCHEMA_VERSION,
	type SwarmGraph,
	type SwarmGraphDeps,
} from "../src/swarm/graph.ts";
import { sessionIdFor, type SwarmSessionNode, type SwarmTaskNode } from "../src/swarm/nodes.ts";
import type { AgentStatus } from "../src/host.ts";
import type { JournalEvent } from "../src/swarm/journal-read.ts";

const watchdog = setTimeout(() => {
	console.error("SWARM-GRAPH CHECK WATCHDOG FIRED (a step hung)");
	process.exit(1);
}, 20_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function worker(over: Partial<ManifestWorker> & { name: string }): ManifestWorker {
	const { name, ...rest } = over;
	return {
		name,
		placement: rest.placement ?? { kind: "tab", checkoutPath: "/repo", backend: "fake", placementRef: `fake:${name}` },
		briefPath: rest.briefPath ?? `/tmp/exchange/t/brief-${name}.md`,
		reportPath: rest.reportPath ?? `/tmp/exchange/t/report-${name}.json`,
		provider: rest.provider ?? "p",
		model: rest.model ?? "m",
		thinking: rest.thinking ?? "low",
		startedAt: rest.startedAt ?? "2026-01-01T00:00:00.000Z",
		...rest,
	};
}

function manifest(task: string, workers: ManifestWorker[], over: Partial<ExchangeManifest> = {}): ExchangeManifest {
	return { task, dir: `/tmp/exchange/${task}`, workers, ...over };
}

async function seed(store: ManifestStore, m: ExchangeManifest): Promise<void> {
	await store.update(m.dir, () => m);
}

function reader(events: JournalEvent[]): SwarmGraphDeps["journal"] {
	return { eventsAfter: () => events };
}

function transport(statuses: AgentStatus[]): SwarmGraphDeps["transport"] {
	return { listStatuses: async () => statuses, backendName: () => "fake" };
}

function sessions(graph: SwarmGraph): SwarmSessionNode[] {
	return graph.nodes.filter((n): n is SwarmSessionNode => n.kind === "session");
}
function taskNode(graph: SwarmGraph, id: string): SwarmTaskNode | undefined {
	return graph.nodes.find((n): n is SwarmTaskNode => n.kind === "task" && n.id === id);
}
function flags(node: { degraded: Array<{ flag: string }> }): string[] {
	return node.degraded.map((d) => d.flag);
}

const ROOT = "/sessions/orch.jsonl";
const USAGE: SwarmGraphDeps["usage"] = () => ({ outputTokens: 7, contextPct: 12 });

// ---------------------------------------------------------------------------
// G1 — flat fleet
// ---------------------------------------------------------------------------
{
	const store = createMemoryManifestStore();
	await seed(
		store,
		manifest(
			"flat",
			[
				worker({ name: "w1", sessionPath: "/sessions/w1.jsonl", orchestratorSessionPath: ROOT, depth: 0, collectedAt: "2026-01-02T00:00:00.000Z" }),
				worker({ name: "w2", sessionPath: "/sessions/w2.jsonl", orchestratorSessionPath: ROOT, depth: 0, retiredAt: "2026-01-03T00:00:00.000Z" }),
				worker({ name: "w3", sessionPath: "/sessions/w3.jsonl", orchestratorSessionPath: ROOT, depth: 0 }),
			],
			{ masterSessionPath: ROOT },
		),
	);
	const graph = await buildSwarmGraph({
		manifests: store,
		backendName: "fake",
		transport: transport([
			{ name: "w1", status: "idle", placementRef: "fake:w1" },
			{ name: "w2", status: "working", placementRef: "fake:w2" },
			{ name: "w3", status: "done", placementRef: "fake:w3" },
		]),
		usage: USAGE,
	});
	check("G1 sources: manifest + live + usage available, journal absent", graph.sources.manifests && graph.sources.liveStatus && graph.sources.usage && !graph.sources.journal, JSON.stringify(graph.sources));
	check("G1 four session nodes (orchestrator + 3 workers)", sessions(graph).length === 4, String(sessions(graph).length));
	const rootNode = sessions(graph).find((s) => s.id === sessionIdFor(ROOT));
	check("G1 orchestrator role via canonical sessionRole", rootNode?.role === "orchestrator" && rootNode.ownsChildren, JSON.stringify(rootNode));
	check("G1 worker roles are 'worker'", sessions(graph).filter((s) => s.id !== sessionIdFor(ROOT)).every((s) => s.role === "worker"));
	const flatEdges = graph.edges.filter((e) => e.kind === "spawned_by");
	check("G1 spawned_by edges: 3 workers→orchestrator + task→orchestrator", flatEdges.length === 4, JSON.stringify(flatEdges));
	check("G1 collected edge carries the stamp time", graph.edges.some((e) => e.kind === "collected" && e.from === sessionIdFor("/sessions/w1.jsonl") && e.to === "flat" && e.at === "2026-01-02T00:00:00.000Z"));
	check("G1 retired edge carries the stamp time", graph.edges.some((e) => e.kind === "retired" && e.from === sessionIdFor("/sessions/w2.jsonl") && e.to === "flat" && e.at === "2026-01-03T00:00:00.000Z"));
	check("G1 live status attached to the worker session", sessions(graph).find((s) => s.id === sessionIdFor("/sessions/w2.jsonl"))?.liveStatus === "working");
	check("G1 no orphans in a clean flat fleet", graph.orphans.length === 0, JSON.stringify(graph.orphans));
	check("G1 schemaVersion stamped", graph.schemaVersion === SWARM_GRAPH_SCHEMA_VERSION);
}

// ---------------------------------------------------------------------------
// G2 — depth-2 fleet: 5 leads × 4 workers
// ---------------------------------------------------------------------------
{
	const store = createMemoryManifestStore();
	const workers: ManifestWorker[] = [];
	for (let l = 1; l <= 5; l++) {
		const leadPath = `/sessions/lead${l}.jsonl`;
		workers.push(
			worker({
				name: `lead${l}`,
				sessionPath: leadPath,
				orchestratorSessionPath: ROOT,
				depth: 0,
				placement: { kind: "tab", checkoutPath: "/repo", backend: "fake", placementRef: `fake:lead${l}` },
			}),
		);
		for (let w = 1; w <= 4; w++) {
			workers.push(
				worker({
					name: `lead${l}-w${w}`,
					sessionPath: `/sessions/lead${l}-w${w}.jsonl`,
					orchestratorSessionPath: leadPath,
					depth: 1,
					placement: { kind: "tab", checkoutPath: "/repo", backend: "fake", placementRef: `fake:lead${l}-w${w}` },
				}),
			);
		}
	}
	await seed(store, manifest("deep", workers, { masterSessionPath: ROOT }));
	const graph = await buildSwarmGraph({ manifests: store, backendName: "fake", usage: USAGE });
	check("G2 26 session nodes (root + 5 leads + 20 workers)", sessions(graph).length === 26, String(sessions(graph).length));
	check(
		"G2 the five leads are worker-orchestrators",
		[1, 2, 3, 4, 5].every((l) => sessions(graph).find((s) => s.id === sessionIdFor(`/sessions/lead${l}.jsonl`))?.role === "worker-orchestrator"),
	);
	check(
		"G2 leaf workers are 'worker' and depth 1",
		[1, 2, 3, 4, 5].every((l) => [1, 2, 3, 4].every((w) => {
			const s = sessions(graph).find((x) => x.id === sessionIdFor(`/sessions/lead${l}-w${w}.jsonl`));
			return s?.role === "worker" && s.depth === 1;
		})),
	);
	check("G2 spawned_by edges = 26 (25 worker→spawner + task→root)", graph.edges.filter((e) => e.kind === "spawned_by").length === 26, String(graph.edges.filter((e) => e.kind === "spawned_by").length));
}

// ---------------------------------------------------------------------------
// G3 — legacy manifest without sessionPath → orphans
// ---------------------------------------------------------------------------
{
	const store = createMemoryManifestStore();
	await seed(
		store,
		manifest("legacy", [worker({ name: "legacy1" }), worker({ name: "legacy2" })], {}),
	);
	const graph = await buildSwarmGraph({ manifests: store, backendName: "fake", usage: USAGE });
	check("G3 two orphans (no resolvable parent)", graph.orphans.length === 2, JSON.stringify(graph.orphans));
	check("G3 orphans carry reason legacy-orphan", graph.orphans.every((o) => o.reason === "legacy-orphan"));
	check("G3 no session nodes without a path", sessions(graph).length === 0, String(sessions(graph).length));
	check("G3 no structural edges from orphans", graph.edges.length === 0, JSON.stringify(graph.edges));
	const t = taskNode(graph, "legacy");
	check("G3 task node carries legacy-orphan + no-session-path", t !== undefined && flags(t).includes("legacy-orphan") && flags(t).includes("no-session-path"), JSON.stringify(t?.degraded));
	check("G3 embodiments carry legacy-orphan", t?.workers.every((w) => flags(w).includes("legacy-orphan") && flags(w).includes("no-session-path")) === true);
}

// ---------------------------------------------------------------------------
// G4 — same-name retry → two embodiments with correct manifestRefs
// ---------------------------------------------------------------------------
{
	const store = createMemoryManifestStore();
	await seed(
		store,
		manifest(
			"retry",
			[
				worker({ name: "dup", sessionPath: "/sessions/dup0.jsonl", orchestratorSessionPath: ROOT, embodiment: { run: 0, placementRef: "fake:1" } }),
				worker({ name: "dup", sessionPath: "/sessions/dup1.jsonl", orchestratorSessionPath: ROOT, embodiment: { run: 1, placementRef: "fake:2" } }),
			],
			{ masterSessionPath: ROOT },
		),
	);
	const graph = await buildSwarmGraph({ manifests: store, backendName: "fake", usage: USAGE });
	const t = taskNode(graph, "retry");
	check("G4 two embodiments of the same name", t?.workers.length === 2, JSON.stringify(t?.workers));
	check("G4 runs are 0 and 1", t?.workers.map((w) => w.run).join(",") === "0,1", JSON.stringify(t?.workers.map((w) => w.run)));
	check(
		"G4 manifestRefs are distinct and correct",
		t?.workers[0]?.manifestRef.run === 0 &&
			t?.workers[0]?.manifestRef.placementRef === "fake:1" &&
			t?.workers[1]?.manifestRef.run === 1 &&
			t?.workers[1]?.manifestRef.placementRef === "fake:2",
		JSON.stringify(t?.workers.map((w) => w.manifestRef)),
	);
	check("G4 two distinct embodiment session nodes", sessions(graph).length === 3, String(sessions(graph).length));
}

// ---------------------------------------------------------------------------
// G5 — each input source degraded one at a time
// ---------------------------------------------------------------------------
{
	const store = createMemoryManifestStore();
	await seed(
		store,
		manifest("deg", [worker({ name: "w1", sessionPath: "/sessions/w1.jsonl", orchestratorSessionPath: ROOT })], { masterSessionPath: ROOT }),
	);

	const noTransport = await buildSwarmGraph({ manifests: store, backendName: "fake", usage: USAGE });
	check("G5 no transport → sources.liveStatus false", noTransport.sources.liveStatus === false);
	check(
		"G5 no transport → no-live-status on the worker session",
		flags(sessions(noTransport).find((s) => s.id === sessionIdFor("/sessions/w1.jsonl"))!).includes("no-live-status"),
	);

	const noUsage = await buildSwarmGraph({ manifests: store, backendName: "fake", transport: transport([{ name: "w1", status: "idle" }]) });
	check("G5 no usage resolver → sources.usage false", noUsage.sources.usage === false);
	check("G5 no usage → usage-unavailable on the task node", flags(taskNode(noUsage, "deg")!).includes("usage-unavailable"));

	const noJournal = await buildSwarmGraph({ manifests: store, backendName: "fake", usage: USAGE });
	check("G5 no journal reader → sources.journal false, graph still valid", noJournal.sources.journal === false && noJournal.nodes.length > 0);

	// journal-only projection: task + session nodes and edges from events alone.
	const sid = sessionIdFor(ROOT);
	const stamped = sessionIdFor("/sessions/jw.jsonl");
	const events: JournalEvent[] = [
		{ seq: 1, ts: "2026-01-01T00:00:00.000Z", kind: "spawn", sessionId: sid, task: "jtask", worker: "jw", payload: { depth: 0 } },
		{ seq: 2, ts: "2026-01-01T00:01:00.000Z", kind: "stamp", sessionId: sid, task: "jtask", worker: "jw", payload: { field: "sessionPath", value: "/sessions/jw.jsonl" } },
		{ seq: 3, ts: "2026-01-02T00:00:00.000Z", kind: "collect", sessionId: sid, task: "jtask", worker: "jw", payload: { status: "pass" } },
		{ seq: 4, ts: "2026-01-03T00:00:00.000Z", kind: "retire", sessionId: sid, task: "jtask", worker: "jw", payload: { reason: "ack" } },
	];
	const journalOnly = await buildSwarmGraph({ journal: reader(events), usage: USAGE });
	check("G5 no manifests → sources.manifests false, journal true", journalOnly.sources.manifests === false && journalOnly.sources.journal === true, JSON.stringify(journalOnly.sources));
	check("G5 journal-only: task node present", taskNode(journalOnly, "jtask") !== undefined);
	check("G5 journal-only: child session node present", sessions(journalOnly).some((s) => s.id === stamped));
	check(
		"G5 journal-only: spawned_by + collected + retired edges",
		journalOnly.edges.some((e) => e.kind === "spawned_by" && e.from === stamped && e.to === sid) &&
			journalOnly.edges.some((e) => e.kind === "collected" && e.from === stamped && e.to === "jtask" && e.at === "2026-01-02T00:00:00.000Z") &&
			journalOnly.edges.some((e) => e.kind === "retired" && e.from === stamped && e.to === "jtask" && e.at === "2026-01-03T00:00:00.000Z"),
		JSON.stringify(journalOnly.edges),
	);
	check("G5 journal-only: no legacy-orphan flag (manifest-only concept)", !flags(taskNode(journalOnly, "jtask")!).includes("legacy-orphan"), JSON.stringify(taskNode(journalOnly, "jtask")?.degraded));
	check("G5 journal-only: depth preserved from the spawn payload", sessions(journalOnly).find((s) => s.id === stamped)?.depth === 0 && taskNode(journalOnly, "jtask")?.depth === 0);
}

// ---------------------------------------------------------------------------
// G6 — deterministic output (two runs byte-equal)
// ---------------------------------------------------------------------------
{
	const mkWorkers = (order: "ba" | "ab"): ManifestWorker[] => {
		const b = worker({ name: "b", sessionPath: "/sessions/b.jsonl", orchestratorSessionPath: ROOT, collectedAt: "2026-01-02T00:00:00.000Z" });
		const a = worker({ name: "a", sessionPath: "/sessions/a.jsonl", orchestratorSessionPath: ROOT });
		return order === "ba" ? [b, a] : [a, b];
	};
	const storeA = createMemoryManifestStore();
	await seed(storeA, manifest("det", mkWorkers("ba"), { masterSessionPath: ROOT }));
	const storeB = createMemoryManifestStore();
	await seed(storeB, manifest("det", mkWorkers("ab"), { masterSessionPath: ROOT }));
	const mkDeps = (store: ManifestStore, statuses: AgentStatus[]): SwarmGraphDeps => ({ manifests: store, backendName: "fake", transport: transport(statuses), usage: USAGE });
	const one = await buildSwarmGraph(mkDeps(storeA, [{ name: "b", status: "idle" }, { name: "a", status: "working" }]));
	const two = await buildSwarmGraph(mkDeps(storeB, [{ name: "a", status: "working" }, { name: "b", status: "idle" }]));
	check("G6 two runs byte-equal", serializeSwarmGraph(one) === serializeSwarmGraph(two));
	check("G6 shuffled input order is canonicalized (order-independence)", serializeSwarmGraph(one) === serializeSwarmGraph(await buildSwarmGraph(mkDeps(storeA, [{ name: "b", status: "idle" }, { name: "a", status: "working" }]))));
}

// ---------------------------------------------------------------------------
// G7 — SessionId parity with the watcherKey convention
// ---------------------------------------------------------------------------
{
	check(
		"G7 sessionIdFor == watcherKeyFor for real paths",
		sessionIdFor("/sessions/orch.jsonl") === watcherKeyFor("/sessions/orch.jsonl") &&
			sessionIdFor("C:\\Users\\x\\s.jsonl") === watcherKeyFor("C:\\Users\\x\\s.jsonl"),
	);
	check("G7 an absent path degrades to 'anon'", sessionIdFor(undefined) === "anon" && sessionIdFor("") === "anon");
}

// ---------------------------------------------------------------------------
// G8 — never throws: every input failing still yields a valid graph
// ---------------------------------------------------------------------------
{
	const boom = new Error("boom");
	const throwing: SwarmGraphDeps = {
		manifests: { scan: () => { throw boom; } },
		journal: { eventsAfter: () => { throw boom; } },
		transport: { listStatuses: async () => { throw boom; }, backendName: () => "fake" },
		usage: () => { throw boom; },
		sessionRole: () => { throw boom; },
	};
	let graph: SwarmGraph | null = null;
	let threw = false;
	try {
		graph = await buildSwarmGraph(throwing);
	} catch {
		threw = true;
	}
	check("G8 never throws on failing inputs", !threw && graph !== null);
	check("G8 failing graph is valid and versioned", graph?.schemaVersion === SWARM_GRAPH_SCHEMA_VERSION && Array.isArray(graph?.nodes) && Array.isArray(graph?.edges) && Array.isArray(graph?.orphans));
	check("G8 failed sources reflected", graph?.sources.manifests === false && graph?.sources.journal === false && graph?.sources.liveStatus === false);
	// Degraded-vs-legitimately-empty distinction: dependency failures above are
	// data (available stays true); only the catastrophic fallback marks false.
	check("G8 dependency-degraded graph is still available", graph?.available === true);
	let serializeThrew = false;
	let emptyWire = "";
	try {
		emptyWire = serializeSwarmGraph(emptyGraph());
	} catch {
		serializeThrew = true;
	}
	check("G8 emptyGraph is distinguishable and serializes without throwing", !serializeThrew && emptyGraph().available === false && emptyWire.includes('"available":false'));
}

console.log(failures === 0 ? "\nALL SWARM-GRAPH CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);