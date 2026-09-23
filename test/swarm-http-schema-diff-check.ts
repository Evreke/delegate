/**
 * swarm-http-schema-diff-check — issue #55 acceptance 1 (ARCHITECTURE §4.2,
 * Law 7): the additive-only discipline of the HTTP API's envelopes.
 *
 * The rule: a shipped envelope may only be ADDED to. Losing or renaming a
 * field relative to its golden is a CI failure; adding an unknown field is
 * legal and passes. This check pins the comparator's behavior itself (the
 * red legs: field removal, field rename, array shrink, type change) and
 * exercises it against the LIVE server (green legs: real envelopes pass; an
 * envelope with one dropped field fails), so the gate that
 * test/swarm-http-api-check.ts applies to every golden cannot silently
 * weaken.
 *
 * The per-endpoint live envelopes (snapshot, events, console, mutation) are
 * additionally compared additively by test/swarm-http-api-check.ts's golden()
 * helper; this file proves the mechanism and the universal wrapper envelope.
 *
 * Run with: bun test/swarm-http-schema-diff-check.ts   (from repo root)
 * Fail-fast: top-level watchdog; every fetch is loopback + bounded.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_VERSION } from "../src/version.ts";
import { additiveViolations, HTTP_GOLDENS, render, withKey, withoutKey } from "./swarm-http-goldens.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-http-schema-diff-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-http-diff-"));
mkdirSync(join(SANDBOX, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent");
process.env.PI_DELEGATE_EXCHANGE_ROOT = join(SANDBOX, "ex");
process.env.SWARM_JOURNAL_DB = join(SANDBOX, "journal", "events.db");

async function main(): Promise<void> {
	// -----------------------------------------------------------------------
	// D1 — comparator self-test: the red legs (removal/rename/shrink/type)
	// -----------------------------------------------------------------------
	const version = JSON.parse(render(HTTP_GOLDENS.version, { VERSION: EXTENSION_VERSION })) as Record<string, unknown>;
	const notFound = JSON.parse(render(HTTP_GOLDENS.notFound, { PATH: "/api/nope" })) as Record<string, unknown>;

	check("D1.1 golden vs itself → no violations (baseline)", additiveViolations(version, version).length === 0, JSON.stringify(additiveViolations(version, version)));
	check("D1.2 a REMOVED top-level field fails", additiveViolations(version, withoutKey(version, "protocol")).length > 0, JSON.stringify(additiveViolations(version, withoutKey(version, "protocol"))));
	check("D1.3 a RENAMED field fails (old key missing)", additiveViolations(version, { ...(withoutKey(version, "protocol") as Record<string, unknown>), protocolVersion: "swarm-http/1" }).length > 0);
	check("D1.4 an ADDED unknown field PASSES (additions are legal)", additiveViolations(version, withKey(version, "futureField", { eye: "cat" })).length === 0, JSON.stringify(additiveViolations(version, withKey(version, "futureField", 1))));
	check("D1.5 a nested REMOVED field fails", additiveViolations(notFound, { ...notFound, error: withoutKey(notFound.error as Record<string, unknown>, "hint") }).length > 0);
	check("D1.6 a nested ADDED field passes", additiveViolations(notFound, { ...notFound, error: withKey(notFound.error as Record<string, unknown>, "traceId", "t") }).length === 0);
	check("D1.7 a TYPE change fails", additiveViolations(version, { ...version, schemaVersion: "1" }).length > 0, JSON.stringify(additiveViolations(version, { ...version, schemaVersion: "1" })));
	check("D1.8 an array SHRINK fails", additiveViolations([{ a: 1 }, { a: 2 }], [{ a: 1 }]).length > 0);
	check("D1.9 an array ADDITION passes", additiveViolations([{ a: 1 }], [{ a: 1 }, { a: 2 }]).length === 0);

	// -----------------------------------------------------------------------
	// D2 — live leg: the server's real envelopes pass; a dropped field fails
	// -----------------------------------------------------------------------
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
	const h = await mountSwarmServer({ sessionFile: "/sessions/schema-diff.jsonl", env: { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" } });
	check("D2.0 mount returns a handle", h !== null);
	if (h) {
		const get = async (path: string): Promise<{ status: number; json: Record<string, unknown> }> => {
			const res = await fetch(`http://127.0.0.1:${h.port}${path}`, { signal: AbortSignal.timeout(5_000) });
			return { status: res.status, json: JSON.parse(await res.text()) as Record<string, unknown> };
		};
		const liveVersion = await get("/api/version");
		const liveNotFound = await get("/api/nope");
		check(
			"D2.1 LIVE /api/version passes additive vs its golden (and carries schemaVersion)",
			liveVersion.status === 200 && liveVersion.json.schemaVersion === 1 && additiveViolations(version, liveVersion.json).length === 0,
			JSON.stringify(additiveViolations(version, liveVersion.json)),
		);
		check(
			"D2.2 LIVE 404 error passes additive vs its golden (schemaVersion on errors — Law 7)",
			liveNotFound.status === 404 && liveNotFound.json.schemaVersion === 1 && additiveViolations(notFound, liveNotFound.json).length === 0,
			JSON.stringify(additiveViolations(notFound, liveNotFound.json)),
		);
		check(
			"D2.3 the gate catches a REGRESSION: dropping schemaVersion from the live envelope fails",
			additiveViolations(version, withoutKey(liveVersion.json, "schemaVersion")).length > 0,
		);
		check(
			"D2.4 the gate tolerates an ADDITION: an injected unknown field on the live envelope passes",
			additiveViolations(version, withKey(liveVersion.json, "injectedUnknownField", true)).length === 0,
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
	console.error(`\nswarm-http-schema-diff-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-http-schema-diff-check: all checks passed");
process.exit(0);