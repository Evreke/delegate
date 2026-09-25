/**
 * pi-delegate — src/swarm-server/static.ts — static-file serving for the
 * read-only fleet dashboard (issue #53, ARCHITECTURE §4.2).
 *
 * MODULE_CONTRACT — maps dashboard GET paths to files under
 * `src/swarm-server/public/`: `/` (and any extension-less path) serves
 * `index.html`; `/app.js`, `/stream.js`, `/degrade.js`, `/app.css` serve the
 * flat ES-module/CSS assets next to it. This is the
 * server-side half of the "static SPA, no build step" constraint: the assets
 * are served verbatim as source — no bundler, no framework, no runtime
 * transforms. Only html/js/css are served (the dashboard's closed asset set);
 * anything else is "not a static file" and falls through to the router's
 * structured 404.
 *
 * Safety: the request path is resolved under the public dir and the result is
 * prefix-checked against it — `..`, backslashes, NUL and absolute escapes are
 * refused (null → the caller's 404), so a path can never leave the asset root.
 *
 * Dependencies: node:fs, node:path, node:url, ./http1.ts (types only). A leaf;
 * no read-model, no durable store, no backend adapter (Law 13/Law 4).
 *
 * Critical invariants:
 *   - pure resolution (`resolveStaticPath`) never touches the filesystem;
 *   - `serveStaticFile` is total: a missing/unreadable/non-file path returns
 *     null, never throws (Law 8);
 *   - the served bytes are the raw file contents; the MIME set is exactly
 *     html/js/css.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Http1Response } from "./http1.ts";

/** The dashboard asset root (next to this module). */
export function swarmPublicDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "public");
}

/** The closed MIME set: extension → Content-Type (html/js/css only). */
const STATIC_MIME: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

/** MIME type for a resolved path, or undefined when it is not a served type. */
export function mimeForPath(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	if (dot === -1 || dot < path.lastIndexOf("/")) return undefined;
	return STATIC_MIME[path.slice(dot).toLowerCase()];
}

/**
 * Resolve a request path to an absolute asset path under `publicDir`.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: pathname — the parsed request path (query already stripped by the
 *   http1 core); publicDir — the asset root (defaults to the shipped dir)
 * Output: the absolute path, or null when the request escapes the root or is
 *   not a servable asset shape
 * Guarantees: pure (no I/O); `/` and empty map to `index.html`; `..`, `\`,
 *   NUL and out-of-root results are refused; never throws
 * Raises: never
 */
export function resolveStaticPath(pathname: string, publicDir: string = swarmPublicDir()): string | null {
	let rel = pathname;
	if (rel === "/" || rel.length === 0) rel = "/index.html";
	if (!rel.startsWith("/")) return null;
	rel = rel.slice(1);
	if (rel.length === 0) rel = "index.html";
	if (rel.includes("\0") || rel.includes("\\")) return null;
	// A `..` segment (start, middle or end) would escape the asset root.
	if (/(^|\/)\.\.(\/|$)/.test(rel)) return null;
	const root = resolve(publicDir);
	const full = resolve(root, rel);
	if (full !== root && !full.startsWith(root + sep)) return null;
	return full;
}

/**
 * Serve one dashboard path.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: pathname — request path; publicDir — asset root override
 * Output: the Http1Response (200 + raw bytes + MIME) or null when the path
 *   is not a served static file (the caller answers 404)
 * Guarantees: total — read/stat failures return null, never throw; only
 *   html/js/css are served; the body is the file's utf8 text
 * Raises: never
 */
export function serveStaticFile(pathname: string, publicDir: string = swarmPublicDir()): Http1Response | null {
	const full = resolveStaticPath(pathname, publicDir);
	if (full === null) return null;
	const contentType = mimeForPath(full);
	if (contentType === undefined) return null;
	try {
		if (!statSync(full).isFile()) return null;
		return { status: 200, body: readFileSync(full, "utf8"), contentType };
	} catch {
		return null;
	}
}