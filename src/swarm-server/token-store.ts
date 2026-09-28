/**
 * pi-delegate — src/swarm-server/token-store.ts — the shared per-machine
 * operator token (the startup-noise round; amends ARCHITECTURE §4.2.4).
 *
 * MODULE_CONTRACT — ONE mutation token per machine: every mount of the
 * swarm server reads-or-creates `<agentDir>/delegate-swarm-token`
 * (mode 0600), so the tokenized dashboard link announced in ANY session's
 * UI authenticates against the session that actually serves the fleet (the
 * D1 primary) — the per-mount random token made every secondary session's
 * announced link dead (the primary rejected its token). Rotation is
 * deleting the file; the next mount generates fresh.
 *
 * Degradation is ADVISORY (Law 8): a store path that cannot be written
 * falls back to a per-process random token with `persisted: false` and a
 * machine-readable `warning` — never a throw; the server's mutation gate
 * still works for THIS process, the announced link just stops working
 * across sessions until the store is writable again.
 *
 * Dependencies: node builtins + pi's getAgentDir() (honors
 * PI_CODING_AGENT_DIR — the watcher audit-log precedent). No herdr import
 * (Law 4); no journal/store import (Law 13).
 *
 * Critical invariants:
 *   - the returned token is ALWAYS 64 lowercase hex, whatever the path;
 *   - a well-formed store file is returned verbatim, never rewritten;
 *   - a malformed file is replaced, never trusted;
 *   - the file is written 0600 (operator-private), content token + newline;
 *   - total: never throws.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The token file name under the agent dir (rotation = delete this file). */
export const SWARM_TOKEN_FILE = "delegate-swarm-token";

const HEX64 = /^[0-9a-f]{64}$/;

/** Result of resolving the machine's shared operator token. */
export interface SharedTokenResult {
	/** The operator token (64 lowercase hex) — always present. */
	token: string;
	/** true when the token came from / was persisted to the shared store;
	 *  false when the store was unavailable and a per-process random token
	 *  was minted instead (the announced link then works only this session). */
	persisted: boolean;
	/** Machine-readable degradation code when persisted is false. */
	warning?: string;
}

/**
 * Read-or-create the machine's shared operator token.
 * <p>
 * FUNCTION_CONTRACT: Input — optional agentDir override (tests) and a
 * randomHex factory (tests). Output — { token, persisted, warning? }.
 * Guarantees: total (never throws); 64-hex token on every path; a valid
 * store is never rewritten; a corrupt store is replaced; an unwritable
 * store degrades to an unpersisted per-process token + warning.
 * Raises: never.
 */
export function sharedOperatorToken(opts?: { agentDir?: string; randomHex?: () => string }): SharedTokenResult {
	const randomHex = opts?.randomHex ?? ((): string => randomBytes(32).toString("hex"));
	const dir = opts?.agentDir ?? getAgentDir();
	const path = join(dir, SWARM_TOKEN_FILE);
	try {
		let existing: string | undefined;
		try {
			const raw = readFileSync(path, "utf8").trim();
			if (HEX64.test(raw)) existing = raw;
		} catch {
			// absent or unreadable → create fresh below
		}
		if (existing) return { token: existing, persisted: true };
		const token = randomHex();
		if (!HEX64.test(token)) return { token: randomHex(), persisted: false, warning: "token-store-unavailable" }; // belt for an injected factory
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${token}\n`, { mode: 0o600 });
		return { token, persisted: true };
	} catch {
		// Advisory (Law 8): the store is unavailable — per-process token,
		// machine-readable warning, the mount keeps working.
		return { token: randomHex(), persisted: false, warning: "token-store-unavailable" };
	}
}
