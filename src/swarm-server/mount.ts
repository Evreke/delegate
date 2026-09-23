/**
 * pi-delegate — src/swarm-server/mount.ts — the session-lifecycle mount
 * (issue #50, ARCHITECTURE §4.2, Law 3).
 *
 * MODULE_CONTRACT — mounts the session-hosted read server for ONE
 * session_start and returns the Law-3 handle the session context stores;
 * session_shutdown calls stop() on exactly this session's handle. Mounts are
 * keyed by session file in a globalThis registry (the observe.ts/watcher.ts
 * Wave-2 precedent): a second mount for an already-mounted session file is
 * REFUSED — logged, the FIRST instance's handle returned, never a silent
 * replace (a double module load cannot run two servers for one session).
 *
 * ADVISORY BY CONTRACT (Law 8, §4.2): every failure path — disabled config,
 * bind failure, journal-reader failure — is logged as one structured JSON
 * stderr line and returns null (or a degraded-but-live handle); mountSwarmServer
 * NEVER throws and NEVER blocks session start, spawn, or collect (proven by
 * test/swarm-server-fault-check.ts).
 *
 * PORT POLICY: the configured port (default 7331, config key
 * swarm.server.port; 0 = OS-assigned) is a REQUEST, not a requirement — on
 * EADDRINUSE the mount retries ONCE with port 0 (OS-assigned) and logs the
 * substituted port, so two parallel sessions each get an independent server
 * on different ports (issue #50 acceptance 4).
 *
 * Dependencies: node builtins, ./config.ts, ./server.ts, ./http1.ts, plus
 * ../swarm/journal-read.ts (the ONE long-lived read-only journal reader per
 * session — the openReadOnly precedent, never the CLI's per-request
 * temp-copy workaround) and ../swarm/storage.ts (the ONE db-path override
 * spelling: SWARM_JOURNAL_DB). No herdr adapter import (Law 4).
 *
 * Critical invariants:
 *   - total: never throws (a mount failure is a logged null);
 *   - the registry key survives double module loads (globalThis);
 *   - stop() is idempotent and frees the registry key (a later re-mount of
 *     the same session file mounts fresh).
 */

import { resolveSwarmServerConfig } from "./config.ts";
import { defaultUsageSource, routeRequest, type SwarmServerDeps } from "./server.ts";
import { startHttp1Server, type Http1ServerHandle } from "./http1.ts";
import { createJournalReader, type JournalReader } from "../swarm/journal-read.ts";
import { resolveSwarmStorage, type SwarmStorageConfig } from "../swarm/storage.ts";
import { activeBackendName } from "../swarm/snapshot.ts";
import type { SwarmUsageSource } from "../swarm/graph.ts";

/** globalThis slot of the per-session server mount registry (Law 3). */
const SWARM_SERVER_MOUNT_REGISTRY_KEY = "__piDelegateSwarmServerMounts";

export interface SwarmServerHandle extends Omit<Http1ServerHandle, "close"> {
	/** Tear down THIS session's server (listener + sockets + journal reader +
	 *  registry key). Idempotent. */
	stop(): void;
}

export interface MountSwarmServerDeps extends Omit<SwarmServerDeps, "usage"> {
	/** This session's file identity (the registry key; the Law-3 owner). */
	sessionFile?: string;
	/** The process environment (config + test tiers). */
	env?: NodeJS.ProcessEnv;
	/** Listener override (fault-injection seam — tests make binds fail). */
	listen?: (port: number, deps: SwarmServerDeps) => Promise<Http1ServerHandle>;
	/** Journal-reader factory override (fault-injection seam; default the
	 *  ONE long-lived read-only reader per session — openReadOnly precedent,
	 *  never the CLI's per-request temp copy). */
	journalFactory?: (dbPath: string | undefined) => JournalReader | undefined;
	/** Usage resolver override (the read-model's input seam). `false` binds NO
	 *  resolver — the identity spelling that matches the CLI verb's sources
	 *  exactly (protocol identity); the default binds defaultUsageSource. */
	usage?: SwarmUsageSource | false;
}

/** One structured stderr line (the writeJournalWarning shape — machine-readable). */
function logAdvisory(event: string, fields: Record<string, unknown>): void {
	try {
		process.stderr.write(`${JSON.stringify({ level: "warn", component: "swarm-server", event, ...fields })}\n`);
	} catch {
		// stderr itself is advisory
	}
}

function mountRegistry(): Map<string, SwarmServerHandle> {
	const g = globalThis as unknown as Record<string, unknown>;
	const existing = g[SWARM_SERVER_MOUNT_REGISTRY_KEY];
	if (existing instanceof Map) return existing as Map<string, SwarmServerHandle>;
	const fresh = new Map<string, SwarmServerHandle>();
	g[SWARM_SERVER_MOUNT_REGISTRY_KEY] = fresh;
	return fresh;
}

/** The registry key: the session file, else the cwd (an unkeyed session). */
function mountKey(sessionFile: string | undefined): string {
	return sessionFile ?? `cwd:${process.cwd()}`;
}

/**
 * Mount the session-hosted read server for one session_start.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: deps — sessionFile, env (config + test tiers), transport, optional
 *   listener override (fault injection)
 * Output: the Law-3 handle { stop, port, address }, or null when the server
 *   is disabled or failed to bind
 * Guarantees:
 *   - TOTAL (Law 8): never throws; every failure is a logged null
 *   - disabled (default) → null, nothing bound
 *   - a second mount for an already-mounted key REFUSES: logged, returns the
 *     FIRST instance's handle, binds nothing new (Law 3)
 *   - EADDRINUSE → one retry on an OS-assigned port (logged); a second bind
 *     failure → logged null (the session continues without a server)
 *   - stop() is idempotent; stop frees the registry key for a fresh re-mount
 * Raises: never
 */
export async function mountSwarmServer(deps: MountSwarmServerDeps): Promise<SwarmServerHandle | null> {
	const env = deps.env ?? process.env;
	let cfg;
	try {
		cfg = resolveSwarmServerConfig(env);
	} catch (err) {
		logAdvisory("config-failed", { error: String((err as Error).message ?? err) });
		return null;
	}
	for (const warning of cfg.warnings) logAdvisory("config-warning", { warning });
	if (!cfg.enabled) return null;

	const key = mountKey(deps.sessionFile);
	const registry = mountRegistry();
	const existing = registry.get(key);
	if (existing) {
		logAdvisory("mount-refused", { key, port: existing.port, reason: "session already mounted — returning the first instance's handle (Law 3)" });
		return existing;
	}

	const listen =
		deps.listen ??
		((port: number, serverDeps: SwarmServerDeps) =>
			startHttp1Server({
				port,
				onRequest: (req) => routeRequest(serverDeps, req),
			}));

	// The session's ONE long-lived read-only journal reader (§4.2: the
	// openReadOnly precedent — a single reader per session, NOT the CLI's
	// per-request temp-copy workaround). A factory failure is advisory: the
	// server mounts degraded (empty-but-valid read envelopes), Law 8.
	let storage: SwarmStorageConfig;
	try {
		storage = resolveSwarmStorage(env);
	} catch {
		storage = { storage: "files", projection: true, warnings: [] }; // unreachable (resolver is total) — belt
	}
	let journal: JournalReader | undefined;
	try {
		const factory = deps.journalFactory ?? ((dbPath: string | undefined) => createJournalReader({ dbPath }));
		journal = factory(storage.dbPath);
	} catch (err) {
		logAdvisory("journal-reader-failed", { error: String((err as Error).message ?? err) });
		journal = undefined;
	}
	const serverDeps: SwarmServerDeps = {
		transport: deps.transport,
		journal,
		usage: deps.usage === false ? undefined : (deps.usage ?? defaultUsageSource),
		storage,
		backendName: deps.transport?.backendName?.() ?? activeBackendName(),
	};

	let bound: Http1ServerHandle;
	try {
		bound = await listen(cfg.port, serverDeps);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EADDRINUSE" || cfg.port === 0) {
			logAdvisory("bind-failed", { port: cfg.port, code: code ?? String(err) });
			return null;
		}
		try {
			bound = await listen(0, serverDeps);
			logAdvisory("port-substituted", { requested: cfg.port, bound: bound.port, reason: "EADDRINUSE — bound an OS-assigned port instead" });
		} catch (err2) {
			logAdvisory("bind-failed", { port: 0, code: (err2 as NodeJS.ErrnoException).code ?? String(err2) });
			return null;
		}
	}

	const handle: SwarmServerHandle = {
		port: bound.port,
		address: bound.address,
		stop() {
			bound.close();
			try {
				journal?.close();
			} catch {
				// advisory — a close failure never propagates past stop()
			}
			if (registry.get(key) === handle) registry.delete(key);
		},
	};
	registry.set(key, handle);
	return handle;
}
