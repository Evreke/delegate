/**
 * swarm-server-lifecycle-check — issue #50 acceptance 4 (ARCHITECTURE §4.2,
 * Law 3): the session-lifecycle boundary of the session-hosted read server —
 * session_start/session_shutdown mounting, the double-mount refusal, two
 * parallel sessions on independent ports, and shutdown isolation.
 *
 * Run with: bun test/swarm-server-lifecycle-check.ts   (from repo root)
 *
 * Two legs:
 *   Leg A — mountSwarmServer (the mount module's own semantics):
 *     L1  mount → handle; stop closes; a re-mount after stop mounts fresh
 *         (the registry key was freed)
 *     L2  a second mount for the SAME session file REFUSES: returns the
 *         FIRST handle (identity), binds nothing, logs one structured line
 *     L3  two parallel sessions requesting the SAME port → two handles on
 *         DIFFERENT ports (EADDRINUSE → one OS-assigned retry), both serve
 *     L4  shutdown isolation: stopping session A's handle leaves B serving
 *         and A refused — one session's stop never touches the other
 *     L5  unkeyed sessions (no session file) share the cwd registry key:
 *         the second mount refuses too
 *   Leg B — the composition root (index.ts) drives the mount through the
 *     real session_start/session_shutdown handlers:
 *     B1  session_start with swarm.server.enabled mounts — /api/version
 *         serves on the configured loopback port
 *     B2  the paired session_shutdown stops it (connection refused)
 *     B3  a replacement session_start mounts fresh (the pairing holds)
 *     B4  with the server OFF (default), session_start completes and mounts
 *         NOTHING (no listener on the configured port)
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every wait
 * has a deadline. Exit 0 only if all checks pass.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("swarm-server-lifecycle-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-server-lc-"));
const AGENT = join(SANDBOX, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = join(SANDBOX, "ex");
process.env.SWARM_JOURNAL_DB = join(SANDBOX, "absent", "events.db");

async function get(port: number, path: string): Promise<{ ok: boolean; status: number; body: string }> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}${path}`);
		return { ok: true, status: res.status, body: await res.text() };
	} catch {
		return { ok: false, status: 0, body: "" };
	}
}

/** One token-gated POST (the mutation auth gate probe). */
async function post(port: number, path: string, token: string): Promise<{ status: number; body: string }> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ text: "takeover probe" }),
			signal: AbortSignal.timeout(4_000),
		});
		return { status: res.status, body: await res.text() };
	} catch {
		return { status: 0, body: "" };
	}
}

/** Poll a predicate with a bounded deadline (fail-fast: every wait has one). */
async function waitFor(cond: () => boolean, timeoutMs = 4_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
	return cond();
}

type Handle = { stop(): void; port: number };

async function main(): Promise<void> {
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
	const env = (extra: Record<string, string>): NodeJS.ProcessEnv => {
		const e = { ...process.env };
		delete e.SWARM_SERVER_ENABLED;
		delete e.SWARM_SERVER_PORT;
		return { ...e, ...extra };
	};
	const transport = { backendName: () => "herdr", listStatuses: async () => [] as Array<{ name: string; status: "idle"; placementRef?: string }> };

	// -----------------------------------------------------------------------
	// Leg A — the mount module's own semantics
	// -----------------------------------------------------------------------
	{
		// L1: mount → stop → re-mount fresh.
		const P1 = 17850;
		const a1 = await mountSwarmServer({ sessionFile: "/sessions/lc-a.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: String(P1) }) });
		check("L1.1 mount returns a handle on the requested port", a1 !== null && a1.port === P1, JSON.stringify(a1 && a1.port));
		if (a1) {
			const serve = await get(a1.port, "/api/version");
			check("L1.2 the mounted server serves", serve.ok && serve.status === 200);
			a1.stop();
			const refused = await get(a1.port, "/api/version");
			check("L1.3 stop closes the listener", !refused.ok);
			const a1b = await mountSwarmServer({ sessionFile: "/sessions/lc-a.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: String(P1) }) });
			check("L1.4 a re-mount after stop mounts fresh (registry key freed)", a1b !== null && a1b !== a1 && a1b.port === P1);
			a1b?.stop();
		}

		// L2: second mount for the SAME session file refuses.
		const stderrLines: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
			stderrLines.push(s);
			return true;
		};
		const b1 = await mountSwarmServer({ sessionFile: "/sessions/lc-b.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }) });
		const b2 = await mountSwarmServer({ sessionFile: "/sessions/lc-b.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }) });
		(process.stderr as unknown as { write: (s: string) => boolean }).write = realWrite;
		check(
			"L2.1 second mount for the same session file REFUSES: the FIRST handle is returned (identity), nothing rebound",
			b1 !== null && b2 === b1,
			`b1=${b1 && b1.port} b2=${b2 && b2.port}`,
		);
		check(
			"L2.2 the refusal is logged as one structured JSON line (mount-refused)",
			stderrLines.some((l) => {
				try {
					const j = JSON.parse(l) as { component?: string; event?: string };
					return j.component === "swarm-server" && j.event === "mount-refused";
				} catch {
					return false;
				}
			}),
			stderrLines.join(" | ").slice(0, 200),
		);
		b1?.stop();

		// L3 + L4 (issue #65 item 3 D1): two parallel sessions on the SAME
		// configured port → ONE primary (the port holder) + ONE secondary (no
		// listener; the primary serves its fleets read-only). Stopping the
		// primary hands the canonical port to the survivor (item 3b takeover:
		// the OS is the arbiter — no election protocol, no new store).
		const P3 = 17851;
		const watchFast = { intervalMs: 60, maxIntervalMs: 240 };
		const s1 = await mountSwarmServer({ sessionFile: "/sessions/lc-s1.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: String(P3) }), primaryWatch: watchFast });
		const s2 = await mountSwarmServer({ sessionFile: "/sessions/lc-s2.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: String(P3) }), primaryWatch: watchFast });
		check(
			"L3 D1: two sessions on one configured port → ONE primary on the canonical port + ONE secondary with NO listener",
			s1 !== null && s2 !== null && s1.role === "primary" && s1.port === P3 && s2.role === "secondary" && s2.port === P3,
			`s1=${s1?.role}:${s1?.port} s2=${s2?.role}:${s2?.port}`,
		);
		if (s1 && s2) {
			const served = await get(s1.port, "/api/version");
			check("L3b the primary serves on the canonical loopback port", served.ok && served.status === 200);
			// L4 — takeover: kill the primary; the survivor binds the canonical port.
			s1.stop();
			const promoted = await waitFor(() => s2.role === "primary");
			const canon = await get(P3, "/api/version");
			check(
				"L4 takeover: the survivor binds the canonical port within a bounded time and the canonical URL keeps serving",
				promoted && s2.port === P3 && canon.ok && canon.status === 200,
				`role=${s2.role} port=${s2.port} canon=${canon.status}`,
			);
			s2.stop();
			const dead = await get(P3, "/api/version");
			check("L4b a second kill with no survivors degrades gracefully (the canonical port is free — no crash, no phantom listener)", !dead.ok);
		}

		// L6 + L7 (item 3b): exactly ONE survivor wins the canonical-port race,
		// and the canonical URL then requires the NEW primary's token.
		const P6 = 17852;
		const prim = await mountSwarmServer({ sessionFile: "/sessions/lc-prim.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: String(P6) }), operatorToken: "alpha-token", primaryWatch: watchFast });
		const r1 = await mountSwarmServer({ sessionFile: "/sessions/lc-r1.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: String(P6) }), operatorToken: "beta-token", primaryWatch: watchFast });
		const r2 = await mountSwarmServer({ sessionFile: "/sessions/lc-r2.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: String(P6) }), operatorToken: "gamma-token", primaryWatch: watchFast });
		check("L6.0 three sessions: one primary + two secondaries before the kill", prim?.role === "primary" && r1?.role === "secondary" && r2?.role === "secondary", `${prim?.role}/${r1?.role}/${r2?.role}`);
		if (prim && r1 && r2) {
			prim.stop();
			const won = await waitFor(() => [r1, r2].filter((h) => h.role === "primary").length === 1);
			const winners = [r1, r2].filter((h) => h.role === "primary");
			const survivor = winners[0];
			check(
				"L6 exactly ONE survivor takes over the canonical port (the OS arbitrates; the loser stays secondary)",
				won && winners.length === 1 && survivor.port === P6 && (await get(P6, "/api/version")).ok,
				`winners=${winners.length}`,
			);
			if (survivor) {
				const oldToken = await post(P6, "/api/workers/lc-w1/steer", "alpha-token");
				const winnerToken = survivor === r1 ? "beta-token" : "gamma-token";
				const newToken = await post(P6, "/api/workers/lc-w1/steer", winnerToken);
				check(
					"L7 token continuity: the canonical URL now requires the NEW primary's token (the dead primary's token is refused)",
					oldToken.status === 401 && newToken.status !== 401,
					`old=${oldToken.status} new=${newToken.status}`,
				);
			}
			r1.stop();
			r2.stop();
		}

		// L5: unkeyed sessions share the cwd registry key — the second refuses.
		const u1 = await mountSwarmServer({ transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }) });
		const u2 = await mountSwarmServer({ transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }) });
		check("L5 unkeyed sessions (no session file): the second mount refuses on the shared cwd key", u1 !== null && u2 === u1);
		u1?.stop();
	}

	// -----------------------------------------------------------------------
	// Leg B — the composition root (index.ts) drives the mount
	// -----------------------------------------------------------------------
	{
		const ix = await import("../index.ts");
		type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
		const handlers = new Map<string, Handler>();
		const fakePi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
		};
		ix.default(fakePi as never);
		check("B0 the composition root registers session_start/session_shutdown handlers", handlers.has("session_start") && handlers.has("session_shutdown"));

		const ctxFor = (sessionFile: string): unknown => ({
			hasUI: false,
			cwd: SANDBOX,
			sessionManager: { getSessionFile: () => sessionFile },
		});

		const P_ON = 17860;
		const P_OFF = 17861;
		try {
			// B4 first (server OFF by default): session_start completes, mounts nothing.
			delete process.env.SWARM_SERVER_ENABLED;
			delete process.env.SWARM_SERVER_PORT;
			await handlers.get("session_start")?.({}, ctxFor("/sessions/ix-off.jsonl"));
			const offProbe = await get(P_OFF, "/api/version");
			check("B4 with the server OFF (default), session_start mounts NOTHING (no listener)", !offProbe.ok);

			// B1: session_start with the server enabled mounts.
			process.env.SWARM_SERVER_ENABLED = "1";
			process.env.SWARM_SERVER_PORT = String(P_ON);
			await handlers.get("session_start")?.({}, ctxFor("/sessions/ix-a.jsonl"));
			const onProbe = await get(P_ON, "/api/version");
			check(
				"B1 session_start mounts the read server (the composition root binds it) — /api/version serves on the configured loopback port",
				onProbe.ok && onProbe.status === 200 && onProbe.body.includes('"protocol":"swarm-http/1"'),
				`${onProbe.status} ${onProbe.body.slice(0, 120)}`,
			);

			// B2: the paired shutdown stops it.
			await handlers.get("session_shutdown")?.({}, ctxFor("/sessions/ix-a.jsonl"));
			const goneProbe = await get(P_ON, "/api/version");
			check("B2 the paired session_shutdown stops this session's server", !goneProbe.ok);

			// B3: a replacement session_start mounts fresh.
			await handlers.get("session_start")?.({}, ctxFor("/sessions/ix-b.jsonl"));
			const freshProbe = await get(P_ON, "/api/version");
			check("B3 a replacement session_start mounts fresh (the pairing holds across replacement)", freshProbe.ok && freshProbe.status === 200);
			await handlers.get("session_shutdown")?.({}, ctxFor("/sessions/ix-b.jsonl"));
		} finally {
			delete process.env.SWARM_SERVER_ENABLED;
			delete process.env.SWARM_SERVER_PORT;
			// belt: if a handler leg failed mid-way, stop whatever it mounted
			const sd = handlers.get("session_shutdown");
			if (sd) await sd({}, ctxFor("/sessions/ix-b.jsonl"));
		}
	}
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

if (failures > 0) {
	console.error(`\nswarm-server-lifecycle-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-server-lifecycle-check: all checks passed");
process.exit(0);
