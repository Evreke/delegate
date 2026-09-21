/**
 * pi-delegate — src/swarm/graph.ts — the SwarmGraph projector facade (issue #29).
 *
 * MODULE_CONTRACT — the canonical read-model (ARCHITECTURE §4.1.5 / Law 13).
 * `buildSwarmGraph(deps)` is a PURE PROJECTION: every input is injected (the
 * journal reader, the ManifestStore port, the canonical `sessionRole`, an
 * optional Transport for live status, an optional usage resolver), it performs
 * ZERO writes, is DETERMINISTIC on identical inputs (all arrays sorted by
 * stable keys), and NEVER throws — a missing/failing input degrades the graph
 * (per-node `degraded[]` + the `sources` block) instead of failing it.
 * Advisory by contract (Law 8): the pipeline never depends on the read-model.
 *
 * This module owns the PUBLIC contract (types, version, serialization) and the
 * never-throws wrapper; the projection body lives in ./graph-build.ts, the
 * node vocabulary in ./nodes.ts and the edge vocabulary in ./edges.ts (Law 5
 * split — every family file stays under the size threshold). The journal is
 * the system of record (§4.1.2); the manifest store and the live transport are
 * the current-state inputs. This module never scans the exchange directory and
 * never imports a durable store other than the ManifestStore port. Session
 * roles are computed by the canonical `sessionRole` from src/watch-role.ts —
 * reused, never reimplemented.
 *
 * The serialized JSON is versioned (`schemaVersion`, Law 7) and pinned by the
 * byte-equality assertion in test/swarm-graph-check.ts (Law 10).
 */

import type { ManifestLike, SessionIdentity, SessionRole } from "../watch-role.ts";
import type { Transport } from "../host.ts";
import type { ManifestStore } from "../manifest-store.ts";
import type { JournalReader } from "./journal-read.ts";
import type { SwarmGraphNode, SwarmUsageSummary } from "./nodes.ts";
import type { SwarmEdge, SwarmOrphan } from "./edges.ts";
import { projectSwarmGraph } from "./graph-build.ts";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The read-model's serialized-JSON contract version (Law 7; additive-only). */
export const SWARM_GRAPH_SCHEMA_VERSION = 1;

/** Which inputs were available to the projection. `false` means the
 *  corresponding input was absent or threw; the graph is still valid. */
export interface SwarmGraphSources {
	journal: boolean;
	manifests: boolean;
	liveStatus: boolean;
	usage: boolean;
}

export interface SwarmGraph {
	schemaVersion: number;
	sources: SwarmGraphSources;
	nodes: SwarmGraphNode[];
	edges: SwarmEdge[];
	orphans: SwarmOrphan[];
}

/** The injected usage resolver: a narrow summary per worker session path (or
 *  null when the session cannot be counted). Never throws by contract; the
 *  projector tolerates a throw anyway. */
export type SwarmUsageSource = (sessionPath: string) => SwarmUsageSummary | null;

/** The canonical role-verdict signature (src/watch-role.ts sessionRole) —
 *  injected so tests can spy/stub it, defaulted to the canon. */
export type SwarmRoleFn = (
	self: SessionIdentity,
	manifests: ReadonlyArray<ManifestLike | null | undefined>,
	opts?: { platform?: NodeJS.Platform },
) => SessionRole;

/** The journal reader seam (src/swarm/journal-read.ts), narrowed to the read
 *  the projection needs. */
export type SwarmJournalReader = Pick<JournalReader, "eventsAfter">;

/** The manifest store seam (src/manifest-store.ts). */
export type SwarmManifestStore = Pick<ManifestStore, "scan">;

/** The live-status transport seam (src/host.ts), narrowed to the list read. */
export type SwarmLiveTransport = Pick<Transport, "listStatuses"> & {
	backendName?(): string;
};

export interface SwarmGraphDeps {
	journal?: SwarmJournalReader;
	manifests?: SwarmManifestStore;
	/** Defaults to the canonical `sessionRole` from src/watch-role.ts. */
	sessionRole?: SwarmRoleFn;
	transport?: SwarmLiveTransport;
	usage?: SwarmUsageSource;
	/** Active backend name for the manifest scan when no transport is bound. */
	backendName?: string;
}

// ---------------------------------------------------------------------------
// The projector
// ---------------------------------------------------------------------------

/**
 * Build the SwarmGraph from injected read-only dependencies.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — journal reader, manifest store, canonical sessionRole,
 *   optional transport (live status) and usage resolver
 * Output: a deterministic, never-throwing SwarmGraph
 * Guarantees:
 *   - zero writes: every dependency is a reader; nothing is persisted
 *   - deterministic: two calls over identical inputs serialize byte-equal
 *     (nodes/edges/orphans/workers sorted by stable keys)
 *   - never throws: any dependency failure flips its `sources` flag and
 *     degrades the graph; a catastrophic internal error yields an empty but
 *     valid graph
 * Raises: never (all failures are data)
 */
export async function buildSwarmGraph(deps: SwarmGraphDeps): Promise<SwarmGraph> {
	try {
		return await projectSwarmGraph(deps ?? {}, SWARM_GRAPH_SCHEMA_VERSION);
	} catch {
		return emptyGraph();
	}
}

/** Serialize a graph to its canonical byte representation (the Law 7 wire
 *  form). Arrays are already canonically ordered by the projector; the
 *  key order is the construction order, fixed by ./graph-build.ts. */
export function serializeSwarmGraph(graph: SwarmGraph): string {
	return JSON.stringify(graph);
}

/** A valid, fully-degraded graph (the never-throws fallback). */
export function emptyGraph(): SwarmGraph {
	return {
		schemaVersion: SWARM_GRAPH_SCHEMA_VERSION,
		sources: { journal: false, manifests: false, liveStatus: false, usage: false },
		nodes: [],
		edges: [],
		orphans: [],
	};
}