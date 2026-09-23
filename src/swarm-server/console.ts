/**
 * pi-delegate — src/swarm-server/console.ts — the worker-console endpoint
 * (issue #52, ARCHITECTURE §4.2.4, Law 8/Law 13).
 *
 * MODULE_CONTRACT — the console half of the session-hosted read server:
 *
 *   GET /api/workers/:id/console?offset=<n>       → one console frame (REST)
 *   WS  /api/workers/:id/console/stream?offset=<n> → live tail, same frame
 *
 * THE FRAME (v1, additive-only, Law 7 — every frame carries schemaVersion):
 *
 *   {ok, schemaVersion, worker, nodeId, task?, state, chunk, nextOffset,
 *    oldestOffset, dropped, error?}
 *
 * `:id` is the SwarmGraph SESSION node id of the worker session (never the
 * raw session path — nodes.ts's stable hash). Resolution walks the read-model
 * graph (Law 13: fleet state enters only via the read-model) to the worker
 * embodiment, then proves OWNERSHIP through the canonical watch-role verdict
 * (`workerAudienceMatch` over the graph edge's parent session path) — the
 * gate is FAIL-CLOSED (Law 8): an unknown id, a task node, a foreign owner, a
 * missing owner edge and a degraded self-id are ONE refusal
 * (`E_CONSOLE_WORKER_REFUSED`, 404 — no existence oracle).
 *
 * STATES (truthful, backend-derived — never fabricated):
 *   live                     — the transport still reports the worker alive
 *   ended-with-retained-backlog — the worker's process ended AND the backend
 *                                still retains its console history
 *   ended                    — the worker ended and the backend no longer
 *                              retains anything
 *   unavailable              — the backend exposes no console stream
 *                              (`E_CONSOLE_UNAVAILABLE` + recovery hint,
 *                              HTTP 200: a valid degraded answer, not an
 *                              error — "never fabricate, never error")
 *
 * OFFSETS: character positions in the server-session transcript served by
 * ./console-buffer.ts (byte-capped, drop-oldest). `oldestOffset` is the
 * frontier a client compares its cursor against; `dropped` marks a read that
 * fell below it. Feeding `nextOffset` back yields exactly the later bytes —
 * no duplication, no loss, inside the retained window.
 *
 * ADVISORY BY CONTRACT (Law 8): every failure here is a frame or a refusal —
 * never a throw into the HTTP core, never a server crash, never a pipeline
 * dependency. Console text is EPHEMERAL display data: it is never written to
 * the journal and never enters the swarm snapshot.
 *
 * Dependencies: node:net (types), ./http1.ts (envelope + writers), ./ws.ts
 * (RFC 6455 codec), ./console-buffer.ts, ../watch-role.ts (the ownership
 * canon — a leaf), TYPE-ONLY ../swarm/graph.ts + ../host.ts. No durable
 * store, journal writer or backend adapter (Law 4/Law 13; the family pin
 * enforces it).
 */

import type { Http1Response } from "./http1.ts";
import { SWARM_HTTP_SCHEMA_VERSION, errorEnvelope } from "./http1.ts";
import { workerAudienceMatch } from "../watch-role.ts";
import { ConsoleBacklog, ConsoleCapture, type ConsoleStreamSource } from "./console-buffer.ts";
import type { SwarmGraph } from "../swarm/graph.ts";
import type { AgentStatusName } from "../host.ts";

/** The console endpoint's E_* additions (taxonomy grows by addition only). */
export type ConsoleErrorCode = "E_CONSOLE_USAGE" | "E_CONSOLE_WORKER_REFUSED" | "E_CONSOLE_UNAVAILABLE";

const CONSOLE_HINTS: Record<ConsoleErrorCode, string> = {
	E_CONSOLE_USAGE: "Pass an integer ?offset=<n> (>= 0; omit for 0). The endpoint refuses non-numeric or negative offsets.",
	E_CONSOLE_WORKER_REFUSED: "The id must be the SwarmGraph node id of a worker session owned by THIS session's read-model. Unknown, non-worker and foreign ids are refused identically (fail-closed).",
	E_CONSOLE_UNAVAILABLE: "This backend exposes no console stream. Use a backend with console capture (the rpc backend) or read the worker's own terminal; nothing is fabricated here.",
};

export const CONSOLE_USAGE_HINT = CONSOLE_HINTS.E_CONSOLE_USAGE;
export const CONSOLE_REFUSED_HINT = CONSOLE_HINTS.E_CONSOLE_WORKER_REFUSED;
export const CONSOLE_UNAVAILABLE_HINT = CONSOLE_HINTS.E_CONSOLE_UNAVAILABLE;

/** One console state value (the closed v1 set). */
export type ConsoleState = "live" | "ended" | "ended-with-retained-backlog" | "unavailable";

/** The structural transport slice the console endpoint consumes. */
export interface ConsoleTransport extends ConsoleStreamSource {
	listStatuses(): Promise<Array<{ name: string; status: AgentStatusName; placementRef?: string }>>;
	readConsole?(name: string, opts?: { maxChars?: number }): Promise<string>;
}

/** The resolved worker the endpoint serves. */
export interface ConsoleTarget {
	name: string;
	nodeId: string;
	task?: string;
}

/** Injected route dependencies (structurally satisfied by SwarmServerDeps). */
export interface ConsoleRouteDeps {
	transport?: ConsoleTransport;
	/** This session's file identity (the ownership gate's self). */
	sessionFile?: string;
	/** Prebuilt read-model graph (composition root / tests); absent → buildGraph. */
	graph?: SwarmGraph;
	buildGraph?: () => Promise<SwarmGraph>;
	/** Path-comparison platform override (tests; default ambient). */
	platform?: NodeJS.Platform;
}

/** The per-server console runtime (one capture per mounted server — Law 3). */
export interface ConsoleRuntime {
	capture: ConsoleCapture;
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

const REST_PATH = /^\/api\/workers\/([^/]+)\/console$/;
const STREAM_PATH = /^\/api\/workers\/([^/]+)\/console\/stream$/;

/** The worker id for a plain console GET, or null when the path is not ours. */
export function matchConsoleRestPath(path: string): string | null {
	const m = REST_PATH.exec(path);
	return m === null ? null : m[1]!;
}

/** The worker id for a console WS upgrade, or null when the path is not ours. */
export function matchConsoleStreamPath(path: string): string | null {
	const m = STREAM_PATH.exec(path);
	return m === null ? null : m[1]!;
}

// ---------------------------------------------------------------------------
// Identity + ownership (fail-closed)
// ---------------------------------------------------------------------------

export type ConsoleResolution = { ok: true; target: ConsoleTarget } | { ok: false; message: string };

/**
 * Resolve a SwarmGraph node id to a worker this session OWNS.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: graph — the read-model projection; id — the requested node id;
 *   sessionFile — this session's identity; platform — path policy (tests)
 * Output: the target (worker name + node id + task) or a refusal message
 * Guarantees:
 *   - only "session" nodes that appear as a worker embodiment resolve;
 *   - ownership is the canonical workerAudienceMatch verdict over the
 *     spawned_by parent (worker-level owner; task-level fleet owner as the
 *     fallback) — ONLY "mine" passes; "foreign", "no-owner" and "no-self-id"
 *     are refused identically (fail-closed, Law 8);
 *   - pure and total: never throws
 * Raises: never
 */
export function resolveConsoleTarget(
	graph: SwarmGraph,
	id: string,
	sessionFile: string | undefined,
	platform?: NodeJS.Platform,
): ConsoleResolution {
	const node = graph.nodes.find((n) => n.id === id);
	if (!node || node.kind !== "session") {
		return { ok: false, message: `no worker session node ${JSON.stringify(id)} in the read-model` };
	}
	let task: string | undefined;
	let name: string | undefined;
	for (const n of graph.nodes) {
		if (n.kind !== "task") continue;
		const w = n.workers.find((x) => x.sessionId === id);
		if (w) {
			task = n.id;
			name = w.name;
			break;
		}
	}
	if (name === undefined) {
		return { ok: false, message: `session node ${JSON.stringify(id)} is not a worker embodiment in the read-model` };
	}
	const ownerPath = ownerPathFor(graph, id, task);
	const verdict = workerAudienceMatch({ orchestratorSessionPath: ownerPath }, { sessionFile }, { legacyFailOpen: false, ...(platform === undefined ? {} : { platform }) });
	if (verdict !== "mine") {
		return { ok: false, message: `worker ${JSON.stringify(id)} is not owned by this session (verdict ${verdict})` };
	}
	return { ok: true, target: { name, nodeId: id, ...(task === undefined ? {} : { task }) } };
}

/** The worker's proven owner session path: the spawned_by parent session,
 *  else the task's fleet-owner edge (the worker-level/master-level mirror). */
function ownerPathFor(graph: SwarmGraph, id: string, task: string | undefined): string | undefined {
	const sessionPath = (nodeId: string): string | undefined => {
		const n = graph.nodes.find((x) => x.id === nodeId && x.kind === "session");
		return n && n.kind === "session" ? n.sessionPath : undefined;
	};
	for (const e of graph.edges) {
		if (e.kind === "spawned_by" && e.from === id) {
			const p = sessionPath(e.to);
			if (p !== undefined) return p;
		}
	}
	if (task !== undefined) {
		for (const e of graph.edges) {
			if (e.kind === "spawned_by" && e.from === task) {
				const p = sessionPath(e.to);
				if (p !== undefined) return p;
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// State + frames
// ---------------------------------------------------------------------------

/** Parse the ?offset= query value: 0 when absent, null when invalid. */
export function parseConsoleOffset(raw: string | undefined): number | null {
	if (raw === undefined || raw === "") return 0;
	if (!/^\d+$/.test(raw)) return null;
	const n = Number(raw);
	return Number.isSafeInteger(n) ? n : null;
}

/**
 * Derive the worker's console state from the TRANSPORT (never the graph):
 * live while a status is reported and not "done"; otherwise ended, narrowed
 * to ended-with-retained-backlog when the backend still answers a console
 * read. Total: a throwing status read degrades to ended + probe (never a
 * throw).
 */
export async function deriveState(transport: ConsoleTransport, name: string): Promise<Exclude<ConsoleState, "unavailable">> {
	let status: AgentStatusName | undefined;
	try {
		const list = await transport.listStatuses();
		status = list.find((s) => s.name === name)?.status;
	} catch {
		status = undefined;
	}
	if (status !== undefined && status !== "done") return "live";
	return (await probeRetained(transport, name)) ? "ended-with-retained-backlog" : "ended";
}

/** Probe whether the backend still serves anything for a worker (retention). */
async function probeRetained(transport: ConsoleTransport, name: string): Promise<boolean> {
	if (typeof transport.readConsole === "function") {
		try {
			await transport.readConsole(name, { maxChars: 1 });
			return true;
		} catch {
			return false;
		}
	}
	if (typeof transport.streamConsole === "function") {
		try {
			const sub = transport.streamConsole(name, { afterSeq: 0 });
			sub.unsubscribe?.();
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

/** One serialized console frame (fixed key order — golden-pinned). */
export function consoleFrame(
	target: ConsoleTarget,
	state: ConsoleState,
	read: { chunk: string; nextOffset: number; oldestOffset: number; dropped: boolean },
	error?: { code: ConsoleErrorCode; message: string },
): string {
	const body: Record<string, unknown> = {
		ok: true,
		schemaVersion: SWARM_HTTP_SCHEMA_VERSION,
		worker: target.name,
		nodeId: target.nodeId,
	};
	if (target.task !== undefined) body.task = target.task;
	body.state = state;
	body.chunk = read.chunk;
	body.nextOffset = read.nextOffset;
	body.oldestOffset = read.oldestOffset;
	body.dropped = read.dropped;
	if (error !== undefined) body.error = { code: error.code, message: error.message, hint: CONSOLE_HINTS[error.code] };
	return JSON.stringify(body);
}

export async function buildGraphFor(deps: ConsoleRouteDeps): Promise<SwarmGraph> {
	if (deps.graph) return deps.graph;
	if (deps.buildGraph) {
		try {
			return await deps.buildGraph();
		} catch {
			return { schemaVersion: 1, available: false, sources: { journal: false, manifests: false, liveStatus: false, usage: false }, nodes: [], edges: [], orphans: [] };
		}
	}
	return { schemaVersion: 1, available: false, sources: { journal: false, manifests: false, liveStatus: false, usage: false }, nodes: [], edges: [], orphans: [] };
}

/**
 * Serve one plain console GET.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — injected read-model/transport sources; rawId — the path id;
 *   rawOffset — the ?offset= value; runtime — the mounted capture (absent →
 *   a throwaway capture, which only serves single-shot reads)
 * Output: the Http1Response (200 frame | 400 usage | 404 refusal)
 * Guarantees: never throws; every response is a schemaVersion-carrying frame
 *   or error envelope (Law 7)
 * Raises: never
 */
export async function consoleRoute(
	deps: ConsoleRouteDeps,
	rawId: string,
	rawOffset: string | undefined,
	runtime?: ConsoleRuntime,
): Promise<Http1Response> {
	const offset = parseConsoleOffset(rawOffset);
	if (offset === null) return errorEnvelope(400, "E_CONSOLE_USAGE", "invalid ?offset= value", CONSOLE_USAGE_HINT);
	const graph = await buildGraphFor(deps);
	const id = decodeURIComponent(rawId);
	const resolved = resolveConsoleTarget(graph, id, deps.sessionFile, deps.platform);
	if (!resolved.ok) return errorEnvelope(404, "E_CONSOLE_WORKER_REFUSED", resolved.message, CONSOLE_REFUSED_HINT);
	const { target } = resolved;
	const transport = deps.transport;
	if (!transport || !ConsoleCapture.canCapture(transport)) {
		return consoleFrameResponse(target, "unavailable", offset, { code: "E_CONSOLE_UNAVAILABLE", message: "backend exposes no console stream" });
	}
	const state = await deriveState(transport, target.name);
	if (state === "ended") {
		return { status: 200, body: consoleFrame(target, "ended", { chunk: "", nextOffset: offset, oldestOffset: 0, dropped: false }) };
	}
	const backlog = await ensureBacklog(transport, runtime, target.name);
	if (backlog === null) {
		return consoleFrameResponse(target, "unavailable", offset, { code: "E_CONSOLE_UNAVAILABLE", message: "console capture failed for this worker" });
	}
	return { status: 200, body: consoleFrame(target, state, backlog.read(offset)) };
}

function consoleFrameResponse(target: ConsoleTarget, state: "unavailable", offset: number, error: { code: ConsoleErrorCode; message: string }): Http1Response {
	return { status: 200, body: consoleFrame(target, state, { chunk: "", nextOffset: offset, oldestOffset: 0, dropped: false }, error) };
}

async function ensureBacklog(transport: ConsoleTransport, runtime: ConsoleRuntime | undefined, name: string): Promise<ConsoleBacklog | null> {
	try {
		if (runtime) return await runtime.capture.ensure(name);
		return await new ConsoleCapture(transport).ensure(name);
	} catch {
		return null;
	}
}

