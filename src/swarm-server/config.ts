/**
 * pi-delegate — src/swarm-server/config.ts — the swarm server's config tier.
 *
 * MODULE_CONTRACT — resolves the two `swarm.server.*` keys (issue #50,
 * ARCHITECTURE §4.2): `swarm.server.enabled` (boolean; DEFAULT FALSE — the
 * server is opt-in this release) and `swarm.server.port` (integer 0–65535;
 * DEFAULT 7331; 0 = OS-assigned ephemeral, the documented spelling for
 * parallel sessions).
 *
 * Precedence (the resolveSwarmStorage precedent): env (SWARM_SERVER_ENABLED /
 * SWARM_SERVER_PORT — the test/scripting tier) beats the config file
 * (`swarm.server.enabled` / `swarm.server.port` in
 * ~/.pi/agent/pi-delegate.config.json) beats the defaults. Invalid values
 * degrade to the DEFAULT with a recorded warning, never a throw and never the
 * non-default mode (Law 8: the config tier is advisory to the pipeline).
 *
 * Dependencies: node builtins, ../profile.ts (loadDelegateConfig — the ONE
 * config read). No herdr import (Law 4); no sqlite driver import (the journal
 * module family owns that seam).
 *
 * Critical invariants:
 *   - resolveSwarmServerConfig is TOTAL: a corrupt/throwing config read
 *     degrades to defaults + warning;
 *   - "0" is a VALID port (OS-assigned), never treated as absent;
 *   - loopback-only binding is NOT configurable here (it is a §4.2 trust-model
 *     constant enforced in http1.ts, not an operator knob).
 */

import { loadDelegateConfig } from "../profile.ts";

/** The documented default port (README + §4.2). 0 anywhere means ephemeral. */
export const SWARM_SERVER_DEFAULT_PORT = 7331;

export interface SwarmServerConfig {
	/** Whether the session-hosted server mounts at all. Default false. */
	enabled: boolean;
	/** The requested listen port. 0 = OS-assigned (parallel sessions). */
	port: number;
	/** Non-fatal degradations applied while resolving (invalid values, unreadable config). */
	warnings: string[];
}

function parseBool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (typeof v !== "string") return undefined;
	const s = v.trim().toLowerCase();
	if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
	if (s === "0" || s === "false" || s === "off" || s === "no" || s === "") return false;
	return undefined;
}

/** Integer 0–65535 or undefined (everything else is invalid). */
function parsePort(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isInteger(v)) {
		return v >= 0 && v <= 65535 ? v : undefined;
	}
	if (typeof v !== "string") return undefined;
	const s = v.trim();
	if (!/^\d+$/.test(s)) return undefined;
	const n = Number(s);
	return n >= 0 && n <= 65535 ? n : undefined;
}

/**
 * Resolve the swarm server configuration.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: env — the process environment (explicit param for tests; the env
 *   tier exists for checks and scripting, same as SWARM_STORAGE)
 * Output: the effective { enabled, port, warnings }
 * Guarantees:
 *   - total: a corrupt/throwing config read degrades to defaults + warning
 *   - invalid values degrade to the DEFAULT with a warning (never a throw,
 *     never the non-default mode)
 *   - env beats config keys beat defaults; SWARM_SERVER_ENABLED="" reads as
 *     an EXPLICIT false (the "delete the env override" spelling for checks)
 * Raises: never
 */
export function resolveSwarmServerConfig(env: NodeJS.ProcessEnv = process.env): SwarmServerConfig {
	const warnings: string[] = [];
	let cfgServer: Record<string, unknown> = {};
	try {
		const cfg = loadDelegateConfig() as { swarm?: unknown };
		const swarm = cfg.swarm;
		if (swarm !== null && typeof swarm === "object" && !Array.isArray(swarm)) {
			const server = (swarm as { server?: unknown }).server;
			if (server !== null && typeof server === "object" && !Array.isArray(server)) {
				cfgServer = server as Record<string, unknown>;
			}
		}
	} catch (err) {
		warnings.push(`config unreadable (${(err as Error).message}) — defaults applied`);
	}

	let enabled = false;
	const rawEnabled = env.SWARM_SERVER_ENABLED !== undefined ? env.SWARM_SERVER_ENABLED : cfgServer.enabled;
	if (rawEnabled !== undefined) {
		const b = parseBool(rawEnabled);
		if (b === undefined) warnings.push(`invalid swarm.server.enabled ${JSON.stringify(String(rawEnabled))} — default false applied`);
		else enabled = b;
	}

	let port = SWARM_SERVER_DEFAULT_PORT;
	const rawPort = env.SWARM_SERVER_PORT !== undefined ? env.SWARM_SERVER_PORT : cfgServer.port;
	if (rawPort !== undefined) {
		const p = parsePort(rawPort);
		if (p === undefined) warnings.push(`invalid swarm.server.port ${JSON.stringify(String(rawPort))} — default ${SWARM_SERVER_DEFAULT_PORT} applied`);
		else port = p;
	}

	return { enabled, port, warnings };
}
