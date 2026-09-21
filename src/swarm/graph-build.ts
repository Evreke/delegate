/**
 * pi-delegate — src/swarm/graph-build.ts — the SwarmGraph projection body.
 *
 * MODULE_CONTRACT — the accumulator-level half of the SwarmGraph projector
 * (issue #29, ARCHITECTURE §4.1.5 / Law 13). This module owns the manifest
 * projection, the journal projection, the live-status/usage attachment and
 * the node/edge assembly. It is a pure function of its injected inputs:
 * ZERO writes, deterministic, never throws (the public never-throws wrapper
 * lives in ./graph.ts; this body is total by construction).
 *
 * Law 5: split out of src/swarm/graph.ts so the public read-model facade
 * stays under the size threshold; the vocabulary lives in ./nodes.ts and
 * ./edges.ts. Public contract types are imported TYPE-ONLY from ./graph.ts
 * (erased at runtime — no module cycle).
 */

import { basename } from "node:path";
import { sessionRole, type SessionRole } from "../watch-role.ts";
import type { AgentStatus, AgentStatusName } from "../host.ts";
import type { ExchangeManifest, ManifestWorker } from "../manifest-store.ts";
import type { JournalEvent } from "./journal-read.ts";
import { projectJournal } from "./graph-journal.ts";
import {
	addDegraded,
	degraded,
	manifestRefFor,
	placementRefFor,
	roleLabel,
	sessionIdFor,
	sortDegraded,
	sortNodes,
	sortWorkerEmbodiments,
	type SwarmDegraded,
	type SwarmSessionNode,
	type SwarmTaskNode,
	type SwarmUsageSummary,
	type SwarmWorkerEmbodiment,
} from "./nodes.ts";
import {
	dedupeEdges,
	ORPHAN_DEGRADED_FLAG,
	sortEdges,
	sortOrphans,
	type SwarmEdge,
	type SwarmOrphan,
} from "./edges.ts";
import type { SwarmGraph, SwarmGraphDeps, SwarmGraphSources, SwarmRoleFn } from "./graph.ts";

// ---------------------------------------------------------------------------
// Internal accumulators
// ---------------------------------------------------------------------------

interface SessionAcc {
	id: string;
	sessionPath?: string;
	tasks: Set<string>;
	depths: number[];
	workerMeta?: { name: string; placementRef?: string };
}

interface TaskAcc {
	id: string;
	dir?: string;
	description?: string;
	workers: SwarmWorkerEmbodiment[];
}

function nonEmpty(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function manifestTaskName(m: ExchangeManifest): string {
	return nonEmpty(m.task) ?? basename(nonEmpty(m.dir) ?? "");
}

/** The parent session path of one manifest worker entry: its own
 *  orchestratorSessionPath, else the manifest's masterSessionPath. */
function parentSessionPath(m: ExchangeManifest, w: ManifestWorker): string | undefined {
	return nonEmpty(w.orchestratorSessionPath) ?? nonEmpty(m.masterSessionPath);
}

function safeRole(roleFn: SwarmRoleFn, path: string, manifests: ExchangeManifest[]): SessionRole {
	try {
		return roleFn({ sessionFile: path }, manifests, {});
	} catch {
		return { isWorker: false, ownsChildren: false };
	}
}

function normalizeUsage(u: SwarmUsageSummary): SwarmUsageSummary {
	const out: SwarmUsageSummary = {};
	if (typeof u.outputTokens === "number") out.outputTokens = u.outputTokens;
	if (u.contextPct !== undefined) out.contextPct = u.contextPct;
	return out;
}

// ---------------------------------------------------------------------------
// The projector body
// ---------------------------------------------------------------------------

/**
 * The pure projection body. Total: every dependency failure degrades the
 * graph (sources flags + per-node `degraded[]`), never throws; the public
 * never-throws wrapper (buildSwarmGraph) additionally catches internal
 * errors. `schemaVersion` is passed in so this module never reads a value
 * from ./graph.ts at eval time.
 */
export async function projectSwarmGraph(
	deps: SwarmGraphDeps,
	schemaVersion: number,
): Promise<SwarmGraph> {
	const roleFn: SwarmRoleFn = deps.sessionRole ?? sessionRole;

	// ---- inputs (each independently degraded) -----------------------------
	const sources: SwarmGraphSources = {
		journal: false,
		manifests: false,
		liveStatus: false,
		usage: typeof deps.usage === "function",
	};

	let manifests: ExchangeManifest[] = [];
	try {
		if (deps.manifests) {
			const backend = deps.transport?.backendName?.() ?? deps.backendName ?? "";
			manifests = (deps.manifests.scan(backend) ?? []).slice().sort((a, b) => {
				const at = manifestTaskName(a);
				const bt = manifestTaskName(b);
				if (at !== bt) return at < bt ? -1 : 1;
				const ad = nonEmpty(a.dir) ?? "";
				const bd = nonEmpty(b.dir) ?? "";
				return ad < bd ? -1 : ad > bd ? 1 : 0;
			});
			sources.manifests = true;
		}
	} catch {
		sources.manifests = false;
	}

	let events: JournalEvent[] = [];
	try {
		if (deps.journal) {
			events = (deps.journal.eventsAfter(0) ?? [])
				.slice()
				.sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1));
			sources.journal = true;
		}
	} catch {
		sources.journal = false;
	}

	let statuses: AgentStatus[] = [];
	try {
		if (deps.transport?.listStatuses) {
			statuses = (await deps.transport.listStatuses()) ?? [];
			sources.liveStatus = true;
		}
	} catch {
		sources.liveStatus = false;
	}
	statuses = statuses.slice().sort((a, b) => {
		if (a.name !== b.name) return a.name < b.name ? -1 : 1;
		const ap = a.placementRef ?? "";
		const bp = b.placementRef ?? "";
		return ap < bp ? -1 : ap > bp ? 1 : 0;
	});

	const liveByRef = new Map<string, AgentStatusName>();
	const liveByName = new Map<string, AgentStatusName>();
	for (const s of statuses) {
		const name = nonEmpty(s.name);
		if (name === undefined) continue;
		const ref = nonEmpty(s.placementRef);
		if (ref !== undefined) liveByRef.set(ref, s.status);
		liveByName.set(name, s.status);
	}

	// ---- accumulators -----------------------------------------------------
	const sessions = new Map<string, SessionAcc>();
	const tasks = new Map<string, TaskAcc>();
	const edges: SwarmEdge[] = [];
	const orphans: SwarmOrphan[] = [];
	const orphanTasks = new Set<string>();

	const ensureSession = (id: string, sessionPath?: string): SessionAcc => {
		let acc = sessions.get(id);
		if (!acc) {
			acc = { id, sessionPath, tasks: new Set(), depths: [] };
			sessions.set(id, acc);
		} else if (acc.sessionPath === undefined && sessionPath !== undefined) {
			acc.sessionPath = sessionPath;
		}
		return acc;
	};
	const ensureTask = (id: string, dir?: string, description?: string): TaskAcc => {
		let acc = tasks.get(id);
		if (!acc) {
			acc = { id, workers: [] };
			tasks.set(id, acc);
		}
		if (acc.dir === undefined && dir !== undefined) acc.dir = dir;
		if (acc.description === undefined && description !== undefined) acc.description = description;
		return acc;
	};

	// ---- manifest projection ----------------------------------------------
	for (const m of manifests) {
		const task = manifestTaskName(m);
		if (task.length === 0) continue;
		const taskAcc = ensureTask(task, nonEmpty(m.dir), nonEmpty(m.description));
		const masterPath = nonEmpty(m.masterSessionPath);
		if (masterPath !== undefined) ensureSession(sessionIdFor(masterPath), masterPath).tasks.add(task);

		for (const w of m.workers ?? []) {
			if (w === null || typeof w !== "object") continue;
			const name = nonEmpty(w.name);
			if (name === undefined) continue;
			const parentPath = parentSessionPath(m, w);
			const childPath = nonEmpty(w.sessionPath);
			const flags: SwarmDegraded[] = [];
			if (childPath === undefined) addDegraded(flags, degraded("no-session-path"));
			if (parentPath === undefined) {
				addDegraded(flags, degraded(ORPHAN_DEGRADED_FLAG));
				orphanTasks.add(task);
				const placementRef = placementRefFor(w);
				orphans.push({
					task,
					worker: name,
					run: typeof w.embodiment?.run === "number" ? w.embodiment.run : null,
					...(placementRef === undefined ? {} : { placementRef }),
					reason: "legacy-orphan",
				});
			}

			const childId = childPath === undefined ? undefined : sessionIdFor(childPath);
			const parentId = parentPath === undefined ? undefined : sessionIdFor(parentPath);
			if (childPath !== undefined) ensureSession(childId!, childPath).tasks.add(task);
			if (parentPath !== undefined) ensureSession(parentId!, parentPath).tasks.add(task);

			const embodiment: SwarmWorkerEmbodiment = {
				name,
				run: typeof w.embodiment?.run === "number" ? w.embodiment.run : null,
				...(placementRefFor(w) === undefined ? {} : { placementRef: placementRefFor(w) }),
				...(childId === undefined ? {} : { sessionId: childId }),
				...(childPath === undefined ? {} : { sessionPath: childPath }),
				...(typeof w.depth === "number" ? { depth: w.depth } : {}),
				...(nonEmpty(w.placement?.backend) === undefined ? {} : { backend: nonEmpty(w.placement?.backend) }),
				...(nonEmpty(w.startedAt) === undefined ? {} : { startedAt: nonEmpty(w.startedAt) }),
				...(nonEmpty(w.collectedAt) === undefined ? {} : { collectedAt: nonEmpty(w.collectedAt) }),
				...(nonEmpty(w.retiredAt) === undefined ? {} : { retiredAt: nonEmpty(w.retiredAt) }),
				manifestRef: manifestRefFor(task, w),
				degraded: sortDegraded(flags),
			};
			taskAcc.workers.push(embodiment);

			if (childId !== undefined && parentId !== undefined) {
				edges.push({ kind: "spawned_by", from: childId, to: parentId });
			}
			if (childId !== undefined && nonEmpty(w.collectedAt) !== undefined) {
				edges.push({ kind: "collected", from: childId, to: task, at: nonEmpty(w.collectedAt)! });
			}
			if (childId !== undefined && nonEmpty(w.retiredAt) !== undefined) {
				edges.push({ kind: "retired", from: childId, to: task, at: nonEmpty(w.retiredAt)! });
			}
			if (childId !== undefined) {
				const childAcc = ensureSession(childId, childPath);
				if (typeof w.depth === "number") childAcc.depths.push(w.depth);
				childAcc.workerMeta =
					placementRefFor(w) === undefined
						? { name }
						: { name, placementRef: placementRefFor(w) };
			}
		}

		const fleetOwner = masterPath ?? m.workers.map((w) => parentSessionPath(m, w)).find((p) => p !== undefined);
		if (fleetOwner !== undefined) {
			edges.push({ kind: "spawned_by", from: task, to: sessionIdFor(fleetOwner) });
		}
	}

	// ---- journal projection ------------------------------------------------
	const journal = projectJournal(events);
	for (const id of journal.tasks) ensureTask(id);
	for (const s of journal.sessions) {
		const acc = ensureSession(s.id, s.path);
		for (const t of s.tasks) acc.tasks.add(t);
	}
	for (const e of journal.edges) edges.push(e);

	// ---- live status on embodiments ---------------------------------------
	for (const t of tasks.values()) {
		for (const w of t.workers) {
			if (!sources.liveStatus) {
				addDegraded(w.degraded, degraded("no-live-status"));
				continue;
			}
			const st = (w.placementRef === undefined ? undefined : liveByRef.get(w.placementRef)) ?? liveByName.get(w.name);
			if (st !== undefined) w.liveStatus = st;
			else addDegraded(w.degraded, degraded("no-live-status"));
			w.degraded = sortDegraded(w.degraded);
		}
	}

	// ---- session nodes -----------------------------------------------------
	const sessionNodes: SwarmSessionNode[] = [];
	for (const acc of sessions.values()) {
		const flags: SwarmDegraded[] = [];
		const node: SwarmSessionNode = {
			kind: "session",
			id: acc.id,
			...(acc.sessionPath === undefined ? {} : { sessionPath: acc.sessionPath }),
			role: "unknown",
			isWorker: false,
			ownsChildren: false,
			tasks: [...acc.tasks].sort(),
			degraded: [],
		};
		if (acc.sessionPath === undefined) {
			addDegraded(flags, degraded("no-session-path"));
		} else {
			const role = safeRole(roleFn, acc.sessionPath, manifests);
			node.role = roleLabel(role);
			node.isWorker = role.isWorker;
			node.ownsChildren = role.ownsChildren;
		}
		const worker = acc.workerMeta;
		if (worker !== undefined) {
			if (acc.depths.length > 0) node.depth = Math.min(...acc.depths);
			if (!sources.liveStatus) {
				addDegraded(flags, degraded("no-live-status"));
			} else {
				const st =
					(worker.placementRef === undefined ? undefined : liveByRef.get(worker.placementRef)) ??
					liveByName.get(worker.name);
				if (st !== undefined) node.liveStatus = st;
				else addDegraded(flags, degraded("no-live-status"));
			}
			if (acc.sessionPath !== undefined) {
				if (typeof deps.usage !== "function") {
					addDegraded(flags, degraded("usage-unavailable"));
				} else {
					let usage: SwarmUsageSummary | null = null;
					try {
						usage = deps.usage(acc.sessionPath);
					} catch {
						usage = null;
					}
					if (usage === null) addDegraded(flags, degraded("usage-unavailable"));
					else node.usage = normalizeUsage(usage);
				}
			}
		}
		node.degraded = sortDegraded(flags);
		sessionNodes.push(node);
	}

	// ---- task nodes --------------------------------------------------------
	const taskNodes: SwarmTaskNode[] = [];
	for (const acc of tasks.values()) {
		const flags: SwarmDegraded[] = [];
		const workers = sortWorkerEmbodiments(acc.workers);
		const node: SwarmTaskNode = {
			kind: "task",
			id: acc.id,
			...(acc.dir === undefined ? {} : { dir: acc.dir }),
			...(acc.description === undefined ? {} : { description: acc.description }),
			workers,
			degraded: [],
		};
		const depths = workers.map((w) => w.depth).filter((d): d is number => typeof d === "number");
		if (depths.length > 0) node.depth = Math.min(...depths);
		if (orphanTasks.has(acc.id)) addDegraded(flags, degraded(ORPHAN_DEGRADED_FLAG));
		if (workers.some((w) => w.sessionPath === undefined)) addDegraded(flags, degraded("no-session-path"));
		if (workers.length > 0 && typeof deps.usage !== "function") addDegraded(flags, degraded("usage-unavailable"));
		if (!sources.manifests && workers.length === 0) addDegraded(flags, degraded("legacy-orphan"));
		node.degraded = sortDegraded(flags);
		taskNodes.push(node);
	}

	return {
		schemaVersion,
		sources,
		nodes: sortNodes([...sessionNodes, ...taskNodes]),
		edges: sortEdges(dedupeEdges(edges)),
		orphans: sortOrphans(orphans),
	};
}