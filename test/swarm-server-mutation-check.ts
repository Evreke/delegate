/**
 * swarm-server-mutation-check — issue #51 acceptance 1–6 (ARCHITECTURE §4.2,
 * Law 4/6/8/11): the session-hosted server's MUTATION surface — the two
 * operator-token-gated POST endpoints that route through the SAME
 * orchestrator mailbox core the delegate_mailbox tool uses:
 *
 *   POST /api/workers/<id>/steer   {text}
 *   POST /api/asks/<id>/answer     {text}
 *
 * Covers:
 *   M1 operator token: generated at mount and surfaced ONLY on stderr; the
 *      token string never appears in a response body or in the journal.
 *   M2 auth gate: missing/wrong Bearer token → the uniform E_SWARM_AUTH
 *      refusal (same body either way); GET/WS stay open.
 *   M3 steer: reaches the owned fixture worker — the a-<name>.json envelope
 *      is written with the frozen writer byte-shape and the journal carries
 *      a `steer` row with `via:"http"`.
 *   M4 answer: posts the a-file, archives the pending question and appends
 *      the `answer` journal row.
 *   M5 ownership: a foreign-fleet id and an unknown id both refuse
 *      (fail-closed, E_SWARM_FORBIDDEN).
 *   M6 usage/shape: invalid body / empty text / bad id → structured E_*.
 *   M7 no write path bypasses the journal: every successful HTTP mutation
 *      produced exactly one journal row.
 *   M8 CLI verbs unchanged: the read verbs still run with no token.
 *   M9 #69 confirmation envelope (operator ruling): files mode appends NO
 *      journal row and answers `confirmation:"unavailable"` — the dashboard
 *      settles the marker at delivered/unconfirmed, never a forever-pending
 *      spinner; journal mode still yields a durable row + `"confirmed"`.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every fetch
 * is loopback and bounded by it. Exit 0 only if all checks pass.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatusName } from "../src/host.ts";
import type { ExchangeManifest } from "../src/manifest-store.ts";
import type { SwarmGraph } from "../src/swarm/graph.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-server-mutation-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-mutation-check-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
const ALPHA = join(EX, "alpha");
const BETA = join(EX, "beta");
mkdirSync(AGENT, { recursive: true });
mkdirSync(ALPHA, { recursive: true });
mkdirSync(BETA, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;
process.env.SWARM_STORAGE = "journal";
process.env.SWARM_SESSION_ID = "sess-51";
process.env.SWARM_SERVER_ENABLED = "1";
process.env.SWARM_SERVER_PORT = "0";
process.env.SWARM_FIXED_TS = "2026-07-01T00:00:00.000Z";

const SELF = "/sessions/orch.jsonl";
const TOKEN = "test-token-51-abc";

/** Minimal manifest rows for the ownership gate (read-model input seam). */
const MANIFESTS: ExchangeManifest[] = [
	{
		schemaVersion: 1,
		task: "alpha",
		dir: ALPHA,
		masterSessionPath: SELF,
		workers: [
			{
				name: "w1",
				placement: { kind: "tab", backend: "fake", placementRef: "fake:1", checkoutPath: "/checkouts/w1" },
				briefPath: join(ALPHA, "brief-w1.md"),
				reportPath: join(ALPHA, "report-w1.json"),
				provider: "p",
				model: "m",
				thinking: "off",
				startedAt: "2026-07-01T00:00:00.000Z",
				orchestratorSessionPath: SELF,
			},
			{
				name: "w2",
				placement: { kind: "tab", backend: "fake", placementRef: "fake:3", checkoutPath: "/checkouts/w2" },
				briefPath: join(ALPHA, "brief-w2.md"),
				reportPath: join(ALPHA, "report-w2.json"),
				provider: "p",
				model: "m",
				thinking: "off",
				startedAt: "2026-07-01T00:00:00.000Z",
				orchestratorSessionPath: SELF,
			},
		],
	},
	{
		schemaVersion: 1,
		task: "beta",
		dir: BETA,
		masterSessionPath: "/sessions/other.jsonl",
		workers: [
			{
				name: "foreign1",
				placement: { kind: "tab", backend: "fake", placementRef: "fake:2", checkoutPath: "/checkouts/foreign1" },
				briefPath: join(BETA, "brief-foreign1.md"),
				reportPath: join(BETA, "report-foreign1.json"),
				provider: "p",
				model: "m",
				thinking: "off",
				startedAt: "2026-07-01T00:00:00.000Z",
				orchestratorSessionPath: "/sessions/other.jsonl",
			},
		],
	},
];

type Handle = { stop(): void; port: number; address: string };

async function main(): Promise<void> {
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");

	const fakeTransport = () => ({
		backendName: () => "fake",
		listStatuses: async () => [] as Array<{ name: string; status: AgentStatusName; placementRef?: string }>,
		getStatus: async () => ({ name: "w1", status: "idle" as AgentStatusName }),
		submitPrompt: async () => {},
	});

	async function withStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
		const lines: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
			lines.push(s);
			return true;
		};
		try {
			return { result: await fn(), lines };
		} finally {
			(process.stderr as unknown as { write: (s: string) => boolean }).write = realWrite;
		}
	}

	async function req(
		port: number,
		method: string,
		path: string,
		opts: { token?: string; body?: unknown; rawBody?: string } = {},
	): Promise<{ status: number; body: string; json: Record<string, unknown> | null }> {
		const headers: Record<string, string> = {};
		if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
		let body: string | undefined;
		if (opts.rawBody !== undefined) body = opts.rawBody;
		else if (opts.body !== undefined) {
			body = JSON.stringify(opts.body);
			headers["content-type"] = "application/json";
		}
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method,
			headers,
			body,
			signal: AbortSignal.timeout(5_000),
		});
		const text = await res.text();
		let json: Record<string, unknown> | null = null;
		try {
			json = JSON.parse(text) as Record<string, unknown>;
		} catch {
			/* detail below */
		}
		return { status: res.status, body: text, json };
	}

	const manifests = { scan: () => MANIFESTS };

	// -----------------------------------------------------------------------
	// M1 — operator token: generated at mount, surfaced only on stderr
	// -----------------------------------------------------------------------
	{
		const { result: h, lines } = await withStderr(() =>
			mountSwarmServer({
				sessionFile: SELF,
				transport: fakeTransport(),
				manifests,
				env: { ...process.env },
			}),
		);
		check("M1.1 mount with the mutation surface enabled returns a handle", h !== null);
		const tokenLines = lines
			.map((l) => {
				try {
					return JSON.parse(l) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((o): o is Record<string, unknown> => o !== null && o.event === "operator-token");
		const token = typeof tokenLines[0]?.token === "string" ? (tokenLines[0].token as string) : "";
		check(
			"M1.2 the operator token is surfaced on ONE structured stderr line and is a 64-hex random string",
			tokenLines.length === 1 && /^[0-9a-f]{64}$/.test(token),
			JSON.stringify({ lines: tokenLines.length, tokenLen: token.length }),
		);
		if (h) {
			const v = await req(h.port, "GET", "/api/version");
			check("M1.3 the token never appears in a response body (GET surface)", !v.body.includes(token), v.body.slice(0, 80));
			h.stop();
		}
	}

	// -----------------------------------------------------------------------
	// Main mount: known token, in-memory manifest seam, journal storage
	// -----------------------------------------------------------------------
	const h: Handle | null = await mountSwarmServer({
		sessionFile: SELF,
		transport: fakeTransport(),
		manifests,
		operatorToken: TOKEN,
		env: { ...process.env },
	});
	check("M0 main mount returns a handle", h !== null);
	if (!h) {
		console.error("cannot continue without a mounted server");
		watchdog.close?.();
		process.exit(1);
	}

	// -----------------------------------------------------------------------
	// M2 — auth gate
	// -----------------------------------------------------------------------
	{
		const none = await req(h.port, "POST", "/api/workers/w1/steer", { body: { text: "x" } });
		const wrong = await req(h.port, "POST", "/api/workers/w1/steer", { token: "nope", body: { text: "x" } });
		const e1 = none.json?.error as { code?: string } | undefined;
		check(
			"M2.1 missing Bearer token → 401 E_SWARM_AUTH + schemaVersion, no mutation",
			none.status === 401 && none.json?.ok === false && none.json?.schemaVersion === 1 && e1?.code === "E_SWARM_AUTH",
			`${none.status} ${none.body}`,
		);
		check(
			"M2.2 wrong token → the SAME uniform refusal body (missing vs wrong indistinguishable)",
			wrong.status === 401 && wrong.body === none.body,
			`none=${none.body} wrong=${wrong.body}`,
		);
		const getOpen = await req(h.port, "GET", "/api/swarm/events?after=0");
		check("M2.3 GET stays open (no token required)", getOpen.status === 200 && getOpen.json?.ok === true, `${getOpen.status}`);
	}

	// -----------------------------------------------------------------------
	// M3 — steer through HTTP reaches the owned fixture worker
	// -----------------------------------------------------------------------
	{
		const steer = await req(h.port, "POST", "/api/workers/w1/steer", { token: TOKEN, body: { text: "please continue" } });
		check(
			"M3.1 POST /api/workers/w1/steer → 200 {ok, schemaVersion, ...}",
			steer.status === 200 && steer.json?.ok === true && steer.json?.schemaVersion === 1 && steer.json?.worker === "w1",
			`${steer.status} ${steer.body}`,
		);
		const aPath = join(ALPHA, "a-w1.json");
		check("M3.2 the mailbox envelope a-w1.json is written next to the brief", existsSync(aPath));
		const raw = existsSync(aPath) ? readFileSync(aPath, "utf8") : "";
		let envelope: Record<string, unknown> | null = null;
		try {
			envelope = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			/* detail below */
		}
		check(
			"M3.3 envelope byte-shape = the frozen writeAnswer format (tab-indented JSON + trailing newline, ordered keys)",
			raw.endsWith("\n") &&
				raw.startsWith('{\n\t"schemaVersion": 1,') &&
				raw.includes('\n\t"from": "orchestrator",') &&
				raw.includes('\n\t"answer": "please continue"'),
			JSON.stringify(raw.slice(0, 160)),
		);
		check(
			"M3.4 envelope carries from=orchestrator, a non-empty ts and the verbatim text",
			envelope?.from === "orchestrator" &&
				typeof envelope?.ts === "string" &&
				(envelope.ts as string).length > 0 &&
				envelope?.answer === "please continue",
			JSON.stringify(envelope),
		);

		const ev = await req(h.port, "GET", "/api/swarm/events?after=0");
		const events = (ev.json?.events as Array<Record<string, unknown>>) ?? [];
		const steerRow = events.find((e) => e.kind === "steer" && e.worker === "w1");
		const payload = steerRow?.payload as Record<string, unknown> | undefined;
		check(
			"M3.5 the journal carries a steer row for the worker with the additive via:\"http\"",
			steerRow !== undefined && payload?.text === "please continue" && payload?.via === "http",
			JSON.stringify(steerRow ?? null),
		);
		check(
			"M3.6 the token is absent from every journal payload",
			!JSON.stringify(events).includes(TOKEN),
			"token leaked into the journal",
		);

		// Golden: the TOOL's own posting core, fed the same text, produces the
		// same envelope bytes (modulo the wall-clock ts). This is the #51
		// acceptance-1 "byte-format = CLI-issued" proof — not a re-derived
		// expectation, but the other writer's real output.
		const { postSteerAndNudge } = await import("../src/mailbox-store.ts");
		await postSteerAndNudge(fakeTransport(), "w2", ALPHA, "please continue");
		const toolRaw = readFileSync(join(ALPHA, "a-w2.json"), "utf8");
		const stripTs = (s: string) => s.replace(/"ts": "[^"]*"/, '"ts": "<ts>"');
		check(
			"M3.7 HTTP-issued a-file is byte-identical (modulo ts) to the tool core's own output — same writer, not a copy",
			stripTs(raw) === stripTs(toolRaw),
			`http=${raw} tool=${toolRaw}`,
		);
	}

	// -----------------------------------------------------------------------
	// M4 — answer through HTTP unblocks the waiting worker
	// -----------------------------------------------------------------------
	{
		// Seed a pending question exactly as `swarm ask` would (same envelope).
		const qPath = join(ALPHA, "q-w1.json");
		writeFileSync(qPath, JSON.stringify({ worker: "w1", ts: "2026-07-01T00:00:00.000Z", question: "which color?" }) + "\n");
		const answer = await req(h.port, "POST", "/api/asks/w1/answer", { token: TOKEN, body: { text: "42" } });
		check(
			"M4.1 POST /api/asks/w1/answer → 200 {ok, schemaVersion, ...}",
			answer.status === 200 && answer.json?.ok === true && answer.json?.schemaVersion === 1,
			`${answer.status} ${answer.body}`,
		);
		const aRaw = readFileSync(join(ALPHA, "a-w1.json"), "utf8");
		check("M4.2 the answer overwrote the a-w1.json envelope", aRaw.includes('"answer": "42"'));
		check("M4.3 the pending question was archived (q-w1.json gone)", !existsSync(qPath));
		const archived = readdirSync(ALPHA).some((f) => /^q-w1\.answered-\d+\.json$/.test(f));
		check("M4.4 the archived question keeps the q-w1.answered-<ts>.json name", archived, readdirSync(ALPHA).join(","));

		const ev = await req(h.port, "GET", "/api/swarm/events?after=0");
		const events = (ev.json?.events as Array<Record<string, unknown>>) ?? [];
		const answerRow = events.find((e) => e.kind === "answer" && e.worker === "w1");
		const payload = answerRow?.payload as Record<string, unknown> | undefined;
		check(
			"M4.5 the journal carries an answer row with the additive via:\"http\"",
			answerRow !== undefined && payload?.text === "42" && payload?.via === "http",
			JSON.stringify(answerRow ?? null),
		);
	}

	// -----------------------------------------------------------------------
	// M5 — ownership gate is fail-closed
	// -----------------------------------------------------------------------
	{
		const foreign = await req(h.port, "POST", "/api/workers/foreign1/steer", { token: TOKEN, body: { text: "x" } });
		const ghost = await req(h.port, "POST", "/api/workers/ghost/steer", { token: TOKEN, body: { text: "x" } });
		const code = (r: { json: Record<string, unknown> | null }) => (r.json?.error as { code?: string } | undefined)?.code;
		check(
			"M5.1 a foreign-fleet id refuses fail-closed (403 E_SWARM_FORBIDDEN)",
			foreign.status === 403 && code(foreign) === "E_SWARM_FORBIDDEN",
			`${foreign.status} ${foreign.body}`,
		);
		check(
			"M5.2 an unknown id refuses the same way (existence is not leaked)",
			ghost.status === 403 && code(ghost) === "E_SWARM_FORBIDDEN" && ghost.body === foreign.body,
			`${ghost.status} ${ghost.body}`,
		);
		check("M5.3 no a-file was written for the refused ids", !existsSync(join(BETA, "a-foreign1.json")));
	}

	// -----------------------------------------------------------------------
	// M6 — usage/shape errors are structured (Law 8)
	// -----------------------------------------------------------------------
	{
		const empty = await req(h.port, "POST", "/api/workers/w1/steer", { token: TOKEN, body: { text: "   " } });
		const garbage = await req(h.port, "POST", "/api/workers/w1/steer", { token: TOKEN, rawBody: "not json" });
		const badId = await req(h.port, "POST", "/api/workers/W1/steer", { token: TOKEN, body: { text: "x" } });
		const code = (r: { json: Record<string, unknown> | null }) => (r.json?.error as { code?: string } | undefined)?.code;
		check(
			"M6.1 empty text → 400 E_SWARM_USAGE with schemaVersion",
			empty.status === 400 && empty.json?.schemaVersion === 1 && code(empty) === "E_SWARM_USAGE",
			`${empty.status} ${empty.body}`,
		);
		check("M6.2 malformed JSON body → 400 E_SWARM_USAGE", garbage.status === 400 && code(garbage) === "E_SWARM_USAGE", `${garbage.status}`);
		check("M6.3 a non-canonical worker id → 400 E_SWARM_USAGE", badId.status === 400 && code(badId) === "E_SWARM_USAGE", `${badId.status}`);
		const nf = await req(h.port, "POST", "/api/nope", { token: TOKEN, body: { text: "x" } });
		check("M6.4 unknown POST path → 404 E_SWARM_NOT_FOUND", nf.status === 404 && code(nf) === "E_SWARM_NOT_FOUND", `${nf.status}`);
	}

	// -----------------------------------------------------------------------
	// M7 — no write path bypasses the journal (functional): two successes,
	//      exactly two mutation rows in the journal
	// -----------------------------------------------------------------------
	{
		const ev = await req(h.port, "GET", "/api/swarm/events?after=0");
		const events = (ev.json?.events as Array<Record<string, unknown>>) ?? [];
		const mutations = events.filter((e) => e.kind === "steer" || e.kind === "answer");
		check(
			"M7.1 every successful HTTP mutation produced exactly one journal row (2 rows for 2 successes)",
			mutations.length === 2,
			JSON.stringify(mutations.map((m) => m.kind)),
		);
	}

	h.stop();

	// -----------------------------------------------------------------------
	// M9 — #69 operator ruling (2026-09-25T09:40Z): the confirmation envelope.
	//      `files` storage mode is Phase A (§4.1.3) — the HTTP mutation appends
	//      NO journal row, the envelope says confirmation "unavailable", and the
	//      dashboard settles the marker at the honest delivered/unconfirmed
	//      state instead of spinning on `pending` forever. The companion leg
	//      proves journal mode still yields a durable row + "confirmed".
	// -----------------------------------------------------------------------
	{
		/** The REAL dashboard mutation pipeline (public/mutations.js) pointed at
		 *  one mounted server, with the token already in an in-memory store. */
		const dashboardFor = async (port: number) => {
			const mod = await import(new URL("../src/swarm-server/public/mutations.js", import.meta.url).href);
			const mem = new Map<string, string>();
			return mod.createMutations({
				fetch: (url: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${url}`, init),
				storage: {
					getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
					setItem: (k: string, v: string) => {
						mem.set(k, String(v));
					},
					removeItem: (k: string) => {
						mem.delete(k);
					},
				},
				prompt: () => TOKEN,
				currentSeq: () => 0,
			});
		};

		// --- files mode: no row → "unavailable" → honest delivered state ------
		const FILES_DB = join(SANDBOX, "journal-files", "events.db");
		const hf = await mountSwarmServer({
			sessionFile: SELF,
			transport: fakeTransport(),
			manifests,
			operatorToken: TOKEN,
			env: { ...process.env, SWARM_STORAGE: "files", SWARM_JOURNAL_DB: FILES_DB },
		});
		check("M9.1 a files-mode mount returns a handle", hf !== null);
		if (hf) {
			const steer = await req(hf.port, "POST", "/api/workers/w1/steer", { token: TOKEN, body: { text: "files-mode steer" } });
			check(
				"M9.2 files-mode steer → journal null + confirmation \"unavailable\" (Phase A appends no row)",
				steer.status === 200 && steer.json?.ok === true && steer.json?.journal === null && steer.json?.confirmation === "unavailable",
				`${steer.status} ${steer.body}`,
			);
			const ev = await req(hf.port, "GET", "/api/swarm/events?after=0");
			const events = (ev.json?.events as Array<Record<string, unknown>>) ?? [];
			check(
				"M9.3 files mode → NO durable steer row exists (the journal received no write)",
				events.every((e) => !(e.kind === "steer" && (e.payload as Record<string, unknown> | undefined)?.text === "files-mode steer")),
				JSON.stringify(events.map((e) => e.kind)),
			);
			// The REAL dashboard pipeline submits and settles the marker from the
			// envelope — the honest delivered/unconfirmed state, never a spinner.
			const mf = await dashboardFor(hf.port);
			await mf.sendSteer("w1", "files-mode dashboard steer");
			const marker = mf.latestPending("w1", "steer");
			check(
				"M9.4 the dashboard settles the files-mode marker at delivered/unconfirmed, NOT pending",
				marker !== null && marker.status === "unconfirmed" && marker.label === "delivered" && marker.detail.includes("confirmation unavailable"),
				JSON.stringify(marker),
			);
			mf.fold([]);
			check("M9.5 no journal fold ever reverts the delivered marker to pending", mf.latestPending("w1", "steer")?.status === "unconfirmed", JSON.stringify(mf.latestPending("w1", "steer")));
			hf.stop();
		}

		// --- journal mode (companion): durable row → "confirmed" --------------
		const JOURNAL_DB = join(SANDBOX, "journal-confirmed", "events.db");
		const hj = await mountSwarmServer({
			sessionFile: SELF,
			transport: fakeTransport(),
			manifests,
			operatorToken: TOKEN,
			env: { ...process.env, SWARM_STORAGE: "journal", SWARM_JOURNAL_DB: JOURNAL_DB },
		});
		check("M9.6 a journal-mode companion mount returns a handle", hj !== null);
		if (hj) {
			const steer = await req(hj.port, "POST", "/api/workers/w1/steer", { token: TOKEN, body: { text: "journal-mode steer" } });
			const journal = steer.json?.journal as { seq?: number } | null | undefined;
			check(
				"M9.7 journal-mode steer → confirmation \"confirmed\" with the durable seq (behavior unchanged)",
				steer.status === 200 && steer.json?.confirmation === "confirmed" && typeof journal?.seq === "number",
				`${steer.status} ${steer.body}`,
			);
			const mj = await dashboardFor(hj.port);
			await mj.sendSteer("w1", "journal-mode dashboard steer");
			const marker = mj.latestPending("w1", "steer");
			check(
				"M9.8 the dashboard settles the journal-mode marker confirmed from the envelope",
				marker !== null && marker.status === "confirmed" && marker.detail.includes("confirmed by journal"),
				JSON.stringify(marker),
			);
			hj.stop();
		}
	}

	// -----------------------------------------------------------------------
	// M10 — #62 item 2: the mutation routes accept the SwarmGraph SESSION node
	//       id spelling additively (the same id the console route uses).
	// -----------------------------------------------------------------------
	{
		const { fixtureConsoleGraph, fixtureConsoleWorkerId } = await import("./swarm-http-goldens.ts");
		const hn = await mountSwarmServer({
			sessionFile: SELF,
			transport: fakeTransport(),
			manifests,
			operatorToken: TOKEN,
			graph: fixtureConsoleGraph(SELF),
			env: { ...process.env },
		});
		check("M10.1 a graph-fixture mount returns a handle", hn !== null);
		if (hn) {
			const nodeId = fixtureConsoleWorkerId();
			const byNode = await req(hn.port, "POST", `/api/workers/${nodeId}/steer`, { token: TOKEN, body: { text: "by node id" } });
			check(
				"M10.2 a mutation by session node id resolves to the owned worker name (additive, v1 name route unaffected)",
				byNode.status === 200 && byNode.json?.worker === "w1",
				`${byNode.status} ${byNode.body}`,
			);
			check(
				"M10.3 both spellings reach the SAME worker (a-w1.json carries the node-id mutation)",
				existsSync(join(ALPHA, "a-w1.json")) && readFileSync(join(ALPHA, "a-w1.json"), "utf8").includes('"answer": "by node id"'),
			);
			hn.stop();
		}
	}

	// -----------------------------------------------------------------------
	// M11 — #62 item 2: a name that equals a node id resolves deterministically
	//       NAME-FIRST (documented in docs/swarm-http-api.md).
	// -----------------------------------------------------------------------
	{
		const shadowGraph: SwarmGraph = {
			schemaVersion: 1,
			available: true,
			sources: { journal: true, manifests: true, liveStatus: false, usage: false },
			nodes: [
				{ kind: "session", id: "w1", sessionPath: "/sessions/shadow-w1.jsonl", role: "worker", isWorker: true, ownsChildren: false, tasks: ["beta"], degraded: [] },
			],
			edges: [],
			orphans: [],
		};
		const ha = await mountSwarmServer({
			sessionFile: SELF,
			transport: fakeTransport(),
			manifests,
			operatorToken: TOKEN,
			graph: shadowGraph,
			env: { ...process.env },
		});
		check("M11.1 an ambiguity-fixture mount returns a handle", ha !== null);
		if (ha) {
			const r = await req(ha.port, "POST", "/api/workers/w1/steer", { token: TOKEN, body: { text: "name first" } });
			check(
				"M11.2 name == node id resolves NAME-FIRST: the owned w1 wins over the shadow session node",
				r.status === 200 && r.json?.worker === "w1",
				`${r.status} ${r.body}`,
			);
			ha.stop();
		}
	}
}

await main();

// ---------------------------------------------------------------------------
// M8 — CLI verbs unchanged (orchestrator-side read still runs with no token)
// ---------------------------------------------------------------------------
{
	const { spawnSync } = await import("node:child_process");
	const cli = join(resolveCliRoot(), "src", "swarm", "cli.ts");
	const res = spawnSync("bun", [cli, "events", "--after", "0"], {
		env: { ...process.env },
		encoding: "utf8",
		timeout: 15_000,
	});
	check(
		"M8.1 the existing CLI read verb still runs unauthenticated (exit 0, JSON envelope)",
		res.status === 0 && (res.stdout ?? "").includes('"verb":"events"'),
		`status=${res.status} out=${(res.stdout ?? "").slice(0, 80)} err=${(res.stderr ?? "").slice(0, 120)}`,
	);
}

function resolveCliRoot(): string {
	return join(import.meta.dir, "..");
}

watchdog.close?.();
if (failures > 0) {
	console.error(`swarm-server-mutation-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("swarm-server-mutation-check: all checks passed");
