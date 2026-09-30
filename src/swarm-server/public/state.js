/**
 * state.js — the v1 dashboard read-model fold (issue #66, dashboard shell).
 *
 * `foldJournal(events)` and `buildDashboardState(input)` are PURE projections
 * from the two wire contracts the dashboard consumes (the SwarmGraph snapshot
 * and the journal event rows) into ONE screen model:
 *
 *   - nodes    — the graph nodes enriched with a resolved status (ask / dead /
 *                live / collected / retired / unknown; benign non-worker `idle`,
 *                #133 role-aware), severity, progress, usage, elapsed, ownership;
 *   - rail     — fleets grouped by owning session (own first, foreign marked), each
 *                with its TaskNodes, done/total counters and severity-first workers;
 *   - attention— chips + a severity-ordered queue, aggregated over OWN fleets
 *                ONLY (a foreign fleet never raises attention);
 *   - graph    — the canvas input: deterministic depth columns, `spawned_by`
 *                edges, adaptive collapse decisions for all-terminal leads
 *                (UI state only — an expansion set never leaves the client).
 *
 * Nothing is invented: a signal the wire does not carry is ABSENT (an honest
 * `null`), never a fabricated healthy value. Degradation flags are carried
 * verbatim and always rendered. No DOM, no framework; total and pure.
 */

import { degradeViews, severityFor, worstSeverity, severityRank } from "./degrade.js";
import { isTerminalStatus, liveStatusToName, statusSeverity, statusView } from "./status.js";
import { foldJournal, humanizeDuration } from "./journal.js";
import { computeCollapse } from "./layout.js";
import { buildAttention } from "./attention-model.js";

function tsOf(value) {
	if (typeof value !== "string") return null;
	const t = Date.parse(value);
	return Number.isFinite(t) ? t : null;
}

/** Index the graph's worker embodiments by sessionId (first deterministic hit). */
function embodimentIndex(graph) {
	const index = new Map();
	for (const node of graph.nodes ?? []) {
		if (node.kind !== "task") continue;
		for (const w of node.workers ?? []) {
			if (typeof w.sessionId !== "string" || index.has(w.sessionId)) continue;
			// #87: `dir` is the task's exchange dir — a worker's brief/report fetch key.
			index.set(w.sessionId, { task: node.id, dir: node.dir ?? null, worker: w });
		}
	}
	return index;
}

/** First spawned_by parent per node id (the graph's own convention). */
function parentIndex(graph) {
	const parents = new Map();
	for (const e of graph.edges ?? []) {
		if (!e || e.kind !== "spawned_by" || parents.has(e.from)) continue;
		parents.set(e.from, e.to);
	}
	return parents;
}

/**
 * The fleet-root ancestry: spawned_by (worker → orchestrator session) PLUS
 * owned_by (task → owner session, #136). Parentage stays spawned_by-only
 * (parentIndex — the causal chain), but the foreign/own verdict must climb
 * BOTH: a task reaches its owner session only through the authority edge, and
 * dropping it made every task's journal row read as foreign.
 */
function ancestryIndex(graph) {
	const ancestry = new Map();
	for (const e of graph.edges ?? []) {
		if (!e || (e.kind !== "spawned_by" && e.kind !== "owned_by") || ancestry.has(e.from)) continue;
		ancestry.set(e.from, e.to);
	}
	return ancestry;
}

/** Walk to the root ancestor (cycle-safe). */
export function rootOf(id, parents) {
	let cur = id;
	const seen = new Set([id]);
	for (;;) {
		const next = parents.get(cur);
		if (next === undefined || seen.has(next)) return cur;
		seen.add(next);
		cur = next;
	}
}

function ownedBy(input, sessionPath, rootId) {
	// #81: the serving identity (ownSessionId preferred) is the authority; a console refusal still outranks the path heuristics.
	const ownId = input.ownSessionId && typeof input.ownSessionId === "string" ? input.ownSessionId : null;
	const ownPath = input.ownSessionPath && typeof input.ownSessionPath === "string" ? input.ownSessionPath : null;
	if (input.foreignSessionIds && input.foreignSessionIds.has(rootId)) return true;
	if ((ownId && rootId === ownId) || (ownPath && sessionPath === ownPath)) return false;
	return Boolean(ownId || ownPath);
}

function resolveStatus({ node, worker, journal, degradedFlags }) {
	const workerName = worker?.name;
	const ask = workerName ? journal.asks.get(workerName) : null;
	if (ask) return "ask";
	if (workerName && journal.dead.has(workerName)) return "dead";
	// Durable stamps beat advisory live status: a collect/retire row is a fact,
	// a transport reading is a hint (and may lag a just-finished worker).
	if (worker?.retiredAt) return "retired";
	if (worker?.collectedAt) return "collected";
	if (node.liveStatus) {
		const mapped = liveStatusToName(node.liveStatus);
		if (mapped !== "unknown") return mapped;
	}
	// #133 role-aware: a worker (or a no-live-status flag) stays honest `unknown`; a NON-worker root is benign `idle`.
	return degradedFlags.includes("no-live-status") || worker || node.isWorker === true ? "unknown" : "idle";
}

/**
 * #136 root label: a NON-WORKER root session is named by its ROLE — an opaque
 * session-id hash is not a name a human can read on the canvas. The raw id
 * stays reachable via `data-graph-node` / the node `id`. Actual worker
 * sessions are NEVER relabeled here (their worker name is theirs; this map is
 * only consulted for an `isWorker:false && ownsChildren:true` root).
 */
const ROOT_ROLE_LABELS = Object.freeze({ orchestrator: "orchestrator" });

function buildSessionNode(node, ctx) {
	const worker = ctx.embodiments.get(node.id)?.worker ?? null;
	const degradedFlags = (node.degraded ?? []).map((d) => d.flag);
	const status = resolveStatus({ node, worker, journal: ctx.journal, degradedFlags });
	const workerName = worker?.name ?? null;
	const startedAt = tsOf(worker?.startedAt);
	const elapsedMs = startedAt === null || ctx.nowMs === null ? null : Math.max(0, ctx.nowMs - startedAt);
	const progress = workerName ? ctx.journal.progress.get(workerName) ?? null : null;
	const ask = workerName ? ctx.journal.asks.get(workerName) ?? null : null;
	const severity = worstSeverity([statusSeverity(status), ...degradedFlags.map(severityFor)]);
	const contextPct = node.usage && typeof node.usage.contextPct === "number" ? node.usage.contextPct : null;
	const isWorker = node.isWorker === true;
	const ownsChildren = node.ownsChildren === true;
	return {
		id: node.id,
		kind: "session",
		// #136: the non-worker root renders by ROLE; every other session keeps
		// its id (the canvas node carries the raw id either way).
		name: !isWorker && ownsChildren ? ROOT_ROLE_LABELS[node.role] ?? node.id : node.id,
		worker: workerName,
		task: ctx.embodiments.get(node.id)?.task ?? (node.tasks ?? [])[0] ?? null, dir: ctx.embodiments.get(node.id)?.dir ?? null,
		// #139: the spawn's resolved model identity, projected from THIS
		// session's worker embodiment (honest null when no embodiment or a
		// legacy manifest without the field).
		model: worker?.model ?? null,
		provider: worker?.provider ?? null,
		thinking: worker?.thinking ?? null,
		role: node.role,
		isWorker,
		ownsChildren,
		depth: typeof node.depth === "number" ? node.depth : null,
		sessionPath: node.sessionPath ?? null,
		status,
		statusView: statusView(status),
		severity,
		degraded: degradeViews(degradedFlags),
		usage: {
			contextPct,
			outputTokens: node.usage && typeof node.usage.outputTokens === "number" ? node.usage.outputTokens : null,
			available: Boolean(node.usage) && !degradedFlags.includes("usage-unavailable"),
		},
		elapsedMs,
		elapsedLabel: elapsedMs === null ? null : humanizeDuration(elapsedMs),
		progress,
		progressLabel: progress ? progressLabelOf(progress) : null,
		ask,
		foreign: ctx.foreign(node),
		parentId: ctx.parents.get(node.id) ?? null,
		childIds: (ctx.children.get(node.id) ?? []).slice(),
		workers: [],
	};
}

function progressLabelOf(progress) {
	if (!progress) return null;
	const pct = progress.pct === null ? "" : ` ${progress.pct}%`;
	return `${progress.phase}${pct}`.trim() || null;
}

function buildTaskNode(node, ctx) {
	const workers = (node.workers ?? []).map((w) => {
		const degradedFlags = (w.degraded ?? []).map((d) => d.flag);
		const status = resolveStatus({ node: w, worker: w, journal: ctx.journal, degradedFlags });
		const startedAt = tsOf(w.startedAt);
		const elapsedMs = startedAt === null || ctx.nowMs === null ? null : Math.max(0, ctx.nowMs - startedAt);
		const progress = w.name ? ctx.journal.progress.get(w.name) ?? null : null;
		return {
			// #85a: a stable id + kind so a worker row is never an anonymous subject.
			id: `${node.id}/${w.name ?? "worker"}`, kind: "worker", name: w.name, run: w.run ?? null,
			sessionId: w.sessionId ?? null, task: node.id, dir: node.dir ?? null, role: null, depth: typeof node.depth === "number" ? node.depth : null,
			// #139: the embodiment's resolved model identity (honest null on a
			// legacy manifest entry without the fields).
			model: w.model ?? null,
			provider: w.provider ?? null,
			thinking: w.thinking ?? null,
			liveStatus: w.liveStatus ?? null,
			status,
			statusView: statusView(status),
			severity: worstSeverity([statusSeverity(status), ...degradedFlags.map(severityFor)]),
			degraded: degradeViews(degradedFlags),
			elapsedMs,
			elapsedLabel: elapsedMs === null ? null : humanizeDuration(elapsedMs),
			progress,
			progressLabel: progressLabelOf(progress),
			ask: w.name ? ctx.journal.asks.get(w.name) ?? null : null,
			usage: {
				contextPct: null,
				outputTokens: null,
				available: false,
			},
			foreign: ctx.foreign(node),
			parentId: node.id,
			childIds: [],
		};
	}).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.ask ? 1 : 0) - (a.ask ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // rail-ux F6: severity desc, ask first, then name — one stable sort
	const total = workers.length;
	const done = workers.filter((w) => isTerminalStatus(w.status)).length;
	const openAsk = workers.find((w) => w.ask) ?? null;
	const worst = workers.reduce((acc, w) => (severityRank(w.severity) > severityRank(acc) ? w.severity : acc), "clear");
	const status = workers.some((w) => w.status === "dead")
		? "dead"
		: openAsk
			? "ask"
			: total > 0 && done === total
				? "collected"
				: workers.some((w) => w.status === "running")
					? "running"
					: worst === "clear"
						? "unknown"
						: "idle";
	const degradedFlags = (node.degraded ?? []).map((d) => d.flag);
	return {
		id: node.id,
		kind: "task",
		name: node.id,
		worker: null, dir: node.dir ?? null,
		depth: typeof node.depth === "number" ? node.depth : null,
		status,
		statusView: statusView(status),
		severity: worstSeverity([statusSeverity(status), worst, ...degradedFlags.map(severityFor)]),
		degraded: degradeViews(degradedFlags),
		usage: { contextPct: null, outputTokens: null, available: false },
		elapsedMs: null,
		elapsedLabel: null,
		progress: null,
		progressLabel: null,
		ask: openAsk ? openAsk.ask : null,
		foreign: ctx.foreign(node),
		parentId: ctx.parents.get(node.id) ?? null,
		childIds: (ctx.children.get(node.id) ?? []).slice(),
		workers,
		counters: { done, total },
	};
}

/**
 * Build the one-screen dashboard model.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: input — { graph, events, ownSessionPath?, ownSessionId?,
 *   foreignSessionIds?, expansion?, nowMs? }
 * Output: { available, sources, nodes, byId, rail, attention, graph }
 * Guarantees:
 *   - total: malformed/absent graph or events yield an empty, valid model;
 *   - deterministic: identical inputs give a byte-equal model (stable sorts);
 *   - attention aggregates over OWN fleets ONLY — a foreign fleet raises none;
 *   - collapse is UI state (`expansion`); it never mutates the graph.
 * Raises: never
 */
export function buildDashboardState(input = {}) {
	const graph = input.graph && typeof input.graph === "object" ? input.graph : {};
	const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
	const edges = Array.isArray(graph.edges) ? graph.edges : [];
	const parents = parentIndex(graph);
	const ancestry = ancestryIndex(graph);
	const children = new Map();
	for (const [from, to] of parents) {
		if (!children.has(to)) children.set(to, []);
		children.get(to).push(from);
	}
	for (const list of children.values()) list.sort();
	const embodiments = embodimentIndex(graph);
	const byIdRaw = new Map(nodes.map((n) => [n.id, n]));
	const nowMs = typeof input.nowMs === "number" ? input.nowMs : null;
	/** Is this node id outside this session's fleets? (console refusals mark a
	 *  whole branch foreign; otherwise the root session's path decides.) The
	 *  climb follows the fleet ancestry (spawned_by + owned_by, #136). */
	const isForeignId = (id) => {
		if (input.foreignSessionIds && input.foreignSessionIds.size > 0) {
			let cur = id;
			const seen = new Set([cur]);
			for (;;) {
				if (input.foreignSessionIds.has(cur)) return true;
				const next = ancestry.get(cur);
				if (next === undefined || seen.has(next)) break;
				seen.add(next);
				cur = next;
			}
		}
		const rootId = rootOf(id, ancestry);
		const root = byIdRaw.get(rootId);
		return ownedBy(input, root && root.sessionPath, rootId);
	};
	const foreign = (node) => isForeignId(node.id);
	// The journal is SHARED across fleets: a foreign fleet's `ask` / `dead-reboot`
	// / `progress` row names a worker that may collide with an own worker name,
	// so the fold is scoped by each row's own `task` — the same task-set filter
	// the per-fleet HTTP/stream surface applies server-side (#66 box 2: foreign
	// fleets never raise attention). A row whose `task` is absent or unknown to
	// the graph stays: it cannot be attributed, and dropping it would be silent
	// data loss.
	const ownEvents = (Array.isArray(input.events) ? input.events : []).filter((e) => {
		const task = e && typeof e.task === "string" ? e.task : null;
		return task === null || !byIdRaw.has(task) || !isForeignId(task);
	});
	const journal = foldJournal(ownEvents);
	const ctx = { journal, parents, children, embodiments, foreign, nowMs };
	const enriched = nodes.map((n) => (n.kind === "task" ? buildTaskNode(n, ctx) : buildSessionNode(n, ctx)));
	const byId = new Map(enriched.map((n) => [n.id, n]));
	for (const n of enriched) n.childIds = (children.get(n.id) ?? []).filter((id) => byId.has(id));
	const sorted = [...enriched].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const rail = buildRail(enriched, taskOwnership(graph), byId);
	const attention = buildAttention(sorted, journal, input.expansion);
	const collapse = computeCollapse(enriched, children, byId, journal);
	return {
		available: graph.available !== false,
		sources: graph.sources ?? { journal: false, manifests: false, liveStatus: false, usage: false },
		nodes: sorted,
		byId,
		edges: edges.slice(),
		rail,
		attention,
		graph: {
			nodes: sorted,
			edges: edges.slice(),
			collapse,
			// #92: app.js hands in the UI's Set (an array stays valid for old callers).
			expansion: new Set(input.expansion instanceof Set ? input.expansion : Array.isArray(input.expansion) ? input.expansion : []),
		},
	};
}

/** Group fleet owners (rail): own first, then foreign; each with its TaskNodes. */
/**
 * Task ownership per owner session (#136): `owned_by` (task → owner session)
 * is the AUTHORITY edge — the rail groups a fleet's tasks under the session
 * that owns them. The old shape read this off spawned_by children (the
 * conflation #136 removed); ownership is not causal lineage.
 */
function taskOwnership(graph) {
	const owned = new Map();
	for (const e of graph.edges ?? []) {
		if (!e || e.kind !== "owned_by" || typeof e.to !== "string") continue;
		if (!owned.has(e.to)) owned.set(e.to, []);
		owned.get(e.to).push(e.from);
	}
	for (const list of owned.values()) list.sort();
	return owned;
}

function buildRail(nodes, ownedTasks, byId) {
	const owners = new Set();
	for (const n of nodes) {
		if (n.kind !== "session") continue;
		const ownsTask = (ownedTasks.get(n.id) ?? []).length > 0;
		const isRoot = n.parentId === null;
		if (ownsTask || isRoot) owners.add(n.id);
	}
	const groups = [...owners]
		.map((id) => {
			const session = byId.get(id);
			const fleets = (ownedTasks.get(id) ?? [])
				.map((taskId) => byId.get(taskId))
				.filter((child) => child && child.kind === "task");
			return { session, fleets, foreign: session.foreign };
		})
		.sort((a, b) => {
			if (a.foreign !== b.foreign) return a.foreign ? 1 : -1;
			return a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0;
		});
	const own = groups.filter((g) => !g.foreign);
	const foreign = groups.filter((g) => g.foreign);
	return { groups, own, foreign, taskCount: groups.reduce((n, g) => n + g.fleets.length, 0) };
}

/** The attention queue's spotlight consumer contract (center module input). */
export function spotlightIdsFor(item) {
	return new Set(Array.isArray(item?.focusIds) ? item.focusIds : item?.nodeId ? [item.nodeId] : []);
}
