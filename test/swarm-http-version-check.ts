/**
 * swarm-http-version-check — issue #55 acceptance 3 (ARCHITECTURE §4.2,
 * Law 7): the version-negotiation contract of the HTTP/WS surface.
 *
 * The documented rule (docs/swarm-http-api.md §3):
 *   1. every envelope — success AND error — carries `schemaVersion: 1`;
 *   2. clients MUST tolerate unknown fields (envelopes are additive-only);
 *   3. clients check `schemaVersion` and ignore a version they do not support
 *      (a missing version is legacy v1 and stays accepted).
 *
 * This check pins `/api/version` against its golden and proves the rule on
 * the SHIPPED dashboard client (src/swarm-server/public/stream.js): an
 * envelope with an injected unknown field is applied, an unsupported
 * `schemaVersion` is ignored (never half-read), and an absent one is legacy
 * v1. The tree view model is exercised with unknown graph fields too.
 *
 * Run with: bun test/swarm-http-version-check.ts   (from repo root)
 * Fail-fast: top-level watchdog; every fetch is loopback + bounded.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_VERSION } from "../src/version.ts";
import { additiveViolations, HTTP_GOLDENS, render, withKey } from "./swarm-http-goldens.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-http-version-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 25_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-http-version-"));
mkdirSync(join(SANDBOX, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent");
process.env.PI_DELEGATE_EXCHANGE_ROOT = join(SANDBOX, "ex");
process.env.SWARM_JOURNAL_DB = join(SANDBOX, "journal", "events.db");

const publicUrl = (f: string): string => new URL(`../src/swarm-server/public/${f}`, import.meta.url).href;

async function main(): Promise<void> {
	const stream = (await import(publicUrl("stream.js"))) as {
		initialStreamState: (after?: number) => Record<string, unknown>;
		reduceFrame: (state: Record<string, unknown>, frame: unknown) => Record<string, unknown>;
		SUPPORTED_STREAM_SCHEMA_VERSION: number;
	};
	const tree = (await import(publicUrl("tree.js"))) as { buildTreeView: (g: unknown) => { nodeCount: number } };

	check("N0 the shipped dashboard client declares schema version 1", stream.SUPPORTED_STREAM_SCHEMA_VERSION === 1, String(stream.SUPPORTED_STREAM_SCHEMA_VERSION));

	// -----------------------------------------------------------------------
	// N1 — /api/version pinned + schemaVersion on success AND error envelopes
	// -----------------------------------------------------------------------
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
	const h = await mountSwarmServer({ sessionFile: "/sessions/version.jsonl", env: { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" } });
	check("N1.0 mount returns a handle", h !== null);
	if (h) {
		const get = async (path: string): Promise<{ status: number; body: string }> => {
			const res = await fetch(`http://127.0.0.1:${h.port}${path}`, { signal: AbortSignal.timeout(5_000) });
			return { status: res.status, body: await res.text() };
		};
		const versionGolden = render(HTTP_GOLDENS.version, { VERSION: EXTENSION_VERSION });
		const v = await get("/api/version");
		check("N1.1 GET /api/version → 200 + byte-exact frozen envelope", v.status === 200 && v.body === versionGolden, `${v.status} ${v.body}`);

		const nf = await get("/api/nope");
		const bad = JSON.parse((await get("/api/swarm/events?after=abc")).body) as Record<string, unknown>;
		check(
			"N1.2 schemaVersion is present on the error envelopes too (404 and 400 — Law 7)",
			JSON.parse(nf.body).schemaVersion === 1 && bad.schemaVersion === 1,
			`${nf.body} | ${JSON.stringify(bad)}`,
		);

		// --------------------------------------------------------------------
		// N2 — unknown-field tolerance (the client applies, never rejects)
		// --------------------------------------------------------------------
		const snapFrame = {
			ok: true,
			schemaVersion: 1,
			type: "snapshot",
			injectedUnknownField: { eye: "cat" },
			snapshot: {
				schemaVersion: 1,
				available: true,
				sources: { journal: true, manifests: true, liveStatus: false, usage: false },
				futureSource: "unknown",
				nodes: [{ kind: "task", id: "alpha", workers: [], degraded: [], futureNodeField: 7 }],
				edges: [],
				orphans: [],
			},
		};
		const applied = stream.reduceFrame(stream.initialStreamState(0), snapFrame);
		check(
			"N2.1 the dashboard applies an envelope carrying injected unknown fields (top-level + nested)",
			applied.snapshot !== null && applied.state === "open",
			JSON.stringify(applied),
		);
		const evFrame = { ok: true, schemaVersion: 1, type: "events", after: 0, injectedUnknownField: true, events: [{ seq: 1, kind: "progress", futureRowField: "x" }] };
		const advanced = stream.reduceFrame(applied, evFrame);
		check("N2.2 an events frame with an injected unknown field advances the cursor", advanced.lastSeq === 1, JSON.stringify(advanced));
		check("N2.3 the tree view model tolerates unknown graph/node fields", tree.buildTreeView(snapFrame.snapshot).nodeCount === 1, JSON.stringify(tree.buildTreeView(snapFrame.snapshot)));

		// --------------------------------------------------------------------
		// N3 — schemaVersion is CHECKED: unsupported version ignored, absent = v1
		// --------------------------------------------------------------------
		const future = stream.reduceFrame(stream.initialStreamState(0), { ok: true, schemaVersion: 2, type: "snapshot", snapshot: { nodes: [], edges: [], orphans: [] } });
		check("N3.1 an unsupported schemaVersion is IGNORED (state unchanged, never half-read)", future.snapshot === null && future.lastSeq === 0, JSON.stringify(future));
		const legacy = stream.reduceFrame(stream.initialStreamState(0), { ok: true, type: "snapshot", snapshot: { nodes: [], edges: [], orphans: [] } });
		check("N3.2 a missing schemaVersion is legacy v1 and accepted (tolerance convention)", legacy.snapshot !== null, JSON.stringify(legacy));

		// --------------------------------------------------------------------
		// N4 — the golden itself is an additive wrapper: unknown fields pass
		// --------------------------------------------------------------------
		check(
			"N4 the live /api/version envelope passes additive with an injected unknown field",
			additiveViolations(JSON.parse(versionGolden), withKey(JSON.parse(v.body), "injectedUnknownField", true)).length === 0,
		);
		h.stop();
	}
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

watchdog.close?.();
if (failures > 0) {
	console.error(`\nswarm-http-version-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-http-version-check: all checks passed");
process.exit(0);