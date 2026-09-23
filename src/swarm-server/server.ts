/**
 * pi-delegate — src/swarm-server/server.ts — the read-model HTTP/WS surface
 * (issue #50, ARCHITECTURE §4.2, Law 13).
 *
 * MODULE_CONTRACT — the session-hosted read server's ENDPOINT layer: routes
 * plain GET requests over the loopback http1 core (./http1.ts) to the
 * read-model read API. v1 surface (additive-only, Law 7):
 *
 *   GET /api/version        → {ok, schemaVersion, serverVersion, protocol}
 *   GET /api/swarm/snapshot → the `swarm snapshot` CLI envelope, verbatim,
 *                             built from the LIVE in-process deps (transport
 *                             status + usage fold in — the flags no-live-status
 *                             / usage-unavailable appear only when genuinely
 *                             unavailable; issue #50 acceptance 1)
 *   GET /api/swarm/events?after=<seq> → the `swarm events` CLI envelope,
 *                             verbatim (protocol identity with the CLI verbs)
 *   WS  /api/swarm/stream?after=<seq> → ./ws.ts (one snapshot frame, then
 *                             event frames as the journal cursor advances)
 *
 * TRUST MODEL (§4.2): loopback only, no auth in v1 beyond the loopback bind —
 * every process on this machine can read the read API; that is the documented
 * boundary (a future daemon may add auth; this server never listens off-loop).
 *
 * Every JSON envelope — success AND error — carries `schemaVersion: 1`
 * (Law 7) and structured E_* errors (Law 8): 404 E_SWARM_NOT_FOUND, 400/405
 * E_SWARM_USAGE. E_SWARM_NOT_FOUND joins the E_* taxonomy by ADDITION (the
 * HTTP surface's own code; the CLI codes are reused elsewhere).
 *
 * Dependencies: node builtins, ./http1.ts, ../version.ts (EXTENSION_VERSION —
 * the ONE runtime version source, Law 9). The snapshot/events/stream routes
 * import the read-model pieces (Law 13 — fleet state enters ONLY via the
 * read-model, never a direct manifest/satellite/progress read; pinned
 * statically in test/static-check.ts). No herdr adapter import (Law 4); no
 * sqlite driver import (the journal module family owns that seam; the journal
 * is consumed ONLY through ../swarm/journal-read.ts).
 *
 * Critical invariants:
 *   - handlers NEVER throw into the http1 core (the core wraps them, and the
 *     route layer itself catches: a failing read degrades to a structured
 *     error envelope, never a crash — Law 8, the server is advisory);
 *   - response bodies are EXACTLY the CLI verbs' JSON bytes (protocol
 *     identity; pinned by golden comparison against a real CLI run in
 *     test/swarm-server-endpoints-check.ts);
 *   - `Connection: close` semantics (one request per connection — the http1
 *     core owns that; documented in §4.2).
 */

import type { Http1Request, Http1Response } from "./http1.ts";
import { existsSync } from "node:fs";
import { EXTENSION_VERSION } from "../version.ts";
import { parseAfterCursor, SWARM_EVENTS_SCHEMA_VERSION } from "../swarm/events.ts";
import { SwarmError } from "../swarm/result.ts";
import { activeBackendName, manifestSource } from "../swarm/snapshot.ts";
import { buildSwarmGraph, type SwarmLiveTransport, type SwarmUsageSource } from "../swarm/graph.ts";
import type { JournalReader } from "../swarm/journal-read.ts";
import type { SwarmStorageConfig } from "../swarm/storage.ts";
import { contextPct, parseSessionUsage, resolveContextWindow } from "../usage.ts";
import { StreamHub } from "./stream.ts";

/** The HTTP surface's own contract version (Law 7; additive-only evolution). */
export const SWARM_HTTP_SCHEMA_VERSION = 1;

/** The protocol identity string (§4.2 — frozen surface of the HTTP API). */
export const SWARM_HTTP_PROTOCOL = "swarm-http/1";

/** The HTTP surface's E_* code ADDITION (taxonomy grows by addition only). */
export type SwarmServerErrorCode = "E_SWARM_NOT_FOUND" | "E_SWARM_USAGE" | "E_SWARM_IO";

const SERVER_ERROR_HINTS: Record<SwarmServerErrorCode, string> = {
	E_SWARM_NOT_FOUND: "The read API serves /api/version, /api/swarm/snapshot, /api/swarm/events and the WS /api/swarm/stream — check the path.",
	E_SWARM_USAGE: "Use GET with the documented query flags (events/stream need an integer ?after=<seq> cursor; 0 for everything).",
	E_SWARM_IO: "The read server could not serve this request; retry or check the orchestrator log.",
};

/** Build a structured error envelope (schemaVersion on every response — Law 7). */
export function httpError(status: number, code: SwarmServerErrorCode, message: string): Http1Response {
	return {
		status,
		body: JSON.stringify({
			ok: false,
			schemaVersion: SWARM_HTTP_SCHEMA_VERSION,
			error: { code, message, hint: SERVER_ERROR_HINTS[code] },
		}),
	};
}

/** The journal reader seam the endpoint layer consumes (the read half of
 *  src/swarm/journal-read.ts — the ONE long-lived read-only reader per
 *  session, mounted open once and never the CLI's temp-copy workaround). */
export type SwarmServerJournal = JournalReader;

/**
 * The default in-process usage resolver (the read-model's DECLARED input
 * seam — graph.ts SwarmUsageSource; not a fleet-state read, Law 13: the
 * projector consumes the summary, this source only parses the worker's own
 * session JSONL through usage.ts's ONE spelling). A session file that does
 * not exist cannot be counted → null (the projector marks the node
 * usage-unavailable — the same degraded flag the CLI surface shows).
 */
export const defaultUsageSource: SwarmUsageSource = (sessionPath: string) => {
	if (!existsSync(sessionPath)) return null;
	const u = parseSessionUsage(sessionPath);
	return { outputTokens: u.output, contextPct: contextPct(u, resolveContextWindow()) };
};

/** The injected dependencies of the endpoint layer. */
export interface SwarmServerDeps {
	/** The session's live transport (live status folds into the snapshot). */
	transport?: SwarmLiveTransport;
	/** The session's ONE long-lived read-only journal reader (openReadOnly
	 *  precedent); absent only when the factory failed at mount (the read
	 *  endpoints then degrade to empty-but-valid envelopes — Law 8). */
	journal?: SwarmServerJournal;
	/** The session's usage resolver (the read-model's input seam; the identity
	 *  mount passes undefined to match the CLI verb's sources exactly). */
	usage?: SwarmUsageSource;
	/** The resolved storage config (the manifest source branches on it). */
	storage?: SwarmStorageConfig;
	/** The manifest scan's backend filter when no transport is bound
	 *  (mirrors the CLI verb's tolerant spelling). */
	backendName?: string;
}

/** GET /api/version — the frozen identity envelope. */
function versionResponse(): Http1Response {
	return {
		status: 200,
		body: JSON.stringify({
			ok: true,
			schemaVersion: SWARM_HTTP_SCHEMA_VERSION,
			serverVersion: EXTENSION_VERSION,
			protocol: SWARM_HTTP_PROTOCOL,
		}),
	};
}

/** GET /api/swarm/events — the `swarm events` CLI envelope, verbatim
 *  (events.ts parseAfterCursor + the reader's rows; protocol identity). */
function eventsResponse(deps: SwarmServerDeps, req: Http1Request): Http1Response {
	let cursor: number;
	try {
		cursor = parseAfterCursor(req.query.get("after") ?? undefined);
	} catch (err) {
		if (err instanceof SwarmError) {
			return {
				status: 400,
				body: JSON.stringify({
					ok: false,
					schemaVersion: SWARM_HTTP_SCHEMA_VERSION,
					error: { code: err.code, message: err.message, hint: err.hint },
				}),
			};
		}
		throw err;
	}
	const journal = deps.journal;
	return {
		status: 200,
		body: JSON.stringify({
			ok: true,
			verb: "events",
			schemaVersion: SWARM_EVENTS_SCHEMA_VERSION,
			after: cursor,
			events: journal ? journal.eventsAfter(cursor) : [],
			journal: journal ? { count: journal.count(), dbSizeBytes: journal.dbSizeBytes() } : { count: 0, dbSizeBytes: 0 },
		}),
	};
}

/** Build the SwarmGraph once for one snapshot request/frame — the ONE
 *  spelling shared by the HTTP route and the WS snapshot frame (Law 9). */
async function buildSnapshotGraph(deps: SwarmServerDeps): Promise<unknown> {
	const storage: SwarmStorageConfig = deps.storage ?? { storage: "files", projection: true, warnings: [] };
	return buildSwarmGraph({
		journal: deps.journal,
		manifests: manifestSource(deps.journal, storage, deps.backendName ?? activeBackendName()),
		transport: deps.transport,
		usage: deps.usage,
		backendName: deps.backendName,
	});
}

/** GET /api/swarm/snapshot — the `swarm snapshot` CLI envelope, verbatim,
 *  built from the LIVE in-process deps (transport status + usage fold in).
 *  The build is total (buildSwarmGraph never throws) — a failing source
 *  degrades the graph, never the response (Law 8/Law 13). */
async function snapshotResponse(deps: SwarmServerDeps): Promise<Http1Response> {
	const graph = await buildSnapshotGraph(deps);
	return {
		status: 200,
		body: JSON.stringify({ ok: true, verb: "snapshot", snapshot: graph }),
	};
}

/**
 * The plain-request router.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — the injected read-model sources; req — one parsed request head
 * Output: the response (a promise for the snapshot route — graph build is async)
 * Guarantees:
 *   - non-GET → 405 E_SWARM_USAGE (the surface is GET-only)
 *   - unknown path → 404 E_SWARM_NOT_FOUND
 *   - every envelope (success + error) carries schemaVersion (Law 7)
 * Raises: never (all failures are structured error envelopes or degraded graphs)
 */
export function routeRequest(deps: SwarmServerDeps, req: Http1Request): Http1Response | Promise<Http1Response> {
	if (req.method !== "GET") {
		return httpError(405, "E_SWARM_USAGE", `method ${JSON.stringify(req.method)} is not served; the read API is GET-only`);
	}
	if (req.path === "/api/version") return versionResponse();
	if (req.path === "/api/swarm/events") return eventsResponse(deps, req);
	if (req.path === "/api/swarm/snapshot") return snapshotResponse(deps);
	return httpError(404, "E_SWARM_NOT_FOUND", `no such path ${JSON.stringify(req.path)}`);
}

/** The full route table the mount wires into the http1 core: the plain
 *  router + the WS stream hub (one hub per server — the poll timer and the
 *  connection set are server-scoped, not request-scoped). */
export interface SwarmRouteTable {
	onRequest: (req: Http1Request) => Http1Response | Promise<Http1Response>;
	onUpgrade: (req: Http1Request, socket: import("node:net").Socket, head: Buffer) => boolean;
	/** Stop the stream hub's poll timer (sockets are closed by the core). */
	close(): void;
}

/** Build the route table (plain routes + the stream hub). */
export function createRouteTable(deps: SwarmServerDeps & { pollMs?: number }): SwarmRouteTable {
	const hub = new StreamHub({
		journal: deps.journal,
		buildSnapshot: () => buildSnapshotGraph(deps),
		pollMs: deps.pollMs,
	});
	return {
		onRequest: (req) => routeRequest(deps, req),
		onUpgrade: (req, socket, head) => hub.handleUpgrade(req, socket, head),
		close: () => hub.close(),
	};
}
