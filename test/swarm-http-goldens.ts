/**
 * swarm-http-goldens — the golden-envelope fixtures of the session-hosted
 * HTTP/WS API (issue #55, ARCHITECTURE §4.2, Law 7).
 *
 * NOT a check: the runner skips `*goldens*` files. This module is the ONE
 * spelling of the HTTP surface's frozen envelopes and of the additive-only
 * comparison discipline the schema-diff check enforces. The templates are the
 * bytes the live server produced at the pinned fixtures (captured, reviewed,
 * then frozen) — a shape change turns the golden check red; an ADDITION
 * passes the additive comparator by design.
 *
 * Every template uses `render(template, tokens)` for the machine-dependent
 * fragments (sandbox paths, sqlite layout size). Byte equality is the pin;
 * `additiveViolations` is the additive-only discipline (field removal/rename
 * fails, additions pass).
 */

import { join } from "node:path";
import type { SwarmGraph } from "../src/swarm/graph.ts";
import { sessionIdFor } from "../src/swarm/nodes.ts";

/** Substitute `{{TOKEN}}` placeholders in a golden template. */
export function render(template: string, tokens: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
		const v = tokens[key];
		if (v === undefined) throw new Error(`swarm-http-goldens: no token ${key}`);
		return v;
	});
}

// ---------------------------------------------------------------------------
// Additive-only discipline (Law 7): golden fields may be ADDED to, never
// removed or renamed. Returns one violation string per broken golden field.
// ---------------------------------------------------------------------------

function typeName(v: unknown): string {
	if (v === null) return "null";
	return Array.isArray(v) ? "array" : typeof v;
}

/**
 * Compare actual against golden additively: every golden key must exist in
 * actual (no removal/rename), every primitive type must be unchanged, arrays
 * may not shrink and compare element-wise. EXTRA keys in actual are
 * additions and PASS.
 */
export function additiveViolations(golden: unknown, actual: unknown, path = "$"): string[] {
	const out: string[] = [];
	if (golden === null) {
		if (actual !== null) out.push(`${path}: expected null, got ${typeName(actual)}`);
		return out;
	}
	if (Array.isArray(golden)) {
		if (!Array.isArray(actual)) {
			out.push(`${path}: expected array, got ${typeName(actual)}`);
			return out;
		}
		if (actual.length < golden.length) out.push(`${path}: array shrank ${golden.length} → ${actual.length} (removal)`);
		const n = Math.min(golden.length, actual.length);
		for (let i = 0; i < n; i++) out.push(...additiveViolations(golden[i], actual[i], `${path}[${i}]`));
		return out;
	}
	if (typeof golden === "object") {
		if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
			out.push(`${path}: expected object, got ${typeName(actual)}`);
			return out;
		}
		const g = golden as Record<string, unknown>;
		const a = actual as Record<string, unknown>;
		for (const key of Object.keys(g)) {
			if (!(key in a)) out.push(`${path}.${key}: field removed/renamed`);
			else out.push(...additiveViolations(g[key], a[key], `${path}.${key}`));
		}
		return out;
	}
	if (typeof actual !== typeof golden) out.push(`${path}: type changed ${typeof golden} → ${typeof actual}`);
	return out;
}

/** Test fixture: golden with one nested key removed (drives the red leg). */
export function withoutKey(golden: unknown, key: string): unknown {
	if (golden === null || typeof golden !== "object" || Array.isArray(golden)) throw new Error("withoutKey expects an object");
	const copy = { ...(golden as Record<string, unknown>) };
	delete copy[key];
	return copy;
}

/** Test fixture: golden with one added key (drives the green/addition leg). */
export function withKey(golden: unknown, key: string, value: unknown): unknown {
	if (golden === null || typeof golden !== "object" || Array.isArray(golden)) throw new Error("withKey expects an object");
	return { ...(golden as Record<string, unknown>), [key]: value };
}

// ---------------------------------------------------------------------------
// Golden templates (frozen bytes at the pinned fixtures; see
// test/swarm-http-api-check.ts for the fixtures that produce them).
// ---------------------------------------------------------------------------

/** The ONE generic 404 body (unknown API path AND a servable-shaped path that
 *  resolves to no file — `serveStaticFile` is total and falls through to the
 *  router's 404, so there is no separate static error shape). */
const NOT_FOUND_ENVELOPE =
	'{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_NOT_FOUND","message":"no such path \\"{{PATH}}\\"","hint":"The server serves /api/version, /api/swarm/snapshot, /api/swarm/events, the WS /api/swarm/stream, and the token-gated POST /api/workers/<id>/steer and /api/asks/<id>/answer — check the path."}}';

/** The seeded two-row journal rows (the events endpoint AND the WS events
 *  frame carry byte-identical rows — ONE spelling). */
const SEEDED_EVENTS_ROWS =
	'[{"seq":1,"ts":"2026-06-01T00:00:00.000Z","kind":"spawn","sessionId":"sess-alpha","task":"alpha-fleet","worker":"w1","payload":{"backend":"herdr","placementRef":"herdr:pane:1","briefPath":"/b.md","briefText":"# b"}},{"seq":2,"ts":"2026-06-01T00:00:00.000Z","kind":"progress","sessionId":"sess-alpha","task":"alpha-fleet","worker":"w1","payload":{"phase":"build","pct":50}}]';

export const HTTP_GOLDENS = {
	/** GET /api/version — fully static except the extension version. */
	version: '{"ok":true,"schemaVersion":1,"serverVersion":"{{VERSION}}","protocol":"swarm-http/1"}',

	/** 404 unknown path — canned hint, message embeds the path. */
	notFound: NOT_FOUND_ENVELOPE,

	/** Static-asset path that resolves to no file — the SAME generic 404
	 *  envelope as an unknown API path (there is no separate static error
	 *  shape; the asset resolver falls through to this router 404). */
	staticNotFound: NOT_FOUND_ENVELOPE,

	/** WS upgrade refused on a non-stream path / bad cursor / missing key
	 *  (src/swarm-server/http1.ts:288 + ./stream.ts refusals): a PLAIN
	 *  HTTP 400 E_SWARM_USAGE envelope, never a 101 handshake. */
	upgradeRefused:
		'{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_USAGE","message":"websocket upgrade refused","hint":"Only /api/swarm/stream speaks WebSocket; other paths are plain JSON requests."}}',

	/** 405 method on a GET path. */
	methodNotAllowed: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_USAGE","message":"method POST is not served on \\"{{PATH}}\\"; it is a GET path","hint":"Use GET with the documented query flags, or POST {text} to a mutation path with a canonical worker id."}}',

	/** 400 invalid events cursor. */
	invalidAfter: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_USAGE","message":"--after must be an integer journal seq cursor, got \\"{{VALUE}}\\"","hint":"Run the swarm CLI with a known verb and the flags that verb requires."}}',

	/** GET /api/swarm/events over the seeded two-row journal. */
	events: `{"ok":true,"verb":"events","schemaVersion":1,"after":0,"events":${SEEDED_EVENTS_ROWS},"journal":{"count":2,"dbSizeBytes":{{DBSIZE}}}}`,

	/** GET /api/swarm/events over an ABSENT journal (empty-but-valid). */
	eventsEmpty: '{"ok":true,"verb":"events","schemaVersion":1,"after":0,"events":[],"journal":{"count":0,"dbSizeBytes":0}}',

	/** The fleet-unknown refusal (issue #65 item 3): the ONE spelling shared
	 *  by the index, events and scoped-stream routes. */
	fleetNotFound: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_NOT_FOUND","message":"no such fleet \\"{{ID}}\\"","hint":"The fleet path takes a SwarmGraph session node id; enumerate them with GET /api/swarm/fleets."}}',

	/** GET /api/swarm/fleets on the multi-fleet fixture (issue #65 item 3). */
	fleets: '{"ok":true,"schemaVersion":1,"self":{"sessionId":"36f9edae","sessionPath":"/sessions/orch.jsonl"},"fleets":[{"sessionId":"1b863e90","sessionPath":"/sessions/w1.jsonl","own":false,"tasks":["alpha-fleet"]},{"sessionId":"36f9edae","sessionPath":"/sessions/orch.jsonl","own":true,"tasks":["alpha-fleet"]},{"sessionId":"7fed90cf","sessionPath":"/sessions/foreign1.jsonl","own":false,"tasks":["beta-fleet"]},{"sessionId":"c97a214a","sessionPath":"/sessions/absent-w3.jsonl","own":false,"tasks":["alpha-fleet"]},{"sessionId":"ef2f5792","sessionPath":"/sessions/other.jsonl","own":false,"tasks":["beta-fleet"]},{"sessionId":"sess-alpha","sessionPath":null,"own":false,"tasks":["alpha-fleet"]}]}',

	/** GET /fleets/<id>/api/swarm/events — the fleet's OWN rows only (the
	 *  per-audience cursor precedent: attention never crosses fleets). */
	fleetEvents: `{"ok":true,"verb":"events","schemaVersion":1,"after":0,"events":${SEEDED_EVENTS_ROWS},"journal":{"count":2,"dbSizeBytes":{{DBSIZE}}}}`,

	/** The same route for a fleet with no rows of its own — an empty-but-valid
	 *  envelope, never a foreign row (no cross-traffic). */
	fleetEventsEmpty: '{"ok":true,"verb":"events","schemaVersion":1,"after":0,"events":[],"journal":{"count":0,"dbSizeBytes":{{DBSIZE}}}}',

	/** GET /api/swarm/snapshot — the multi-fleet fixture, all four degraded
	 *  flags. EXPATH = sandbox exchange root; session paths are FIXED (the
	 *  usage resolver is injected so no sandbox path enters a node id). */
	snapshot:
		'{"ok":true,"verb":"snapshot","snapshot":{"schemaVersion":1,"available":true,"sources":{"journal":true,"manifests":true,"liveStatus":false,"usage":true},"nodes":[{"kind":"session","id":"1b863e90","sessionPath":"/sessions/w1.jsonl","role":"worker","isWorker":true,"ownsChildren":false,"tasks":["alpha-fleet"],"degraded":[{"flag":"no-live-status"}],"depth":0,"usage":{"outputTokens":42,"contextPct":0}},{"kind":"session","id":"36f9edae","sessionPath":"/sessions/orch.jsonl","role":"orchestrator","isWorker":false,"ownsChildren":true,"tasks":["alpha-fleet"],"degraded":[]},{"kind":"session","id":"7fed90cf","sessionPath":"/sessions/foreign1.jsonl","role":"worker","isWorker":true,"ownsChildren":false,"tasks":["beta-fleet"],"degraded":[{"flag":"no-live-status"},{"flag":"usage-unavailable"}],"depth":0},{"kind":"session","id":"c97a214a","sessionPath":"/sessions/absent-w3.jsonl","role":"worker","isWorker":true,"ownsChildren":false,"tasks":["alpha-fleet"],"degraded":[{"flag":"no-live-status"},{"flag":"usage-unavailable"}],"depth":0},{"kind":"session","id":"ef2f5792","sessionPath":"/sessions/other.jsonl","role":"orchestrator","isWorker":false,"ownsChildren":true,"tasks":["beta-fleet"],"degraded":[]},{"kind":"session","id":"sess-alpha","role":"unknown","isWorker":false,"ownsChildren":false,"tasks":["alpha-fleet"],"degraded":[{"flag":"no-session-path"}]},{"kind":"task","id":"alpha-fleet","dir":"{{EXPATH}}/alpha-fleet","description":"alpha-fleet fixture","workers":[{"name":"w1","run":null,"placementRef":"herdr:pane:1","sessionId":"1b863e90","sessionPath":"/sessions/w1.jsonl","depth":0,"backend":"herdr","startedAt":"2026-06-01T00:10:00.000Z","manifestRef":{"task":"alpha-fleet","worker":"w1","run":null,"placementRef":"herdr:pane:1"},"degraded":[{"flag":"no-live-status"}]},{"name":"w2","run":null,"placementRef":"herdr:pane:2","depth":0,"backend":"herdr","startedAt":"2026-06-01T00:10:00.000Z","manifestRef":{"task":"alpha-fleet","worker":"w2","run":null,"placementRef":"herdr:pane:2"},"degraded":[{"flag":"no-session-path"},{"flag":"no-live-status"}]},{"name":"w3","run":null,"placementRef":"herdr:pane:3","sessionId":"c97a214a","sessionPath":"/sessions/absent-w3.jsonl","depth":0,"backend":"herdr","startedAt":"2026-06-01T00:10:00.000Z","manifestRef":{"task":"alpha-fleet","worker":"w3","run":null,"placementRef":"herdr:pane:3"},"degraded":[{"flag":"no-live-status"}]}],"degraded":[{"flag":"no-session-path"}],"depth":0},{"kind":"task","id":"beta-fleet","dir":"{{EXPATH}}/beta-fleet","description":"beta-fleet fixture","workers":[{"name":"foreign1","run":null,"placementRef":"herdr:pane:1","sessionId":"7fed90cf","sessionPath":"/sessions/foreign1.jsonl","depth":0,"backend":"herdr","startedAt":"2026-06-01T00:10:00.000Z","manifestRef":{"task":"beta-fleet","worker":"foreign1","run":null,"placementRef":"herdr:pane:1"},"degraded":[{"flag":"no-live-status"}]}],"degraded":[],"depth":0},{"kind":"task","id":"orphan-fleet","dir":"{{EXPATH}}/orphan-fleet","description":"orphan-fleet fixture","workers":[{"name":"orphan1","run":null,"placementRef":"herdr:pane:9","depth":0,"backend":"herdr","startedAt":"2026-06-01T00:10:00.000Z","manifestRef":{"task":"orphan-fleet","worker":"orphan1","run":null,"placementRef":"herdr:pane:9"},"degraded":[{"flag":"legacy-orphan"},{"flag":"no-session-path"},{"flag":"no-live-status"}]}],"degraded":[{"flag":"legacy-orphan"},{"flag":"no-session-path"}],"depth":0}],"edges":[{"kind":"spawned_by","from":"1b863e90","to":"36f9edae"},{"kind":"spawned_by","from":"7fed90cf","to":"ef2f5792"},{"kind":"spawned_by","from":"alpha-fleet","to":"36f9edae"},{"kind":"spawned_by","from":"alpha-fleet","to":"sess-alpha"},{"kind":"spawned_by","from":"beta-fleet","to":"ef2f5792"},{"kind":"spawned_by","from":"c97a214a","to":"36f9edae"}],"orphans":[{"task":"orphan-fleet","worker":"orphan1","run":null,"placementRef":"herdr:pane:9","reason":"legacy-orphan"}]}}',

	/** Console live frame (rpc-shaped fixture). */
	consoleLive: '{"ok":true,"schemaVersion":1,"worker":"w1","nodeId":"{{NODEID}}","task":"alpha","state":"live","chunk":"hello world","nextOffset":11,"oldestOffset":0,"dropped":false}',

	/** Console unavailable frame (captureless backend): HTTP 200 + E_*. */
	consoleUnavailable: '{"ok":true,"schemaVersion":1,"worker":"w1","nodeId":"{{NODEID}}","task":"alpha","state":"unavailable","chunk":"","nextOffset":0,"oldestOffset":0,"dropped":false,"error":{"code":"E_CONSOLE_UNAVAILABLE","message":"backend exposes no console stream","hint":"This backend exposes no console stream. Use a backend with console capture (the rpc backend) or read the worker\'s own terminal; nothing is fabricated here."}}',

	/** Console foreign/unknown refusal (fail-closed 404). */
	consoleRefused: '{"ok":false,"schemaVersion":1,"error":{"code":"E_CONSOLE_WORKER_REFUSED","message":"{{MESSAGE}}","hint":"The id must be the SwarmGraph node id of a worker session owned by THIS session\'s read-model. Unknown, non-worker and foreign ids are refused identically (fail-closed)."}}',

	/** Console bad offset (400). */
	consoleUsage: '{"ok":false,"schemaVersion":1,"error":{"code":"E_CONSOLE_USAGE","message":"invalid ?offset= value","hint":"Pass an integer ?offset=<n> (>= 0; omit for 0). The endpoint refuses non-numeric or negative offsets."}}',

	/** Mutation success (steer, journal mode; the durable audit row is appended
	 *  under the real storage mode — #69 operator ruling — so `journal` carries
	 *  the seq and `confirmation` is "confirmed"). */
	steerOk: '{"ok":true,"schemaVersion":1,"verb":"steer","worker":"w1","via":"http","answerPath":"{{ANSWER_PATH}}","journal":{"seq":{{SEQ}}},"confirmation":"confirmed","nudged":false}',

	/** Mutation success (steer, `files` storage mode — #69): Phase A appends NO
	 *  journal row, so `journal` is null and `confirmation` is the honest
	 *  "unavailable" (the dashboard settles delivered/unconfirmed). */
	steerOkFiles: '{"ok":true,"schemaVersion":1,"verb":"steer","worker":"w1","via":"http","answerPath":"{{ANSWER_PATH}}","journal":null,"confirmation":"unavailable","nudged":false}',

	/** Mutation success (answer; the same envelope with verb=answer). */
	answerOk: '{"ok":true,"schemaVersion":1,"verb":"answer","worker":"w1","via":"http","answerPath":"{{ANSWER_PATH}}","journal":{"seq":{{SEQ}}},"confirmation":"confirmed","nudged":false}',

	/** Mutation success (answer, `files` storage mode — #69; journal null). */
	answerOkFiles: '{"ok":true,"schemaVersion":1,"verb":"answer","worker":"w1","via":"http","answerPath":"{{ANSWER_PATH}}","journal":null,"confirmation":"unavailable","nudged":false}',

	/** Mutation auth refusal — missing and wrong token are byte-identical. */
	authRefused: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_AUTH","message":"missing or invalid operator token","hint":"Every mutation request needs Authorization: Bearer <operator token>; the token is printed on the session\'s stderr at mount."}}',

	/** Mutation ownership refusal — foreign and unknown ids are identical. */
	forbidden: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_FORBIDDEN","message":"the worker id is not owned by this session","hint":"The mutation surface only reaches workers this session spawned; check the id or use the delegate_mailbox tool."}}',

	/** Mutation body/id usage error (400). */
	mutationUsage: '{"ok":false,"schemaVersion":1,"error":{"code":"E_SWARM_USAGE","message":"{{MESSAGE}}","hint":"Use GET with the documented query flags, or POST {text} to a mutation path with a canonical worker id."}}',
} as const;

/**
 * The WS-stream frame goldens (issue #55 review F2). The stream hub and the
 * HTTP routes call the SAME builders (`buildSnapshotGraph`, the journal
 * reader), so the frames wrap the HTTP envelopes' OWN bytes — ONE spelling of
 * the snapshot graph and of the events rows. Key order matches the server's
 * frame objects (src/swarm-server/stream.ts): `ok, schemaVersion, type,
 * snapshot` and `ok, schemaVersion, type, after, events`.
 *
 * The console WS frames are the REST console frame byte-for-byte (ONE
 * `consoleFrame` spelling, ./console.ts): the api-check pins them against
 * `HTTP_GOLDENS.consoleLive` / `consoleUnavailable`.
 */
export const HTTP_STREAM_GOLDENS = {
	/** WS /api/swarm/stream FIRST frame: the snapshot graph the HTTP snapshot
	 *  envelope carries, in the stream frame's own wrapping. */
	streamSnapshot(tokens: Record<string, string>): string {
		const http = render(HTTP_GOLDENS.snapshot, tokens);
		const marker = '"snapshot":';
		const at = http.indexOf(marker);
		if (at === -1) throw new Error("swarm-http-goldens: snapshot envelope has no snapshot key");
		const graph = http.slice(at + marker.length, -1); // strip the envelope's closing brace
		return `{"ok":true,"schemaVersion":1,"type":"snapshot","snapshot":${graph}}`;
	},

	/** WS /api/swarm/stream event frame — the events envelope's rows. */
	streamEvents: `{"ok":true,"schemaVersion":1,"type":"events","after":{{AFTER}},"events":${SEEDED_EVENTS_ROWS}}`,
} as const;

/** The worker-console fixture graph: worker w1 owned by the `self` session,
 *  plus a FOREIGN worker (beta) for the foreign-fleet refusal leg. */
export function fixtureConsoleGraph(self: string, workerSessionPath = "/sessions/console-w1.jsonl"): SwarmGraph {
	const selfId = sessionIdFor(self);
	const workerId = sessionIdFor(workerSessionPath);
	const foreignPath = "/sessions/other.jsonl";
	const foreignId = sessionIdFor(foreignPath);
	const foreignWorkerPath = "/sessions/console-foreign.jsonl";
	const foreignWorkerId = sessionIdFor(foreignWorkerPath);
	return {
		schemaVersion: 1,
		available: true,
		sources: { journal: true, manifests: true, liveStatus: true, usage: false },
		nodes: [
			{ kind: "session", id: selfId, sessionPath: self, role: "orchestrator", isWorker: false, ownsChildren: true, tasks: ["alpha"], degraded: [] },
			{
				kind: "session",
				id: workerId,
				sessionPath: workerSessionPath,
				role: "worker",
				isWorker: true,
				ownsChildren: false,
				tasks: ["alpha"],
				degraded: [],
				depth: 0,
			},
			{ kind: "session", id: foreignId, sessionPath: foreignPath, role: "orchestrator", isWorker: false, ownsChildren: true, tasks: ["beta"], degraded: [] },
			{
				kind: "session",
				id: foreignWorkerId,
				sessionPath: foreignWorkerPath,
				role: "worker",
				isWorker: true,
				ownsChildren: false,
				tasks: ["beta"],
				degraded: [],
				depth: 0,
			},
			{
				kind: "task",
				id: "alpha",
				dir: "/checkouts/alpha",
				workers: [
					{
						name: "w1",
						run: null,
						placementRef: "rpc:1",
						sessionId: workerId,
						sessionPath: workerSessionPath,
						depth: 0,
						backend: "rpc",
						startedAt: "2026-06-01T00:10:00.000Z",
						manifestRef: { task: "alpha", worker: "w1", run: null, placementRef: "rpc:1" },
						degraded: [],
					},
				],
				degraded: [],
				depth: 0,
			},
			{
				kind: "task",
				id: "beta",
				dir: "/checkouts/beta",
				workers: [
					{
						name: "foreign1",
						run: null,
						placementRef: "rpc:2",
						sessionId: foreignWorkerId,
						sessionPath: foreignWorkerPath,
						depth: 0,
						backend: "rpc",
						startedAt: "2026-06-01T00:11:00.000Z",
						manifestRef: { task: "beta", worker: "foreign1", run: null, placementRef: "rpc:2" },
						degraded: [],
					},
				],
				degraded: [],
				depth: 0,
			},
		],
		edges: [
			{ kind: "spawned_by", from: workerId, to: selfId },
			{ kind: "spawned_by", from: foreignWorkerId, to: foreignId },
		],
		orphans: [],
	};
}

/** The console fixture's FOREIGN worker node id (the foreign-fleet refusal). */
export function fixtureForeignWorkerId(): string {
	return sessionIdFor("/sessions/console-foreign.jsonl");
}

/** The console fixture's worker node id (the id a client must pass). */
export function fixtureConsoleWorkerId(workerSessionPath = "/sessions/console-w1.jsonl"): string {
	return sessionIdFor(workerSessionPath);
}

/** The exchange-dir answer path of a mutation fixture. */
export function fixtureAnswerPath(exchangeRoot: string, task: string, worker: string): string {
	return join(exchangeRoot, task, `a-${worker}.json`);
}