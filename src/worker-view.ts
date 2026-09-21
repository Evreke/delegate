/**
 * pi-delegate — worker view aggregation (the single shared read-model).
 * <p>
 * MODULE_CONTRACT: merges durable on-disk manifests with live transport
 * statuses into WorkerView records, and reads the manifest extras the
 * delegate_status tool surfaces beyond WorkerView. This is the ONE read-model
 * consumed by the status tool and the /delegate-teardown command — the single
 * source of truth for "what does the fleet look like right now".
 * Strictly READ-ONLY: manifest scans, satellite-stamp merges, report-file
 * existence probes and the read-only transport.listStatuses() — no mutating
 * call, no mailbox write. Moved verbatim out of the old fleet.ts SECTION 5/5
 * (originally observe.ts) and SECTION 4's manifest-extras reader; the move
 * keeps the observe→fleet edge one-way (view-building is view code).
 * Dependencies: ./host.ts (the Transport seam + Placement/AgentStatusName
 * types), manifest-store.ts (manifestStore), watch-store.ts (the watcher
 * satellite stamp layers), fs-probe.ts (tolerant report-exists probe). It
 * imports no presentation module (no ui-text rendering, no commands) — it
 * sits BELOW them in the layering.
 * Exported surface: WorkerView, buildWorkerView, ManifestExtras,
 * readManifestExtras.
 * Owned invariants (moved verbatim):
 *   - buildWorkerView never throws for an unreachable transport — statuses
 *     degrade to "unknown"; a worker appears once per (dir,name).
 *   - readManifestExtras is tolerant: missing/corrupt manifest, absent worker
 *     or wrong-typed field degrades to {} / omitted field, never throws.
 *   - retire/collect stamps are read by merging the manifest layer with every
 *     watcher satellite layer (earliest stamp wins) — one shared reader.
 * Error modes: none thrown to callers — all fs/transport failures degrade.
 */

import { manifestStore } from "./manifest-store.ts";
import { fileExists } from "./fs-probe.ts";
import { mergeRetireStamps, readWatchStampLayers } from "./watch-store.ts";
import type { AgentStatusName, Placement, Transport } from "./host.ts";

// ---------------------------------------------------------------------------
// Manifest extras: sessionPath + per-call budgetTokens live in the on-disk
// manifest but are not projected onto WorkerView — read them tolerantly.
// ---------------------------------------------------------------------------

export interface ManifestExtras {
	sessionPath?: string;
	budgetTokens?: number;
	briefPath?: string;
	model?: string;
	/** Owner session JSONL path (v1.11.1+) — absent on legacy manifests. */
	orchestratorSessionPath?: string;
	/** Watcher stage A: the manifest-level fleet owner (F1) — feeds the
	 *  canonical display mapping so a known-foreign master renders foreign. */
	masterSessionPath?: string;
	/** ISO 8601 collect stamp (v1.12.1) — drives the folded group's stale
	 *  age tail (§22.3). */
	collectedAt?: string;
}

/**
 * Read the manifest extras the overlay needs beyond WorkerView.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: exchange task dir containing manifest.json
 *   - name: worker name to find in manifest.workers
 * Output: ManifestExtras — only fields present AND of the expected type are
 *   projected; every field optional
 * Guarantees:
 *   - tolerant: missing/corrupt manifest, missing worker, wrong-typed field →
 *     {} or field omitted; NEVER throws
 *   - read-only
 * Raises: none
 * Wave 2 (Law 9): this is the ONE manifest-extras reader — the ambient widget
 * (the former buildWidgetRows/overlay buildRow consumed it; both went with
 * the ambient UI removal — the status tool is the remaining consumer); the former
 * index.ts copy is deleted.
 */
export async function readManifestExtras(dir: string, name: string): Promise<ManifestExtras> {
	try {
		// Migration stage 2 (audit step 5): the raw manifest.json re-parse is
		// GONE — the read goes through the manifest storage port (manifestStore,
		// file-backed, tolerant). The per-field type guards stay: a manifest
		// whose top-level shape parses can still carry wrong-typed fields.
		// EXTERNAL_DEPENDENCY: exchange manifest on disk at <dir>/manifest.json
		// (dir is under /tmp/exchange/<task>/); shape documented in exchange.ts.
		const manifest = manifestStore.read(dir);
		if (!manifest) return {};
		const w = manifest.workers.find((x) => x.name === name);
		if (!w) return {};
		const extras: ManifestExtras = {};
		if (typeof w.sessionPath === "string" && w.sessionPath.length > 0) {
			extras.sessionPath = w.sessionPath;
		}
		if (typeof w.budgetTokens === "number" && Number.isFinite(w.budgetTokens) && w.budgetTokens > 0) {
			extras.budgetTokens = w.budgetTokens;
		}
		if (typeof w.orchestratorSessionPath === "string" && w.orchestratorSessionPath.length > 0) {
			extras.orchestratorSessionPath = w.orchestratorSessionPath;
		}
		// Watcher stage A: the manifest-level fleet owner feeds the canonical
		// display mapping (the former fleet.ts classifyOwnership mapping intent →
		// workerAudienceMatch) so a
		// known-foreign master is rendered foreign, not unknown.
		if (typeof manifest.masterSessionPath === "string" && manifest.masterSessionPath.length > 0) {
			extras.masterSessionPath = manifest.masterSessionPath;
		}
		if (typeof w.briefPath === "string") {
			extras.briefPath = w.briefPath;
		}
		if (typeof w.model === "string" && w.model.length > 0) {
			extras.model = w.model;
		}
		if (typeof w.collectedAt === "string" && w.collectedAt.length > 0) {
			extras.collectedAt = w.collectedAt;
		}
		return extras;
	} catch {
		return {}; // missing/corrupt manifest → zero-usage row, never throw
	}
}

/**
 * pi-delegate — worker view aggregation.
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * Read-only module: merges durable on-disk manifests (exchange.ts) with live
 * herdr agent statuses (via the Transport seam). Contains NO mutating calls —
 * this is the data source for `delegate_status` and `/delegate-teardown`.
 */

/** One known worker, as seen by the orchestrator. */
export interface WorkerView {
	/** Canonical (herdr-confirmed) worker name. */
	name: string;
	/** Exchange dir (manifest source) this worker belongs to. */
	dir: string;
	/** Live status when herdr knows the agent, otherwise "unknown". */
	status: AgentStatusName;
	/** Full placement record from the manifest (teardown source of truth). */
	placement: Placement;
	/** Convenience projections of `placement`. */
	kind: Placement["kind"];
	branch?: string;
	workspaceId?: string;
	paneId?: string;
	/** Conventional report path for this worker. */
	reportPath: string;
	/** True when the report file currently exists on disk. */
	reportExists: boolean;
	/** True when the manifest records `retiredAt` — the worker is HISTORY
	 *  (pane already closed, by retire/teardown/manual): the teardown command
	 *  must not attempt (and fail tab_not_found) on it. */
	retired?: boolean;
	/** ISO 8601 start time from the manifest. */
	startedAt: string;
	/** Ms since startedAt (0 when unparseable). */
	elapsedMs: number;
}

/**
 * Aggregate all known workers: every manifest under /tmp/exchange merged with
 * a live `listStatuses()` snapshot. Never throws for herdr being unreachable —
 * statuses degrade to "unknown" instead.
 */
export async function buildWorkerView(transport: Transport): Promise<WorkerView[]> {
	const manifests = manifestStore.scan(transport.backendName());
	// Migration stage 3 (audit steps 6/10): the watcher's stamps (retiredAt)
	// live in per-watcher satellite files — merge the manifest layer with every
	// satellite layer (readers merge layers, earliest stamp wins). One tolerant
	// read per manifest dir per sweep.

	let statuses: Awaited<ReturnType<Transport["listStatuses"]>> = [];
	try {
		// EXTERNAL_DEPENDENCY: live herdr agent statuses via the injected
		// transport (herdr socket/CLI underneath — see transport.ts).
		statuses = await transport.listStatuses();
	} catch {
		statuses = []; // herdr unreachable — fall back to manifest data only
	}
	const liveByName = new Map(statuses.map((s) => [s.name, s]));

	const views: WorkerView[] = [];
	const seen = new Set<string>();
	for (const manifest of manifests) {
		const stampLayers = readWatchStampLayers(manifest.dir);
		for (const worker of manifest.workers) {
			const key = `${manifest.dir}#${worker.name}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const live = liveByName.get(worker.name);
			const startedMs = Date.parse(worker.startedAt);
			views.push({
				name: worker.name,
				dir: manifest.dir,
				status: live?.status ?? "unknown",
				placement: worker.placement,
				kind: worker.placement.kind,
				branch: worker.placement.branch,
				workspaceId: worker.placement.workspaceId,
				paneId: worker.placement.paneId,
				reportPath: worker.reportPath,
				// EXTERNAL_DEPENDENCY: report file existence check on disk at
				// worker.reportPath (under /tmp/exchange/<task>/).
				reportExists: await fileExists(worker.reportPath),
				retired: mergeRetireStamps(
					{
						retiredAt: typeof worker.retiredAt === "string" && worker.retiredAt.length > 0 ? worker.retiredAt : undefined,
					},
					stampLayers,
					worker.name,
				).retiredAt !== undefined,
				startedAt: worker.startedAt,
				elapsedMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
			});
		}
	}
	return views;
}
