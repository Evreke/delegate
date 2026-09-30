/**
 * auth-bootstrap.js — the fragment-token bootstrap (issue #65 item 2).
 *
 * The operator reaches the dashboard through a widget/mount link that carries
 * the session's operator token in the URL **fragment**:
 *
 *   127.0.0.1:<port>/#t=<operator token>   (no scheme spelled here — the
 *   asset scanner forbids external-URL literals in the shipped assets)
 *
 * A fragment is NEVER sent to the server (the browser keeps it client-side),
 * so the token cannot appear in a request line, a server log, the journal or a
 * response body. On load this module reads `#t=<token>`, moves it into the
 * existing `sessionStorage` operator-token store (`steer.js` `TOKEN_KEY` — the
 * ONE token store) and strips the fragment with `history.replaceState`, so the
 * token never lingers in the address bar, the history entry or a copied URL.
 *
 * A bookmark WITHOUT a fragment bootstraps nothing — the existing manual
 * prompt in `mutations.js` stays the fallback (a 401 re-prompts).
 *
 * R9 deep link: the SAME fragment may carry a further `node=<id>` parameter
 * (`#t=<token>&node=<id>`) naming the graph node to select at load. This
 * module only parses it (`parseFragmentNode`) and strips the fragment once
 * read; app.js applies the selection when the first state resolves and
 * ignores unknown/missing ids. The `#t=` spelling stays the ONE leading
 * spelling (Law 9 / pin T1.29) — `node` is a parameter of it, never a
 * query string.
 *
 * No framework, plain ES module; every browser seam (`location`, `history`,
 * `storage`) is injected so the module is unit-testable headlessly.
 */

import { writeToken } from "./steer.js";

/** The fragment key the link uses: `#t=<token>` (Law 9 — one spelling). */
export const FRAGMENT_TOKEN_KEY = "t";

/** The deep-link node key: `#t=<token>&node=<id>` (R9) — a FURTHER parameter
 *  of the same `#t=` fragment, never a second fragment spelling. */
export const FRAGMENT_NODE_KEY = "node";

/**
 * Parse the operator token out of a URL fragment.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: hash — a `location.hash` value (`""`, `"#t=abc"`, `"#a=1&t=abc"`)
 * Output: the decoded non-empty token, or null when absent/empty/undecodable
 * Guarantees: pure; never throws; only the documented `t` key is read
 * Raises: never
 */
export function parseFragmentToken(hash) {
	if (typeof hash !== "string" || hash.length === 0) return null;
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (raw.length === 0) return null;
	for (const part of raw.split("&")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		if (part.slice(0, eq) !== FRAGMENT_TOKEN_KEY) continue;
		let value = part.slice(eq + 1);
		try {
			value = decodeURIComponent(value);
		} catch {
			return null;
		}
		return value.length > 0 ? value : null;
	}
	return null;
}

/**
 * Parse the deep-link node id out of a URL fragment (R9).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: hash — a `location.hash` value (`""`, `"#t=abc&node=n1"`,
 *   `"#node=n1"` — a node-only link works when the token is already in
 *   sessionStorage)
 * Output: the decoded non-empty node id, or null when absent/empty/undecodable
 * Guarantees: pure; never throws; only the documented `node` key is read;
 *   the id is a graph node id passed to the UI verbatim (no DOM lookup here)
 * Raises: never
 */
export function parseFragmentNode(hash) {
	if (typeof hash !== "string" || hash.length === 0) return null;
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (raw.length === 0) return null;
	for (const part of raw.split("&")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		if (part.slice(0, eq) !== FRAGMENT_NODE_KEY) continue;
		let value = part.slice(eq + 1);
		try {
			value = decodeURIComponent(value);
		} catch {
			return null;
		}
		return value.length > 0 ? value : null;
	}
	return null;
}

/**
 * Strip the fragment from the address bar via `history.replaceState`.
 * <p>
 * FUNCTION_CONTRACT: Input — location (pathname+search), history.
 * Output: none. Guarantees: total (a missing history / private-mode throw is
 * swallowed — the fragment strip is best effort). Raises: never.
 */
export function stripFragment(location, history) {
	if (!history || typeof history.replaceState !== "function") return;
	const path = `${(location && location.pathname) || "/"}${(location && location.search) || ""}`;
	try {
		history.replaceState(null, "", path);
	} catch {
		/* best effort — a private-mode failure never breaks the dashboard */
	}
}

/**
 * Bootstrap the operator token from the URL fragment, exactly once.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: { location, history, storage } browser seams (all optional)
 * Output: the token that was moved to sessionStorage, or null when no
 *   fragment token was present
 * Guarantees:
 *   - the token is written to the sessionStorage store only (steer.js
 *     `writeToken` — never localStorage, never a URL/query/log)
 *   - the fragment is stripped from the address bar on every match — a
 *     token OR the R9 deep-link `node` parameter (both ride the same
 *     `#t=` fragment, and the fragment is transient by design)
 *   - total: a missing seam or a throwing store never breaks page start
 * Raises: never
 */
export function bootstrapFragmentToken(env = {}) {
	const location = env.location || null;
	const hash = location ? location.hash : "";
	const token = parseFragmentToken(hash);
	// R9: the deep-link node id rides the SAME fragment — read here only to
	// decide the strip (app.js parses it before this call, while the fragment
	// still exists); it never enters the token path.
	const node = parseFragmentNode(hash);
	if (token === null && node === null) return null;
	if (token !== null) writeToken(env.storage || null, token);
	stripFragment(location, env.history || null);
	return token;
}
