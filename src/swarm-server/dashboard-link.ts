/**
 * pi-delegate — src/swarm-server/dashboard-link.ts — the canonical dashboard
 * link spelling (issue #65 items 1–2, ARCHITECTURE §4.2.8, Law 9/Law 11).
 *
 * MODULE_CONTRACT — ONE spelling of the dashboard URL, its fragment-token
 * link and the structured announcement the mount emits exactly once
 * per successful bind. The URL names the ACTUAL bound port (the EADDRINUSE
 * substitution is reflected, never the configured one); the token rides in
 * the URL FRAGMENT only — a fragment is never sent to the server, so the
 * token cannot appear in a request line, a server log, the journal or a
 * response body.
 *
 * Lives on a leaf so `./mount.ts` stays under the Law 5 size threshold. The
 * ONLY channel of the link is the session's ONE diagnostic channel
 * (src/ui-log.ts — a TUI notification in a UI session, one structured
 * stderr line headless; Law 11); `logDashboard` writes it and swallows a
 * failure (advisory).
 *
 * Dependencies: ../ui-log.ts (the diagnostic channel), none above node
 * otherwise (a leaf). No herdr import (Law 4); no store (Law 13).
 *
 * Critical invariants:
 *   - `dashboardUrlFor` is pure and names the passed port verbatim;
 *   - `dashboardLinkFor` places the token AFTER `#t=` — never a path/query;
 *   - `logDashboard` is total (a throwing stderr never propagates).
 */

import { uiLog } from "../ui-log.ts";

/** The canonical dashboard URL for a bound port (the ACTUAL bound port — the
 *  EADDRINUSE fallback is reflected, never the configured one). */
export function dashboardUrlFor(port: number): string {
	return `http://127.0.0.1:${port}/`;
}

/** The dashboard link: the canonical URL plus the token in the FRAGMENT
 *  (issue #65 item 2 — never a path or query segment). */
export function dashboardLinkFor(port: number, token: string): string {
	return `${dashboardUrlFor(port)}#t=${token}`;
}

/** Surface the canonical dashboard link through the session's ONE diagnostic
 *  channel (src/ui-log.ts) — ONE structured line per bind (issue #65 items
 *  1+2). Total; a failure is advisory. */
export function logDashboard(url: string, link: string): void {
	try {
		uiLog(JSON.stringify({ level: "info", component: "swarm-server", event: "dashboard", url, link }));
	} catch {
		// stringify itself is advisory
	}
}
