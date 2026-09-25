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
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every fetch
 * is loopback and bounded by it. Exit 0 only if all checks pass.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatusName } from "../src/host.ts";
import type { ExchangeManifest } from "../src/manifest-store.ts";

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
		check(
			"M3.1b journal mode → the envelope confirms (confirmation:\"confirmed\" + a durable seq) — the #62 item-1 additive field",
			steer.json?.confirmation === "confirmed" &&
				typeof (steer.json?.journal as { seq?: unknown } | null)?.seq === "number",
			`${steer.body}`,
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
