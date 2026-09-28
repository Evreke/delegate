/**
 * dashboard-canvas-intent-check — the canvas-intent round (prototype rulings
 * R1–R10 on the divergence report `/tmp/exchange/dashboard-intent/`).
 *
 * Headless pins for the ruled interaction contract:
 *   I1 R1 — selection and spotlight are decoupled in the UI reducer: a
 *      select-node NEVER carries/sets a spotlight; dismiss-overlay,
 *      chip-click and select-node all release a live spotlight.
 *   I2 R1 — a canvas node click dispatches a bare select-node (an aggregate
 *      click toggles collapse); nothing dims.
 *   I3 R2 — the selection is a visible canvas state (`data-selected`) that
 *      survives a spotlight dim (sel+dim combine).
 *   I4 C8 — edges into spotlighted nodes carry `data-hot` (the amber path
 *      cue); non-touching edges do not.
 *   I5 R2 — canvas.css pins the two-color system: accent selection stroke,
 *      amber attention stroke+glow, 0.35 dim, hot edges, hover affordance.
 *   I6 R1/R2 — app wiring: a select-node dispatch re-renders the canvas with
 *      exactly one `data-selected` node.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; no unbounded
 * waits. Exit 0 only if all checks pass.
 */

import { sessionIdFor } from "../src/swarm/nodes.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const watchdog = setTimeout(() => {
	console.error("dashboard-canvas-intent-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 25_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const publicUrl = (f: string): string => new URL(`../src/swarm-server/public/${f}`, import.meta.url).href;
const PUBLIC_DIR = fileURLToPath(new URL("../src/swarm-server/public/", import.meta.url));
const readAsset = (name: string): string => readFileSync(join(PUBLIC_DIR, name), "utf8");

// ---------------------------------------------------------------------------
// Fake DOM seam (listener-capable — the click contracts need fired events)
// ---------------------------------------------------------------------------

class FakeEl {
	attributes: Record<string, string> = {};
	childNodes: any[] = [];
	text = "";
	listeners: Record<string, Array<(e?: any) => void>> = {};
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
	addEventListener(type: string, fn: (e?: any) => void) {
		(this.listeners[type] ??= []).push(fn);
	}
	fire(type: string, event: any = {}) {
		for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
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
		return this.text + this.childNodes.map((c: any) => c.textContent ?? "").join("");
	}
}
function fakeDoc(els: Record<string, any> = {}): any {
	return {
		createElement: (t: string) => new FakeEl(t),
		createElementNS: (_ns: string, t: string) => new FakeEl(t),
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

// ---------------------------------------------------------------------------
// Fixture fleet: SELF orchestrator → task milestone1 (leads 1–2) → each lead
// a sub-task with 2 workers; lead-1's subtree is all-collected (collapses).
// ---------------------------------------------------------------------------

const SELF = "/sessions/orch.jsonl";
const LEAD = (i: number) => `/sessions/lead-${i}.jsonl`;
const WORK = (i: number, j: number) => `/sessions/w${i}-${j}.jsonl`;
const NOW = Date.parse("2026-09-20T02:00:00.000Z");

function fixture() {
	const session = (path: string, extra: Record<string, unknown> = {}) => ({
		kind: "session",
		id: sessionIdFor(path),
		sessionPath: path,
		role: "worker",
		isWorker: true,
		ownsChildren: false,
		tasks: ["milestone1"],
		depth: 1,
		degraded: [],
		...extra,
	});
	const embodiment = (path: string, name: string, task: string, depth: number, extra: Record<string, unknown> = {}) => ({
		name,
		run: 1,
		sessionId: sessionIdFor(path),
		sessionPath: path,
		depth,
		backend: "fake",
		startedAt: "2026-09-20T00:10:00.000Z",
		manifestRef: { task, worker: name, run: 1 },
		degraded: [],
		...extra,
	});
	const orch = {
		kind: "session",
		id: sessionIdFor(SELF),
		sessionPath: SELF,
		role: "orchestrator",
		isWorker: false,
		ownsChildren: true,
		tasks: ["milestone1"],
		depth: 0,
		degraded: [],
	};
	// lead-1: collected + both workers collected → the subtree collapses.
	const lead1 = session(LEAD(1), { collectedAt: "2026-09-20T01:00:00.000Z", ownsChildren: true, role: "worker-orchestrator", depth: 1 });
	const lead2 = session(LEAD(2), { liveStatus: "idle", ownsChildren: true, role: "worker-orchestrator", depth: 1 });
	const workers = [1, 2].flatMap((i) =>
		[1, 2].map((j) => session(WORK(i, j), { depth: 2, ...(i === 1 ? { collectedAt: "2026-09-20T00:50:00.000Z" } : { liveStatus: "idle" }) })),
	);
	const task = { kind: "task", id: "milestone1", dir: "/exchange/milestone1", description: "milestone 1", depth: 0, workers: [embodiment(LEAD(1), "lead-1", "milestone1", 1, { collectedAt: "2026-09-20T01:00:00.000Z" }), embodiment(LEAD(2), "lead-2", "milestone1", 1, { liveStatus: "idle" })], degraded: [] };
	const subtasks = [1, 2].map((i) => ({
		kind: "task",
		id: `m1-lead-${i}`,
		dir: `/exchange/m1-lead-${i}`,
		description: `milestone 1 \u00b7 lead ${i}`,
		depth: 2,
		workers: [1, 2].map((j) =>
			embodiment(WORK(i, j), `w${i}-${j}`, `m1-lead-${i}`, 2, i === 1 ? { collectedAt: "2026-09-20T00:50:00.000Z" } : { liveStatus: "idle" }),
		),
		degraded: [],
	}));
	const edges: Array<{ kind: string; from: string; to: string }> = [
		{ kind: "spawned_by", from: "milestone1", to: sessionIdFor(SELF) },
		{ kind: "spawned_by", from: sessionIdFor(LEAD(1)), to: sessionIdFor(SELF) },
		{ kind: "spawned_by", from: sessionIdFor(LEAD(2)), to: sessionIdFor(SELF) },
	];
	for (const i of [1, 2]) {
		edges.push({ kind: "spawned_by", from: `m1-lead-${i}`, to: sessionIdFor(LEAD(i)) });
		for (const j of [1, 2]) edges.push({ kind: "spawned_by", from: sessionIdFor(WORK(i, j)), to: sessionIdFor(LEAD(i)) });
	}
	const events = [
		{ seq: 1, kind: "ask", worker: "w2-1", task: "m1-lead-2", payload: { question: "retry?" } },
	];
	const graph = { schemaVersion: 1, available: true, sources: { journal: true, manifests: true, liveStatus: true, usage: true }, nodes: [orch, lead1, lead2, ...workers, task, ...subtasks], edges, orphans: [] };
	return { graph, events };
}

async function main(): Promise<void> {
	const stateMod = (await import(publicUrl("state.js"))) as any;
	const layoutMod = (await import(publicUrl("layout.js"))) as any;
	const uiMod = (await import(publicUrl("ui.js"))) as any;
	const canvasMod = (await import(publicUrl("canvas.js"))) as any;

	const { graph, events } = fixture();
	const model = stateMod.buildDashboardState({ graph, events, ownSessionPath: SELF, nowMs: NOW });
	const L2 = sessionIdFor(LEAD(2));
	const W21 = sessionIdFor(WORK(2, 1));
	// Everything visible (lead-1's subtree expanded) — the click/edge contracts
	// below want the full node set.
	const expansion = new Set([sessionIdFor(LEAD(1))]);
	const layout = layoutMod.computeLayout(model, { expansion });
	const askItem = model.attention.items.find((i: any) => i.kind === "ask");

	// -- I1 — R1: selection and spotlight are decoupled ----------------------
	{
		const ui0 = uiMod.createUiState();
		const lit = uiMod.uiReducer(ui0, { type: "select-attention", item: askItem });
		check("I1.1 select-attention still owns the spotlight (set to the item's focusIds)", lit.spotlight.size > 0 && [...lit.spotlight].every((id: string) => askItem.focusIds.includes(id)), JSON.stringify([...lit.spotlight]));
		const viaSelect = uiMod.uiReducer(lit, { type: "select-node", id: W21 });
		check("I1.2 a select-node sets the selection and releases the spotlight (never replaces it)", viaSelect.selection === W21 && viaSelect.spotlight.size === 0, JSON.stringify({ selection: viaSelect.selection, spotlight: [...viaSelect.spotlight] }));
		check("I1.3 dismiss-overlay clears the spotlight (Escape / outside click)", uiMod.uiReducer(lit, { type: "dismiss-overlay" }).spotlight.size === 0);
		check("I1.4 chip-click clears the spotlight (toggle open or closed)", uiMod.uiReducer(lit, { type: "chip-click", kind: "ask" }).spotlight.size === 0 && uiMod.uiReducer(lit, { type: "chip-click", kind: "dead-reboot" }).spotlight.size === 0);
		check("I1.5 the reducer ignores a stale spotlightIds field on select-node (the old coupling is dead)", (() => {
			const next = uiMod.uiReducer(lit, { type: "select-node", id: W21, spotlightIds: [W21, L2] });
			return next.spotlight.size === 0 && next.selection === W21;
		})());
	}

	// -- I2 — R1: a canvas node click selects, never dims --------------------
	{
		const doc = fakeDoc();
		const root = doc.createElement("div");
		const dispatched: any[] = [];
		canvasMod.renderCanvas(model, layout, root, doc, { dispatch: (a: any) => dispatched.push(a) });
		const nodeEl = byAttr(root, "data-graph-node").find((g: any) => g.attributes["data-graph-node"] === W21);
		nodeEl.fire("click");
		const action = dispatched.find((a: any) => a.type === "select-node");
		check("I2.1 a canvas node click dispatches a bare select-node (no spotlightIds — nothing dims)", action !== undefined && action.id === W21 && action.spotlightIds === undefined, JSON.stringify(action));
		// The collapsed aggregate still toggles collapse.
		const collapsedDoc = fakeDoc();
		const collapsedRoot = collapsedDoc.createElement("div");
		const collapsedDispatched: any[] = [];
		canvasMod.renderCanvas(model, layoutMod.computeLayout(model, { expansion: new Set() }), collapsedRoot, collapsedDoc, { dispatch: (a: any) => collapsedDispatched.push(a) });
		const aggEl = byAttr(collapsedRoot, "data-graph-node").find((g: any) => g.attributes["data-graph-node"]?.startsWith("agg:"));
		aggEl.fire("click");
		check("I2.2 an aggregate click still toggles collapse (no selection)", collapsedDispatched.length === 1 && collapsedDispatched[0].type === "toggle-collapse" && collapsedDispatched[0].leadId === sessionIdFor(LEAD(1)), JSON.stringify(collapsedDispatched));
	}

	// -- I3 — R2: the selection is a visible, dim-proof canvas state ---------
	{
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(model, layout, root, doc, { selection: W21 });
		const selected = byAttr(root, "data-graph-node").filter((g: any) => g.attributes["data-selected"] === "1");
		check("I3.1 exactly the selected node carries data-selected=1", selected.length === 1 && selected[0].attributes["data-graph-node"] === W21, JSON.stringify(selected.map((g: any) => g.attributes["data-graph-node"])));
		// sel+dim combine: a selected node OUTSIDE the spotlight keeps its
		// selection attribute while being dimmed like the rest.
		const spot = new Set([L2, "m1-lead-2", W21]);
		const doc2 = fakeDoc();
		const root2 = doc2.createElement("div");
		canvasMod.renderCanvas(model, layout, root2, doc2, { selection: sessionIdFor(LEAD(1)), spotlight: spot });
		const selEl = byAttr(root2, "data-graph-node").find((g: any) => g.attributes["data-graph-node"] === sessionIdFor(LEAD(1)));
		check("I3.2 a selected node outside the spotlight keeps data-selected while dimmed (sel+dim combine)", selEl.attributes["data-selected"] === "1" && selEl.attributes["data-dimmed"] === "1", JSON.stringify({ sel: selEl.attributes["data-selected"], dim: selEl.attributes["data-dimmed"] }));
		// patchCanvas mirrors both attributes (the in-place path).
		const doc3 = fakeDoc();
		const root3 = doc3.createElement("div");
		const index = canvasMod.renderCanvas(model, layout, root3, doc3, {});
		canvasMod.patchCanvas(index, model, doc3, { selection: W21, spotlight: spot });
		const patched = index.nodes.get(W21);
		check("I3.3 patchCanvas updates data-selected/data-dimmed in place (no relayout)", patched.attributes["data-selected"] === "1" && patched.attributes["data-dimmed"] === "0" && patched.attributes["data-x"] !== undefined, JSON.stringify(patched.attributes));
	}

	// -- I4 — C8: hot edges into spotlighted nodes ---------------------------
	{
		const spot = new Set([L2, "m1-lead-2", W21]);
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(model, layout, root, doc, { spotlight: spot });
		const edges = byAttr(root, "data-edge");
		const hot = edges.filter((e: any) => e.attributes["data-hot"] === "1");
		const touching = edges.filter((e: any) => spot.has(e.attributes["data-edge-from"]) || spot.has(e.attributes["data-edge-to"]));
		check("I4.1 exactly the edges touching a spotlighted node carry data-hot=1", hot.length === touching.length && hot.length > 0 && hot.every((e: any) => touching.includes(e)), JSON.stringify({ hot: hot.length, touching: touching.length, edges: edges.length }));
		const doc2 = fakeDoc();
		const root2 = doc2.createElement("div");
		canvasMod.renderCanvas(model, layout, root2, doc2, {});
		check("I4.2 without a spotlight no edge is hot", byAttr(root2, "data-edge").every((e: any) => e.attributes["data-hot"] === undefined));
	}

	// -- I5 — R2: the two-color system is pinned in canvas.css ---------------
	{
		const css = readAsset("canvas.css");
		check("I5.1 the dim level is 0.35 (the prototype's attention dim)", /\.graph-node\[data-dimmed="1"\]\s*\{[^}]*opacity:\s*0\.35/.test(css));
		check("I5.2 the selection stroke is accent (blue = selection)", /\.graph-node\[data-selected="1"\]\s*\.graph-box\s*\{[^}]*stroke:\s*var\(--accent\)/.test(css));
		check("I5.3 the spotlight stroke is amber (amber = attention)", /\.graph-node\[data-spotlight="1"\]\s*\.graph-box\s*\{[^}]*stroke:\s*var\(--amber\)/.test(css) && /\.graph-node\[data-spotlight="1"\]\s*\{[^}]*drop-shadow/.test(css));
		check("I5.4 hot edges turn amber", /\.graph-edge\[data-hot="1"\]\s*\{[^}]*stroke:\s*var\(--amber\)/.test(css));
		check("I5.5 a hover affordance exists (pointer cursor + accent stroke)", /\.graph-node\s*\{[^}]*cursor:\s*pointer/.test(css) && /\.graph-node:hover\s*\.graph-box\s*\{[^}]*stroke:\s*var\(--accent\)/.test(css));
	}

	// -- I6 — app wiring: selection reaches the canvas DOM --------------------
	{
		const els: Record<string, any> = {};
		const doc = fakeDoc(els);
		const fetchImpl = async (url: string) => {
			if (url.startsWith("/api/swarm/fleets")) return { json: async () => ({ ok: true, fleets: [] }) };
			if (url.startsWith("/api/swarm/snapshot")) return { json: async () => ({ ok: true, snapshot: graph }) };
			if (url.startsWith("/api/swarm/events")) return { json: async () => ({ ok: true, events, journal: { count: 1, dbSizeBytes: 12 } }) };
			throw new Error(`unexpected fetch ${url}`);
		};
		const appMod = (await import(publicUrl("app.js"))) as any;
		const app = appMod.createFleetApp({
			doc,
			fetch: fetchImpl,
			storage: null,
			location: { protocol: "http:", host: "h", pathname: "/", search: "", hash: "" },
			stream: () => ({ state: { lastSeq: 0 }, close() {} }),
			consoleTail: () => ({ close() {} }),
			ownSessionPath: SELF,
			nowMs: () => NOW,
		});
		await app.start();
		const shell = els["fleet-tree"];
		const none = byAttr(shell, "data-graph-node").filter((g: any) => g.attributes["data-selected"] === "1");
		app.dispatch({ type: "select-node", id: W21 });
		const one = byAttr(shell, "data-graph-node").filter((g: any) => g.attributes["data-selected"] === "1");
		check("I6.1 no node is selected initially; a select-node dispatch paints exactly one data-selected node", none.length === 0 && one.length === 1 && one[0].attributes["data-graph-node"] === W21, JSON.stringify(one.map((g: any) => g.attributes["data-graph-node"])));
		const dimmed = byAttr(shell, "data-graph-node").filter((g: any) => g.attributes["data-dimmed"] === "1");
		check("I6.2 a select-node leaves every other node at full opacity (nothing dims)", dimmed.length === 0, JSON.stringify(dimmed.length));
		app.close();
	}

	console.log(failures === 0 ? "\nALL CANVAS-INTENT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
