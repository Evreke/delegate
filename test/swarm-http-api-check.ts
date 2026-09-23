/**
 * swarm-http-api-check — issue #55 acceptance 1 + 3 (ARCHITECTURE §4.2,
 * Law 7/Law 8/Law 10): the GOLDEN ENVELOPE SUITE of the session-hosted
 * HTTP/WS read + mutation surface. Every endpoint's success envelope AND
 * every structured-error shape is pinned against the frozen goldens in
 * ./swarm-http-goldens.ts (byte-exact; the additive discipline is exercised
 * by ./swarm-http-schema-diff-check.ts).
 *
 * Fixtures cover (brief #55 item 1): empty journal, multi-fleet, all four
 * degraded flags, herdr-unavailable console, foreign-fleet refusal, and
 * wrong/absent operator token.
 *
 * Covers:
 *   V  /api/version pinned; 404 E_SWARM_NOT_FOUND; 405 E_SWARM_USAGE;
 *      events 400 E_SWARM_USAGE (schemaVersion on every error — Law 7).
 *   S  snapshot envelope over the multi-fleet fixture: empty journal absent,
 *      all four degraded flags (no-live-status, no-session-path,
 *      legacy-orphan, usage-unavailable), orphan basket, multi-fleet.
 *   E  events envelope over the seeded journal; empty-journal mount.
 *   C  console frames: rpc live, captureless (herdr) unavailable, foreign
 *      refusal, bad offset.
 *   M  mutation: steer/answer success, absent + wrong token (byte-identical),
 *      foreign-fleet refusal, malformed body.
 *
 * Run with: bun test/swarm-http-api-check.ts   (from repo root)
 * Fail-fast: top-level watchdog; every fetch is bounded.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_VERSION } from "../src/version.ts";
import type { AgentStatusName } from "../src/host.ts";
import { additiveViolations, fixtureAnswerPath, fixtureConsoleGraph, fixtureConsoleWorkerId, fixtureForeignWorkerId, HTTP_GOLDENS, render } from "./swarm-http-goldens.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-http-api-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 30_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-http-api-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
const ABSENT_DB = join(SANDBOX, "absent", "events.db");
mkdirSync(AGENT, { recursive: true });
mkdirSync(EX, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;
process.env.SWARM_FIXED_TS = "2026-06-01T00:00:00.000Z";

const SELF = "/sessions/orch.jsonl";
const TOKEN = "http-golden-token";
const FIXED_MS = Date.parse("2026-06-01T00:00:00.000Z");
/** Deterministic usage resolver (fixed session path → fixed summary) so no
 *  sandbox path enters a session-node id and the golden stays machine-
 *  independent; a path not in the map degrades to usage-unavailable. */
const usageResolver = (sessionPath: string) => (sessionPath === "/sessions/w1.jsonl" ? { outputTokens: 42, contextPct: 0 } : null);
/** JSON-escape a fragment for a golden template's in-string placeholder. */
const jstr = (s: string): string => JSON.stringify(s).slice(1, -1);

function writeManifest(task: string, masterSessionPath: string | undefined, workers: unknown[]): void {
	const dir = join(EX, task);
	mkdirSync(dir, { recursive: true });
	const m: Record<string, unknown> = { schemaVersion: 1, task, dir, description: `${task} fixture`, workers };
	if (masterSessionPath !== undefined) m.masterSessionPath = masterSessionPath;
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, "\t")}\n`, "utf8");
}

const P = { kind: "tab", checkoutPath: "/repo", backend: "herdr", placementRef: "herdr:pane:1" };
const base = {
	placement: P,
	briefPath: "/b.md",
	reportPath: "/r.json",
	provider: "p",
	model: "m",
	thinking: "low",
	startedAt: "2026-06-01T00:10:00.000Z",
	orchestratorSessionPath: SELF,
	depth: 0,
};
// Multi-fleet: alpha (mine: w1 usage, w2 no session path, w3 missing usage file),
// beta (foreign), orphan (no resolvable parent → legacy-orphan).
writeManifest("alpha-fleet", SELF, [
	{ ...base, name: "w1", sessionPath: "/sessions/w1.jsonl", placement: { ...P, placementRef: "herdr:pane:1" } },
	{ ...base, name: "w2", placement: { ...P, placementRef: "herdr:pane:2" } },
	{ ...base, name: "w3", sessionPath: "/sessions/absent-w3.jsonl", placement: { ...P, placementRef: "herdr:pane:3" } },
]);
writeManifest("beta-fleet", "/sessions/other.jsonl", [
	{ ...base, name: "foreign1", sessionPath: "/sessions/foreign1.jsonl", orchestratorSessionPath: "/sessions/other.jsonl" },
]);
writeManifest("orphan-fleet", undefined, [{ ...base, name: "orphan1", orchestratorSessionPath: undefined, placement: { ...P, placementRef: "herdr:pane:9" } }]);

type Handle = { stop(): void; port: number; address: string };

/** One console transport with a streamConsole backlog then an idle tail. */
function consoleTransport(chunks: string[], status: AgentStatusName = "working") {
	return {
		backendName: () => "rpc",
		listStatuses: async () => [{ name: "w1", status, placementRef: "rpc:1" }],
		streamConsole: (_name: string) => {
			let i = 0;
			const sub = {
				[Symbol.asyncIterator]() {
					return sub;
				},
				async next(): Promise<IteratorResult<{ workerName: string; seq: number; timestamp: number; kind: string; payload: string }>> {
					if (i < chunks.length) {
						const payload = chunks[i]!;
						i += 1;
						return { value: { workerName: "w1", seq: i, timestamp: FIXED_MS, kind: "raw", payload }, done: false };
					}
					return new Promise(() => {}); // idle live tail — the capture's drain stops here
				},
				unsubscribe: () => {},
			};
			return sub;
		},
	};
}

async function main(): Promise<void> {
	const { createJournalWriter } = await import("../src/swarm/journal.ts");
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");

	const w = createJournalWriter({ dbPath: DB, clock: { now: () => FIXED_MS, delay: () => Promise.resolve() } });
	for (const r of [
		{ kind: "spawn", sessionId: "sess-alpha", task: "alpha-fleet", worker: "w1", payload: { backend: "herdr", placementRef: "herdr:pane:1", briefPath: "/b.md", briefText: "# b" } },
		{ kind: "progress", sessionId: "sess-alpha", task: "alpha-fleet", worker: "w1", payload: { phase: "build", pct: 50 } },
	] as const) {
		const res = await w.append(r);
		if (!res.ok) throw new Error(`seed failed: ${res.code}`);
	}
	w.close();

	const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
		const e: NodeJS.ProcessEnv = { ...process.env };
		delete e.SWARM_SERVER_ENABLED;
		delete e.SWARM_SERVER_PORT;
		return { ...e, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0", ...extra };
	};

	async function req(port: number, method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string } = {}): Promise<{ status: number; body: string }> {
		const headers: Record<string, string> = {};
		if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
		let body: string | undefined;
		if (opts.rawBody !== undefined) body = opts.rawBody;
		else if (opts.body !== undefined) {
			body = JSON.stringify(opts.body);
			headers["content-type"] = "application/json";
		}
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body, signal: AbortSignal.timeout(5_000) });
		return { status: res.status, body: await res.text() };
	}
	const get = (port: number, path: string) => req(port, "GET", path);

	/** Byte-exact golden + the additive discipline on the same bytes. */
	function golden(name: string, actual: { status: number; body: string }, expected: { status: number; body: string }) {
		const byteOk = actual.status === expected.status && actual.body === expected.body;
		let addOk = false;
		try {
			addOk = additiveViolations(JSON.parse(expected.body) as unknown, JSON.parse(actual.body) as unknown).length === 0;
		} catch {
			addOk = false;
		}
		check(name, byteOk && addOk, `status ${actual.status} (want ${expected.status}); body=${actual.body.slice(0, 200)}`);
	}

	// -----------------------------------------------------------------------
	// Mount A — read + mutation (files mode, no transport)
	// -----------------------------------------------------------------------
	const h = await mountSwarmServer({ sessionFile: SELF, env: env(), operatorToken: TOKEN, usage: usageResolver });
	check("A0 main mount returns a handle", h !== null);
	if (!h) throw new Error("cannot continue without a mounted server");

	// --- V: version + error taxonomy --------------------------------------
	const versionGolden = render(HTTP_GOLDENS.version, { VERSION: EXTENSION_VERSION });
	golden("V1 GET /api/version → byte-exact frozen envelope", await get(h.port, "/api/version"), { status: 200, body: versionGolden });
	golden("V2 unknown path → 404 E_SWARM_NOT_FOUND (schemaVersion present)", await get(h.port, "/api/nope"), {
		status: 404,
		body: render(HTTP_GOLDENS.notFound, { PATH: "/api/nope" }),
	});
	golden("V3 POST on a GET path → 405 E_SWARM_USAGE", await req(h.port, "POST", "/api/version", { body: {} }), {
		status: 405,
		body: render(HTTP_GOLDENS.methodNotAllowed, { PATH: "/api/version" }),
	});
	golden("V4 events bad cursor → 400 E_SWARM_USAGE", await get(h.port, "/api/swarm/events?after=abc"), {
		status: 400,
		body: render(HTTP_GOLDENS.invalidAfter, { VALUE: "abc" }),
	});

	// --- E: events over the seeded journal --------------------------------
	const ev = await get(h.port, "/api/swarm/events?after=0");
	let dbSize = "";
	try {
		dbSize = String((JSON.parse(ev.body) as { journal: { dbSizeBytes: number } }).journal.dbSizeBytes);
	} catch {
		/* failure detail below */
	}
	golden("E1 events over the seeded journal → byte-exact golden (dbSize substituted)", ev, {
		status: 200,
		body: render(HTTP_GOLDENS.events, { DBSIZE: dbSize }),
	});

	// --- S: snapshot over the multi-fleet fixture -------------------------
	const snap = await get(h.port, "/api/swarm/snapshot");
	golden("S1 snapshot → byte-exact golden (sandbox paths substituted)", snap, {
		status: 200,
		body: render(HTTP_GOLDENS.snapshot, { EXPATH: EX }),
	});
	{
		const g = (JSON.parse(snap.body) as { snapshot: { nodes: Array<Record<string, unknown>>; orphans: Array<Record<string, unknown>> } }).snapshot;
		const flagText = JSON.stringify(g);
		const flags = ["no-live-status", "no-session-path", "legacy-orphan", "usage-unavailable"];
		check(
			"S2 all four degraded flags appear in the snapshot (Law 13 degraded-fields contract)",
			flags.every((f) => flagText.includes(`"${f}"`)),
			flagText.slice(0, 200),
		);
		const tasks = g.nodes.filter((n) => n.kind === "task").map((n) => n.id);
		check("S3 multi-fleet: three task nodes (alpha-fleet, beta-fleet, orphan-fleet)", tasks.join(",") === "alpha-fleet,beta-fleet,orphan-fleet", tasks.join(","));
		check(
			"S4 orphan basket carries the legacy-orphan entry",
			g.orphans.length === 1 && (g.orphans[0] as { reason?: string }).reason === "legacy-orphan" && (g.orphans[0] as { worker?: string }).worker === "orphan1",
			JSON.stringify(g.orphans),
		);
	}

	// --- C: console (separate mounts with injected fixture graphs) --------
	const consoleSelf = "/sessions/console-rpc.jsonl";
	const graph = fixtureConsoleGraph(consoleSelf);
	const nodeId = fixtureConsoleWorkerId();
	{
		const hc = await mountSwarmServer({ sessionFile: consoleSelf, transport: consoleTransport(["hello ", "world"]) as never, graph, env: env() });
		check("C0 console live mount returns a handle", hc !== null);
		if (hc) {
			golden("C1 console live frame → byte-exact envelope (state live)", await get(hc.port, `/api/workers/${nodeId}/console`), {
				status: 200,
				body: render(HTTP_GOLDENS.consoleLive, { NODEID: nodeId }),
			});
			golden("C2 console bad offset → 400 E_CONSOLE_USAGE", await get(hc.port, `/api/workers/${nodeId}/console?offset=abc`), {
				status: 400,
				body: HTTP_GOLDENS.consoleUsage,
			});
			hc.stop();
		}
	}
	{
		// Captureless (herdr-shaped) backend → 200 unavailable frame, never an error.
		const hHerdr = await mountSwarmServer({
			sessionFile: "/sessions/console-herdr.jsonl",
			transport: { backendName: () => "herdr", listStatuses: async () => [] as Array<{ name: string; status: AgentStatusName }> } as never,
			graph: fixtureConsoleGraph("/sessions/console-herdr.jsonl"),
			env: env(),
		});
		check("C3 herdr-unavailable console mount returns a handle", hHerdr !== null);
		if (hHerdr) {
			golden("C3.1 captureless backend → 200 state:unavailable + E_CONSOLE_UNAVAILABLE (never an HTTP error)", await get(hHerdr.port, `/api/workers/${nodeId}/console`), {
				status: 200,
				body: render(HTTP_GOLDENS.consoleUnavailable, { NODEID: nodeId }),
			});
			hHerdr.stop();
		}
	}
	{
		const hc = await mountSwarmServer({ sessionFile: "/sessions/console-refuse.jsonl", transport: consoleTransport(["x"]) as never, graph: fixtureConsoleGraph("/sessions/console-refuse.jsonl"), env: env() });
		if (hc) {
			const unknown = "deadbeef";
			golden("C4 unknown console id → 404 E_CONSOLE_WORKER_REFUSED (fail-closed)", await get(hc.port, `/api/workers/${unknown}/console`), {
				status: 404,
				body: render(HTTP_GOLDENS.consoleRefused, { MESSAGE: jstr(`no worker session node "${unknown}" in the read-model`) }),
			});
			const foreignId = fixtureForeignWorkerId();
			golden("C5 foreign-fleet console id → 404 E_CONSOLE_WORKER_REFUSED (no existence oracle)", await get(hc.port, `/api/workers/${foreignId}/console`), {
				status: 404,
				body: render(HTTP_GOLDENS.consoleRefused, { MESSAGE: jstr(`worker "${foreignId}" is not owned by this session (verdict foreign)`) }),
			});
			hc.stop();
		}
	}

	// --- M: mutation surface ----------------------------------------------
	const answerPath = fixtureAnswerPath(EX, "alpha-fleet", "w1");
	golden("M1 steer success → byte-exact mutation envelope (files mode: journal null)", await req(h.port, "POST", "/api/workers/w1/steer", { token: TOKEN, body: { text: "carry on" } }), {
		status: 200,
		body: render(HTTP_GOLDENS.steerOk, { ANSWER_PATH: answerPath }),
	});
	const noToken = await req(h.port, "POST", "/api/workers/w1/steer", { body: { text: "x" } });
	const wrongToken = await req(h.port, "POST", "/api/workers/w1/steer", { token: "wrong", body: { text: "x" } });
	golden("M2 absent token → 401 E_SWARM_AUTH", noToken, { status: 401, body: HTTP_GOLDENS.authRefused });
	check("M3 wrong token → byte-identical refusal (indistinguishable)", wrongToken.status === 401 && wrongToken.body === noToken.body, `wrong=${wrongToken.body}`);
	golden("M4 foreign-fleet id → 403 E_SWARM_FORBIDDEN (fail-closed)", await req(h.port, "POST", "/api/workers/foreign1/steer", { token: TOKEN, body: { text: "x" } }), {
		status: 403,
		body: HTTP_GOLDENS.forbidden,
	});
	golden("M5 malformed body → 400 E_SWARM_USAGE", await req(h.port, "POST", "/api/workers/w1/steer", { token: TOKEN, rawBody: "not json" }), {
		status: 400,
		body: render(HTTP_GOLDENS.mutationUsage, { MESSAGE: jstr('a JSON body with a non-empty string "text" is required') }),
	});
	{
		writeFileSync(join(EX, "alpha-fleet", "q-w1.json"), `${JSON.stringify({ worker: "w1", ts: "2026-06-01T00:00:00.000Z", question: "which color?" })}\n`, "utf8");
		golden("M6 answer success → byte-exact envelope, verb answer", await req(h.port, "POST", "/api/asks/w1/answer", { token: TOKEN, body: { text: "42" } }), {
			status: 200,
			body: render(HTTP_GOLDENS.answerOk, { ANSWER_PATH: answerPath }),
		});
	}
	h.stop();

	// -----------------------------------------------------------------------
	// Mount C — empty-journal events envelope
	// -----------------------------------------------------------------------
	{
		const hE = await mountSwarmServer({ sessionFile: "/sessions/empty.jsonl", env: env({ SWARM_JOURNAL_DB: ABSENT_DB }) });
		check("E2.0 empty-journal mount returns a handle", hE !== null);
		if (hE) {
			golden("E2 events over an ABSENT journal → byte-exact empty-but-valid golden", await get(hE.port, "/api/swarm/events?after=0"), {
				status: 200,
				body: HTTP_GOLDENS.eventsEmpty,
			});
			hE.stop();
		}
	}
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

watchdog.close?.();
if (failures > 0) {
	console.error(`\nswarm-http-api-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-http-api-check: all checks passed");
process.exit(0);