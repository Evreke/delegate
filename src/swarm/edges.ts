/**
 * pi-delegate — src/swarm/edges.ts — SwarmGraph edges + orphan basket.
 *
 * MODULE_CONTRACT — edge half of the SwarmGraph projector (issue #29,
 * ARCHITECTURE §4.1.5 / Law 13). Owns the v1 edge vocabulary, the orphan
 * record and the deterministic dedup/sort helpers. NO I/O, never throws.
 *
 * Edge direction convention (binding for every producer, so two producers
 * cannot disagree): an edge points FROM the derived/subject entity TO its
 * owner or container.
 *   - `spawned_by`: from = the spawned entity (a worker SESSION whose own
 *     sessionPath is known, or the TASK whose fleet was spawned) → to = the
 *     spawning orchestrator SESSION.
 *   - `collected`: from = the worker SESSION → to = the owning TASK (the
 *     `collectedAt` stamp source).
 *   - `retired`: from = the worker SESSION → to = the owning TASK (the
 *     `retiredAt` stamp source).
 * Mailbox edges are v2 and deliberately absent here.
 *
 * Orphans: a legacy manifest worker entry with NO resolvable parent (neither
 * its own `orchestratorSessionPath` nor the manifest's `masterSessionPath`).
 * The orphan is data in the `orphans` basket, not a graph node; its task node
 * still exists and carries `legacy-orphan`.
 */

import type { SwarmDegradedFlag } from "./nodes.ts";

export type SwarmEdgeKind = "spawned_by" | "collected" | "retired";

/** The closed v1 edge set (additive-only; mailbox edges are v2). */
export const SWARM_EDGE_KINDS = ["spawned_by", "collected", "retired"] as const;

export interface SwarmEdge {
	kind: SwarmEdgeKind;
	/** Source node id (SessionId or task id). */
	from: string;
	/** Target node id (SessionId or task id). */
	to: string;
	/** ISO 8601 event time when the edge's fact carries one (collect/retire
	 *  stamps; journal event ts). Absent for structural `spawned_by` edges. */
	at?: string;
}

/** The orphan reason token (the issue's "legacy entries without a resolvable
 *  parent" — a manifest-only concept; journal-only nodes never carry it). */
export const ORPHAN_REASON = "legacy-orphan" as const;

/** One legacy entry without a resolvable parent. */
export interface SwarmOrphan {
	task: string;
	worker: string;
	run: number | null;
	placementRef?: string;
	reason: typeof ORPHAN_REASON;
}

/** Stable dedup key for one edge (the `at` is part of the identity: a worker
 *  can be collected once per stamp, never merged away). */
export function edgeKey(e: SwarmEdge): string {
	return `${e.kind}\u0000${e.from}\u0000${e.to}\u0000${e.at ?? ""}`;
}

/** Deduplicate edges by their identity key, preserving input order. */
export function dedupeEdges(edges: SwarmEdge[]): SwarmEdge[] {
	const seen = new Set<string>();
	const out: SwarmEdge[] = [];
	for (const e of edges) {
		const key = edgeKey(e);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return out;
}

/** Deterministic edge order: kind, from, to, at. */
export function sortEdges(edges: SwarmEdge[]): SwarmEdge[] {
	return [...edges].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
		if (a.from !== b.from) return a.from < b.from ? -1 : 1;
		if (a.to !== b.to) return a.to < b.to ? -1 : 1;
		const aa = a.at ?? "";
		const ba = b.at ?? "";
		return aa < ba ? -1 : aa > ba ? 1 : 0;
	});
}

/** Deterministic orphan order: task, worker, run (null first), placementRef. */
export function sortOrphans(orphans: SwarmOrphan[]): SwarmOrphan[] {
	return [...orphans].sort((a, b) => {
		if (a.task !== b.task) return a.task < b.task ? -1 : 1;
		if (a.worker !== b.worker) return a.worker < b.worker ? -1 : 1;
		const ar = a.run ?? -1;
		const br = b.run ?? -1;
		if (ar !== br) return ar - br;
		const ap = a.placementRef ?? "";
		const bp = b.placementRef ?? "";
		return ap < bp ? -1 : ap > bp ? 1 : 0;
	});
}

/** The degradation flag an orphan contributes to its task node. */
export const ORPHAN_DEGRADED_FLAG: SwarmDegradedFlag = "legacy-orphan";
