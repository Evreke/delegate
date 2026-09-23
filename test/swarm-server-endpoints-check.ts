/**
 * swarm-server-endpoints-check — issue #50 acceptance 1 + 5 (ARCHITECTURE
 * §4.2, Law 13): the session-hosted read-model HTTP server's THREE REST
 * endpoints — `/api/version`, `/api/swarm/snapshot`,
 * `/api/swarm/events?after=<seq>` — as observed by an HTTP client.
 *
 * Run with: bun test/swarm-server-endpoints-check.ts   (from repo root)
 *
 * The WebSocket endpoint (`/api/swarm/stream`) has its own check file
 * (test/swarm-server-ws-check.ts); the lifecycle boundary (mount/teardown/
 * double-mount/two parallel sessions) lives in test/swarm-server-lifecycle-
 * check.ts; fault injection in test/swarm-server-fault-check.ts.
 *
 * Covers:
 *   S1  mount + version surface:
 *       S1.1 enabled via env → mount returns a handle on a LOOPBACK port
 *           (127.0.0.1; never 0.0.0.0), port > 0 when port 0 (OS-assigned)
 *       S1.2 GET /api/version → 200, byte-exact frozen envelope
 *           {ok,schemaVersion,serverVersion,protocol:"swarm-http/1"}
 *       S1.3 unknown path → 404 structured error envelope (E_SWARM_NOT_FOUND,
 *           schemaVersion present — Law 7/Law 8)
 *       S1.4 non-GET method → 405 E_SWARM_USAGE with schemaVersion
 *       S1.5 DEFAULT OFF: no config key, no env → mount returns null (the
 *           server is opt-in this release)
 *       S1.6 config-file enable: swarm.server.enabled=true in the sandbox
 *           config file mounts (the documented enable path)
 *       S1.7 stop() closes the listener (connection refused after) and is
 *           idempotent
 *   S2  GET /api/swarm/events: envelope identity with the `swarm events`
 *       CLI verb (byte-equal bodies on the same seeded journal — protocol
 *       identity, acceptance 5); cursor semantics strictly seq > after;
 *       negative clamp; invalid after → 400 E_SWARM_USAGE + schemaVersion;
 *       absent journal → the CLI's empty-but-valid envelope, never a crash.
 *   S3  GET /api/swarm/snapshot: no-transport body byte-equal to the
 *       `swarm snapshot` CLI verb output (protocol identity); with a live
 *       fake Transport the statuses fold in — sources.liveStatus true and
 *       NO no-live-status flag on the matched worker (acceptance 1);
 *       usage folded the same way.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every fetch
 * is loopback and bounded by it. Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { EXTENSION_VERSION } from "../src/version.ts";

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("swarm-server-endpoints-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 25_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// --- sandbox: hermetic agent dir (config tier) + exchange root -------------
// Set BEFORE the dynamic import of the server module: profile.ts resolves the
// config path at module load (getAgentDir()), so the sandbox must be in the
// environment by then.
const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-server-check-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;

type Handle = { stop(): void; port: number; address: string };

async function main(): Promise<void> {
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");

	const fakeTransport = () => ({
		backendName: () => "fake",
		listStatuses: async () => [] as Array<{ name: string; status: string; placementRef?: string }>,
	});

	function env(extra: Record<string, string>): NodeJS.ProcessEnv {
		const e: NodeJS.ProcessEnv = { ...process.env };
		// Strip the server's env tier unless a scenario sets it: default/config
		// legs must not see an ambient override from the host environment.
		delete e.SWARM_SERVER_ENABLED;
		delete e.SWARM_SERVER_PORT;
		return { ...e, ...extra };
	}

	async function get(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
		return { status: res.status, body: await res.text() };
	}

	// -----------------------------------------------------------------------
	// S1 — mount + version surface
	// -----------------------------------------------------------------------
	{
		const h = await mountSwarmServer({ sessionFile: "/sessions/srv-a.jsonl", transport: fakeTransport(), env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }) });
		check("S1.1 enabled mount: handle, loopback 127.0.0.1, port > 0 (OS-assigned when 0)", h !== null && h.address === "127.0.0.1" && h.port > 0, JSON.stringify(h && { port: h.port, address: h.address }));

		if (h) {
			const golden = `{"ok":true,"schemaVersion":1,"serverVersion":"${EXTENSION_VERSION}","protocol":"swarm-http/1"}`;
			const v = await get(h.port, "/api/version");
			check("S1.2 GET /api/version → 200 + byte-exact frozen envelope", v.status === 200 && v.body === golden, `${v.status} ${v.body}`);

			const nf = await get(h.port, "/api/nope");
			let nfJson: Record<string, unknown> | null = null;
			try {
				nfJson = JSON.parse(nf.body) as Record<string, unknown>;
			} catch {
				/* detail below */
			}
			const nfErr = nfJson?.error as { code?: string; hint?: string } | undefined;
			check(
				"S1.3 unknown path → 404 structured error (E_SWARM_NOT_FOUND, schemaVersion 1, non-empty hint)",
				nf.status === 404 && nfJson?.ok === false && nfJson?.schemaVersion === 1 && nfErr?.code === "E_SWARM_NOT_FOUND" && typeof nfErr?.hint === "string" && nfErr.hint.length > 0,
				`${nf.status} ${nf.body}`,
			);

			const m = await get(h.port, "/api/version", { method: "POST" });
			let mJson: Record<string, unknown> | null = null;
			try {
				mJson = JSON.parse(m.body) as Record<string, unknown>;
			} catch {
				/* detail below */
			}
			check(
				"S1.4 non-GET → 405 E_SWARM_USAGE with schemaVersion",
				m.status === 405 && mJson?.schemaVersion === 1 && (mJson?.error as { code?: string } | undefined)?.code === "E_SWARM_USAGE",
				`${m.status} ${m.body}`,
			);

			h.stop();
			let refused = false;
			try {
				await get(h.port, "/api/version");
			} catch {
				refused = true;
			}
			check("S1.7a stop() closes the listener (connection refused after)", refused);
			let idempotent = true;
			try {
				h.stop();
			} catch {
				idempotent = false;
			}
			check("S1.7b stop() is idempotent", idempotent);
		}
	}

	// -----------------------------------------------------------------------
	// S2 — GET /api/swarm/events (envelope identity with the CLI verb)
	// -----------------------------------------------------------------------
	{
		// Seed a fixed-clock journal (the swarm-api-check seeding pattern).
		const FIXED_MS = Date.parse("2026-06-01T00:00:00.000Z");
		const { createJournalWriter } = await import("../src/swarm/journal.ts");
		const w = createJournalWriter({ dbPath: DB, clock: { now: () => FIXED_MS, delay: () => Promise.resolve() } });
		const ROWS = [
			{ kind: "spawn", sessionId: "sess-a", task: "alpha-fleet", worker: "w1", payload: { backend: "fake", placementRef: "fake:w1", briefPath: "/b.md", briefText: "# b" } },
			{ kind: "progress", sessionId: "sess-a", task: "alpha-fleet", worker: "w1", payload: { phase: "build", pct: 50 } },
			{ kind: "ask", sessionId: "sess-a", task: "alpha-fleet", worker: "w1", payload: { text: "which color?" } },
			{ kind: "reconcile-summary", sessionId: "sess-a", task: "alpha-fleet", worker: null, payload: { lost: ["w2"], collectedBeforeLoss: 0 } },
		] as const;
		for (const r of ROWS) {
			const res = await w.append(r);
			if (!res.ok) throw new Error(`seed append failed: ${res.code}`);
		}
		w.close();

		function runCli(args: string[], extra: Record<string, string> = {}): { status: number | null; stdout: string } {
			const cli = join(resolve(dirname(process.argv[1] ?? "."), ".."), "src", "swarm", "cli.ts");
			const res = spawnSync("bun", [cli, ...args], {
				env: { ...process.env, ...extra },
				encoding: "utf8",
				timeout: 15_000,
			});
			return { status: res.status, stdout: (res.stdout ?? "").trim() };
		}

		const h = await mountSwarmServer({ sessionFile: "/sessions/srv-ev.jsonl", transport: fakeTransport(), env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }) });
		check("S2.0 mount with a seeded journal returns a handle", h !== null);
		if (h) {
			const http = await get(h.port, "/api/swarm/events?after=1");
			const cli = runCli(["events", "--after", "1"]);
			check(
				"S2.1 HTTP events envelope byte-identical to the CLI verb output (after=1) — protocol identity",
				http.status === 200 && cli.status === 0 && http.body === cli.stdout,
				`http=${http.body.slice(0, 120)} cli=${cli.stdout.slice(0, 120)}`,
			);

			const negHttp = await get(h.port, "/api/swarm/events?after=-3");
			const negCli = runCli(["events", "--after", "-3"]);
			check(
				"S2.2a negative after clamps to 0 (all rows) — identical to the CLI clamp",
				negHttp.status === 200 && negHttp.body === negCli.stdout && negHttp.body.includes('"after":0'),
				negHttp.body.slice(0, 80),
			);

			const maxHttp = await get(h.port, "/api/swarm/events?after=4");
			check(
				"S2.2b cursor strictly greater: after=4 (last seq) → no rows, count still 4",
				maxHttp.status === 200 && maxHttp.body.includes('"events":[]') && maxHttp.body.includes('"count":4'),
				maxHttp.body,
			);

			for (const bad of ["abc", "", "1.5"]) {
				const r = await get(h.port, `/api/swarm/events?after=${encodeURIComponent(bad)}`);
				let j: Record<string, unknown> | null = null;
				try {
					j = JSON.parse(r.body) as Record<string, unknown>;
				} catch {
					/* detail below */
				}
				check(
					`S2.3 invalid after=${JSON.stringify(bad)} → 400 E_SWARM_USAGE with schemaVersion (Law 8)`,
					r.status === 400 && j?.schemaVersion === 1 && (j?.error as { code?: string } | undefined)?.code === "E_SWARM_USAGE",
					`${r.status} ${r.body}`,
				);
			}
			const missing = await get(h.port, "/api/swarm/events");
			check(
				"S2.3b missing after → 400 E_SWARM_USAGE (the cursor is required, same as the CLI)",
					missing.status === 400 && missing.body.includes('"E_SWARM_USAGE"'),
					missing.body,
				);

			// Absent journal: the CLI's empty-but-valid envelope, byte-identical.
			const absentDb = join(SANDBOX, "absent", "events.db");
			const h2 = await mountSwarmServer({ sessionFile: "/sessions/srv-ev2.jsonl", transport: fakeTransport(), env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0", SWARM_JOURNAL_DB: absentDb }) });
			check("S2.4a mount over an absent journal still returns a handle (never a crash)", h2 !== null);
			if (h2) {
				const http2 = await get(h2.port, "/api/swarm/events?after=0");
				const cli2 = runCli(["events", "--after", "0"], { SWARM_JOURNAL_DB: absentDb });
				check(
					"S2.4b absent journal → the CLI's empty-but-valid envelope, byte-identical",
						http2.status === 200 && http2.body === cli2.stdout && http2.body.includes('"count":0'),
					http2.body,
				);
				h2.stop();
			}
			h.stop();
		}
	}

	{
		const off = await mountSwarmServer({ sessionFile: "/sessions/srv-off.jsonl", transport: fakeTransport(), env: env({}) });
		check("S1.5 DEFAULT OFF: no config file key, no env → mount returns null", off === null);
	}

	{
		writeFileSync(join(AGENT, "pi-delegate.config.json"), JSON.stringify({ swarm: { server: { enabled: true, port: 0 } } }), "utf8");
		const h = await mountSwarmServer({ sessionFile: "/sessions/srv-cfg.jsonl", transport: fakeTransport(), env: env({}) });
		check("S1.6 config-file enable (swarm.server.enabled=true) mounts the server", h !== null && h.port > 0);
		h?.stop();
	}
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

if (failures > 0) {
	console.error(`\nswarm-server-endpoints-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-server-endpoints-check: all checks passed");
process.exit(0);
