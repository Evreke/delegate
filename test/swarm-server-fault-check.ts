/**
 * swarm-server-fault-check — issue #50 acceptance 3 (ARCHITECTURE §4.2,
 * Law 8): the session-hosted read server is ADVISORY BY CONTRACT — a server
 * startup failure (bad port, bound port, failing journal reader) is logged
 * and NEVER blocks session start, spawn, or collect.
 *
 * Run with: bun test/swarm-server-fault-check.ts   (from repo root)
 *
 * Covers:
 *   F1  BOUND PORT (mount level): the requested port is already occupied →
 *       the mount retries once on an OS-assigned port, logs one structured
 *       port-substituted line, and the server SERVES on the fallback port.
 *   F2  BIND ALWAYS FAILS (injected listener rejecting with EACCES on both
 *       attempts): mountSwarmServer returns null, logs bind-failed, and
 *       NEVER throws — a session-start caller is structurally unaffected.
 *   F3  FAILING JOURNAL READER (factory throws): the server still mounts and
 *       serves — events degrade to the empty-but-valid envelope, snapshot
 *       degrades (sources.journal false, available true), /api/version 200.
 *   F4  A THROWING READER (eventsAfter throws): the events endpoint answers
 *       a structured 500 E_SWARM_IO + schemaVersion (per-request envelope,
 *       Law 8) and the server KEEPS SERVING — one bad read never kills it.
 *   F5  BOUND PORT at the COMPOSITION ROOT: with the port occupied, the real
 *       session_start handler completes (the tool layer registers; the
 *       session context is built), the fallback port is visible in the
 *       structured log, and the server serves on it; the paired
 *       session_shutdown stops it.
 *   F6  BAD PORT VALUE (config tier): an invalid swarm.server.port degrades
 *       to the documented default with a recorded warning — never a throw,
 *       never a bind on a garbage port.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog. Exit 0 only
 * if all checks pass.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("swarm-server-fault-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-server-fault-"));
process.env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent");
process.env.PI_DELEGATE_EXCHANGE_ROOT = join(SANDBOX, "ex");
process.env.SWARM_JOURNAL_DB = join(SANDBOX, "absent", "events.db");

async function get(port: number, path: string): Promise<{ ok: boolean; status: number; body: string }> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3_000) });
		return { ok: true, status: res.status, body: await res.text() };
	} catch {
		return { ok: false, status: 0, body: "" };
	}
}

/** Occupy a loopback port with a dummy listener; returns the release fn. */
function occupyPort(port: number): Promise<() => void> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer(() => {});
		srv.once("error", reject);
		srv.listen(port, "127.0.0.1", () => resolve(() => new Promise<void>((r) => srv.close(() => r()))));
	});
}

/** Intercept structured stderr lines while fn runs. */
async function withStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
	const lines: string[] = [];
	const realWrite = process.stderr.write.bind(process.stderr);
	(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
		lines.push(s);
		return true;
	};
	try {
		const result = await fn();
		return { result, lines };
	} finally {
		(process.stderr as unknown as { write: (s: string) => boolean }).write = realWrite;
	}
}

const asJson = (line: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
};

async function main(): Promise<void> {
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
	const { resolveSwarmServerConfig, SWARM_SERVER_DEFAULT_PORT } = await import("../src/swarm-server/config.ts");
	const env = (extra: Record<string, string>): NodeJS.ProcessEnv => {
		const e = { ...process.env };
		delete e.SWARM_SERVER_ENABLED;
		delete e.SWARM_SERVER_PORT;
		return { ...e, ...extra };
	};
	const transport = { backendName: () => "herdr", listStatuses: async () => [] as Array<{ name: string; status: "idle"; placementRef?: string }> };

	// --- F1: bound port → OS-assigned fallback, logged, serving ------------
	{
		const P = 17901;
		const release = await occupyPort(P);
		try {
			const { result: h, lines } = await withStderr(() => mountSwarmServer({ sessionFile: "/sessions/f1.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: String(P) }) }));
			check("F1.1 bound port → mount still returns a handle on a DIFFERENT (OS-assigned) port", h !== null && h.port !== P && h.port > 0, `port=${h && h.port}`);
			const sub = lines.map(asJson).find((j) => j?.event === "port-substituted");
			check(
				"F1.2 the substitution is logged as one structured port-substituted line naming both ports",
				sub !== undefined && sub.requested === P && typeof sub.bound === "number" && (sub.bound as number) === h?.port,
				lines.join(" | ").slice(0, 200),
			);
			if (h) {
				const probe = await get(h.port, "/api/version");
				check("F1.3 the fallback server SERVES", probe.ok && probe.status === 200);
				h.stop();
			}
		} finally {
			await release();
		}
	}

	// --- F2: bind always fails → null, logged, no throw --------------------
	{
		const eacc = Object.assign(new Error("bind EACCES"), { code: "EACCES" });
		const alwaysFails = async (): Promise<never> => {
			throw eacc;
		};
		let returned: unknown = "threw?";
		const { lines } = await withStderr(async () => {
			returned = await mountSwarmServer({ sessionFile: "/sessions/f2.jsonl", transport, env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }), listen: alwaysFails });
		});
		check("F2.1 a bind that always fails → mount returns null (NEVER throws)", returned === null, String(returned));
		check("F2.2 the failure is logged as one structured bind-failed line", lines.map(asJson).some((j) => j?.event === "bind-failed"), lines.join(" | ").slice(0, 160));
	}

	// --- F3: failing journal factory → degraded but live --------------------
	{
		const h = await mountSwarmServer({
			sessionFile: "/sessions/f3.jsonl",
			transport,
			env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }),
			journalFactory: () => {
				throw new Error("journal boom");
			},
		});
		check("F3.1 a throwing journal factory still mounts the server", h !== null);
		if (h) {
			const v = await get(h.port, "/api/version");
			check("F3.2 /api/version serves (200)", v.ok && v.status === 200);
			const ev = await get(h.port, "/api/swarm/events?after=0");
			check(
				"F3.3 events degrade to the empty-but-valid envelope (Law 8 read surface)",
				ev.ok && ev.status === 200 && ev.body.includes('"events":[]') && ev.body.includes('"count":0'),
				ev.body.slice(0, 160),
			);
			const snap = await get(h.port, "/api/swarm/snapshot");
			let sources: Record<string, unknown> | undefined;
			try {
				sources = ((JSON.parse(snap.body) as { snapshot?: { sources?: Record<string, unknown> } }).snapshot ?? {}).sources;
			} catch {
				/* detail below */
			}
			check("F3.4 snapshot degrades honestly (sources.journal false, envelope valid)", snap.status === 200 && sources?.journal === false, snap.body.slice(0, 160));
			h.stop();
		}
	}

	// --- F4: a throwing reader → structured 500, server stays alive ---------
	{
		const evil = () => ({
			eventsAfter: (): never => {
				throw new Error("read boom");
			},
			count: () => 0,
			dbSizeBytes: () => 0,
			close: () => {},
		});
		const h = await mountSwarmServer({
			sessionFile: "/sessions/f4.jsonl",
			transport,
			env: env({ SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" }),
			journalFactory: evil as never,
		});
		check("F4.1 a reader whose reads throw still mounts", h !== null);
		if (h) {
			const ev = await get(h.port, "/api/swarm/events?after=0");
			check(
				"F4.2 the events endpoint answers a structured 500 E_SWARM_IO + schemaVersion (never a crash, never a hang)",
				ev.ok && ev.status === 500 && ev.body.includes("E_SWARM_IO") && ev.body.includes('"schemaVersion":1'),
				`${ev.status} ${ev.body.slice(0, 140)}`,
			);
			const v = await get(h.port, "/api/version");
			check("F4.3 the server KEEPS SERVING after the bad read", v.ok && v.status === 200);
			h.stop();
		}
	}

	// --- F5: bound port at the composition root -----------------------------
	{
		const ix = await import("../index.ts");
		type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
		const handlers = new Map<string, Handler>();
		let toolRegistrations = 0;
		const fakePi = {
			registerTool: () => {
				toolRegistrations++;
			},
			registerCommand: () => {},
			on: (event: string, handler: Handler) => {
				handlers.set(event, handler);
			},
		};
		ix.default(fakePi as never);
		const ctxFor = (sessionFile: string): unknown => ({ hasUI: false, cwd: SANDBOX, sessionManager: { getSessionFile: () => sessionFile } });

		const P = 17902;
		const release = await occupyPort(P);
		process.env.SWARM_SERVER_ENABLED = "1";
		process.env.SWARM_SERVER_PORT = String(P);
		try {
			let completed = false;
			const { lines } = await withStderr(async () => {
				await handlers.get("session_start")?.({}, ctxFor("/sessions/f5.jsonl"));
				completed = true;
			});
			check("F5.1 with the port OCCUPIED, the real session_start handler completes (never blocks — spawn/collect unaffected by construction: the mount is total and inside the handler)", completed);
			check("F5.2 the tool layer registered before/along the mount (registerTool calls present despite the fault)", toolRegistrations >= 3, `tools=${toolRegistrations}`);
			const sub = lines.map(asJson).find((j) => j?.event === "port-substituted");
			const fallbackPort = typeof sub?.bound === "number" ? (sub.bound as number) : 0;
			check("F5.3 the fallback port is visible in the structured log", fallbackPort > 0, lines.join(" | ").slice(0, 200));
			if (fallbackPort > 0) {
				const probe = await get(fallbackPort, "/api/version");
				check("F5.4 the session's server SERVES on the fallback port", probe.ok && probe.status === 200);
			}
			await handlers.get("session_shutdown")?.({}, ctxFor("/sessions/f5.jsonl"));
			if (fallbackPort > 0) {
				const gone = await get(fallbackPort, "/api/version");
				check("F5.5 the paired session_shutdown stopped it", !gone.ok);
			}
		} finally {
			delete process.env.SWARM_SERVER_ENABLED;
			delete process.env.SWARM_SERVER_PORT;
			await release();
		}
	}

	// --- F6: bad port value in the config tier ------------------------------
	{
		const cfg = resolveSwarmServerConfig(env({ SWARM_SERVER_PORT: "notaport" }));
		check(
			"F6 an invalid port degrades to the documented default with a recorded warning (never a throw)",
			cfg.port === SWARM_SERVER_DEFAULT_PORT && cfg.warnings.some((w) => w.includes("swarm.server.port")),
			JSON.stringify(cfg),
		);
	}
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

if (failures > 0) {
	console.error(`\nswarm-server-fault-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-server-fault-check: all checks passed");
process.exit(0);
