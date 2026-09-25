/**
 * swarm-journal-fault-check — issue #23 acceptance 3 (ARCHITECTURE §4.1.3
 * cutover criterion 4, Law 8 / Law 13): a FAILING journal can never fail a
 * verb write, a spawn, or a collect.
 *
 * Run with: bun test/swarm-journal-fault-check.ts   (from the repo root)
 *
 * The journal is broken DETERMINISTICALLY by pointing its path at a directory
 * (SQLite cannot open a directory as a database), so every open/append returns
 * the `E_JOURNAL_OPEN` failure — never a throw.
 *
 * Checks:
 *   F1  In-process: createJournalManifestStore over a broken journal still
 *       resolves append/update and writes the byte-frozen projection; reads
 *       degrade to the tolerant-empty plane.
 *   F2  Child: the REAL delegate cycle (spawn → settle → collect) over a
 *       broken journal returns ok and leaves a valid manifest.json — the
 *       pipeline is not failed by the journal.
 *   F3  The worker's write-report verb exits 0 with `journal:{error}` in the
 *       success envelope and NO structured stderr warning line (the failure is
 *       envelope-only, not stderr noise).
 *   F4  ask / write-progress over the broken journal also exit 0.
 *   F5  appendSwarmEvent is total: a broken journal yields a structured
 *       `{error}` result, never a throw.
 *
 * Fail-fast: every child spawn is bounded; a top-level watchdog exits non-zero.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createJournalManifestStore, type ManifestWorker } from "../src/manifest-store.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-journal-fault-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 60_000);
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
const CLI = join(ROOT, "src", "swarm", "cli.ts");
const DRIVER = join(ROOT, "test", "swarm-journal-cycle-driver.ts");

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-fault-"));
const EXCHANGE_ROOT = join(SANDBOX, "exchange");
const TASK = "task-fault";
const DIR = join(EXCHANGE_ROOT, TASK);
const WORKER = "fault-w1";
// A DIRECTORY at the database path is always unopenable as SQLite → E_JOURNAL_OPEN.
const BROKEN_DB = join(SANDBOX, "broken-journal-dir");
mkdirSync(BROKEN_DB, { recursive: true });
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, `brief-${WORKER}.md`), `# Brief — ${WORKER}\n\nDo the fault thing.\n`);

function makeWorker(name: string): ManifestWorker {
	return {
		name,
		placement: { kind: "worktree", workspaceId: "ws", paneId: "p", checkoutPath: join(SANDBOX, "co") } as ManifestWorker["placement"],
		briefPath: join(DIR, `brief-${name}.md`),
		reportPath: join(DIR, `report-${name}.json`),
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: "2026-01-01T00:00:00.000Z",
	};
}

/** Run a CLI verb over the broken journal (bounded). */
function runCli(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_ROOT;
	env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent");
	env.SWARM_STORAGE = "journal";
	env.SWARM_PROJECTION = "true";
	env.SWARM_JOURNAL_DB = BROKEN_DB;
	env.SWARM_SESSION_ID = "fault-session";
	env.SWARM_TASK = TASK;
	env.SWARM_WORKER = WORKER;
	const res = spawnSync("bun", [CLI, ...args], { env, input, encoding: "utf8", timeout: 20_000 });
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

try {
	// -----------------------------------------------------------------------
	// F1 — in-process store append/update over a broken journal
	// -----------------------------------------------------------------------
	{
		const store = createJournalManifestStore({ dbPath: BROKEN_DB, sessionId: "fault-session", projection: true });
		let threw = false;
		let projected: unknown = null;
		try {
			await store.append(DIR, makeWorker(WORKER));
			projected = await store.update(DIR, (m) => ({
				...m,
				workers: m.workers.map((w) => (w.name === WORKER ? { ...w, collectedAt: "2026-01-01T00:00:00.000Z" } : w)),
			}));
		} catch {
			threw = true;
		}
		check("F1.1 append/update over a broken journal never throw", !threw);
		check("F1.2 the store still resolved a manifest object", !!projected && typeof projected === "object");
		let onDisk: string | null = null;
		try {
			onDisk = readFileSync(join(DIR, "manifest.json"), "utf8");
		} catch {
			onDisk = null;
		}
		check("F1.3 the byte-frozen projection is still written", typeof onDisk === "string" && onDisk.length > 0, String(onDisk).slice(0, 80));
		check(
			"F1.4 a broken journal degrades reads to the tolerant-empty plane (never a throw)",
			store.read(DIR) === null && store.scan("herdr").length === 0,
		);
	}

	// -----------------------------------------------------------------------
	// F2 — the real delegate cycle over a broken journal
	// -----------------------------------------------------------------------
	{
		const exchange = mkdtempSync(join(tmpdir(), "swarm-fault-cycle-"));
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
		env.PI_DELEGATE_EXCHANGE_ROOT = exchange;
		env.PI_CODING_AGENT_DIR = join(exchange, "agent");
		env.SWARM_STORAGE = "journal";
		env.SWARM_PROJECTION = "true";
		env.SWARM_JOURNAL_DB = BROKEN_DB;
		env.SWARM_SESSION_ID = "fault-session";
		const res = spawnSync("bun", [DRIVER, "fake"], { env, encoding: "utf8", timeout: 30_000 });
		rmSync(exchange, { recursive: true, force: true });
		let out: Record<string, unknown> | null = null;
		try {
			out = JSON.parse((res.stdout ?? "").split("\n").find((l) => l.startsWith("{")) ?? "") as Record<string, unknown>;
		} catch {
			out = null;
		}
		check("F2.1 the delegate cycle returns ok over a broken journal (spawn + collect not failed)", out?.ok === true, JSON.stringify(out) || res.stdout.slice(-300));
		check("F2.2 the cycle still wrote the manifest.json projection", out?.projectionExists === true, JSON.stringify(out?.projectionExists));
		check(
			"F2.3 the worker's write-report verb exited 0 with a journal error envelope (no structured stderr note)",
			out?.cliExit === 0 &&
				typeof (out?.cliJournal as { journal?: { error?: string } } | null)?.journal?.error === "string" &&
				!String(out?.cliStderr ?? "").includes("\"component\":\"swarm-journal\""),
			JSON.stringify({ cliExit: out?.cliExit, cliStderr: out?.cliStderr }),
		);
	}

	// -----------------------------------------------------------------------
	// F3/F4 — verb writes over the broken journal
	// -----------------------------------------------------------------------
	{
		const report = runCli(["write-report"], JSON.stringify({ worker: WORKER, status: "pass", summary: "s", artifacts: [], evidence: [] }));
		const env = report.stdout.trim() ? (JSON.parse(report.stdout.trim()) as { journal?: { error?: string } }) : {};
		check("F3.1 write-report exits 0 over a broken journal", report.status === 0, report.stdout || report.stderr);
		check("F3.2 the success envelope records the journal error (advisory)", env.journal?.error === "E_JOURNAL_OPEN", report.stdout);
		check(
			"F3.3 no structured stderr warning line is emitted (the error is envelope-only)",
			!report.stderr.includes("\"level\":\"warn\"") && !report.stderr.includes("\"component\":\"swarm-journal\""),
			report.stderr,
		);
		const ask = runCli(["ask", "--question", "q?"]);
		const progress = runCli(["write-progress", "--phase", "x"]);
		check("F4.1 ask exits 0 over a broken journal", ask.status === 0, ask.stdout || ask.stderr);
		check("F4.2 write-progress exits 0 over a broken journal", progress.status === 0, progress.stdout || progress.stderr);
	}

	// -----------------------------------------------------------------------
	// F5 — appendSwarmEvent is total
	// -----------------------------------------------------------------------
	{
		process.env.SWARM_STORAGE = "journal";
		process.env.SWARM_JOURNAL_DB = BROKEN_DB;
		process.env.SWARM_SESSION_ID = "fault-session";
		const { appendSwarmEvent } = await import("../src/swarm/storage.ts");
		let threw = false;
		let result: unknown = null;
		try {
			result = await appendSwarmEvent({ task: TASK, worker: WORKER, dir: DIR }, "progress", { worker: WORKER, ts: "T", phase: "p" });
		} catch {
			threw = true;
		}
		check("F5.1 appendSwarmEvent never throws on a broken journal", !threw);
		check(
			"F5.2 appendSwarmEvent returns the structured {error} outcome",
			!!result && typeof (result as { error?: unknown }).error === "string",
			JSON.stringify(result),
		);
	}
} finally {
	rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nswarm-journal-fault-check: all checks passed" : `\nswarm-journal-fault-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);