/**
 * pi-delegate — src/swarm-server/auth.ts — the operator-token gate of the
 * mutation surface (issue #51, ARCHITECTURE §4.2.4, Law 11).
 *
 * MODULE_CONTRACT — the session-hosted server's mutation endpoints are
 * operator-only: a per-mount random token is generated in memory, surfaced
 * ONLY on the session's stderr (the operator's UI — never the journal, a
 * response body or a log file), and required as `Authorization: Bearer
 * <token>` on every POST. GET and the WebSocket stream stay open (the #50
 * loopback read trust model is unchanged — §4.2.3); the token gates WRITES
 * only.
 *
 * Comparison is constant-time (sha256 both sides, timingSafeEqual) so a
 * wrong token cannot be probed byte-by-byte. A missing, malformed or wrong
 * token yields the SAME uniform refusal — the gate never reveals which.
 *
 * Dependencies: node:crypto only (a leaf). No herdr import (Law 4); no
 * journal or durable-store import (Law 13 — this module cannot leak).
 *
 * Critical invariants:
 *   - the token is random per mount (crypto.randomBytes, 32 bytes → 64 hex);
 *   - the token is NEVER written to the journal, a response body or a log
 *     file; the mount surfaces it on stderr once;
 *   - the compare is constant-time and total (never throws).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Generate a fresh per-mount operator token (64 lowercase hex chars). */
export function generateOperatorToken(): string {
	return randomBytes(32).toString("hex");
}

/** The Bearer token presented by a request, or undefined (absent/malformed). */
export function bearerTokenOf(req: { headers: Record<string, string> }): string | undefined {
	const raw = req.headers.authorization;
	if (typeof raw !== "string") return undefined;
	const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
	return m ? m[1].trim() : undefined;
}

/**
 * Constant-time token compare (sha256 pre-image keeps the inputs
 * length-independent so timingSafeEqual never throws on length mismatch).
 * <p>
 * FUNCTION_CONTRACT: Input — provided (possibly undefined/malformed) and
 * expected (the mount's token). Output — true iff provided === expected.
 * Guarantees: total, constant-time over equal-length digests; never throws.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
	if (typeof provided !== "string" || provided.length === 0 || expected.length === 0) return false;
	const a = createHash("sha256").update(provided).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}
