/**
 * fleet-scope.js — the per-fleet serving scope (issue #66 scope §7, the #65
 * per-fleet URL contract).
 *
 * MODULE_CONTRACT — the ONE client-side spelling of "which fleet is this page
 * and which graph nodes are its own". The dashboard is served BOTH at the
 * root (`/`, the v1 unscoped view) and at `/fleets/<sessionId>/` (#65's
 * per-fleet URLs); this module turns the serving path into the read base and
 * narrows every graph the app folds to the fleet's own `spawned_by` subtree.
 *
 * Snapshot scoping is CLIENT-side by construction, not by omission: the
 * snapshot envelope is the `swarm snapshot` CLI envelope VERBATIM (protocol
 * identity, ARCHITECTURE §4.2.2) and the scoped WS snapshot frame is a
 * byte-exact golden (`test/swarm-http-goldens.ts` F8.1) — neither may carry a
 * filtered graph, so there is no per-fleet snapshot contract to route to and
 * none is invented. The events/stream reads ARE scoped by the server (#65);
 * the graph is scoped here, from the read-model's OWN `spawned_by` structure,
 * so the view has exactly one source of truth (the graph) and never a second.
 *
 * Critical invariants:
 *   - a null/absent fleet id (the root view) returns the graph IDENTITY — the
 *     v1 unscoped behavior stays untouched;
 *   - the fleet root is the SESSION node whose id is the URL's id segment; its
 *     fleet is that node plus every descendant over `spawned_by` edges
 *     (cycle-safe), so a foreign fleet's tree can never render;
 *   - total: malformed input degrades to the unscoped/graph result, never
 *     throws (Law 8).
 */

/**
 * The serving identity from a `GET /api/swarm/fleets` envelope (issue #81):
 * `body.self` is the single source of truth (`sessionId` / `sessionPath`); the
 * `env` seam is the test/embedded fallback. Pure.
 * <p>
 * FUNCTION_CONTRACT: Input — body (the fleets envelope), env ({ ownSessionId?,
 *   ownSessionPath? }). Output — { sessionId, sessionPath } (nulls when
 *   unknown). Guarantees: never throws on malformed input.
 */
export function servingIdentity(body, env = {}) {
	const self = body && typeof body === "object" && body.self && typeof body.self === "object" ? body.self : {};
	const pick = (v) => (typeof v === "string" && v.length > 0 ? v : null);
	return {
		sessionId: pick(self.sessionId) ?? pick(env.ownSessionId),
		sessionPath: pick(self.sessionPath) ?? pick(env.ownSessionPath),
	};
}

/**
 * The per-fleet serving path shape (`/fleets/<id>`, with or without slash).
 */
const FLEET_PATH_RE = /^\/fleets\/([^/]+)(?:\/|$)/;

/**
 * The serving scope of a page location.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: location — a window.location-like seam ({pathname, protocol, host})
 * Output: { fleetId, base } — the decoded fleet session id and the URL base
 *   prefix for scoped reads; `{ fleetId: null, base: "" }` on the root view
 * Guarantees: pure; `/fleets/<id>/`, `/fleets/<id>` and `/fleets/<id>/...`
 *   all resolve to the same scope; an undecodable id stays raw; never throws
 * Raises: never
 */
export function servingScope(location) {
	const pathname = location && typeof location.pathname === "string" ? location.pathname : "";
	const match = FLEET_PATH_RE.exec(pathname);
	if (match === null) return { fleetId: null, base: "" };
	let fleetId = match[1];
	try {
		fleetId = decodeURIComponent(fleetId);
	} catch {
		/* an undecodable id stays raw — the graph lookup simply misses */
	}
	return { fleetId, base: `/fleets/${match[1]}` };
}

/**
 * Prefix one root-relative read path with the serving base.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: base — "" (root view) or `/fleets/<id>`; path — a root-relative path
 * Output: the scoped path (`${base}${path}`) or the path unchanged at root
 * Guarantees: pure; never throws
 * Raises: never
 */
export function scopedUrl(base, path) {
	return typeof base === "string" && base.length > 0 ? `${base}${path}` : path;
}

/**
 * The WS URL for the current page origin — fleet-scoped under `/fleets/<id>/`.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: location — a window.location-like seam ({protocol, host, pathname})
 * Output: the `ws:`/`wss:` stream URL for the page's serving base
 * Guarantees: pure; the root view yields the v1 `/api/swarm/stream` URL;
 *   never throws
 * Raises: never
 */
export function streamUrlFor(location) {
	const proto = location && location.protocol === "https:" ? "wss:" : "ws:";
	const host = location ? location.host : "127.0.0.1:7331";
	return `${proto}//${host}${scopedUrl(servingScope(location).base, "/api/swarm/stream")}`;
}

/**
 * Narrow a SwarmGraph to one fleet's own subtree.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: graph — a SwarmGraph snapshot; rootId — the fleet's session node id
 *   (null/undefined = the root view)
 * Output: the same graph object when unscoped, else a copy carrying ONLY the
 *   root's descendants over `spawned_by` edges (child = `from`, parent = `to`),
 *   the edges between kept nodes and the orphans whose task is kept
 * Guarantees: pure; cycle-safe; a foreign fleet's nodes/edges/orphans are
 *   absent from the result; never throws
 * Raises: never
 */
export function scopeGraphToFleet(graph, rootId) {
	if (!rootId || !graph || !Array.isArray(graph.nodes)) return graph;
	const children = new Map();
	for (const edge of graph.edges ?? []) {
		if (!edge || edge.kind !== "spawned_by") continue;
		if (!children.has(edge.to)) children.set(edge.to, []);
		children.get(edge.to).push(edge.from);
	}
	const ids = new Set();
	const pending = [rootId];
	while (pending.length > 0) {
		const id = pending.pop();
		if (ids.has(id)) continue;
		ids.add(id);
		for (const child of children.get(id) ?? []) pending.push(child);
	}
	const nodes = graph.nodes.filter((n) => n && ids.has(n.id));
	const edges = (graph.edges ?? []).filter((e) => e && ids.has(e.from) && ids.has(e.to));
	const orphans = (graph.orphans ?? []).filter((o) => o && ids.has(o.task));
	return { ...graph, nodes, edges, orphans };
}

/**
 * Build the scope chrome view (issue #82): the brand text, the document title,
 * the shell's `data-fleet-id` key and the switcher entries that make the two
 * scopes reachable from each other.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: { fleetId, fleets } — the serving scope (null = the root view) and the
 *   `GET /api/swarm/fleets` rows ({sessionId, own, tasks})
 * Output: { fleetId, key, brandText, title, entries, show }
 * Guarantees: pure; the root view is `key: "all"` / `"all fleets"`; a scoped
 *   view always leads with the `all fleets` link back to `/`; fleet entries
 *   are own-first then id-sorted and never include the scope's own fleet;
 *   malformed rows are dropped; never throws
 * Raises: never
 */
export function chromeScope({ fleetId = null, fleets = [] } = {}) {
	const current = typeof fleetId === "string" && fleetId.length > 0 ? fleetId : null;
	const fleetEntries = (Array.isArray(fleets) ? fleets : [])
		.filter((f) => f && typeof f.sessionId === "string" && f.sessionId !== current)
		.map((f) => ({ href: `/fleets/${encodeURIComponent(f.sessionId)}/`, label: f.sessionId, own: f.own === true, current: false }))
		.sort((a, b) => (a.own === b.own ? (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) : a.own ? -1 : 1));
	const entries = current ? [{ href: "/", label: "all fleets", own: false, current: false }, ...fleetEntries] : fleetEntries;
	return {
		fleetId: current,
		key: current ?? "all",
		brandText: current ?? "all fleets",
		title: current ? `fleet ${current} \u2014 pi-delegate dashboard` : "pi-delegate \u2014 fleet dashboard",
		entries,
		show: current !== null || fleetEntries.length > 1,
	};
}
