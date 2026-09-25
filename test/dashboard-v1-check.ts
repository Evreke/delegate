/**
 * dashboard-v1-check — issue #66, dashboard v1 merged layout shell.
 *
 * Headless acceptance for the one-screen dashboard: the frame (rail / center
 * SVG canvas / detail panel / attention strip / statusbar), the status
 * language, the attention aggregates over OWN fleets only, the detail panel's
 * usage bar + last progress + ask banner + disabled-with-reason controls, the
 * deterministic depth-column graph with adaptive collapse, and the
 * in-place stream updates (progress / dead-reboot without relayout).
 *
 * The fixture is built here (1 orchestrator → 5 leads × 4 workers plus one
 * foreign fleet) with exactly 2 asks, 1 dead-reboot and 3 degraded nodes in
 * own fleets — the numbers the acceptance list names.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; no unbounded
 * waits. Exit 0 only if all checks pass.
 */

import { sessionIdFor } from "../src/swarm/nodes.ts";
import type { SwarmGraph } from "../src/swarm/graph.ts";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const watchdog = setTimeout(() => {
	console.error("dashboard-v1-check WATCHDOG TIMEOUT");
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
/** The dashboard asset directory as a filesystem path (bun's readFile rejects
 *  file:// URLs on this host, so reads go through fileURLToPath). */
const PUBLIC_DIR = fileURLToPath(new URL("../src/swarm-server/public/", import.meta.url));
const readAsset = (name: string): string => readFileSync(join(PUBLIC_DIR, name), "utf8");

// ---------------------------------------------------------------------------
// Fixture fleet
// ---------------------------------------------------------------------------

const SELF = "/sessions/orch.jsonl";
const FOREIGN = "/sessions/foreign-orch.jsonl";
const LEAD = (i: number) => `/sessions/lead-${i}.jsonl`;
const WORK = (i: number, j: number) => `/sessions/w${i}-${j}.jsonl`;

type Deg = { flag: string; detail?: string };

interface SessionSpec {
	path: string;
	workerName: string;
	task: string;
	depth: number;
	degraded?: Deg[];
	liveStatus?: string;
	collectedAt?: string;
	retiredAt?: string;
	startedAt?: string;
	usage?: { outputTokens?: number; contextPct?: number | null };
	role?: string;
	isWorker?: boolean;
	ownsChildren?: boolean;
}

function sessionNode(spec: SessionSpec) {
	return {
		kind: "session" as const,
		id: sessionIdFor(spec.path),
		sessionPath: spec.path,
		role: spec.role ?? (spec.ownsChildren ? "orchestrator" : "worker"),
		isWorker: spec.isWorker ?? true,
		ownsChildren: spec.ownsChildren ?? false,
		tasks: [spec.task],
		depth: spec.depth,
		...(spec.liveStatus ? { liveStatus: spec.liveStatus } : {}),
		...(spec.usage ? { usage: spec.usage } : {}),
		degraded: spec.degraded ?? [],
	};
}

function embodiment(spec: SessionSpec) {
	return {
		name: spec.workerName,
		run: 1,
		sessionId: sessionIdFor(spec.path),
		sessionPath: spec.path,
		depth: spec.depth,
		backend: "fake",
		...(spec.startedAt ? { startedAt: spec.startedAt } : {}),
		...(spec.collectedAt ? { collectedAt: spec.collectedAt } : {}),
		...(spec.retiredAt ? { retiredAt: spec.retiredAt } : {}),
		...(spec.liveStatus ? { liveStatus: spec.liveStatus } : {}),
		manifestRef: { task: spec.task, worker: spec.workerName, run: 1 },
		degraded: spec.degraded ?? [],
	};
}

function buildFixture(): { graph: SwarmGraph; events: Array<Record<string, unknown>> } {
	const leadSpecs: SessionSpec[] = [];
	for (let i = 1; i <= 5; i++) {
		leadSpecs.push({
			path: LEAD(i),
			workerName: `lead-${i}`,
			task: "milestone1",
			depth: 1,
			ownsChildren: true,
			role: "worker-orchestrator",
			startedAt: "2026-09-20T00:00:00.000Z",
			...(i === 1 ? { collectedAt: "2026-09-20T01:00:00.000Z" } : {}),
			...(i === 2 ? { liveStatus: "idle" } : {}),
			...(i === 3 ? { liveStatus: "working" } : {}),
			...(i === 4 ? { degraded: [{ flag: "no-live-status" }] } : {}),
			...(i === 5 ? { liveStatus: "idle" } : {}),
		});
	}
	const workerSpecs: SessionSpec[] = [];
	for (let i = 1; i <= 5; i++) {
		for (let j = 1; j <= 4; j++) {
			workerSpecs.push({
				path: WORK(i, j),
				workerName: `w${i}-${j}`,
				task: "milestone1",
				depth: 2,
				startedAt: "2026-09-20T00:10:00.000Z",
				...(i === 1 ? { collectedAt: "2026-09-20T00:50:00.000Z" } : {}),
				...(i === 2 ? { liveStatus: "idle" } : {}),
				...(i === 3 ? { liveStatus: "working" } : {}),
				...(i === 4 ? { liveStatus: "working" } : {}),
				...(i === 5 ? { liveStatus: "idle" } : {}),
				...(i === 4 && j === 1 ? { usage: { outputTokens: 4242, contextPct: 42 } } : {}),
				...(i === 5 && j === 1 ? { degraded: [{ flag: "usage-unavailable" }] } : {}),
				...(i === 5 && j === 2 ? { degraded: [{ flag: "legacy-orphan" }, { flag: "no-session-path" }] } : {}),
			});
		}
	}
	const foreignWorker: SessionSpec = {
		path: "/sessions/fw.jsonl",
		workerName: "fw",
		task: "foreign-task",
		depth: 1,
		degraded: [{ flag: "no-live-status" }],
	};
	const foreignOrch: SessionSpec = {
		path: FOREIGN,
		workerName: "foreign-orch",
		task: "foreign-task",
		depth: 0,
		ownsChildren: true,
		isWorker: false,
		role: "orchestrator",
	};
	const orch: SessionSpec = {
		path: SELF,
		workerName: "orch",
		task: "milestone1",
		depth: 0,
		ownsChildren: true,
		isWorker: false,
		role: "orchestrator",
	};

	const sessionNodes = [orch, ...leadSpecs, ...workerSpecs, foreignOrch, foreignWorker].map(sessionNode);
	const taskNode = {
		kind: "task" as const,
		id: "milestone1",
		dir: "/exchange/milestone1",
		description: "milestone 1",
		depth: 0,
		workers: leadSpecs.map(embodiment),
		degraded: [] as Deg[],
	};
	// Each lead owns a sub-fleet task whose embodiments are its 4 workers — the
	// real graph shape (a worker session's lifecycle stamps live on the task's
	// embodiments, matched by sessionId).
	const subTasks = leadSpecs.map((lead, i) => ({
		kind: "task" as const,
		id: `m1-lead-${i + 1}`,
		dir: `/exchange/m1-lead-${i + 1}`,
		depth: 2,
		workers: workerSpecs.filter((w) => w.task === "milestone1" && w.path.startsWith(`/sessions/w${i + 1}-`)).map(embodiment),
		degraded: [] as Deg[],
	}));
	const foreignTask = {
		kind: "task" as const,
		id: "foreign-task",
		dir: "/exchange/foreign-task",
		depth: 0,
		workers: [embodiment(foreignWorker)],
		degraded: [] as Deg[],
	};
	const edges: Array<{ kind: string; from: string; to: string }> = [
		{ kind: "spawned_by", from: "milestone1", to: sessionIdFor(SELF) },
		{ kind: "spawned_by", from: "foreign-task", to: sessionIdFor(FOREIGN) },
	];
	for (const lead of leadSpecs) edges.push({ kind: "spawned_by", from: sessionIdFor(lead.path), to: sessionIdFor(SELF) });
	for (let i = 1; i <= 5; i++) {
		edges.push({ kind: "spawned_by", from: `m1-lead-${i}`, to: sessionIdFor(LEAD(i)) });
		for (let j = 1; j <= 4; j++) edges.push({ kind: "spawned_by", from: sessionIdFor(WORK(i, j)), to: sessionIdFor(LEAD(i)) });
	}
	edges.push({ kind: "spawned_by", from: sessionIdFor(foreignWorker.path), to: sessionIdFor(FOREIGN) });

	const graph: SwarmGraph = {
		schemaVersion: 1,
		available: true,
		sources: { journal: true, manifests: true, liveStatus: true, usage: true },
		nodes: [...sessionNodes, taskNode, ...subTasks, foreignTask],
		edges,
		orphans: [],
	} as unknown as SwarmGraph;

	const events = [
		{ seq: 1, kind: "ask", worker: "lead-2", task: "milestone1", payload: { question: "which port?", options: ["7331", "0"] } },
		{ seq: 2, kind: "ask", worker: "w2-1", task: "m1-lead-2", payload: { question: "retry?" } },
		{ seq: 3, kind: "dead-reboot", worker: "w3-1", task: "m1-lead-3", payload: { detectedAt: "2026-09-20T02:00:00.000Z" } },
		{ seq: 4, kind: "progress", worker: "w4-1", task: "m1-lead-4", payload: { phase: "build", pct: 50, note: "halfway" } },
		{ seq: 5, kind: "ask", worker: "fw", task: "foreign-task", payload: { question: "foreign question" } },
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
function find(root: any, pred: (e: any) => boolean): any[] {
	return walk(root).filter((e) => e instanceof FakeEl && pred(e));
}
function byAttr(root: any, attr: string): any[] {
	return find(root, (e) => e.attributes[attr] !== undefined);
}

async function main(): Promise<void> {
	const stateMod = (await import(publicUrl("state.js"))) as any;
	const layoutMod = (await import(publicUrl("layout.js"))) as any;
	const statusMod = (await import(publicUrl("status.js"))) as any;
	const degradeMod = (await import(publicUrl("degrade.js"))) as any;
	const uiMod = (await import(publicUrl("ui.js"))) as any;
	const railMod = (await import(publicUrl("rail.js"))) as any;
	const canvasMod = (await import(publicUrl("canvas.js"))) as any;
	const detailMod = (await import(publicUrl("detail.js"))) as any;
	const attentionMod = (await import(publicUrl("attention.js"))) as any;
	const appMod = (await import(publicUrl("app.js"))) as any;

	const { graph, events } = buildFixture();
	const ownSessionPath = SELF;
	const NOW = Date.parse("2026-09-20T02:00:00.000Z");
	const model = stateMod.buildDashboardState({ graph, events, ownSessionPath, nowMs: NOW });
	const L1 = sessionIdFor(LEAD(1));
	const W41 = sessionIdFor(WORK(4, 1));
	const FW = sessionIdFor("/sessions/fw.jsonl");

	// -- A1 — one screen, no tabs/modes ------------------------------------
	{
		const idx = readAsset("index.html");
		check(
			"A1.1 the shell carries a brand, connection state, token state and the statusbar data slots",
			idx.includes('class="brand"') && idx.includes('id="connection-state"') && idx.includes('data-token-state') && idx.includes('id="journal-count"') && idx.includes('id="journal-bytes"') && idx.includes('id="schema-version"') && idx.includes('id="activity-ticker"'),
			idx.slice(0, 120),
		);
		check("A1.2 no mode switcher / tab bar at the shell level (no data-mode, no data-screen, no top-level role=tablist)", !/data-mode|data-screen|role="tablist"/.test(idx));
		check("A1.3 the shell root and the module script are static (no build step)", idx.includes('id="fleet-tree"') && idx.includes('type="module"') && idx.includes("/app.js"));
		const appSrc = readAsset("app.js");
		check("A1.4 app.js mounts the four in-shell regions (attention/rail/canvas/detail); the statusbar lives in the static frame", /data-region/.test(appSrc) && ["attention-strip", "rail", "center-canvas", "detail"].every((r) => appSrc.includes(`"${r}"`)));
	}

	// -- A2 — status language ----------------------------------------------
	{
		const named = statusMod.CANONICAL_STATUSES as string[];
		const views = named.map((s: string) => statusMod.statusView(s));
		check(
			"A2.1 the six canonical statuses have distinct shapes and colors (color+shape+position)",
			named.length === 6 && new Set(views.map((v: any) => v.shape)).size === 6 && new Set(views.map((v: any) => v.className)).size === 6,
			JSON.stringify(views.map((v: any) => [v.shape, v.className])),
		);
		check("A2.2 running/ask pulse, terminal statuses do not", statusMod.statusView("running").pulse === true && statusMod.statusView("ask").pulse === true && statusMod.statusView("collected").pulse === false && statusMod.statusView("dead").pulse === false);
		check("A2.3 the marker position is documented as LEFT of the name", statusMod.STATUS_MARKER_POSITION === "left");
		check(
			"A2.4 the four degradation flags map to distinct visuals with verbatim names on one severity ladder",
			degradeMod.DEGRADED_FLAGS.length === 4 &&
				new Set(degradeMod.DEGRADED_FLAGS.map((f: string) => degradeMod.degradeClass(f))).size === 4 &&
				degradeMod.DEGRADED_FLAGS.every((f: string) => ["info", "warn", "crit"].includes(degradeMod.severityFor(f))) &&
				degradeMod.worstSeverity(["info", "warn"]) === "warn" &&
				degradeMod.worstSeverity([]) === "clear",
		);
		check("A2.5 the marker renders FIRST in the rail row (position LEFT of the name)", (() => {
			const doc = fakeDoc();
			const root = doc.createElement("div");
			railMod.renderRail(model, root, doc, {});
			const row = byAttr(root, "data-node-id")[0];
			return row && row.childNodes[0] && row.childNodes[0].attributes["data-status-marker"] !== undefined;
		})());
		check("A2.6 unknown is a real, honest state (label 'no live status'), never a faked healthy one", statusMod.statusView("unknown").label === "no live status" && statusMod.statusView("made-up") === statusMod.statusView("unknown"));
		check("A2.7 all four degradation flags render as distinct honest chips across the fixture", (() => {
			const flags = new Set();
			for (const n of model.nodes) for (const d of n.degraded) flags.add(d.flag);
			return flags.size === 4 && degradeMod.DEGRADED_FLAGS.every((f: string) => flags.has(f));
		})(), JSON.stringify([...new Set(model.nodes.flatMap((n: any) => n.degraded.map((d: any) => d.flag)))]));
	}

	// -- A3 — attention aggregates ------------------------------------------
	{
		check("A3.1 fixtures give exactly 2 asks / 1 dead-reboot / 3 degraded in OWN fleets", model.attention.askCount === 2 && model.attention.deadCount === 1 && model.attention.degradedCount === 3, JSON.stringify({ ask: model.attention.askCount, dead: model.attention.deadCount, degraded: model.attention.degradedCount }));
		const labels = attentionMod.chipLabels(model.attention);
		check("A3.2 chips read exactly '2 asks waiting' / '1 dead-reboot' / '3 degraded'", labels[0] === "2 asks waiting" && labels[1] === "1 dead-reboot" && labels[2] === "3 degraded", JSON.stringify(labels));
		check("A3.3 the foreign fleet's ask and degraded flag are NOT counted", !model.attention.items.some((i: any) => i.worker === "fw") && model.attention.items.every((i: any) => !String(i.label).includes("foreign-task")), JSON.stringify(model.attention.items.map((i: any) => i.label)));
		check("A3.4 the queue is severity-ordered (crit first)", model.attention.items[0].severity === "crit", JSON.stringify(model.attention.items.map((i: any) => i.severity)));
		const empty = stateMod.buildDashboardState({ graph: { ...graph, nodes: graph.nodes.filter((n: any) => n.id === sessionIdFor(SELF)), edges: [] }, events: [], ownSessionPath, nowMs: NOW });
		check("A3.5 an empty queue renders the honest 'all clear' chip (never a zero-count chip row)", empty.attention.clear === true && attentionMod.chipLabels(empty.attention)[0] === "all clear");
		check("A3.6 foreign fleets render read-only in the rail and after own fleets", model.rail.groups[model.rail.groups.length - 1].foreign === true && model.rail.own.length >= 1);
	}

	// -- A4 — attention queue overlay + spotlight ---------------------------
	{
		const doc = fakeDoc();
		const root = doc.createElement("div");
		attentionMod.renderAttention(model, root, doc, { overlay: "ask" });
		check("A4.1 clicking a chip renders the queue overlay", byAttr(root, "data-attention-overlay").length === 1 && byAttr(root, "data-attention-item").length === 2, `items=${byAttr(root, "data-attention-item").length}`);
		const ui = uiMod.createUiState();
		const item = model.attention.items.find((i: any) => i.kind === "ask");
		const next = uiMod.uiReducer(uiMod.uiReducer(ui, { type: "chip-click", kind: "ask" }), { type: "select-attention", item });
		check("A4.2 selecting an item dismisses the overlay and spotlights the affected nodes", next.overlay === null && next.spotlight.size > 0 && next.spotlight.has(item.nodeId), JSON.stringify({ overlay: next.overlay, spotlight: [...next.spotlight] }));
		const dimDoc = fakeDoc();
		const dimRoot = dimDoc.createElement("div");
		const layout = layoutMod.computeLayout(model, { expansion: [] });
		canvasMod.renderCanvas(model, layout, dimRoot, dimDoc, { spotlight: next.spotlight });
		const groups = byAttr(dimRoot, "data-graph-node");
		const dimmed = groups.filter((g) => g.attributes["data-dimmed"] === "1");
		const lit = groups.filter((g) => g.attributes["data-spotlight"] === "1");
		check("A4.3 the spotlight dims non-affected nodes and keeps the affected ones lit", dimmed.length === groups.length - lit.length && lit.length === next.spotlight.size && lit.every((g) => next.spotlight.has(g.attributes["data-graph-node"])), JSON.stringify({ groups: groups.length, dimmed: dimmed.length, lit: lit.length }));
		check("A4.4 outside-click dismissal is a pure UI action", uiMod.uiReducer(next, { type: "dismiss-overlay" }).overlay === null);
		const railFocus = uiMod.uiReducer(uiMod.createUiState(), { type: "select-node", id: "milestone1", spotlightIds: railMod.taskFocusIds(model.byId.get("milestone1")) });
		check("A4.5 a rail task tap focuses the center view (spotlight = task + owner + worker sessions, never a screen switch)", railFocus.spotlight.has("milestone1") && railFocus.spotlight.has(sessionIdFor(LEAD(1))) && railFocus.selection === "milestone1");
		check("A4.6 a collapsed lead toggles in place through the UI reducer", uiMod.uiReducer(uiMod.createUiState(), { type: "toggle-collapse", leadId: L1 }).expansion.has(L1));
	}

	// -- A5 — detail panel ---------------------------------------------------
	{
		const askItem = model.attention.items.find((i: any) => i.kind === "ask" && i.worker === "lead-2");
		const doc = fakeDoc();
		const root = doc.createElement("div");
		detailMod.renderDetail(
			{ subject: model.byId.get(sessionIdFor(LEAD(2))), worker: "lead-2", workerSessionId: sessionIdFor(LEAD(2)), console: null, controls: { disabled: false, reasonCode: null, reason: "", pendingAsk: null }, pending: null, ask: askItem ? { question: "which port?", options: ["7331", "0"], seq: 1 } : null, draft: "", tab: "console" },
			root,
			doc,
			{},
		);
		check("A5.1 an ask worker renders the question banner with its options", byAttr(root, "data-ask-banner").length === 1 && byAttr(root, "data-ask-question")[0].textContent === "which port?" && byAttr(root, "data-ask-option").length === 2);
		check("A5.2 the panel renders console/brief/report tabs and states the absent brief/report endpoint", byAttr(root, "data-detail-tab").length === 3);
		const doc2 = fakeDoc();
		const root2 = doc2.createElement("div");
		detailMod.renderDetail({ subject: model.byId.get(W41), worker: "w4-1", workerSessionId: W41, console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "brief" }, root2, doc2, {});
		check("A5.3 the brief/report tabs say the endpoint is absent instead of faking content", byAttr(root2, "data-pane")[0].attributes["data-pane-unavailable"] === "1");
		const doc3 = fakeDoc();
		const root3 = doc3.createElement("div");
		detailMod.renderDetail({ subject: model.byId.get(W41), worker: "w4-1", workerSessionId: W41, console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "console" }, root3, doc3, {});
		check("A5.4 the context-usage bar comes from the snapshot usage fold", byAttr(root3, "data-context-bar")[0].attributes["data-context-pct"] === 42 || byAttr(root3, "data-context-bar")[0].attributes["data-context-pct"] === "42", JSON.stringify(byAttr(root3, "data-context-bar")[0]?.attributes));
		check("A5.5 the last progress event renders (phase + pct + note)", byAttr(root3, "data-last-progress")[0].textContent.includes("build") && byAttr(root3, "data-last-progress")[0].textContent.includes("50") && byAttr(root3, "data-last-progress")[0].textContent.includes("halfway"), byAttr(root3, "data-last-progress")[0].textContent);
		const noUsage = model.byId.get(sessionIdFor(WORK(5, 1)));
		const doc4 = fakeDoc();
		const root4 = doc4.createElement("div");
		detailMod.renderDetail({ subject: noUsage, worker: "w5-1", workerSessionId: noUsage.id, console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "console" }, root4, doc4, {});
		check("A5.6 a usage-unavailable node renders the honest bar, never a fake percentage", byAttr(root4, "data-usage-unavailable").length === 1 && byAttr(root4, "data-context-pct").length === 0);
		const doc5 = fakeDoc();
		const root5 = doc5.createElement("div");
		detailMod.renderDetail({ subject: model.byId.get(FW), worker: "fw", workerSessionId: FW, console: null, controls: { disabled: true, reasonCode: "foreign", reason: "disabled: worker is not owned by this session (foreign fleet)" }, pending: null, ask: null, draft: "", tab: "console" }, root5, doc5, {});
		const controls = byAttr(root5, "data-steer-worker")[0];
		check("A5.7 a foreign worker shows disabled controls WITH the ownership reason", controls.attributes["data-steer-disabled"] === "1" && byAttr(root5, "data-disabled-reason")[0].textContent.includes("not owned"), byAttr(root5, "data-disabled-reason")[0]?.textContent);
		check("A5.8 the model marks the foreign worker read-only", model.byId.get(FW).foreign === true && model.byId.get(W41).foreign === false);
	}

	// -- A6 — graph: columns, edges, statuses, collapse, golden --------------
	{
		const layout = layoutMod.computeLayout(model, { expansion: [] });
		check("A6.1 columns follow depth: orchestrator 0 → leads 1 → workers 2", layout.positions[sessionIdFor(SELF)].col === 0 && layout.positions[L1].col === 1 && layout.positions[sessionIdFor(WORK(1, 1))] === undefined && layout.positions[W41].col === 2, JSON.stringify({ orch: layout.positions[sessionIdFor(SELF)]?.col, lead: layout.positions[L1]?.col, w41: layout.positions[W41]?.col }));
		const full = layoutMod.computeLayout(model, { expansion: new Set([L1]) });
		const graphEdges = graph.edges.map((e: any) => `${e.kind}:${e.from}->${e.to}`).sort().join(",");
		const layoutEdges = full.edges.map((e: any) => `${e.kind}:${e.from}->${e.to}`).sort().join(",");
		check("A6.2 edges match the graph's spawned_by set node-for-node", graphEdges === layoutEdges, `${layoutEdges.length} vs ${graphEdges.length}`);
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(model, full, root, doc, {});
		const nodeEls = byAttr(root, "data-graph-node");
		check("A6.3 every graph node renders exactly once in the SVG", nodeEls.length === graph.nodes.length, `dom=${nodeEls.length} graph=${graph.nodes.length}`);
		const statusMismatch = nodeEls.filter((g) => model.byId.get(g.attributes["data-graph-node"]) && model.byId.get(g.attributes["data-graph-node"]).status !== g.attributes["data-status"]);
		check("A6.4 statuses are node-for-node with the model", statusMismatch.length === 0, JSON.stringify(statusMismatch.map((g) => g.attributes["data-graph-node"])));
		check("A6.5 the marker renders LEFT (before the name) of every canvas node", nodeEls.every((g) => {
			const children = g.childNodes;
			const marker = children.findIndex((c: any) => c.getAttribute && c.getAttribute("data-status-marker") !== null);
			const name = children.findIndex((c: any) => c.getAttribute && c.getAttribute("data-node-name") !== null);
			return marker >= 0 && name >= 0 && marker < name;
		}));
		check("A6.6 SVG only — no canvas/WebGL anywhere in the asset set", byAttr(root, "data-graph").length === 1);
	}

	// -- A7 — adaptive collapse ---------------------------------------------
	{
		const collapsed = layoutMod.computeLayout(model, { expansion: [] });
		const agg = collapsed.nodes.find((n: any) => n.kind === "aggregate");
		check("A7.1 an all-terminal lead collapses to ONE aggregate child", agg !== undefined && agg.leadId === L1 && agg.total === 5 && agg.collected === 5 && /^\d+\/\d+ collected \u2713$/.test(agg.name), JSON.stringify(collapsed.aggregates));
		check("A7.2 collapsed children are hidden from the canvas", !collapsed.visibleIds.has(sessionIdFor(WORK(1, 1))) && collapsed.visibleIds.has(`agg:${L1}`));
		check("A7.3 the aggregate surfaces the WORST child severity (degraded never hidden as healthy)", typeof agg.severity === "string" && degradeMod.severityRank(agg.severity) >= 0);
		const expanded = layoutMod.computeLayout(model, { expansion: new Set([L1]) });
		check("A7.4 expanding restores the children in place", expanded.visibleIds.has(sessionIdFor(WORK(1, 1))) && !expanded.nodes.some((n: any) => n.kind === "aggregate"));
		const ui = uiMod.uiReducer(uiMod.createUiState(), { type: "toggle-collapse", leadId: L1 });
		check("A7.5 the expansion toggle is UI state only (never persisted)", ui.expansion.has(L1) && ui.toggled.has(L1));
		// worst-severity witness: a collapsed lead whose children are degraded
		const degradedGraph = {
			...graph,
			nodes: graph.nodes.map((n: any) =>
				n.kind === "session" && [sessionIdFor(WORK(1, 1)), sessionIdFor(WORK(1, 2))].includes(n.id) ? { ...n, degraded: [{ flag: "no-live-status" }] } : n,
			),
		};
		const degradedModel = stateMod.buildDashboardState({ graph: degradedGraph, events, ownSessionPath, nowMs: NOW });
		const degradedLayout = layoutMod.computeLayout(degradedModel, { expansion: [] });
		const degradedAgg = degradedLayout.nodes.find((n: any) => n.kind === "aggregate");
		check("A7.6 a degraded child raises the aggregate severity to warn (never a green ✓)", degradedAgg.severity === "warn", JSON.stringify(degradedAgg));
	}

	// -- A8 — deterministic layout + in-place stream updates -----------------
	{
		const a = layoutMod.computeLayout(model, { expansion: [] });
		const b = layoutMod.computeLayout(model, { expansion: [] });
		check("A8.1 two renders of the same snapshot are byte-identical (golden coordinates)", layoutMod.coordinateGolden(a) === layoutMod.coordinateGolden(b));
		const before = layoutMod.coordinateGolden(a);
		// A progress event for a visible worker: status/sub change, no relayout.
		const progressed = stateMod.buildDashboardState({ graph, events: events.concat([{ seq: 6, kind: "progress", worker: "w4-1", payload: { phase: "verify", pct: 90 } }]), ownSessionPath, nowMs: NOW });
		const after = layoutMod.computeLayout(progressed, { expansion: [] });
		check("A8.2 a progress event leaves every node coordinate untouched (in-place update)", before === layoutMod.coordinateGolden(after));
		check("A8.3 the progress event updates the node's sub-line data instead", progressed.byId.get(W41).progress.phase === "verify" && progressed.byId.get(W41).progress.pct === 90);
		const preDead = stateMod.buildDashboardState({ graph, events: events.filter((e: any) => e.kind !== "dead-reboot"), ownSessionPath, nowMs: NOW });
		const postDead = stateMod.buildDashboardState({ graph, events, ownSessionPath, nowMs: NOW });
		const deadId = sessionIdFor(WORK(3, 1));
		check("A8.4 a dead-reboot event flips the node status in place", preDead.byId.get(deadId).status !== "dead" && postDead.byId.get(deadId).status === "dead");
		check("A8.5 the dead-reboot flip does not relayout", layoutMod.coordinateGolden(layoutMod.computeLayout(preDead, { expansion: [] })) === layoutMod.coordinateGolden(layoutMod.computeLayout(postDead, { expansion: [] })));
		// Patch keeps coordinates (the renderer's in-place contract). Render the
		// PRE-dead state so the flip below is a real in-place transition.
		const doc = fakeDoc();
		const root = doc.createElement("div");
		const index = canvasMod.renderCanvas(preDead, layoutMod.computeLayout(preDead, { expansion: [] }), root, doc, {});
		const node = index.nodes.get(W41);
		const x = node.attributes["data-x"];
		const y = node.attributes["data-y"];
		const progressOnly = stateMod.buildDashboardState({ graph, events: events.filter((e: any) => e.kind !== "dead-reboot").concat([{ seq: 6, kind: "progress", worker: "w4-1", payload: { phase: "verify", pct: 90 } }]), ownSessionPath, nowMs: NOW });
		canvasMod.patchCanvas(index, progressOnly, doc, {});
		check("A8.6 patchCanvas updates status text while leaving transform/x/y untouched", node.attributes["data-x"] === x && node.attributes["data-y"] === y && index.nodes.get(W41).childNodes.some((c: any) => c.getAttribute && c.getAttribute("data-node-sub") !== undefined && c.attributes["data-text"] !== undefined));
		const deadX = index.nodes.get(deadId).attributes["data-x"];
		const deadY = index.nodes.get(deadId).attributes["data-y"];
		canvasMod.patchCanvas(index, postDead, doc, {});
		const deadEl = index.nodes.get(deadId);
		const deadMarker = deadEl.childNodes.find((c: any) => c.getAttribute && c.getAttribute("data-status-marker") !== null);
		check("A8.6b patchCanvas repaints the status marker class/shape on a dead-reboot flip (in place)", deadEl.attributes["data-status"] === "dead" && deadMarker.attributes.class.includes("status-dead") && deadEl.attributes["data-x"] === deadX && deadEl.attributes["data-y"] === deadY, JSON.stringify({ status: deadEl.attributes["data-status"], marker: deadMarker.attributes.class }));
		check("A8.7 topology growth appends deterministically (sorted by depth, then id)", (() => {
			const extra = { ...graph, nodes: graph.nodes.concat([sessionNode({ path: "/sessions/w9-9.jsonl", workerName: "w9-9", task: "milestone1", depth: 2, liveStatus: "idle" }) as never]), edges: graph.edges.concat([{ kind: "spawned_by", from: sessionIdFor("/sessions/w9-9.jsonl"), to: L1 }]) };
			const grown = layoutMod.computeLayout(stateMod.buildDashboardState({ graph: extra, events, ownSessionPath, nowMs: NOW }), { expansion: new Set([L1]) });
			const merged = layoutMod.computeLayout(stateMod.buildDashboardState({ graph: extra, events, ownSessionPath, nowMs: NOW }), { expansion: new Set([L1]) });
			return layoutMod.coordinateGolden(grown) === layoutMod.coordinateGolden(merged) && grown.positions[sessionIdFor("/sessions/w9-9.jsonl")] !== undefined;
		})());
	}

	// -- A9 — pan / zoom / fit ----------------------------------------------
	{
		check("A9.1 zoom clamps to the documented 0.5×–2× range", layoutMod.clampZoom(10) === 2 && layoutMod.clampZoom(0.1) === 0.5 && layoutMod.clampZoom(NaN) === 1);
		const view = layoutMod.initialView();
		const zoomed = layoutMod.zoomAt(view, 1.5, 100, 50);
		const worldX = (100 - view.panX) / view.zoom;
		const worldY = (50 - view.panY) / view.zoom;
		check("A9.2 wheel zoom is cursor-anchored (the point under the cursor stays put)", Math.abs((100 - zoomed.panX) / zoomed.zoom - worldX) < 1e-9 && Math.abs((50 - zoomed.panY) / zoomed.zoom - worldY) < 1e-9);
		check("A9.3 pan is a pure screen-space delta", layoutMod.panBy(view, 10, -5).panX === 10 && layoutMod.panBy(view, 10, -5).panY === -5);
		const fit = layoutMod.fitView({ minX: 0, minY: 0, width: 2000, height: 1000 }, { width: 800, height: 400 });
		check("A9.4 fit resolves the whole graph into the viewport at a clamped zoom", fit.zoom === 0.5 && Number.isFinite(fit.panX) && Number.isFinite(fit.panY));
		const doc = fakeDoc();
		const root = doc.createElement("div");
		const layout = layoutMod.computeLayout(model, { expansion: [] });
		canvasMod.renderCanvas(model, layout, root, doc, { view: { zoom: 1.25, panX: 30, panY: -10 }, viewport: () => ({ width: 900, height: 600 }), onView: () => {} });
		check("A9.5 pan/zoom is applied as a view transform (node coordinates are never mutated) and a fit affordance exists", byAttr(root, "data-view")[0].attributes.transform === "translate(30 -10) scale(1.25)" && byAttr(root, "data-canvas-fit").length === 1, JSON.stringify(byAttr(root, "data-view")[0]?.attributes));
	}

	// -- A10 — app wiring: one screen, live ---------------------------------
	{
		const els: Record<string, any> = {};
		const doc = fakeDoc(els);
		const fetchImpl = async (url: string) => {
			if (url.startsWith("/api/swarm/snapshot")) return { json: async () => ({ ok: true, snapshot: graph }) };
			if (url.startsWith("/api/swarm/events")) return { json: async () => ({ ok: true, events, journal: { count: 7, dbSizeBytes: 1234 } }) };
			if (url.includes("/console")) return { json: async () => ({ ok: true, worker: "w4-1", nodeId: W41, state: "live", chunk: "booting", nextOffset: 7, oldestOffset: 0, dropped: false }) };
			throw new Error(`unexpected fetch ${url}`);
		};
		let captured: any = null;
		const app = appMod.createFleetApp({
			doc,
			fetch: fetchImpl,
			storage: null,
			location: { protocol: "http:", host: "127.0.0.1:7331" },
			stream: (opts: any) => {
				captured = opts;
				return { state: { lastSeq: 0 }, close() {} };
			},
			consoleTail: () => ({ close() {} }),
			ownSessionPath,
			nowMs: () => NOW,
		});
		await app.start();
		const shell = els["fleet-tree"];
		check("A10.1 start() mounts the four in-shell regions inside one shell root (the statusbar lives in the static frame)", byAttr(shell, "data-region").length === 4 && app.state !== null);
		check("A10.2 the rail renders node rows, the canvas renders graph nodes, the detail renders a panel", byAttr(shell, "data-node-id").length > 0 && byAttr(shell, "data-graph-node").length === layoutMod.computeLayout(app.state, { expansion: app.ui.expansion }).nodes.length && byAttr(shell, "data-detail-for").length === 1, JSON.stringify({ rail: byAttr(shell, "data-node-id").length, canvas: byAttr(shell, "data-graph-node").length, detail: byAttr(shell, "data-detail-for").length }));
		check("A10.3 the attention strip shows the fixture counts", byAttr(shell, "data-attention-chip").length === 3 && byAttr(shell, "data-attention-chip").every((c) => c.attributes["data-count"] !== undefined));
		check("A10.4 the statusbar reflects the journal envelope + schema", els["journal-count"].textContent === "7" && els["journal-bytes"].textContent === "1234" && els["schema-version"].textContent === "1");
		const beforeCoord = layoutMod.coordinateGolden(layoutMod.computeLayout(app.state, { expansion: app.ui.expansion }));
		captured.onFrame({ type: "events", after: 0, events: [{ seq: 9, kind: "progress", worker: "w4-1", payload: { phase: "ship", pct: 99 } }] }, "events");
		await new Promise((r) => setTimeout(r, 120));
		const afterCoord = layoutMod.coordinateGolden(layoutMod.computeLayout(app.state, { expansion: app.ui.expansion }));
		check("A10.5 an event frame updates the model without a relayout", beforeCoord === afterCoord && app.state.byId.get(W41).progress.phase === "ship", JSON.stringify(app.state.byId.get(W41).progress));
		app.dispatch({ type: "chip-click", kind: "ask" });
		check("A10.6 a chip click opens the overlay through the UI reducer", byAttr(shell, "data-attention-overlay").length === 1);
		app.close();
	}

	// -- A11 — no build step / no external network / system fonts -----------
	{
		const names = readdirSync(PUBLIC_DIR).filter((n) => /\.(js|html|css)$/.test(n));
		const externals: string[] = [];
		const canvasShapes: string[] = [];
		let fontFile = false;
		for (const name of names) {
			const code = readAsset(name);
			if (/https?:\/\/(?!www\.w3\.org)[^\s"'`)]+/.test(code)) externals.push(name);
			if (/\bgetContext\s*\(|<canvas\b|createElement\(\s*["']canvas["']/i.test(code)) canvasShapes.push(name);
			if (/@font-face|\.woff2?|fonts\.googleapis/.test(code)) fontFile = true;
		}
		check("A11.1 zero external network calls (no CDN, no font download — system fallback stacks only)", externals.length === 0 && fontFile === false, `externals=${externals.join(",")} fontFile=${fontFile}`);
		check("A11.2 SVG only — no canvas/WebGL anywhere in the asset set", canvasShapes.length === 0, canvasShapes.join(","));
		check("A11.3 no build artifacts (flat source assets only)", names.every((n) => !/\.(map)$|\.min\.js$|\.bundle\.js$/.test(n)));
		check("A11.4 no asset is a parking lot (every public module stays under 400 lines)", names.every((n) => readAsset(n).split("\n").length <= 400), names.filter((n) => readAsset(n).split("\n").length > 400).join(","));
		check("A11.5 the status palette + type scale are CSS custom properties (no inline palette drift)", (() => {
			const css = readAsset("app.css");
			return css.includes("--sev-info") && css.includes("--type-md") && css.includes("--font-prose") && css.includes("--font-mono");
		})());
		check("A11.6 the system font stacks are declared (Inter + system-ui, JetBrains Mono + platform monospace)", (() => {
			const css = readAsset("app.css");
			return /--font-prose:\s*Inter[^;]*system-ui/.test(css) && /--font-mono:\s*"JetBrains Mono"[^;]*ui-monospace/.test(css);
		})());
	}
}

await main()
	.then(() => {
		clearTimeout(watchdog);
		console.log(failures === 0 ? "\nALL DASHBOARD V1 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		clearTimeout(watchdog);
		console.error("dashboard-v1-check CRASHED", err);
		process.exit(1);
	});
