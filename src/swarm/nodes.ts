/**
 * pi-delegate — src/swarm/nodes.ts — SwarmGraph node vocabulary + builders.
 *
 * MODULE_CONTRACT — node half of the SwarmGraph projector (issue #29,
 * ARCHITECTURE §4.1.5 / Law 13). This module owns the graph's NODE types
 * (sessions + tasks), the SessionId convention, the degradation vocabulary
 * and the deterministic sorters. It performs NO I/O and reads NO store: the
 * projection lives in ./graph.ts; edges/orphans live in ./edges.ts.
 *
 * SessionId (binding, §4.1.2): the stable hash of the session JSONL path
 * under the SAME FNV-1a convention as the watcher satellite key
 * (`watcherKeyFor`, src/watch-store.ts — stable per session, unique across
 * sessions, readable in a dir listing without leaking the path). The path
 * itself is an ATTRIBUTE (`sessionPath`), never the id. `sessionIdFor` is
 * byte-compatible with `watcherKeyFor` and the check pins that parity; it is
 * reproduced here (a ~10-line pure function) instead of importing the
 * watcher's durable store, because the read-model's dependency budget is
 * journal + manifest + transport (Law 13/§4.1.5) and watch-store is neither.
 *
 * The four degradation flags are the closed per-node vocabulary the issue
 * names: `no-session-path`, `no-live-status`, `legacy-orphan`,
 * `usage-unavailable`. Degradation is data on the node — a degraded graph is
 * a VALID graph (never-throws, advisory by contract, Law 8).
 *
 * Dependencies: ../watch-role.ts (the canonical SessionRole TYPE only — the
 * verdict itself is computed by the injected `sessionRole` in ./graph.ts),
 * ../host.ts and ../manifest-store.ts (types only). Never throws.
 */

import type { SessionRole } from "../watch-role.ts";
import type { AgentStatusName } from "../host.ts";
import type { ManifestWorker } from "../manifest-store.ts";

// ---------------------------------------------------------------------------
// SessionId
// ---------------------------------------------------------------------------

/**
 * The SwarmGraph SessionId: a stable FNV-1a 32-bit hex hash of a session
 * JSONL path (the watcherKey convention).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: sessionPath — the session's JSONL path (may be absent/garbage)
 * Output: the 8-char lowercase hex hash; the literal "anon" when no path
 * Guarantees:
 *   - deterministic and stable per path; different paths practically never
 *     collide; the path is never embedded in the id
 *   - byte-compatible with watch-store.ts `watcherKeyFor` (parity pinned by
 *     test/swarm-graph-check.ts, G7)
 * Raises: never
 */
export function sessionIdFor(sessionPath: string | undefined | null): string {
	if (!sessionPath) return "anon";
	let hash = 0x811c9dc5;
	for (let i = 0; i < sessionPath.length; i++) {
		hash ^= sessionPath.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Degradation vocabulary (the issue's closed set)
// ---------------------------------------------------------------------------

export type SwarmDegradedFlag =
	| "no-session-path"
	| "no-live-status"
	| "legacy-orphan"
	| "usage-unavailable";

export interface SwarmDegraded {
	flag: SwarmDegradedFlag;
	detail?: string;
}

/** Build one degradation entry (omits `detail` when absent — key shape is
 *  part of the deterministic serialization). */
export function degraded(flag: SwarmDegradedFlag, detail?: string): SwarmDegraded {
	return detail === undefined ? { flag } : { flag, detail };
}

/** Append a degradation entry unless an identical one is already present.
 *  Mutates `list` (builders own their accumulators); never throws. */
export function addDegraded(list: SwarmDegraded[], entry: SwarmDegraded): void {
	if (!list.some((d) => d.flag === entry.flag && d.detail === entry.detail)) list.push(entry);
}

/** Sort a degradation list deterministically (flag, then detail). */
export function sortDegraded(list: SwarmDegraded[]): SwarmDegraded[] {
	return [...list].sort((a, b) => {
		if (a.flag !== b.flag) return a.flag < b.flag ? -1 : 1;
		return (a.detail ?? "") < (b.detail ?? "") ? -1 : (a.detail ?? "") > (b.detail ?? "") ? 1 : 0;
	});
}

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** Role label derived from the canonical `sessionRole` verdict (graph.ts). */
export type SwarmSessionRole = "orchestrator" | "worker" | "worker-orchestrator" | "unknown";

/** One SESSION node: a pi session that participates in the fleet — an
 *  orchestrator, a worker, or a worker-orchestrator (tier-1 lead). */
export interface SwarmSessionNode {
	kind: "session";
	/** SessionId — the stable hash, never the raw path. */
	id: string;
	/** The session JSONL path as an attribute (absent → `no-session-path`). */
	sessionPath?: string;
	role: SwarmSessionRole;
	/** Canonical `sessionRole` verdict (watch-role.ts), recomputed here — the
	 *  graph never reimplements the role table. */
	isWorker: boolean;
	ownsChildren: boolean;
	/** Task ids this session participates in (as spawner or worker). Sorted. */
	tasks: string[];
	/** Manifest `depth` of the embodiment(s) mapped to this session, when
	 *  known (issue #28 — feeds level display). */
	depth?: number;
	/** Live transport status, when the transport reported one. */
	liveStatus?: AgentStatusName;
	/** Optional usage summary (injected usage resolver). */
	usage?: SwarmUsageSummary;
	degraded: SwarmDegraded[];
}

/** One TASK node: an exchange task (the fleet container). */
export interface SwarmTaskNode {
	kind: "task";
	/** Task name (the exchange task dir name). */
	id: string;
	/** Exchange dir, when a manifest named it. */
	dir?: string;
	/** Human fleet description from the manifest, when present. */
	description?: string;
	/** Every worker embodiment recorded for this task (same-name retries =
	 *  multiple embodiments). Sorted by (name, run, placementRef). */
	workers: SwarmWorkerEmbodiment[];
	/** Min known `depth` among the task's embodiments (issue #28). */
	depth?: number;
	degraded: SwarmDegraded[];
}

export type SwarmGraphNode = SwarmSessionNode | SwarmTaskNode;

/** One worker embodiment — one manifest entry. The `embodiment` field makes
 *  two same-name retries distinguishable; `manifestRef` is the reference
 *  back into the source manifest. */
export interface SwarmWorkerEmbodiment {
	name: string;
	/** `embodiment.run` (run ordinal); null on legacy entries (absent field). */
	run: number | null;
	placementRef?: string;
	/** SessionId of THIS embodiment's own session (absent → `no-session-path`). */
	sessionId?: string;
	sessionPath?: string;
	/** Manifest `depth` (issue #28); undefined on legacy entries. */
	depth?: number;
	backend?: string;
	startedAt?: string;
	collectedAt?: string;
	retiredAt?: string;
	/** Live transport status matched to this embodiment. */
	liveStatus?: AgentStatusName;
	manifestRef: SwarmManifestRef;
	degraded: SwarmDegraded[];
}

/** The reference back into the source manifest for one embodiment. */
export interface SwarmManifestRef {
	task: string;
	worker: string;
	run: number | null;
	placementRef?: string;
}

/** The injected usage resolver's summary shape (kept narrow — usage.ts owns
 *  the parsing; the projector only consumes a summary). */
export interface SwarmUsageSummary {
	outputTokens?: number;
	contextPct?: number | null;
}

// ---------------------------------------------------------------------------
// Builders + deterministic sorters
// ---------------------------------------------------------------------------

/** The canonical role label for a `sessionRole` verdict. Pure. */
export function roleLabel(role: SessionRole): SwarmSessionRole {
	if (role.isWorker && role.ownsChildren) return "worker-orchestrator";
	if (role.isWorker) return "worker";
	if (role.ownsChildren) return "orchestrator";
	return "unknown";
}

/** The placement handle of a manifest worker: the embodiment ref first (the
 *  in-task identity), then the legacy `placement.placementRef`, then the
 *  legacy pane id. Pure. */
export function placementRefFor(worker: ManifestWorker): string | undefined {
	const ref = worker.embodiment?.placementRef;
	if (typeof ref === "string" && ref.length > 0) return ref;
	const manifestRef = worker.placement?.placementRef;
	if (typeof manifestRef === "string" && manifestRef.length > 0) return manifestRef;
	const pane = worker.placement?.paneId;
	return typeof pane === "string" && pane.length > 0 ? pane : undefined;
}

/** The manifest reference for one worker entry — two same-name retries get
 *  distinct refs via the embodiment's run ordinal/placementRef. Pure. */
export function manifestRefFor(task: string, worker: ManifestWorker): SwarmManifestRef {
	const run = typeof worker.embodiment?.run === "number" ? worker.embodiment.run : null;
	const placementRef = placementRefFor(worker);
	return placementRef === undefined
		? { task, worker: worker.name, run }
		: { task, worker: worker.name, run, placementRef };
}

/** Deterministic node order: kind, then id. */
export function sortNodes(nodes: SwarmGraphNode[]): SwarmGraphNode[] {
	return [...nodes].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

/** Deterministic embodiment order: name, run (null first), placementRef. */
export function sortWorkerEmbodiments(list: SwarmWorkerEmbodiment[]): SwarmWorkerEmbodiment[] {
	return [...list].sort((a, b) => {
		if (a.name !== b.name) return a.name < b.name ? -1 : 1;
		const ar = a.run ?? -1;
		const br = b.run ?? -1;
		if (ar !== br) return ar - br;
		const ap = a.placementRef ?? "";
		const bp = b.placementRef ?? "";
		return ap < bp ? -1 : ap > bp ? 1 : 0;
	});
}