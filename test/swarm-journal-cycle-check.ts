/**
 * swarm-journal-cycle-check — issue #23 acceptance 2 (ARCHITECTURE §4.1.3,
 * cutover criterion 2): with the manifest projection DISABLED by flag, the
 * full delegate cycle works on the JOURNAL ALONE.
 *
 * Run with: bun test/swarm-journal-cycle-check.ts   (from the repo root)
 *
 * The real delegate tool (spawn → settle → collect) is driven in a child
 * process (test/swarm-journal-cycle-driver.ts — the storage default is chosen
 * once at module load, so the config must be fixed before import) against a
 * mock Transport, with `SWARM_STORAGE=journal` and `SWARM_PROJECTION=false`.
 *
 * Checks:
 *   J1  The cycle returns ok (spawn + collect both succeed on the journal).
 *   J2  NO manifest.json exists — the journal is the only truth.
 *   J3  The journal replay (manifestStore.read) shows the collected worker —
 *       the fleet survives on the journal alone.
 *   J4  The journal carries the lifecycle events (spawn + stamp) plus the
 *       worker-verb `report` event.
 *   J5  The worker's write-report verb succeeded (journal mode) — the cycle's
 *       terminal artifact is produced through the verb, not a hand-written file.
 *   J6  The collect-path usage cache is journaled as a fleet-scoped `usage`
 *       stamp, so with projection disabled the usage line is recovered by
 *       replay (Law 9: no raw-file bypass on the collect path).
 *
 * RPC_E2E leg: when `RPC_E2E=1` the SAME cycle runs against the real
 * `pi --mode rpc` backend (burns tokens; needs host auth/config). Without the
 * gate the leg is an HONEST SKIP with its repro command — the deterministic
 * mock leg above always runs.
 *
 * Fail-fast: every child spawn is bounded; a top-level watchdog exits non-zero.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const watchdog = setTimeout(() => {
	console.error("swarm-journal-cycle-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 120_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const DRIVER = join(ROOT, "test", "swarm-journal-cycle-driver.ts");

interface DriverOut {
	ok: boolean;
	code: string;
	projectionExists: boolean;
	replayWorkers: Array<{ name: string; collected: boolean }>;
	replayUsage: unknown;
	journalKinds: string[];
	cliExit: number | null;
	cliStderr: string;
	cliJournal: { ok?: boolean; journal?: { seq?: number } | { error?: string } } | null;
}

/** Run the cycle driver (bounded) under a journal configuration. */
function drive(
	mode: "fake" | "rpc",
	opts: { projection: boolean; journalDb: string; timeoutMs: number },
): { out: DriverOut | null; stdout: string; stderr: string; status: number | null } {
	const exchange = mkdtempSync(join(tmpdir(), "jcy-check-exchange-"));
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	env.PI_DELEGATE_EXCHANGE_ROOT = exchange;
	env.PI_CODING_AGENT_DIR = join(exchange, "agent");
	env.SWARM_STORAGE = "journal";
	env.SWARM_PROJECTION = opts.projection ? "true" : "false";
	env.SWARM_JOURNAL_DB = opts.journalDb;
	env.SWARM_SESSION_ID = "jcy-check-session";
	const res = spawnSync("bun", [DRIVER, mode], { env, encoding: "utf8", timeout: opts.timeoutMs });
	rmSync(exchange, { recursive: true, force: true });
	let out: DriverOut | null = null;
	try {
		out = JSON.parse((res.stdout ?? "").split("\n").find((l) => l.startsWith("{")) ?? "") as DriverOut;
	} catch {
		out = null;
	}
	return { out, stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

// ---------------------------------------------------------------------------
// Deterministic leg — mock transport, journal alone, projection off
// ---------------------------------------------------------------------------
{
	const sandbox = mkdtempSync(join(tmpdir(), "jcy-check-db-"));
	const run = drive("fake", { projection: false, journalDb: join(sandbox, "events.db"), timeoutMs: 25_000 });
	rmSync(sandbox, { recursive: true, force: true });
	check("J0.1 the child cycle completed (driver reached its JSON output)", run.out !== null, run.stdout.slice(-300) || run.stderr.slice(-300));
	const o = run.out;
	check("J1 the delegate cycle (spawn + collect) succeeds on the journal alone", o?.ok === true, JSON.stringify(o));
	check("J2 projection=false writes NO manifest.json (journal is the only truth)", o?.projectionExists === false, JSON.stringify(o?.projectionExists));
	check(
		"J3 the journal replay shows the collected worker (manifestStore.read)",
		!!o && o.replayWorkers.length === 1 && o.replayWorkers[0]!.collected === true,
		JSON.stringify(o?.replayWorkers),
	);
	check(
		"J4 the journal carries the lifecycle events (spawn + stamp) plus the verb `report` event",
		!!o && o.journalKinds.includes("spawn") && o.journalKinds.includes("stamp") && o.journalKinds.includes("report"),
		JSON.stringify(o?.journalKinds),
	);
	check(
		"J5 the worker's write-report verb succeeded and journaled in journal mode",
		!!o && o.cliExit === 0 && typeof (o.cliJournal?.journal as { seq?: number } | undefined)?.seq === "number",
		JSON.stringify({ cliExit: o?.cliExit, cliJournal: o?.cliJournal }),
	);
	check(
		"J6 the collect-path usage snapshot is visible from the journal replay alone (projection off)",
		!!o && !!o.replayUsage && typeof o.replayUsage === "object" && (o.replayUsage as { workers?: unknown }).workers === 1,
		JSON.stringify(o?.replayUsage),
	);
}

// ---------------------------------------------------------------------------
// RPC_E2E leg — real rpc backend; honest skip without the gate
// ---------------------------------------------------------------------------
if (process.env.RPC_E2E !== "1") {
	console.log(
		"SKIP  J7 rpc-backend journal-alone cycle — set RPC_E2E=1 to run (needs host auth/config).",
	);
	console.log(`      repro: RPC_E2E=1 bun test/swarm-journal-cycle-check.ts   (driver: bun ${DRIVER} rpc)`);
} else {
	const sandbox = mkdtempSync(join(tmpdir(), "jcy-check-rpc-db-"));
	const run = drive("rpc", { projection: false, journalDb: join(sandbox, "events.db"), timeoutMs: 180_000 });
	rmSync(sandbox, { recursive: true, force: true });
	const o = run.out;
	check("J7.1 the rpc-backend cycle succeeds on the journal alone", o?.ok === true, run.stdout.slice(-300) || run.stderr.slice(-300));
	check("J7.2 projection=false writes NO manifest.json (rpc leg)", o?.projectionExists === false, JSON.stringify(o?.projectionExists));
	check(
		"J7.3 the journal replay shows the collected worker (rpc leg)",
		!!o && o.replayWorkers.length === 1 && o.replayWorkers[0]!.collected === true,
		JSON.stringify(o?.replayWorkers),
	);
}

console.log(failures === 0 ? "\nswarm-journal-cycle-check: all checks passed" : `\nswarm-journal-cycle-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);