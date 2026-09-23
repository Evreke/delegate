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
 *   POST /api/workers/<id>/steer → the #51 mutation route (operator-token
 *                             gated; see the mutation block below)
 *   POST /api/asks/<id>/answer   → the #51 mutation route
 *
 * Issue #52 adds the worker-console surface (./console.ts, §4.2.4):
 *   GET /api/workers/:id/console?offset=<n>       → one console frame
 *   WS  /api/workers/:id/console/stream?offset=<n> → live-tail console frames
 * `:id` is a SwarmGraph session node id; resolution is fail-closed through
 * the watch-role ownership verdict, states are transport-derived (live /
 * ended / ended-with-retained-backlog / unavailable), and a backend without
 * console capture yields `unavailable` + `E_CONSOLE_UNAVAILABLE` (never a
 * fabricated stream, never an HTTP error). Console text is ephemeral — it
 * never reaches the journal or the snapshot.
 *
 * TRUST MODEL (§4.2): loopback only. The READ surface (GET/WS) has no auth
 * beyond the loopback bind — every process on this machine can read it; that
 * is the documented boundary (a future daemon may add auth; this server
 * never listens off-loop). The #51 WRITE surface is operator-only: both POST
 * routes require `Authorization: Bearer <operator token>` (./auth.ts), a
 * per-mount secret surfaced only on the session's stderr (Law 11).
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
 * The mutation routes (issue #51, §4.2.4) delegate the actual write to the
 * injected `mutate` seam (wired in ./mount.ts to the shared swarm mailbox
 * core, src/swarm/mailbox-verbs.ts): this layer owns ONLY auth, id/body
 * validation and envelope mapping — never a mailbox write (pinned by T1.16),
 * so a mutation cannot bypass the journal.
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
import { SWARM_HTTP_SCHEMA_VERSION, errorEnvelope } from "./http1.ts";
import { existsSync } from "node:fs";
import { EXTENSION_VERSION } from "../version.ts";
import { parseAfterCursor, SWARM_EVENTS_SCHEMA_VERSION } from "../swarm/events.ts";
import { SwarmError } from "../swarm/result.ts";
import { WORKER_NAME_RE } from "../host.ts";
import { bearerTokenOf, tokenMatches } from "./auth.ts";
import type { OrchestratorVerbOutcome } from "../swarm/mailbox-verbs.ts";
import { activeBackendName, manifestSource } from "../swarm/snapshot.ts";
import { buildSwarmGraph, type SwarmLiveTransport, type SwarmUsageSource } from "../swarm/graph.ts";
import type { JournalReader } from "../swarm/journal-read.ts";
import type { SwarmStorageConfig } from "../swarm/storage.ts";
import { contextPct, parseSessionUsage, resolveContextWindow } from "../usage.ts";
import { StreamHub } from "./stream.ts";
import { ConsoleCapture } from "./console-buffer.ts";
import type { ConsoleStreamSource } from "./console-buffer.ts";
import { consoleRoute, matchConsoleRestPath, matchConsoleStreamPath, type ConsoleRuntime, type ConsoleTransport } from "./console.ts";
import { ConsoleHub } from "./console-ws.ts";
import type { SwarmGraph } from "../swarm/graph.ts";

/** The HTTP surface's contract version (Law 7) — re-exported from the leaf
 *  (./http1.ts) so consumers see one import surface; the leaf owns the one
 *  spelling (Law 9). */
export { SWARM_HTTP_SCHEMA_VERSION };

/** The protocol identity string (§4.2 — frozen surface of the HTTP API). */
export const SWARM_HTTP_PROTOCOL = "swarm-http/1";

/** The HTTP surface's E_* code ADDITIONS (taxonomy grows by addition only).
 *  E_SWARM_AUTH / E_SWARM_FORBIDDEN are the #51 mutation-surface codes. */
export type SwarmServerErrorCode =
	| "E_SWARM_NOT_FOUND"
	| "E_SWARM_USAGE"
	| "E_SWARM_IO"
	| "E_SWARM_AUTH"
	| "E_SWARM_FORBIDDEN";

const SERVER_ERROR_HINTS: Record<SwarmServerErrorCode, string> = {
	E_SWARM_NOT_FOUND: "The server serves /api/version, /api/swarm/snapshot, /api/swarm/events, the WS /api/swarm/stream, and the token-gated POST /api/workers/<id>/steer and /api/asks/<id>/answer — check the path.",
	E_SWARM_USAGE: "Use GET with the documented query flags, or POST {text} to a mutation path with a canonical worker id.",
	E_SWARM_IO: "The read server could not serve this request; retry or check the orchestrator log.",
	E_SWARM_AUTH: "Every mutation request needs Authorization: Bearer <operator token>; the token is printed on the session's stderr at mount.",
	E_SWARM_FORBIDDEN: "The mutation surface only reaches workers this session provably spawned.",
};

/** Build a structured error envelope (schemaVersion on every response — Law 7).
 *  A caller may override the canned hint with a failure's own recovery hint. */
export function httpError(status: number, code: SwarmServerErrorCode, message: string, hint?: string): Http1Response {
	return errorEnvelope(status, code, message, hint ?? SERVER_ERROR_HINTS[code]);
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
	/** The operator token of the #51 mutation surface (generated at mount).
	 *  Absent → every mutation refuses E_SWARM_AUTH. NEVER serialized. */
	operatorToken?: string;
	/** The injected mutation core (wired by mount.ts from the swarm module
	 *  family — the server layer maps its structured outcome to HTTP). Absent
	 *  → mutation routes answer a structured 500. */
	mutate?: SwarmMutate;
	/** This session's file identity — the worker-console ownership gate's self
	 *  (issue #52; the read-model is the identity source, fail-closed). */
	sessionFile?: string;
	/** A prebuilt read-model graph (composition root / test injection); absent
	 *  → the console route builds one through buildSnapshotGraph. */
	graph?: SwarmGraph;
}

/** The mutation seam: run one steer/answer for a worker id this session owns. */
export type SwarmMutate = (
	kind: "steer" | "answer",
	id: string,
	text: string,
) => Promise<OrchestratorVerbOutcome>;

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
async function buildSnapshotGraph(deps: SwarmServerDeps): Promise<SwarmGraph> {
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

/** The two mutation routes (path params are decoded by mutationResponse). */
const STEER_ROUTE_RE = /^\/api\/workers\/([^/]+)\/steer$/;
const ANSWER_ROUTE_RE = /^\/api\/asks\/([^/]+)\/answer$/;

/** Uniform auth refusal: missing and wrong tokens are indistinguishable. */
function authRefusal(): Http1Response {
	return httpError(401, "E_SWARM_AUTH", "missing or invalid operator token");
}

/** Parse + validate the {text} body of a mutation request. */
function mutationText(req: Http1Request): string | null {
	if (req.body === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(req.body);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const text = (parsed as Record<string, unknown>).text;
	return typeof text === "string" && text.trim().length > 0 ? text : null;
}

/**
 * Serve one POST mutation: auth gate → id validation → body → ownership +
 * envelope + journal (the injected swarm core).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps (token + mutate seam), req, kind, rawId (still URL-encoded)
 * Output: the structured success envelope or a structured E_* refusal
 * Guarantees:
 *   - missing/wrong token → the SAME 401 E_SWARM_AUTH refusal;
 *   - a non-canonical or undecodable id → 400 E_SWARM_USAGE (no core call);
 *   - an invalid body → 400 E_SWARM_USAGE (no core call);
 *   - a core refusal maps by code (E_SWARM_FORBIDDEN → 403, else 500);
 *   - never throws (a core throw degrades to a structured 500)
 * Raises: never
 */
async function mutationResponse(
	deps: SwarmServerDeps,
	req: Http1Request,
	kind: "steer" | "answer",
	rawId: string,
): Promise<Http1Response> {
	const expected = deps.operatorToken;
	if (expected === undefined || !tokenMatches(bearerTokenOf(req), expected)) return authRefusal();

	let id: string;
	try {
		id = decodeURIComponent(rawId);
	} catch {
		return httpError(400, "E_SWARM_USAGE", "worker id is not valid URL encoding");
	}
	if (!WORKER_NAME_RE.test(id)) {
		return httpError(400, "E_SWARM_USAGE", `worker id ${JSON.stringify(id)} is not a canonical worker name`);
	}
	const text = mutationText(req);
	if (text === null) return httpError(400, "E_SWARM_USAGE", "a JSON body with a non-empty string \"text\" is required");
	if (deps.mutate === undefined) return httpError(500, "E_SWARM_IO", "the mutation core is not mounted");

	let outcome: OrchestratorVerbOutcome;
	try {
		outcome = await deps.mutate(kind, id, text);
	} catch (err) {
		return httpError(500, "E_SWARM_IO", `mutation failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!outcome.ok) {
		const status = outcome.code === "E_SWARM_FORBIDDEN" ? 403 : outcome.code === "E_SWARM_USAGE" ? 400 : 500;
		return httpError(status, outcome.code as SwarmServerErrorCode, outcome.message, outcome.hint);
	}
	return {
		status: 200,
		body: JSON.stringify({
			ok: true,
			schemaVersion: SWARM_HTTP_SCHEMA_VERSION,
			verb: kind,
			worker: outcome.worker,
			via: "http",
			answerPath: outcome.answerPath,
			journal: outcome.journal,
			nudged: outcome.nudged,
		}),
	};
}

/**
 * The plain-request router.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — the injected read-model sources + mutation seam; req — one
 *   parsed request (head + optional body); runtime — the mounted console
 *   capture (the WS/REST console routes share it; absent on direct calls →
 *   single-shot console reads)
 * Output: the response (a promise for the async routes)
 * Guarantees:
 *   - GET serves the read routes, no auth (the #50 loopback boundary);
 *   - POST serves ONLY the two token-gated mutation routes, else 404;
 *   - other methods → 405 E_SWARM_USAGE
 *   - unknown path → 404 E_SWARM_NOT_FOUND
 *   - every envelope (success + error) carries schemaVersion (Law 7)
 * Raises: never (all failures are structured error envelopes or degraded graphs)
 */
export function routeRequest(deps: SwarmServerDeps, req: Http1Request, runtime?: ConsoleRuntime): Http1Response | Promise<Http1Response> {
	if (req.method === "POST") {
		const steer = STEER_ROUTE_RE.exec(req.path);
		if (steer) return mutationResponse(deps, req, "steer", steer[1]);
		const answer = ANSWER_ROUTE_RE.exec(req.path);
		if (answer) return mutationResponse(deps, req, "answer", answer[1]);
		// A POST against a known GET path is a method error (405), not a
		// missing path — the #50 read surface's method contract is preserved.
		if (req.path === "/api/version" || req.path === "/api/swarm/events" || req.path === "/api/swarm/snapshot") {
			return httpError(405, "E_SWARM_USAGE", `method POST is not served on ${JSON.stringify(req.path)}; it is a GET path`);
		}
		return httpError(404, "E_SWARM_NOT_FOUND", `no such path ${JSON.stringify(req.path)}`);
	}
	if (req.method !== "GET") {
		return httpError(405, "E_SWARM_USAGE", `method ${JSON.stringify(req.method)} is not served; the read API is GET-only (writes use POST)`);
	}
	if (req.path === "/api/version") return versionResponse();
	if (req.path === "/api/swarm/events") return eventsResponse(deps, req);
	if (req.path === "/api/swarm/snapshot") return snapshotResponse(deps);
	const consoleId = matchConsoleRestPath(req.path);
	if (consoleId !== null) return consoleRoute(deps, consoleId, req.query.get("offset") ?? undefined, runtime);
	if (matchConsoleStreamPath(req.path) !== null) {
		return httpError(400, "E_SWARM_USAGE", "the console stream is a WebSocket endpoint (/api/workers/:id/console/stream)");
	}
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

/** Build the route table (plain routes + the stream hubs). */
export function createRouteTable(deps: SwarmServerDeps & { pollMs?: number }): SwarmRouteTable {
	const captureTransport = deps.transport as ConsoleTransport | undefined;
	const captureSource: ConsoleStreamSource = { streamConsole: captureTransport?.streamConsole?.bind(captureTransport) };
	const runtime: ConsoleRuntime = { capture: new ConsoleCapture(captureSource) };
	const hub = new StreamHub({
		journal: deps.journal,
		buildSnapshot: () => buildSnapshotGraph(deps),
		pollMs: deps.pollMs,
	});
	const consoleHub = new ConsoleHub({
		deps: { transport: deps.transport, sessionFile: deps.sessionFile, graph: deps.graph, buildGraph: () => buildSnapshotGraph(deps) },
		capture: runtime.capture,
		pollMs: deps.pollMs,
	});
	return {
		onRequest: (req) => routeRequest(deps, req, runtime),
		onUpgrade: (req, socket, head) => consoleHub.handleUpgrade(req, socket, head) || hub.handleUpgrade(req, socket, head),
		close: () => {
			hub.close();
			consoleHub.close();
			runtime.capture.stop();
		},
	};
}
