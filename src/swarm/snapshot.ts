/**
 * pi-delegate — src/swarm/snapshot.ts — the `swarm snapshot` orchestrator-side
 * read verb (issue #30, ARCHITECTURE §4.1.1/Law 13: the read-model's client
 * surface).
 *
 * MODULE_CONTRACT — the whole-graph half of the read API: serialize the
 * SwarmGraph (./graph.ts buildSwarmGraph — the canonical read-model) to
 * stdout with the real dependencies injected: the journal reader
 * (./journal-read.ts) and the ManifestStore of the CONFIGURED storage mode
 * (§4.1.3). PURE READ, ZERO WRITES: no journal event is appended, no
 * manifest.json projection is written, and no database is created or
 * migrated — in journal mode the manifest scan goes through the READ-ONLY
 * journal replay (scanManifestsViaJournalReader), never the store
 * constructor (whose writer open creates/migrates events.db).
 *
 * Stdout payload — the success envelope (./result.ts) carrying the frozen v1
 * snapshot contract: { ok, verb: "snapshot", snapshot: SwarmGraph }, where
 * snapshot is the graph's own Law 7 wire form (schemaVersion stamped inside
 * it by ./graph.ts — SWARM_GRAPH_SCHEMA_VERSION; the nested bytes are exactly
 * serializeSwarmGraph's output).
 *
 * Identity: NONE required — an orchestrator-side read, no SWARM_TASK/
 * SWARM_WORKER gate (§4.1.1; the #30 issue's decision). Stray positionals
 * still fail E_SWARM_USAGE (./cli.ts dispatch).
 *
 * Live status / usage are structurally unavailable to the CLI (a separate
 * bun process has no Transport handle, and the usage resolver is
 * extension-side): the graph marks those sources false and degrades the
 * affected nodes with flags (no-live-status / usage-unavailable) — degraded
 * fields, never a failure (Law 13; the same surface test/swarm-graph-check
 * G5/G8 pins at the projector level).
 *
 * Dependencies: ../profile.ts (loadDelegateConfig — the ONE config read),
 * ../manifest-store.ts (createFileManifestStore — the files-mode production
 * store), ./journal-manifest-store.ts (scanManifestsViaJournalReader),
 * ./journal-read.ts, ./graph.ts, ./storage.ts, ./result.ts. No herdr import
 * (Law 4); no sqlite driver import (the journal family owns that seam); no
 * write path anywhere under the verb.
 *
 * Critical invariants:
 *   - never fails on data: buildSwarmGraph never throws, so any degraded
 *     source yields a valid (possibly empty) graph with available:true, or
 *     the fully-degraded fallback graph (available:false) — exit 0 either way
 *     unless the failure is a usage failure (Law 8);
 *   - exactly one JSON object on stdout;
 *   - the reader is closed on every path (finally);
 *   - the manifest scan backend name mirrors index.ts's resolveConfiguredHost
 *     tolerant leg (missing/corrupt config → "herdr"); an UNKNOWN host value
 *     degrades to "herdr" instead of throwing E_START — this is a read
 *     surface, not a session-start gate (Law 8: a read verb never crashes).
 */

import { loadDelegateConfig } from "../profile.ts";
import { createFileManifestStore } from "../manifest-store.ts";
import { buildSwarmGraph, type SwarmManifestStore } from "./graph.ts";
import { scanManifestsViaJournalReader } from "./journal-manifest-store.ts";
import { createJournalReader, type JournalReader } from "./journal-read.ts";
import { emitSuccess } from "./result.ts";
import { resolveSwarmStorage, swarmSessionIdFor, type SwarmStorageConfig } from "./storage.ts";

/**
 * The active-backend name for the manifest scan's foreign-backend filter
 * (migration stage 3: no module scans with an implicit backend). Tolerant
 * mirror of index.ts resolveConfiguredHost — see MODULE_CONTRACT.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: none (reads the merged config — EXTERNAL_DEPENDENCY: profile.ts)
 * Output: "herdr" or "rpc"
 * Guarantees: missing/corrupt/unknown config → "herdr"; never throws
 * Raises: never
 */
function activeBackendName(): string {
	try {
		const host = (loadDelegateConfig() as { host?: unknown }).host;
		if (host === "herdr" || host === "rpc") return host;
	} catch {
		// tolerant: no/corrupt config reads as the default backend
	}
	return "herdr";
}

/**
 * The manifest source for the snapshot, per storage mode — always a PURE
 * READ: files mode binds the production file store (scan is read-only);
 * journal mode replays through the read-only journal scan (never the store
 * constructor, whose writer open would create/migrate the database).
 */
function manifestSource(journal: JournalReader, cfg: SwarmStorageConfig, backendName: string): SwarmManifestStore {
	if (cfg.storage !== "journal") return createFileManifestStore();
	return {
		scan: (backend: string) =>
			scanManifestsViaJournalReader(journal, (dir) => swarmSessionIdFor(dir, cfg), backend),
	};
}

/**
 * Run `swarm snapshot`: build the SwarmGraph over the real read-only inputs
 * and emit it. Total on the data side (Law 8) — see MODULE_CONTRACT.
 */
export async function runSnapshot(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const cfg = resolveSwarmStorage(env);
	const backendName = activeBackendName();
	const journal = createJournalReader({ dbPath: cfg.dbPath });
	try {
		const graph = await buildSwarmGraph({
			journal,
			manifests: manifestSource(journal, cfg, backendName),
			backendName,
		});
		emitSuccess("snapshot", { snapshot: graph });
	} finally {
		journal.close();
	}
}
