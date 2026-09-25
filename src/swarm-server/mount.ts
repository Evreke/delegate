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
import { createRouteTable, defaultUsageSource, SWARM_HTTP_PROTOCOL, type SwarmServerDeps } from "./server.ts";
import { startHttp1Server, SWARM_SERVER_BIND_HOST, type Http1ServerHandle } from "./http1.ts";
import { PRIMARY_WATCH_PROBE_TIMEOUT_MS, startPrimaryWatch, type PrimaryWatchHandle } from "./primary-watch.ts";
import { dashboardLinkFor, dashboardUrlFor, logDashboard } from "./dashboard-link.ts";
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
	/** This session's primary/secondary role under D1 (issue #65 item 3). */
	readonly role: SwarmServerRole;
	/** The canonical dashboard URL (`http://127.0.0.1:<port>/`) this session's
	 *  widget link points at — the ACTUAL bound port when this session serves
	 *  one, else the configured primary port. Never a token. */
	readonly dashboardUrl: string;
	/** Tear down THIS session's server (listener + sockets + journal reader +
	 *  registry key). Idempotent. */
	stop(): void;
}

/** D1 role of a mounted session (issue #65 item 3): the session that holds
 *  the configured port is `primary`; a later session whose server is absent
 *  (the primary serves its fleets read-only) is `secondary`; a session that
 *  could not reach a delegate primary and mounted an OS-assigned fallback is
 *  `fallback` (fail-open for single-session). */
export type SwarmServerRole = "primary" | "secondary" | "fallback";

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
	/** Primary-probe override (tests/fault injection): true when the canonical
	 *  port answers as a delegate server. Default: a bounded loopback HTTP
	 *  probe of `/api/version` (the §4.2 identity envelope). */
	probePrimary?: (port: number) => Promise<boolean>;
	/** Takeover-watch tuning (issue #65 item 3b; tests tighten the backoff). */
	primaryWatch?: { intervalMs?: number; maxIntervalMs?: number };
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

/**
 * The canonical dashboard URL/fragment-link spelling lives in
 * ./dashboard-link.ts (issue #65 items 1–2, Law 9 — ONE spelling).
 */

/**
 * Is the loopback process on `port` a delegate swarm server?
 * <p>
 * FUNCTION_CONTRACT: Input — port, timeoutMs. Output — true iff
 * `/api/version` answers 200 with `protocol: "swarm-http/1"` within the
 * deadline (a foreign or dead occupant answers false). Total; never throws.
 */
async function probeDelegatePrimary(port: number, timeoutMs: number = PRIMARY_WATCH_PROBE_TIMEOUT_MS): Promise<boolean> {
	try {
		const url = "http://127.0.0.1:" + String(port) + "/api/version";
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return false;
		const body = (await res.json()) as { protocol?: unknown };
		return body !== null && typeof body === "object" && body.protocol === SWARM_HTTP_PROTOCOL;
	} catch {
		return false;
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

	// --- D1 bind decision (issue #65 item 3) -------------------------------
	// A session that binds the configured port is PRIMARY; a later session sees
	// the delegate primary, mounts NO listener and becomes SECONDARY (the
	// primary serves its fleets read-only); an occupant that is not a delegate
	// server (or nothing at all) falls back to an OS-assigned port (fail-open
	// for single-session). Port 0 is always primary (no canonical port).
	const probePrimary = deps.probePrimary ?? ((port: number) => probeDelegatePrimary(port));
	const tryBind = async (port: number): Promise<Http1ServerHandle | null> => {
		try {
			return await listen(port);
		} catch {
			return null;
		}
	};
	let role: SwarmServerRole = "primary";
	let bound: Http1ServerHandle | null = null;
	let watch: PrimaryWatchHandle | null = null;
	let dashboardUrl = dashboardUrlFor(cfg.port);
	const emitDashboard = (port: number): void => {
		dashboardUrl = dashboardUrlFor(port);
		logDashboard(dashboardUrl, dashboardLinkFor(port, operatorToken));
	};

	if (cfg.port === 0) {
		try {
			bound = await listen(0);
		} catch (err) {
			logAdvisory("bind-failed", { port: 0, code: (err as NodeJS.ErrnoException).code ?? String(err) });
			return null;
		}
	} else {
		try {
			bound = await listen(cfg.port);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EADDRINUSE") {
				logAdvisory("bind-failed", { port: cfg.port, code: code ?? String(err) });
				return null;
			}
			if (await probePrimary(cfg.port)) {
				role = "secondary";
				logAdvisory("secondary-mount", {
					port: cfg.port,
					reason: "a delegate primary holds the configured port; this session mounts no listener (its fleets are served read-only through the primary — D1)",
				});
			} else {
				try {
					bound = await listen(0);
					role = "fallback";
					logAdvisory("port-substituted", { requested: cfg.port, bound: bound.port, reason: "EADDRINUSE — bound an OS-assigned port instead" });
				} catch (err2) {
					logAdvisory("bind-failed", { port: 0, code: (err2 as NodeJS.ErrnoException).code ?? String(err2) });
					return null;
				}
			}
			// Takeover watch (item 3b): advisory, bounded backoff; the OS arbitrates.
			watch = startPrimaryWatch({
				port: cfg.port,
				probe: () => probePrimary(cfg.port),
				bind: () => tryBind(cfg.port),
				onPromoted: (promoted) => {
					bound = promoted;
					role = "primary";
					// Only a real port CHANGE is re-announced: a secondary's link already
					// names the canonical port (session churn never moves it).
					if (dashboardUrl !== dashboardUrlFor(promoted.port)) emitDashboard(promoted.port);
				},
				log: logAdvisory,
				intervalMs: deps.primaryWatch?.intervalMs,
				maxIntervalMs: deps.primaryWatch?.maxIntervalMs,
			});
		}
	}

	// Bound (or knowingly listenerless) — now (and only now) surface the token
	// and the canonical dashboard link on the session's stderr. This is their
	// ONLY channel (Law 11); the token rides in the fragment, never in the URL
	// path/query. The link names the ACTUAL serving port when this session
	// serves one, else the canonical primary port.
	logOperatorToken(operatorToken);
	emitDashboard(bound ? bound.port : cfg.port);

	const handle: SwarmServerHandle = {
		get role() {
			return role;
		},
		get dashboardUrl() {
			return dashboardUrl;
		},
		get port() {
			return bound ? bound.port : cfg.port;
		},
		get address() {
			return bound ? bound.address : SWARM_SERVER_BIND_HOST;
		},
		stop() {
			watch?.stop();
			watch = null;
			try {
				bound?.close();
			} catch {
				// advisory — a close failure never propagates past stop()
			}
			bound = null;
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
