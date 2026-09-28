/**
 * pi-delegate — src/swarm-server/dashboard-link.ts — the canonical dashboard
 * link spelling (issue #65 items 1–2, ARCHITECTURE §4.2.8, Law 9).
 *
 * MODULE_CONTRACT — ONE spelling of the dashboard URL and its fragment-token
 * link. The URL names the ACTUAL bound port (the EADDRINUSE substitution is
 * reflected, never the configured one); the token rides in the URL FRAGMENT
 * only — a fragment is never sent to the server, so the token cannot appear
 * in a request line, a server log, the journal or a response body.
 *
 * The ANNOUNCEMENT of the link lives on the announce seam (./announce.ts,
 * the startup-noise round): the mount emits one structured `dashboard`
 * event; UI sessions render it as a notify row, headless mode keeps the
 * historical stderr JSON line. This leaf owns only the spelling.
 *
 * Lives on a leaf so `./mount.ts` stays under the Law 5 size threshold.
 *
 * Dependencies: none above node (a leaf). No herdr import (Law 4); no store
 * (Law 13).
 *
 * Critical invariants:
 *   - `dashboardUrlFor` is pure and names the passed port verbatim;
 *   - `dashboardLinkFor` places the token AFTER `#t=` — never a path/query.
 */

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
