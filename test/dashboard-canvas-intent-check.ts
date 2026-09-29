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
 *   I7 R4 — the canvas renders ONLY `spawned_by` edges (collected/retired
 *      links stay in the model, never painted).
 *   I5 R2 — canvas.css pins the two-color system: accent selection stroke,
 *      amber attention stroke+glow, 0.35 dim, hot edges, hover affordance.
 *   I6 R1/R2 — app wiring: a select-node dispatch re-renders the canvas with
 *      exactly one `data-selected` node.
 *   I8 R5 — pan/zoom reachability + drag-vs-click threshold: fit zooms below
 *      the old 0.5 floor when a fleet only fits there (every node's
 *      transformed box lands inside the viewport for ANY fleet size), the
 *      wheel floor follows the fit (wheel-out never traps the view above
 *      the fitting zoom), a pointer move above CLICK_DRAG_THRESHOLD_PX pans
 *      and suppresses its trailing click, a sub-threshold tap still selects.
 *   I9 R6 — the ruled 3-column topology + role names: orchestrator col 0,
 *      tasks col 1, worker sessions col 2 grouped adjacent to their own
 *      task's band (never wire-siblings of it); a worker canvas node is
 *      labeled by its ROLE name (the same name the rail shows), while
 *      `data-graph-node` identity keeps the session hashes (stable across
 *      the relayout); a collapsed sub-fleet's aggregate sits in the worker
 *      column right after its lead.
 *   I10 R7 — the collapsed aggregate sub-line reads
 *      `k/n collected · worst: <sev> — click to expand`: the honest worst
 *      severity PLUS the affordance cue.
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
	// R4 fixture: lifecycle links the wire carries but the canvas must not draw.
	edges.push({ kind: "collected", from: sessionIdFor(WORK(1, 1)), to: "m1-lead-1" });
	edges.push({ kind: "retired", from: sessionIdFor(WORK(1, 2)), to: "m1-lead-1" });
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

	// -- I7 — R4: only the spawn tree is drawn --------------------------------
	{
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(model, layout, root, doc, {});
		const kinds = byAttr(root, "data-edge").map((e: any) => e.attributes["data-edge-kind"]);
		check("I7.1 the canvas renders ONLY spawned_by edges (collected/retired links stay in the model)", kinds.length > 0 && kinds.every((k: string) => k === "spawned_by"), JSON.stringify(kinds));
		check("I7.2 the layout still carries the full wire edge set (the filter is a view concern, not a model loss)", layout.edges.some((e: any) => e.kind === "collected") && layout.edges.some((e: any) => e.kind === "retired"));
	}

	// -- I8 — R5: pan/zoom reachability + drag-vs-click threshold -------------
	{
		const canvasViewMod = (await import(publicUrl("canvas-view.js"))) as any;
		// A viewport so small the fixture only fits below the documented 0.5
		// floor — the old clamp left the graph unreachable there.
		const vp = { width: 400, height: 200 };
		const fit = layoutMod.fitView(layout.bounds, vp);
		const floor = layoutMod.zoomFloorFor(layout.bounds, vp);
		check("I8.1 fit of a fleet too large for 0.5× zooms at its own sub-0.5 ratio (no 0.5 floor)", fit.zoom < 0.5 && fit.zoom > 0 && Math.abs(fit.zoom - floor) < 1e-12, JSON.stringify({ fit, floor }));
		const eps = 1e-6;
		const inside = Object.entries(layout.positions).every(([, p]: any) => {
			const x0 = p.x * fit.zoom + fit.panX;
			const y0 = p.y * fit.zoom + fit.panY;
			return x0 >= -eps && y0 >= -eps && x0 + layoutMod.NODE_W * fit.zoom <= vp.width + eps && y0 + layoutMod.NODE_H * fit.zoom <= vp.height + eps;
		});
		check("I8.2 after fit every node's transformed box is inside the viewport (reachable for ANY fleet size)", inside && Object.keys(layout.positions).length > 0);
		const wheelOut = layoutMod.zoomAt(fit, 0.9, 0, 0, floor);
		check("I8.3 the wheel floor follows the fit: zoom-out at a sub-floor view stays below 0.5 (never jumps up)", wheelOut.zoom < 0.5 && wheelOut.zoom >= floor - 1e-12, JSON.stringify(wheelOut));
		check("I8.4 the documented wheel floor 0.5 is unchanged without a fleet floor (zoomAt default)", layoutMod.zoomAt(fit, 0.9, 0, 0).zoom === 0.5);

		// Integration through attachCanvasControls on the fake svg: the wheel
		// handler must pass the fleet floor (a sub-floor view never clamps up).
		{
			const doc = fakeDoc();
			const root = doc.createElement("div");
			const index = canvasMod.renderCanvas(model, layout, root, doc, { view: { ...fit } });
			const views: any[] = [];
			canvasViewMod.attachCanvasControls(index, doc, { getView: () => views.at(-1) ?? { ...fit }, onView: (v: any) => views.push(v), viewport: () => vp });
			index.svg.fire("wheel", { deltaY: 100, offsetX: 10, offsetY: 10 });
			check("I8.5 a wheel-out through the live controls keeps the sub-0.5 fit view (the floor is wired)", views.length === 1 && views[0].zoom < 0.5 && views[0].zoom >= floor - 1e-12, JSON.stringify(views));
		}

		// The drag-vs-click threshold: >threshold pans and suppresses the
		// trailing click; a sub-threshold tap still selects (and never pans).
		const dragScenario = (dx: number, dy: number) => {
			const doc = fakeDoc();
			const root = doc.createElement("div");
			const dispatched: any[] = [];
			const views: any[] = [];
			const index = canvasMod.renderCanvas(model, layout, root, doc, { dispatch: (a: any) => dispatched.push(a), view: { zoom: 1, panX: 0, panY: 0 } });
			canvasViewMod.attachCanvasControls(index, doc, { getView: () => views.at(-1) ?? { zoom: 1, panX: 0, panY: 0 }, onView: (v: any) => views.push(v), viewport: () => vp });
			const nodeEl = byAttr(root, "data-graph-node").find((g: any) => g.attributes["data-graph-node"] === W21);
			index.svg.fire("pointerdown", { clientX: 100, clientY: 100 });
			index.svg.fire("pointermove", { clientX: 100 + dx, clientY: 100 + dy });
			index.svg.fire("pointerup", {});
			nodeEl.fire("click");
			return { dispatched, views };
		};
		const sub = dragScenario(2, 1); // ~2.2px — below the 4px threshold
		check("I8.6 a sub-threshold tap still selects and never pans", sub.dispatched.length === 1 && sub.dispatched[0].type === "select-node" && sub.dispatched[0].id === W21 && sub.views.length === 0, JSON.stringify({ dispatched: sub.dispatched, views: sub.views }));
		const sup = dragScenario(6, 0); // 6px — above the threshold: a pan
		check("I8.7 a drag above the threshold pans and fires NO select-node", sup.views.length === 1 && sup.views[0].panX === 6 && sup.views[0].panY === 0 && !sup.dispatched.some((a: any) => a.type === "select-node"), JSON.stringify({ dispatched: sup.dispatched, views: sup.views }));
		check("I8.8 the threshold is the exported CLICK_DRAG_THRESHOLD_PX (4px, > not >=)", canvasViewMod.CLICK_DRAG_THRESHOLD_PX === 4 && (() => {
			const g = canvasViewMod.dragGesture();
			g.down(0, 0);
			const at = g.move(4, 0); // exactly 4px is NOT yet a pan
			g.up();
			return at === null && g.suppressesClick() === false;
		})());
	}

	// -- I9 — R6: the ruled 3-column topology + role names --------------------
	{
		const col = (id: string): number | undefined => layout.positions[id]?.col;
		const row = (id: string): number | undefined => layout.positions[id]?.row;
		check(
			"I9.1 the ruled columns: orchestrator col 0, tasks col 1, worker sessions col 2 — a task's workers are grouped under it, never wire-siblings of it",
			col(sessionIdFor(SELF)) === 0 && col("milestone1") === 1 && col("m1-lead-1") === 1 && col("m1-lead-2") === 1 && col(sessionIdFor(LEAD(1))) === 2 && col(L2) === 2 && col(W21) === 2 && col(sessionIdFor(WORK(2, 2))) === 2,
			JSON.stringify(Object.fromEntries(layout.nodes.map((n: any) => [n.id, `c${col(n.id)}r${row(n.id)}`]))),
		);
		const workerRowsOf = (taskId: string): number[] => layout.nodes.filter((n: any) => n.kind === "session" && n.isWorker === true && n.task === taskId).map((n: any) => row(n.id)).sort((a: number, b: number) => a - b);
		check(
			"I9.2 workers sit adjacent to their task's band: the task first, then its workers top-to-bottom, then the next task",
			JSON.stringify(workerRowsOf("m1-lead-1")) === JSON.stringify([row("m1-lead-1")! + 1, row("m1-lead-1")! + 2]) &&
				JSON.stringify(workerRowsOf("m1-lead-2")) === JSON.stringify([row("m1-lead-2")! + 1, row("m1-lead-2")! + 2]) &&
				JSON.stringify(workerRowsOf("milestone1")) === JSON.stringify([row("milestone1")! + 1, row("milestone1")! + 2]) &&
				row("m1-lead-2") === row("m1-lead-1")! + 3 &&
				row("milestone1") === row("m1-lead-2")! + 3,
			JSON.stringify({ m1l1: workerRowsOf("m1-lead-1"), m1l2: workerRowsOf("m1-lead-2"), m1: workerRowsOf("milestone1") }),
		);
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(model, layout, root, doc, {});
		const labelOf = (id: string): string => {
			const group = byAttr(root, "data-graph-node").find((g: any) => g.attributes["data-graph-node"] === id);
			const nameEl = group.childNodes.find((c: any) => c.getAttribute && c.getAttribute("data-node-name") !== null);
			return nameEl.textContent;
		};
		check(
			"I9.3 worker canvas nodes are labeled by the worker ROLE name (the same name the rail shows), never the session hash",
			labelOf(W21) === "w2-1" && labelOf(sessionIdFor(WORK(2, 2))) === "w2-2" && labelOf(L2) === "lead-2" && labelOf(sessionIdFor(LEAD(1))) === "lead-1",
			JSON.stringify({ w21: labelOf(W21), lead2: labelOf(L2) }),
		);
		const domIds = byAttr(root, "data-graph-node").map((g: any) => g.attributes["data-graph-node"]);
		check(
			"I9.4 node identity is unchanged by the relayout: data-graph-node keeps the session hashes/task ids and never adopts a role name",
			domIds.length === model.nodes.length && domIds.every((id: string) => model.byId.has(id)) && domIds.includes(W21) && domIds.includes("milestone1") && !domIds.includes("w2-1") && !domIds.includes("lead-2"),
			JSON.stringify(domIds),
		);
		const collapsed = layoutMod.computeLayout(model, { expansion: new Set() });
		check(
			"I9.5 a collapsed sub-fleet renders its aggregate in the worker column right after its lead (the lead's own summary)",
			collapsed.positions[`agg:${sessionIdFor(LEAD(1))}`]?.col === 2 && collapsed.positions[`agg:${sessionIdFor(LEAD(1))}`]?.row === collapsed.positions[sessionIdFor(LEAD(1))].row + 1 && !collapsed.visibleIds.has("m1-lead-1"),
			JSON.stringify({ agg: collapsed.positions[`agg:${sessionIdFor(LEAD(1))}`], lead: collapsed.positions[sessionIdFor(LEAD(1))] }),
		);
	}

	// -- I10 — R7: the aggregate sub-line wording ------------------------------
	{
		const collapsed = layoutMod.computeLayout(model, { expansion: new Set() });
		const agg = collapsed.nodes.find((n: any) => n.kind === "aggregate");
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(model, collapsed, root, doc, {});
		const aggEl = byAttr(root, "data-graph-node").find((g: any) => g.attributes["data-graph-node"] === agg.id);
		const subEl = aggEl.childNodes.find((c: any) => c.getAttribute && c.getAttribute("data-node-sub") !== null);
		check(
			"I10.1 the collapsed aggregate sub-line reads `k/n collected · worst: <sev> — click to expand` (honest worst + the affordance cue)",
			subEl.textContent === `${agg.collected}/${agg.total} collected \u00b7 worst: ${agg.severity} \u2014 click to expand` && /^\d+\/\d+ collected \u00b7 worst: \S+ \u2014 click to expand$/.test(subEl.textContent),
			subEl.textContent,
		);
	}

	console.log(failures === 0 ? "\nALL CANVAS-INTENT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
