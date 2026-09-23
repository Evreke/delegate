/**
 * tree.js — the fleet-tree view model + DOM renderer (issue #53).
 *
 * `buildTreeView(graph)` is a PURE projection from the SwarmGraph wire shape
 * (src/swarm/graph.ts) to a render tree: every graph node appears exactly once
 * (rooted by the `spawned_by` edges — from = spawned entity, to = parent
 * session), worker embodiments hang off their task node, and the graph's edges
 * and orphans are carried through verbatim. Nothing is invented: a field the
 * graph does not carry (e.g. provider/model today) is simply absent from the
 * view, never a placeholder.
 *
 * `renderTree(view, root, doc)` turns the view into DOM via a minimal
 * document-like seam (`doc`) so the same renderer runs in a browser and under
 * the headless check's fake document. No innerHTML, no framework.
 */

import { degradeViews } from "./degrade.js";

/** Deterministic node order (kind, then id — mirrors the graph's sortNodes). */
function byKindId(a, b) {
	if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function workerView(worker) {
	return {
		name: worker.name,
		run: worker.run,
		placementRef: worker.placementRef,
		sessionId: worker.sessionId,
		sessionPath: worker.sessionPath,
		depth: worker.depth,
		backend: worker.backend,
		startedAt: worker.startedAt,
		collectedAt: worker.collectedAt,
		retiredAt: worker.retiredAt,
		liveStatus: worker.liveStatus,
		manifestRef: worker.manifestRef,
		degraded: (worker.degraded || []).map((d) => d.flag),
	};
}

/**
 * Project a SwarmGraph into a render tree.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: graph — a SwarmGraph wire object (or null/garbage → an empty view)
 * Output: { available, sources, roots, nodes, edges, orphans, nodeCount }
 * Guarantees:
 *   - total: never throws on malformed input;
 *   - every graph node id appears exactly once in the flattened view;
 *   - parent = the target of a `spawned_by` edge whose source is that node
 *     (deterministic: the first such target in the graph's edge order);
 *   - cycles are broken (a node already placed is never re-parented);
 *   - edges/orphans carried verbatim.
 * Raises: never
 */
export function buildTreeView(graph) {
	const g = graph && typeof graph === "object" ? graph : {};
	const nodes = Array.isArray(g.nodes) ? g.nodes.slice() : [];
	const edges = Array.isArray(g.edges) ? g.edges.slice() : [];
	const orphans = Array.isArray(g.orphans) ? g.orphans.slice() : [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const parentOf = new Map();
	const childrenOf = new Map();
	for (const e of edges) {
		if (!e || e.kind !== "spawned_by") continue;
		if (!byId.has(e.from) || !byId.has(e.to)) continue;
		if (!parentOf.has(e.from)) parentOf.set(e.from, e.to);
	}
	for (const n of nodes) {
		const parent = parentOf.get(n.id);
		if (parent === undefined || parent === n.id) continue;
		if (!childrenOf.has(parent)) childrenOf.set(parent, []);
		childrenOf.get(parent).push(n.id);
	}
	for (const list of childrenOf.values()) list.sort();

	const viewOf = (n) => ({
		id: n.id,
		kind: n.kind,
		role: n.role,
		depth: n.depth,
		liveStatus: n.liveStatus,
		sessionPath: n.sessionPath,
		usage: n.usage,
		description: n.description,
		dir: n.dir,
		isWorker: n.isWorker,
		ownsChildren: n.ownsChildren,
		tasks: n.tasks,
		degraded: (n.degraded || []).map((d) => d.flag),
		workers: (n.workers || []).map(workerView),
		orphans: orphans.filter((o) => o.task === n.id),
		parentId: parentOf.get(n.id),
		children: [],
	});

	const views = new Map();
	for (const n of nodes) views.set(n.id, viewOf(n));
	const placed = new Set();
	const attach = (id, parentId, out) => {
		if (placed.has(id)) return;
		placed.add(id);
		const v = views.get(id);
		if (parentId !== undefined) v.parentId = parentId;
		out.push(v);
		for (const childId of childrenOf.get(id) || []) attach(childId, id, v.children);
	};
	const roots = [];
	for (const n of nodes.slice().sort(byKindId)) {
		const parent = parentOf.get(n.id);
		if (parent === undefined || !views.has(parent)) attach(n.id, undefined, roots);
	}
	// Any node left unplaced (e.g. a spawned child of an unplaced cycle head)
	// still renders at the root.
	for (const n of nodes.slice().sort(byKindId)) attach(n.id, undefined, roots);
	roots.sort(byKindId);

	const flat = [];
	const collect = (list) => {
		for (const v of list) {
			flat.push(v);
			collect(v.children);
		}
	};
	collect(roots);

	return {
		available: g.available !== false,
		sources: g.sources,
		roots,
		edges,
		orphans,
		nodeCount: nodes.length,
		nodes: flat,
	};
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

function el(doc, tag, attrs, text) {
	const node = doc.createElement(tag);
	if (attrs) {
		for (const key of Object.keys(attrs)) {
			if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, String(attrs[key]));
		}
	}
	if (text !== undefined) node.appendChild(doc.createTextNode(String(text)));
	return node;
}

function appendFields(doc, parent, fields) {
	for (const [label, value] of fields) {
		if (value === undefined || value === null || value === "") continue;
		parent.appendChild(el(doc, "span", { class: "field", "data-field": label }, `${label}: ${value}`));
	}
}

function renderBadges(doc, parent, degraded) {
	for (const badge of degradeViews(degraded)) {
		parent.appendChild(el(doc, "span", { class: badge.className, "data-degraded-flag": badge.flag }, badge.flag));
	}
}

function renderWorkers(doc, parent, node) {
	if (node.workers.length === 0) return;
	const list = el(doc, "ul", { class: "workers", "data-workers-for": node.id });
	for (const w of node.workers) {
		const item = el(doc, "li", {
			class: "worker",
			"data-worker": w.name,
			"data-task": node.id,
			"data-worker-name": w.name,
			"data-worker-run": w.run === null ? "null" : w.run,
			"data-placement-ref": w.placementRef,
			"data-session-id": w.sessionId,
			"data-live-status": w.liveStatus,
			"data-worker-status": w.liveStatus || (w.retiredAt ? "retired" : w.collectedAt ? "collected" : "unknown"),
		});
		item.appendChild(el(doc, "span", { class: "worker-name" }, w.name));
		appendFields(doc, item, [
			["run", w.run],
			["status", w.liveStatus],
			["backend", w.backend],
			["placement", w.placementRef],
			["depth", w.depth],
			["started", w.startedAt],
			["collected", w.collectedAt],
			["retired", w.retiredAt],
		]);
		renderBadges(doc, item, w.degraded);
		list.appendChild(item);
	}
	parent.appendChild(list);
}

function renderOrphans(doc, parent, orphans) {
	if (orphans.length === 0) return;
	const list = el(doc, "ul", { class: "orphans" });
	for (const o of orphans) {
		list.appendChild(el(doc, "li", { class: "orphan", "data-orphan-worker": o.worker, "data-orphan-task": o.task }, `orphan: ${o.worker}`));
	}
	parent.appendChild(list);
}

function renderNode(doc, node) {
	const kindClass = node.kind === "session" ? "node-session" : "node-task";
	const item = el(doc, "li", {
		class: `node ${kindClass}`,
		"data-node-id": node.id,
		"data-node-kind": node.kind,
		"data-role": node.role,
		"data-depth": node.depth,
		"data-parent-id": node.parentId,
	});
	const header = el(doc, "div", { class: "node-header" });
	header.appendChild(el(doc, "span", { class: "node-kind" }, node.kind));
	header.appendChild(el(doc, "span", { class: "node-id" }, node.id));
	if (node.role) header.appendChild(el(doc, "span", { class: "role role-" + node.role, "data-role-label": node.role }, node.role));
	if (node.depth !== undefined) header.appendChild(el(doc, "span", { class: "depth" }, `depth ${node.depth}`));
	item.appendChild(header);
	appendFields(doc, item, [
		["status", node.liveStatus],
		["session", node.sessionPath],
		["tokens", node.usage && node.usage.outputTokens],
		["context%", node.usage && node.usage.contextPct],
		["description", node.description],
	]);
	renderBadges(doc, item, node.degraded);
	renderWorkers(doc, item, node);
	renderOrphans(doc, item, node.orphans);
	if (node.children.length > 0) {
		const childList = el(doc, "ul", { class: "children" });
		for (const child of node.children) childList.appendChild(renderNode(doc, child));
		item.appendChild(childList);
	}
	return item;
}

/**
 * Render a view tree into `root` (the renderer clears it first).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: view — a buildTreeView result; root — the container element; doc —
 *   a document-like seam ({createElement, createTextNode})
 * Output: none (root is mutated)
 * Guarantees: no innerHTML; edges rendered once each in a dedicated list;
 *   every view node rendered exactly once; deterministic order
 * Raises: never on a well-formed view
 */
export function renderTree(view, root, doc) {
	while (root.firstChild) root.removeChild(root.firstChild);
	if (!view || !Array.isArray(view.roots)) return;
	const edgeList = el(doc, "ul", { class: "edges", "data-edges": String((view.edges || []).length) });
	for (const e of view.edges || []) {
		edgeList.appendChild(
			el(doc, "li", { class: "edge", "data-edge": "1", "data-edge-kind": e.kind, "data-edge-from": e.from, "data-edge-to": e.to, "data-edge-at": e.at }),
		);
	}
	root.appendChild(edgeList);
	const list = el(doc, "ul", { class: "tree", "data-node-count": String(view.nodeCount) });
	for (const node of view.roots) list.appendChild(renderNode(doc, node));
	root.appendChild(list);
}