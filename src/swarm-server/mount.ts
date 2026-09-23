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
 * Since #51 (§4.2.4) the mount ALSO generates the operator token (surfaced
 * on stderr ONLY, Law 11) and wires the mutation seam (the shared swarm
 * mailbox core over the read-model's manifestSource), so the server's POST
 * routes reach the SAME journaling writer path the delegate_mailbox tool uses.
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
import { createRouteTable, defaultUsageSource, type SwarmServerDeps } from "./server.ts";
import { startHttp1Server, type Http1ServerHandle } from "./http1.ts";
import { openSessionJournal } from "./journal-session.ts";
import { generateOperatorToken } from "./auth.ts";
import { type JournalReader } from "../swarm/journal-read.ts";
import { resolveSwarmStorage, type SwarmStorageConfig } from "../swarm/storage.ts";
import { activeBackendName, manifestSource } from "../swarm/snapshot.ts";
import { runOrchestratorVerb } from "../swarm/mailbox-verbs.ts";
import type { SwarmManifestStore, SwarmUsageSource } from "../swarm/graph.ts";
import type { SteerTransport } from "../mailbox-store.ts";

/** globalThis slot of the per-session server mount registry (Law 3). */
const SWARM_SERVER_MOUNT_REGISTRY_KEY = "__piDelegateSwarmServerMounts";

export interface SwarmServerHandle extends Omit<Http1ServerHandle, "close"> {
	/** Tear down THIS session's server (listener + sockets + journal reader +
	 *  registry key). Idempotent. */
	stop(): void;
}

export interface MountSwarmServerDeps extends Omit<SwarmServerDeps, "usage" | "transport"> {
	/** This session's file identity (the registry key; the Law-3 owner). */
	sessionFile?: string;
	/** The session's live transport (live status folds into the snapshot; its
	 *  getStatus/submitPrompt half drives the #51 console nudge). */
	transport?: SwarmServerDeps["transport"] & Partial<SteerTransport>;
	/** Manifest source override (the mutation ownership gate's input seam;
	 *  default the read-model's manifestSource — Law 13). */
	manifests?: SwarmManifestStore;
	/** Operator-token override (tests); default a fresh random token surfaced
	 *  on stderr. */
	operatorToken?: string;
	/** The process environment (config + test tiers). */
	env?: NodeJS.ProcessEnv;
	/** Listener override (fault-injection seam — tests make binds fail). */
	listen?: (port: number) => Promise<Http1ServerHandle>;
	/** Journal-reader factory override (fault-injection seam; default the
	 *  ONE long-lived read-only reader per session — openReadOnly precedent,
	 *  never the CLI's per-request temp copy). */
	journalFactory?: (dbPath: string | undefined) => JournalReader | undefined;
	/** Usage resolver override (the read-model's input seam). `false` binds NO
	 *  resolver — the identity spelling that matches the CLI verb's sources
	 *  exactly (protocol identity); the default binds defaultUsageSource. */
	usage?: SwarmUsageSource | false;
	/** The WS stream hub's cursor poll interval, ms (default 500; tests tighten). */
	pollMs?: number;
}

/** One structured stderr line (the writeJournalWarning shape — machine-readable). */
function logAdvisory(event: string, fields: Record<string, unknown>): void {
	try {
		process.stderr.write(`${JSON.stringify({ level: "warn", component: "swarm-server", event, ...fields })}\n`);
	} catch {
		// stderr itself is advisory
	}
}

/** Surface the operator token on stderr — the session UI is its ONLY channel
 *  (Law 11: never the journal, a response body or a log FILE). One line. */
function logOperatorToken(token: string): void {
	try {
		process.stderr.write(`${JSON.stringify({ level: "info", component: "swarm-server", event: "operator-token", token })}\n`);
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

	// #51 operator token: fresh per mount. Generated here so the route table
	// can gate on it; SURFACED on stderr only once the bind succeeds below
	// (an unusable token for a failed mount is never announced).
	const operatorToken = deps.operatorToken ?? generateOperatorToken();

	const listen =
		deps.listen ??
		((port: number) =>
			startHttp1Server({
				port,
				onRequest: routes.onRequest,
				onUpgrade: routes.onUpgrade,
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
		const factory = deps.journalFactory ?? openSessionJournal;
		journal = factory(storage.dbPath);
	} catch (err) {
		logAdvisory("journal-reader-failed", { error: String((err as Error).message ?? err) });
		journal = undefined;
	}
	const backendName = deps.transport?.backendName?.() ?? activeBackendName();
	const serverDeps: SwarmServerDeps = {
		transport: deps.transport,
		journal,
		usage: deps.usage === false ? undefined : (deps.usage ?? defaultUsageSource),
		storage,
		backendName,
		sessionFile: deps.sessionFile,
		graph: deps.graph,
	};
	// #51 mutation seam: ownership scan (the read-model's manifestSource) +
	// the shared swarm mailbox core. The scan is bounded by the backend filter
	// and total (a read failure degrades to an empty row set → fail-closed).
	const manifestReader = deps.manifests ?? manifestSource(journal, storage, backendName);
	const mutate: NonNullable<SwarmServerDeps["mutate"]> = async (kind, id, text) => {
		let manifests: ReadonlyArray<unknown> = [];
		try {
			manifests = manifestReader.scan(backendName);
		} catch {
			manifests = [];
		}
		return runOrchestratorVerb(
			{
				manifests: manifests as ReadonlyArray<import("../swarm/mailbox-verbs.ts").OrchestratorVerbManifest>,
				self: { sessionFile: deps.sessionFile },
				transport: deps.transport,
				env,
				via: "http",
			},
			{ kind, worker: id, text },
		);
	};
	const routes = createRouteTable({ ...serverDeps, pollMs: deps.pollMs, operatorToken, mutate });

	let bound: Http1ServerHandle;
	try {
		bound = await listen(cfg.port);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EADDRINUSE" || cfg.port === 0) {
			logAdvisory("bind-failed", { port: cfg.port, code: code ?? String(err) });
			return null;
		}
		try {
			bound = await listen(0);
			logAdvisory("port-substituted", { requested: cfg.port, bound: bound.port, reason: "EADDRINUSE — bound an OS-assigned port instead" });
		} catch (err2) {
			logAdvisory("bind-failed", { port: 0, code: (err2 as NodeJS.ErrnoException).code ?? String(err2) });
			return null;
		}
	}

	// Bind succeeded — now (and only now) surface the token on the session's
	// stderr. This is its ONLY channel (Law 11).
	logOperatorToken(operatorToken);

	const handle: SwarmServerHandle = {
		port: bound.port,
		address: bound.address,
		stop() {
			bound.close();
			routes.close();
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
