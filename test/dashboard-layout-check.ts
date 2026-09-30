/**
 * dashboard-layout-check — issue #80 (canvas depth columns) + issue #78
 * (one coordinate space for fit/viewBox) + the canvas-local half of #92.
 *
 * Production shape is the whole point of the #80 fixture: every node carries
 * `depth: 0` (the wire's `depth` is the authority TIER, not tree depth — the
 * live snapshot has it 0 on all 48 nodes) and the hierarchy exists ONLY as
 * `spawned_by` edges. The layout must derive its columns from BFS over those
 * edges, never from `node.depth`.
 *
 * The #78 half drives the real `renderCanvas`/`attachCanvasControls` through a
 * fake DOM seam whose elements report a pixel box: the measured element box
 * must override the hardcoded 1200x720 seam app.js still injects, and the
 * post-fit transformed bounds must intersect the new `0 0 width height`
 * viewBox. Fit/zoom math stays pure (no DOM) because the fake seam without a
 * box yields no measurement.
 *
 * #84 adds the canvas degradation vocabulary (one badge per flag + tooltip)
 * and the status-marker stroke contract (unknown dashed vs idle solid, done
 * 2px vs collected 1.5px). #92 adds cursor-in-user-units wheel zoom and the
 * removal of the dead `ui.toggled` field. #137/AC8 adds the drag regression
 * the #128 review found missing: a RE-RENDERING onView (the real app loop)
 * must still accumulate the pan across moves, and a drag's trailing click
 * must never dispatch select-node.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; no unbounded
 * waits. Exit 0 only if all checks pass.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const watchdog = setTimeout(() => {
	console.error("dashboard-layout-check WATCHDOG TIMEOUT");
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
const PUBLIC_DIR = fileURLToPath(new URL("../src/swarm-server/public/", import.meta.url));
const readAsset = (name: string): string => readFileSync(join(PUBLIC_DIR, name), "utf8");

// ---------------------------------------------------------------------------
// Fake DOM seam (the renderers' document contract; elements may report a box)
// ---------------------------------------------------------------------------

class FakeEl {
	attributes: Record<string, string> = {};
	childNodes: any[] = [];
	text = "";
	listeners: Record<string, Array<(e: any) => void>> = {};
	rect: { width: number; height: number } | null = null;
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
	addEventListener(type: string, fn: (e: any) => void) {
		(this.listeners[type] ??= []).push(fn);
	}
	dispatch(type: string, event: any = {}) {
		for (const fn of this.listeners[type] ?? []) fn(event);
	}
	/** A real browser element reports a pixel box; the fake reports one only
	 *  when the check configures it (headless purity of the pure math). */
	getBoundingClientRect(): { width: number; height: number } {
		return this.rect ?? { width: 0, height: 0 };
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

function fakeDoc(): any {
	return {
		createElement: (t: string) => new FakeEl(t),
		createElementNS: (_ns: string, t: string) => new FakeEl(t),
		createTextNode: (t: string) => ({ textContent: t, childNodes: [] }),
		getElementById: () => new FakeEl("div"),
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

/** Do two [minX,maxX]x[minY,maxY] boxes overlap? */
function intersects(a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
	return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/** A transformed layout bound box (bounds put through translate+scale). */
function transformedBounds(bounds: any, view: { zoom: number; panX: number; panY: number }) {
	const x1 = bounds.minX * view.zoom + view.panX;
	const y1 = bounds.minY * view.zoom + view.panY;
	const x2 = bounds.maxX * view.zoom + view.panX;
	const y2 = bounds.maxY * view.zoom + view.panY;
	return { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
}

/**
 * The #136 production shape: a root orchestrator, two sub-orchestrators, their
 * workers and three task nodes — every node `depth: 0`; the hierarchy is
 * carried by the STRUCTURAL edges (`owned_by`: task→owner, `contains`:
 * task→worker session) plus the CAUSAL `spawned_by` edges (worker session →
 * orchestrator session, which skip the task column). The layout must derive
 * its columns from BFS over the structural edges only — never from
 * `node.depth`, never from `spawned_by`.
 */
function productionShapedState() {
	const node = (kind: string, id: string, name: string) => ({
		kind,
		id,
		name,
		depth: 0,
		status: "running",
		severity: "info",
		statusView: { shape: "dot", className: "status-running", pulse: true },
		foreign: false,
		degraded: [],
		usage: null,
		elapsedLabel: null,
		progress: null,
	});
	const nodes = [
		node("session", "s:root", "root"),
		node("session", "s:lead-a", "lead-a"),
		node("session", "s:lead-b", "lead-b"),
		node("session", "s:a1", "a1"),
		node("session", "s:a2", "a2"),
		node("session", "s:b1", "b1"),
		node("task", "t:root", "root-task"),
		node("task", "t:lead-a", "lead-a-task"),
		node("task", "t:lead-b", "lead-b-task"),
	];
	const edges = [
		// #136 structural: owned_by hangs the task under its owner session,
		// contains hangs the worker session under its task.
		{ kind: "owned_by", from: "t:root", to: "s:root" },
		{ kind: "contains", from: "t:root", to: "s:lead-a" },
		{ kind: "contains", from: "t:root", to: "s:lead-b" },
		{ kind: "owned_by", from: "t:lead-a", to: "s:lead-a" },
		{ kind: "contains", from: "t:lead-a", to: "s:a1" },
		{ kind: "contains", from: "t:lead-a", to: "s:a2" },
		{ kind: "owned_by", from: "t:lead-b", to: "s:lead-b" },
		{ kind: "contains", from: "t:lead-b", to: "s:b1" },
		// #136 causal lineage — still carried, still drawn, never a column.
		{ kind: "spawned_by", from: "s:lead-a", to: "s:root" },
		{ kind: "spawned_by", from: "s:lead-b", to: "s:root" },
		{ kind: "spawned_by", from: "s:a1", to: "s:lead-a" },
		{ kind: "spawned_by", from: "s:a2", to: "s:lead-a" },
		{ kind: "spawned_by", from: "s:b1", to: "s:lead-b" },
	];
	return {
		nodes,
		edges,
		byId: new Map(nodes.map((n) => [n.id, n])),
		graph: { collapse: new Map<string, unknown>() },
	};
}

async function main(): Promise<void> {
	const layoutMod = (await import(publicUrl("layout.js"))) as any;
	const canvasMod = (await import(publicUrl("canvas.js"))) as any;
	const statusMod = (await import(publicUrl("status.js"))) as any;
	const degradeMod = (await import(publicUrl("degrade.js"))) as any;
	const uiMod = (await import(publicUrl("ui.js"))) as any;

	// -- B1 — #136: columns come from BFS over the structural edges ----------
	{
		const state = productionShapedState();
		const layout = layoutMod.computeLayout(state, { expansion: [] });
		const col = (id: string): number | undefined => layout.positions[id]?.col;
		check(
			"B1.1 a production-shaped fixture (every node depth 0) forms columns from the structural edges: orchestrator 0 → task 1 → lead 2 → lead-task 3 → worker 4",
			col("s:root") === 0 && col("t:root") === 1 && col("s:lead-a") === 2 && col("s:lead-b") === 2 && col("t:lead-a") === 3 && col("t:lead-b") === 3 && col("s:a1") === 4 && col("s:a2") === 4 && col("s:b1") === 4,
			JSON.stringify(layout.positions),
		);
		check(
			"B1.2 not one strip: the fixture spans at least three distinct columns (the pre-#80 depth trust put all at 0)",
			new Set(Object.values(layout.positions).map((p: any) => p.col)).size >= 3,
			JSON.stringify([...new Set(Object.values(layout.positions).map((p: any) => p.col))]),
		);
		check(
			"B1.3 every STRUCTURAL edge steps exactly one column (owned_by: task = owner+1; contains: worker = task+1)",
			state.edges.filter((e) => e.kind === "owned_by" || e.kind === "contains").every((e) => (e.kind === "owned_by" ? layout.positions[e.from].col === layout.positions[e.to].col + 1 : layout.positions[e.to].col === layout.positions[e.from].col + 1)),
			JSON.stringify(state.edges.filter((e) => e.kind !== "spawned_by").map((e) => `${e.from}:${layout.positions[e.from].col}->${e.to}:${layout.positions[e.to].col}`)),
		);
		check(
			"B1.3b spawned_by does NOT set a column: the lead hangs at 2 by contains, not at 1 by its causal spawned_by — and every REDUNDANT causal edge is hidden from the default layout (round-1fix), re-shown by showCausal",
			col("s:lead-a") === col("t:root")! + 1 && col("s:lead-a") !== col("s:root")! + 1 && !layout.edges.some((e: any) => e.kind === "spawned_by") && layoutMod.computeLayout(state, { expansion: [], showCausal: true }).edges.some((e: any) => e.kind === "spawned_by" && e.from === "s:a1" && e.to === "s:lead-a"),
			JSON.stringify({ leadA: col("s:lead-a"), drawn: layout.edges.filter((e: any) => e.kind === "spawned_by").map((e: any) => `${e.from}->${e.to}`) }),
		);
		check(
			"B1.4 node.depth stays a decorative attribute (the fixture nodes still carry depth 0)",
			state.nodes.every((n) => n.depth === 0),
		);
		const again = layoutMod.computeLayout(state, { expansion: [] });
		check("B1.5 the BFS layout is deterministic (byte-identical golden on two calls)", layoutMod.coordinateGolden(layout) === layoutMod.coordinateGolden(again));

		// A cycle in the STRUCTURAL parent space is not a root: it must not loop
		// forever and stays deterministic.
		const cyclic = productionShapedState();
		cyclic.nodes.push({ kind: "session", id: "s:c1", name: "c1", depth: 0 } as any, { kind: "task", id: "t:c1", name: "c1-task", depth: 0 } as any);
		cyclic.edges.push({ kind: "contains", from: "t:c1", to: "s:c1" }, { kind: "owned_by", from: "t:c1", to: "s:c1" });
		const cyc = layoutMod.computeLayout(cyclic, { expansion: [] });
		check("B1.6 a pure structural cycle terminates and stays deterministic", layoutMod.coordinateGolden(cyc) === layoutMod.coordinateGolden(layoutMod.computeLayout(cyclic, { expansion: [] })));

		// The same heuristic on the REAL graph shape: all depth 0, structural
		// + causal edges.
		const depths = layoutMod.resolveDepths(state);
		check("B1.7 resolveDepths is exported, pure and structural-edge-derived", depths.get("s:root") === 0 && depths.get("t:root") === 1 && depths.get("s:lead-a") === 2 && depths.get("s:a1") === 4);

		// The causal edges are still DRAWN: every layout edge renders a path
		// carrying its own data-edge-kind.
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(state, layout, root, doc, { view: { zoom: 1, panX: 0, panY: 0 }, viewport: () => ({ width: 900, height: 600 }), onView: () => {} });
		const kinds = byAttr(root, "data-edge").map((p) => p.attributes["data-edge-kind"]).sort().join(",");
		check(
			"B1.8 the default canvas draws the STRUCTURAL edges only (every spawned_by in this fixture is redundant — round-1fix)",
			kinds === "contains,contains,contains,contains,contains,owned_by,owned_by,owned_by",
			kinds,
		);
		const causalRoot = doc.createElement("div");
		canvasMod.renderCanvas(state, layoutMod.computeLayout(state, { expansion: [], showCausal: true }), causalRoot, doc, { view: { zoom: 1, panX: 0, panY: 0 }, viewport: () => ({ width: 900, height: 600 }), onView: () => {}, showCausal: true });
		const causalKinds = byAttr(causalRoot, "data-edge").map((p) => p.attributes["data-edge-kind"]).sort().join(",");
		check(
			"B1.8b the causal toggle re-shows every edge kind: contains, owned_by AND the causal spawned_by paths",
			causalKinds === "contains,contains,contains,contains,contains,owned_by,owned_by,owned_by,spawned_by,spawned_by,spawned_by,spawned_by,spawned_by",
			causalKinds,
		);
	}

	// -- B2 — #78: fit and the authoritative viewBox intersect ---------------
	{
		const state = productionShapedState();
		const layout = layoutMod.computeLayout(state, { expansion: [] });
		const bounds = layout.bounds;
		const vp = { width: 600, height: 400 };
		const fit = layoutMod.fitView(bounds, vp);
		const box = transformedBounds(bounds, fit);
		check(
			"B2.1 after fit the transformed layout bounds still intersect the viewBox [0 0 width height]",
			intersects(box, { minX: 0, minY: 0, maxX: vp.width, maxY: vp.height }),
			JSON.stringify({ bounds, fit, box }),
		);
		check(
			"B2.2 the fit anchor stays inside the viewBox (pan never throws the content off-screen)",
			box.minX < vp.width && box.maxX > 0 && box.minY < vp.height && box.maxY > 0,
			JSON.stringify(box),
		);

		// The element box beats the hardcoded 1200x720 fantasy seam.
		const doc = fakeDoc();
		const root = doc.createElement("div");
		root.rect = { width: 900, height: 600 };
		const onView: any[] = [];
		const index = canvasMod.renderCanvas(state, layout, root, doc, {
			view: { zoom: 1, panX: 0, panY: 0 },
			viewport: () => ({ width: 1200, height: 720 }),
			onView: (v: any) => onView.push(v),
		});
		check(
			"B2.3 the SVG viewBox is the measured pixel box, not the hardcoded 1200x720 fantasy viewport",
			index.svg.attributes.viewBox === "0 0 900 600",
			JSON.stringify(index.svg.attributes),
		);
		check("B2.4 the bogus SVG `viewport` attribute is gone (viewBox is the one coordinate space)", index.svg.attributes.viewport === undefined, JSON.stringify(Object.keys(index.svg.attributes)));
		check("B2.5 no SVG element carries a viewport attribute anywhere in the tree", byAttr(root, "viewport").length === 0);

		// The toolbar fit affordance fits into the measured box and intersects it.
		const fitButton = byAttr(root, "data-canvas-fit")[0];
		fitButton.dispatch("click");
		check("B2.6 the fit button fits the layout into the measured box (and lands inside the viewBox)", onView.length === 1 && intersects(transformedBounds(bounds, onView[0]), { minX: 0, minY: 0, maxX: 900, maxY: 600 }), JSON.stringify(onView));

		// attachCanvasControls auto-fits an untouched view once the SVG reports a box.
		index.svg.rect = { width: 900, height: 600 };
		const attached: any[] = [];
		canvasMod.attachCanvasControls(index, doc, { getView: () => ({ zoom: 1, panX: 0, panY: 0 }), onView: (v: any) => attached.push(v), viewport: () => ({ width: 1200, height: 720 }) });
		check(
			"B2.7 first measured attach frames the untouched view (and re-points the viewBox at the SVG's own box)",
			attached.length === 1 && intersects(transformedBounds(bounds, attached[0]), { minX: 0, minY: 0, maxX: 900, maxY: 600 }) && index.svg.attributes.viewBox === "0 0 900 600",
			JSON.stringify({ attached, viewBox: index.svg.attributes.viewBox }),
		);

		// A non-initial view is never auto-replaced (user pan/zoom survives).
		const index2 = canvasMod.renderCanvas(state, layout, root, doc, { view: { zoom: 1.5, panX: 12, panY: -8 }, viewport: () => ({ width: 1200, height: 720 }), onView: () => {} });
		index2.svg.rect = { width: 900, height: 600 };
		const attached2: any[] = [];
		canvasMod.attachCanvasControls(index2, doc, { getView: () => ({ zoom: 1.5, panX: 12, panY: -8 }), onView: (v: any) => attached2.push(v) });
		check("B2.8 a user view (non-initial) is never auto-fit (no surprise reset on re-attach)", attached2.length === 0, JSON.stringify(attached2));

		// Headless: no measurable element → the injected viewport is honored,
		// and the pure fit math is untouched.
		const doc3 = fakeDoc();
		const root3 = doc3.createElement("div");
		const index3 = canvasMod.renderCanvas(state, layout, root3, doc3, { view: { zoom: 1, panX: 0, panY: 0 }, viewport: () => ({ width: 900, height: 600 }), onView: () => {} });
		check("B2.9 without a measurable element the injected (non-fantasy) viewport is the fallback", index3.svg.attributes.viewBox === "0 0 900 600", JSON.stringify(index3.svg.attributes));
	}

	// -- B3 — #92 canvas-local chrome: the fit toolbar has real CSS ---------
	{
		const canvasCss = readAsset("canvas.css");
		check("B3.1 canvas.css styles the fit toolbar (.canvas-toolbar + .canvas-fit rules exist)", /\.canvas-toolbar\s*\{/.test(canvasCss) && /\.canvas-fit\s*\{/.test(canvasCss));
		check("B3.2 the toolbar is absolutely positioned top-right over the SVG (never steals the 100%-height SVG's layout height)", /\.canvas-toolbar\s*\{[^}]*position:\s*absolute/.test(canvasCss) && /\.canvas-toolbar\s*\{[^}]*background:/.test(canvasCss));
		check("B3.3 the SVG is inset:0 in the region box, so the toolbar cannot clip its bottom", /\.graph-canvas\s*\{[^}]*position:\s*absolute/.test(canvasCss) && /\.graph-canvas\s*\{[^}]*inset:\s*0/.test(canvasCss));
	}

	// -- B4 — #84a: one canvas badge per degradation flag + verbatim tooltip -
	{
		const state = productionShapedState();
		const target = state.byId.get("s:a1")!;
		target.degraded = degradeMod.degradeViews([...degradeMod.DEGRADED_FLAGS]);
		const layout = layoutMod.computeLayout(state, { expansion: [] });
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(state, layout, root, doc, { view: { zoom: 1, panX: 0, panY: 0 }, viewport: () => ({ width: 900, height: 600 }), onView: () => {} });
		const badges = byAttr(root, "data-degraded-flag");
		const flags = badges.map((b) => b.attributes["data-degraded-flag"]);
		check(
			"B4.1 every degradation flag renders its own canvas badge (never one severity-blind ⚠N counter)",
			badges.length === 4 && flags.join(",") === degradeMod.DEGRADED_FLAGS.join(","),
			JSON.stringify(flags),
		);
		check(
			"B4.2 each badge carries the flag's own degrade class + unified severity",
			badges.every((b, i) => b.attributes.class.includes(degradeMod.degradeClass(flags[i])) && b.attributes["data-flag-severity"] === degradeMod.severityFor(flags[i])),
			JSON.stringify(badges.map((b) => [b.attributes.class, b.attributes["data-flag-severity"]])),
		);
		check(
			"B4.3 the four badges use four distinct glyphs (colour is not the only signal)",
			new Set(badges.map((b) => b.attributes["data-degraded-glyph"])).size === 4 && badges.every((b) => b.textContent === b.attributes["data-degraded-glyph"]),
			JSON.stringify(badges.map((b) => b.attributes["data-degraded-glyph"])),
		);
		const title = walk(root).find((e) => e instanceof FakeEl && e.tagName === "title");
		check(
			"B4.4 the badge cluster carries a tooltip listing the flags verbatim",
			!!title && degradeMod.DEGRADED_FLAGS.every((f: string) => title.textContent.includes(f)),
			JSON.stringify(title?.textContent),
		);
		const canvasJs = readAsset("canvas.js");
		check(
			"B4.5 the severity-blind single `graph-degraded` marker is gone from canvas.js",
			canvasJs.includes("renderDegradedBadges") && !canvasJs.includes('"graph-degraded"'),
		);
		const canvasCss = readAsset("canvas.css");
		check(
			"B4.6 canvas.css gives every known flag its own fill rule (four distinct paint states)",
			degradeMod.DEGRADED_FLAGS.every((f: string) => canvasCss.includes(`[data-degraded-flag="${f}"]`)) && /data-flag-severity="warn"/.test(canvasCss),
		);
	}

	// -- B5 — #84b: markers keep the CSS shape vocabulary in SVG -------------
	{
		const idle = canvasMod.markerGeometry(statusMod.statusView("idle"));
		const unknown = canvasMod.markerGeometry(statusMod.statusView("unknown"));
		check("B5.1 unknown is dashed where idle is solid (the colorblind contract survives the SVG)", unknown.dashed === true && !idle.dashed);
		check(
			"B5.2 done is a 2px ring where collected is 1.5px (the status.css stroke-width pair is restored)",
			canvasMod.markerGeometry(statusMod.statusView("done")).strokeWidth === 2 && canvasMod.markerGeometry(statusMod.statusView("collected")).strokeWidth === 1.5,
		);
		const names = Object.keys(statusMod.STATUS_LANGUAGE);
		const tagOf = (shape: string) => (shape.startsWith("dot") || shape.startsWith("ring") ? "circle" : "rect");
		const signatures = names.map((s: string) => {
			const view = statusMod.statusView(s);
			const g = canvasMod.markerGeometry(view);
			return [tagOf(view.shape), g.r ?? g.half, g.hollow, !!g.dashed, g.strokeWidth, !!g.rotated].join("|");
		});
		check("B5.3 no two statuses share an SVG geometry+stroke pair", new Set(signatures).size === names.length, JSON.stringify(names.map((n, i) => `${n}:${signatures[i]}`)));

		// End to end: the rendered circle carries the dash for unknown, not idle.
		const state = productionShapedState();
		const idleNode = state.byId.get("s:a1")!;
		const unknownNode = state.byId.get("s:a2")!;
		idleNode.status = "idle";
		idleNode.statusView = statusMod.statusView("idle");
		unknownNode.status = "unknown";
		unknownNode.statusView = statusMod.statusView("unknown");
		const layout = layoutMod.computeLayout(state, { expansion: [] });
		const doc = fakeDoc();
		const root = doc.createElement("div");
		canvasMod.renderCanvas(state, layout, root, doc, { view: { zoom: 1, panX: 0, panY: 0 }, viewport: () => ({ width: 900, height: 600 }), onView: () => {} });
		const markerOf = (id: string) => byAttr(root, "data-graph-node").find((g) => g.attributes["data-graph-node"] === id).childNodes.find((c: any) => c.getAttribute && c.getAttribute("data-status-marker") !== null);
		check(
			"B5.4 the rendered idle circle is solid and the unknown circle is stroke-dasharray 3 2",
			markerOf("s:a1").attributes["stroke-dasharray"] === undefined && markerOf("s:a2").attributes["stroke-dasharray"] === "3 2",
			JSON.stringify({ idle: markerOf("s:a1").attributes, unknown: markerOf("s:a2").attributes }),
		);
	}

	// -- B6 — #92a: wheel zoom anchors in USER units -------------------------
	{
		const identity = canvasMod.cursorToUser(120, 80, { width: 900, height: 600 }, { width: 900, height: 600 });
		check("B6.1 cursorToUser is the identity when the viewBox IS the element box", identity.x === 120 && identity.y === 80, JSON.stringify(identity));
		const scaled = canvasMod.cursorToUser(200, 100, { width: 900, height: 600 }, { width: 1800, height: 1200 });
		check("B6.2 cursorToUser divides by the viewBox scale (2x element box → half the offset)", Math.abs(scaled.x - 100) < 1e-9 && Math.abs(scaled.y - 50) < 1e-9, JSON.stringify(scaled));
		const letterboxed = canvasMod.cursorToUser(100, 200, { width: 900, height: 600 }, { width: 900, height: 900 });
		check("B6.3 cursorToUser removes the xMidYMid meet letterbox gutters", Math.abs(letterboxed.x - 100) < 1e-9 && Math.abs(letterboxed.y - 50) < 1e-9, JSON.stringify(letterboxed));
		check(
			"B6.4 a malformed viewBox parses to null so the measured box is the fallback",
			canvasMod.parseViewBox("0 0 900") === null && canvasMod.parseViewBox("garbage") === null && canvasMod.parseViewBox("0 0 900 600")?.width === 900,
		);

		// End to end: a wheel event whose element box is 2x the viewBox must
		// anchor the USER-space point, not the raw CSS-pixel offset.
		const state = productionShapedState();
		const layout = layoutMod.computeLayout(state, { expansion: [] });
		const doc = fakeDoc();
		const root = doc.createElement("div");
		root.rect = { width: 900, height: 600 };
		const start = { zoom: 1.5, panX: 12, panY: -8 };
		const onView: any[] = [];
		const index = canvasMod.renderCanvas(state, layout, root, doc, { view: start, viewport: () => ({ width: 900, height: 600 }), onView: (v: any) => onView.push(v) });
		canvasMod.attachCanvasControls(index, doc, { getView: () => start, onView: (v: any) => onView.push(v) });
		index.svg.rect = { width: 1800, height: 1200 };
		index.svg.setAttribute("viewBox", "0 0 900 600");
		index.svg.dispatch("wheel", { deltaY: -1, offsetX: 200, offsetY: 100, preventDefault() {} });
		const out = onView[onView.length - 1];
		const worldUnder = (v: any, x: number, y: number) => ({ x: (x - v.panX) / v.zoom, y: (y - v.panY) / v.zoom });
		const before = worldUnder(start, 100, 50);
		const after = worldUnder(out, 100, 50);
		check(
			"B6.5 wheel zoom holds the USER-space point under the cursor (offset converted through the viewBox scale)",
			Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9,
			JSON.stringify({ out, before, after }),
		);
		const naive = worldUnder(out, 200, 100);
		check(
			"B6.6 the raw CSS-pixel interpretation would NOT hold (the conversion is real, not cosmetic)",
			Math.abs(naive.x - before.x) > 1e-6 || Math.abs(naive.y - before.y) > 1e-6,
			JSON.stringify(naive),
		);
	}

	// -- B7 — #92b: the dead ui.toggled field is gone ------------------------
	{
		const ui0 = uiMod.createUiState();
		const ui1 = uiMod.uiReducer(ui0, { type: "toggle-collapse", leadId: "L1" });
		check("B7.1 createUiState carries no dead `toggled` field and the toggle still expands", !("toggled" in ui0) && ui1.toggled === undefined && ui1.expansion.has("L1"), JSON.stringify(Object.keys(ui0)));
		check("B7.2 ui.js source has no `toggled` writer or reader left", !/\btoggled\b/.test(readAsset("ui.js")));
	}

	// -- B8 — #137/AC8: the pan accumulates and a drag never selects --------
	{
		const state = productionShapedState();
		const layout = layoutMod.computeLayout(state, { expansion: [] });
		const dispatchs: any[] = [];
		const dispatch = (a: any) => dispatchs.push(a);
		const viewport = () => ({ width: 900, height: 600 });

		// The app loop the #128 review said the old I8 pin never exercised: onView
		// updates the view state AND re-renders the canvas (renderRegions's data
		// path). A real browser re-dispatches the pointer to the CURRENT svg under
		// the cursor, so every move below is fired on the LIVE render's svg.
		{
			const doc = fakeDoc();
			const root = doc.createElement("div");
			root.rect = { width: 900, height: 600 };
			let view = { zoom: 1, panX: 0, panY: 0 };
			const gesture = canvasMod.createDragGesture();
			let live: any = null;
			let renders = 0;
			const onView = (v: any) => {
				view = v;
				renders++;
				live = canvasMod.renderCanvas(state, layout, root, doc, { dispatch, view, viewport, onView, gesture });
				canvasMod.attachCanvasControls(live, doc, { getView: () => view, onView, viewport, gesture });
			};
			live = canvasMod.renderCanvas(state, layout, root, doc, { dispatch, view, viewport, onView, gesture });
			canvasMod.attachCanvasControls(live, doc, { getView: () => view, onView, viewport, gesture });
			const firstSvg = live.svg;

			let x = 100;
			const y = 100;
			live.svg.dispatch("pointerdown", { clientX: x, clientY: y });
			for (let i = 0; i < 3; i++) {
				x += 10;
				live.svg.dispatch("pointermove", { clientX: x, clientY: y });
			}
			check(
				"B8.1 the pan ACCUMULATES across three 10px moves under a re-rendering onView (3×10 → 30, not stalled at 10)",
				Math.abs(view.panX - 30) < 1e-9 && Math.abs(view.panY) < 1e-9,
				JSON.stringify({ view, renders }),
			);
			check(
				"B8.2 the drag really survived mid-drag re-renders (every move re-rendered; the events landed on fresh SVGs)",
				renders === 3 && live.svg !== firstSvg,
				JSON.stringify({ renders, sameSvg: live.svg === firstSvg }),
			);

			// The trailing click of the drag: pointerup, then the click the browser
			// fires on the node under the release point. It must NOT select.
			live.svg.dispatch("pointerup", { clientX: x, clientY: y });
			live.nodes.get("s:a1").dispatch("click");
			check(
				"B8.3 a drag's trailing click dispatches NOTHING (no select-node, no toggle-collapse)",
				dispatchs.length === 0,
				JSON.stringify(dispatchs),
			);

			// A genuine click (pointerdown+up, travel under the threshold) still selects.
			live.svg.dispatch("pointerdown", { clientX: x, clientY: y });
			live.svg.dispatch("pointerup", { clientX: x, clientY: y });
			live.nodes.get("s:a1").dispatch("click");
			check(
				"B8.4 a genuine click still selects (the threshold is a drag verdict, not a click ban)",
				dispatchs.length === 1 && dispatchs[0].type === "select-node" && dispatchs[0].id === "s:a1",
				JSON.stringify(dispatchs),
			);
		}

		// The FIXED app loop (AC1): onView PATCHES the live <g data-view>
		// transform in place — a pan step never re-renders the canvas.
		{
			const doc = fakeDoc();
			const root = doc.createElement("div");
			root.rect = { width: 900, height: 600 };
			let view = { zoom: 1, panX: 0, panY: 0 };
			const gesture = canvasMod.createDragGesture();
			let index: any = null;
			let renders = 0;
			const onView = (v: any) => {
				view = v;
				renders++;
				if (index?.view?.setAttribute) index.view.setAttribute("transform", canvasMod.viewTransform(v));
			};
			index = canvasMod.renderCanvas(state, layout, root, doc, { view, viewport, onView, gesture });
			canvasMod.attachCanvasControls(index, doc, { getView: () => view, onView, viewport, gesture });
			const sameIndex = () => index.view.attributes.transform;

			let x = 50;
			const y = 50;
			index.svg.dispatch("pointerdown", { clientX: x, clientY: y });
			for (let i = 0; i < 3; i++) {
				x += 10;
				index.svg.dispatch("pointermove", { clientX: x, clientY: y });
			}
			check(
				"B8.5 the in-place onView accumulates the pan (30) and the <g data-view> transform carries it",
				Math.abs(view.panX - 30) < 1e-9 && sameIndex() === "translate(30 0) scale(1)",
				JSON.stringify({ view, transform: sameIndex() }),
			);
			check(
				"B8.6 a pan step never re-renders the canvas (onView ran 3×, renderCanvas once — the SVG identity is stable)",
				renders === 3 && byAttr(root, "data-graph").length === 1,
				JSON.stringify({ renders, svgs: byAttr(root, "data-graph").length }),
			);
		}

		// The threshold decision itself (pure, headless).
		check(
			"B8.7 the 4px threshold: 3px of jitter is a click, exactly 4px stays a click, 5px of travel is a drag, degenerate input never drags",
			canvasMod.DRAG_THRESHOLD_PX === 4 && canvasMod.isDragGesture({ x: 0, y: 0 }, { x: 3, y: 0 }) === false && canvasMod.isDragGesture({ x: 0, y: 0 }, { x: 4, y: 0 }) === false && canvasMod.isDragGesture({ x: 0, y: 0 }, { x: 5, y: 0 }) === true && canvasMod.isDragGesture(null, { x: 9, y: 9 }) === false,
			JSON.stringify({ threshold: canvasMod.DRAG_THRESHOLD_PX }),
		);
	}

	// -- B9 — round-1fix (a): rows follow the STRUCTURAL FAMILY, not id order -
	// The diagnosis (report-diag-canvas): computeLayout sorted rows by id inside
	// a column, so a task's workers scattered across the whole column and even
	// the structural contains edges crossed sibling boxes. The fix: a
	// deterministic DFS from the structural roots (children in id order), so a
	// task's workers sit in rows ADJACENT to their task's row.
	{
		const node = (kind: string, id: string, name: string) => ({ kind, id, name, depth: 0, status: "running", severity: "info", statusView: { shape: "dot", className: "status-running", pulse: true }, foreign: false, degraded: [], usage: null, elapsedLabel: null, progress: null });
		// Two tasks under one orchestrator; the worker ids deliberately INTERLEAVE
		// the two tasks in id order (w-1,w-3 belong to t-a; w-2,w-4 to t-b) — the
		// old id-sort produced the interleaved column this fix exists to kill.
		const state = {
			nodes: [node("session", "o", "orch"), node("task", "t-a", "task-a"), node("task", "t-b", "task-b"), node("session", "s:w-1", "w-1"), node("session", "s:w-2", "w-2"), node("session", "s:w-3", "w-3"), node("session", "s:w-4", "w-4")],
			edges: [
				{ kind: "owned_by", from: "t-a", to: "o" },
				{ kind: "owned_by", from: "t-b", to: "o" },
				{ kind: "contains", from: "t-a", to: "s:w-1" },
				{ kind: "contains", from: "t-a", to: "s:w-3" },
				{ kind: "contains", from: "t-b", to: "s:w-2" },
				{ kind: "contains", from: "t-b", to: "s:w-4" },
			],
			byId: new Map(),
			graph: { collapse: new Map<string, unknown>() },
		} as any;
		for (const n of state.nodes) state.byId.set(n.id, n);
		const layout = layoutMod.computeLayout(state, { expansion: [] });
		const row = (id: string): number => layout.positions[id].row;
		check(
			"B9.1 a task's workers occupy rows ADJACENT to each other AND to their task — the task's row IS its block's first row (no fleet interleaving inside a column)",
			row("t-a") === 0 && row("t-b") === 2 && row("s:w-1") === 0 && row("s:w-3") === 1 && row("s:w-2") === 2 && row("s:w-4") === 3 && row("t-a") === row("s:w-1") && row("t-b") === row("s:w-2"),
			JSON.stringify(layout.positions),
		);
		check(
			"B9.2 the pin BITES: the family order differs from the id order this fixture was built to defeat (w-2 is NOT between w-1 and w-3)",
			!(row("s:w-1") < row("s:w-2") && row("s:w-2") < row("s:w-3")),
			JSON.stringify({ w1: row("s:w-1"), w2: row("s:w-2"), w3: row("s:w-3") }),
		);
		// The regenerated golden (byte-exact): PAD 24, NODE 168x58, COL_GAP 56,
		// ROW_GAP 18 — global leaf slots in DFS family order, sorted by id inside
		// coordinateGolden (t-b sits at ITS block's first row, slot 2).
		check(
			"B9.3 the coordinateGolden golden (round-1fix bytes): leaf-slot family rows, deterministic",
			layoutMod.coordinateGolden(layout) === "o@24,24|s:w-1@472,24|s:w-2@472,176|s:w-3@472,100|s:w-4@472,252|t-a@248,24|t-b@248,176" && layoutMod.coordinateGolden(layout) === layoutMod.coordinateGolden(layoutMod.computeLayout(state, { expansion: [] })),
			layoutMod.coordinateGolden(layout),
		);
		check(
			"B9.4 the causal-edge filter never relayouts: the golden is byte-identical with showCausal on",
			layoutMod.coordinateGolden(layout) === layoutMod.coordinateGolden(layoutMod.computeLayout(state, { expansion: [], showCausal: true })),
		);
		check(
			"B9.5 each task's worker block is CONTIGUOUS in the shared worker column (no interleaving — the crossing fix)",
			["t-a", "t-b"].every((t) => {
				const rows = ["s:w-1", "s:w-2", "s:w-3", "s:w-4"].filter((w) => state.edges.some((e: any) => e.kind === "contains" && e.from === t && e.to === w)).map(row);
				return rows.every((r, i) => r === Math.min(...rows) + i);
			}),
			JSON.stringify(Object.fromEntries(["t-a", "t-b"].map((t) => [t, row(t)]))),
		);
		check(
			"B9.6 every contains edge is row-monotone (worker row ≥ task row, block order preserved) — near-horizontal, no upward back-edges",
			["s:w-1", "s:w-2", "s:w-3", "s:w-4"].every((w) => {
				const t = state.edges.find((e: any) => e.kind === "contains" && e.to === w).from;
				return row(w) >= row(t);
			}),
		);
	}

	// -- B10 — round-1fix (b): redundant spawned_by hidden, unembodied kept, --
	// -- the toolbar causal toggle re-shows all ------------------------------
	{
		// s:ghost has NO contains parent: its spawned_by is its only structural
		// tie (an unembodied worker session) and must SURVIVE the default filter.
		const state = productionShapedState();
		state.nodes.push({ kind: "session", id: "s:ghost", name: "ghost", depth: 0, status: "running", severity: "info", statusView: { shape: "dot", className: "status-running" }, foreign: false, degraded: [], usage: null, elapsedLabel: null, progress: null } as any);
		state.edges.push({ kind: "spawned_by", from: "s:ghost", to: "s:root" });
		state.byId.set("s:ghost", state.nodes[state.nodes.length - 1]);
		const def = layoutMod.computeLayout(state, { expansion: [] });
		const causal = (l: any) => l.edges.filter((e: any) => e.kind === "spawned_by").map((e: any) => `${e.from}->${e.to}`).sort();
		check(
			"B10.1 the default layout hides every REDUNDANT spawned_by (the structural chain contains+owned_by already reaches the same orchestrator) — only the unembodied ghost's survives",
			causal(def).join(",") === "s:ghost->s:root" && def.edges.length === 9,
			JSON.stringify(causal(def)),
		);
		check(
			"B10.2 an UNEMBODIED worker's spawned_by is KEPT by the default filter (its only structural tie)",
			causal(layoutMod.computeLayout(state, { expansion: [], showCausal: true })).join(",").includes("s:ghost->s:root") && layoutMod.visibleNodes(state, [], {}).edges.some((e: any) => e.kind === "spawned_by" && e.from === "s:ghost"),
			JSON.stringify(causal(layoutMod.computeLayout(state, { expansion: [], showCausal: true }))),
		);
		check(
			"B10.3 the toggle re-shows ALL causal edges (5 redundant + the unembodied one)",
			causal(layoutMod.computeLayout(state, { expansion: [], showCausal: true })).length === 6,
			JSON.stringify(causal(layoutMod.computeLayout(state, { expansion: [], showCausal: true }))),
		);
		// The UI state + reducer: showCausal defaults false; toggle-causal flips.
		const ui0 = uiMod.createUiState();
		const ui1 = uiMod.uiReducer(ui0, { type: "toggle-causal" });
		check(
			"B10.4 ui.showCausal defaults false and toggle-causal flips it (and back)",
			ui0.showCausal === false && ui1.showCausal === true && uiMod.uiReducer(ui1, { type: "toggle-causal" }).showCausal === false,
			JSON.stringify({ ui0: ui0.showCausal, ui1: ui1.showCausal }),
		);
		// The canvas toolbar: a causal toggle NEXT TO fit, aria-pressed honest,
		// clicking dispatches toggle-causal through the app seam.
		const doc = fakeDoc();
		const root = doc.createElement("div");
		const dispatchs: any[] = [];
		canvasMod.renderCanvas(state, def, root, doc, { dispatch: (a: any) => dispatchs.push(a), showCausal: false, view: { zoom: 1, panX: 0, panY: 0 }, viewport: () => ({ width: 900, height: 600 }), onView: () => {} });
		const causalBtn = byAttr(root, "data-canvas-causal")[0];
		causalBtn.dispatch("click");
		const root2 = doc.createElement("div");
		canvasMod.renderCanvas(state, def, root2, doc, { dispatch: () => {}, showCausal: true, view: { zoom: 1, panX: 0, panY: 0 }, viewport: () => ({ width: 900, height: 600 }), onView: () => {} });
		const pressedBtn = byAttr(root2, "data-canvas-causal")[0];
		check(
			"B10.5 the toolbar carries the causal toggle next to fit: unpressed by default, click dispatches toggle-causal, pressed when showCausal",
			causalBtn.attributes["aria-pressed"] === "false" && dispatchs.length === 1 && dispatchs[0].type === "toggle-causal" && byAttr(root, "data-canvas-fit").length === 1 && pressedBtn.attributes["aria-pressed"] === "true",
			JSON.stringify({ dispatchs, pressed: pressedBtn.attributes["aria-pressed"] }),
		);
		check("B10.6 canvas.css styles the causal toggle (the .canvas-causal rule exists with a pressed state)", /\.canvas-causal\s*\{/.test(readAsset("canvas.css")) && /\.canvas-causal\[aria-pressed="true"\]\s*\{/.test(readAsset("canvas.css")));
	}

	console.log(failures === 0 ? "\nALL DASHBOARD LAYOUT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
