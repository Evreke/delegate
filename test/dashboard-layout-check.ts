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
 * removal of the dead `ui.toggled` field.
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
 * The #80 production shape: a root orchestrator, two sub-orchestrators, their
 * workers and two task nodes — every node `depth: 0`, hierarchy only as edges.
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
	];
	const edges = [
		{ kind: "spawned_by", from: "t:root", to: "s:root" },
		{ kind: "spawned_by", from: "s:lead-a", to: "s:root" },
		{ kind: "spawned_by", from: "s:lead-b", to: "s:root" },
		{ kind: "spawned_by", from: "t:lead-a", to: "s:lead-a" },
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

	// -- B1 — #80: columns come from BFS over spawned_by, never node.depth ---
	{
		const state = productionShapedState();
		const layout = layoutMod.computeLayout(state, { expansion: [] });
		const col = (id: string): number | undefined => layout.positions[id]?.col;
		check(
			"B1.1 a production-shaped fixture (every node depth 0) still forms depth columns from spawned_by edges",
			col("s:root") === 0 && col("s:lead-a") === 1 && col("s:lead-b") === 1 && col("t:root") === 1 && col("s:a1") === 2 && col("s:a2") === 2 && col("s:b1") === 2 && col("t:lead-a") === 2,
			JSON.stringify(layout.positions),
		);
		check(
			"B1.2 not one strip: the fixture spans at least three distinct columns (the pre-#80 depth trust put all at 0)",
			new Set(Object.values(layout.positions).map((p: any) => p.col)).size >= 3,
			JSON.stringify([...new Set(Object.values(layout.positions).map((p: any) => p.col))]),
		);
		check(
			"B1.3 every spawned_by edge steps exactly one column (child = parent + 1)",
			state.edges.every((e) => layout.positions[e.from].col === layout.positions[e.to].col + 1),
			JSON.stringify(state.edges.map((e) => `${e.from}:${layout.positions[e.from].col}->${e.to}:${layout.positions[e.to].col}`)),
		);
		check(
			"B1.4 node.depth stays a decorative attribute (the fixture nodes still carry depth 0)",
			state.nodes.every((n) => n.depth === 0),
		);
		const again = layoutMod.computeLayout(state, { expansion: [] });
		check("B1.5 the BFS layout is deterministic (byte-identical golden on two calls)", layoutMod.coordinateGolden(layout) === layoutMod.coordinateGolden(again));

		// A cycle is not a root: it must not loop forever and stays deterministic.
		const cyclic = productionShapedState();
		cyclic.edges.push({ kind: "spawned_by", from: "s:root", to: "s:b1" });
		const cyc = layoutMod.computeLayout(cyclic, { expansion: [] });
		check("B1.6 a pure cycle terminates and stays deterministic", layoutMod.coordinateGolden(cyc) === layoutMod.coordinateGolden(layoutMod.computeLayout(cyclic, { expansion: [] })));

		// The same heuristic on the REAL graph shape: all depth 0, edges only.
		const depths = layoutMod.resolveDepths(state);
		check("B1.7 resolveDepths is exported, pure and edge-derived", depths.get("s:root") === 0 && depths.get("s:lead-a") === 1 && depths.get("s:a1") === 2);
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

	console.log(failures === 0 ? "\nALL DASHBOARD LAYOUT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
