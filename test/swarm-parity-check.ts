/**
 * swarm-parity-check — issue #23 acceptance 1 (ARCHITECTURE §4.1.3, Law 7):
 * identical flows over BOTH storage modes produce BYTE-IDENTICAL projections.
 *
 * Run with: bun test/swarm-parity-check.ts   (from the repo root)
 *
 * Method: the SAME scenario runs twice over the SAME task dir — once with the
 * file-backed store (files = truth), once with the journal-backed store
 * (journal = truth, manifest.json a generated projection). The dir is wiped of
 * its projection between runs, so the two captures share task/dir bytes and no
 * normalization is needed: `manifest.json` plus every verb artifact
 * (report/q/p) must be byte-equal.
 *
 * Checks:
 *   P1  File-mode capture is well-formed (the baseline projection exists).
 *   P2  Byte-identity: manifest.json bytes equal across modes.
 *   P3  Byte-identity: every verb artifact (report/q/p) is byte-equal — the
 *       journal `report`/`ask`/`progress` events never perturb the file
 *       projection.
 *   P4  Read parity: both stores return the same manifest after the scenario.
 *   P5  Projection-disabled leg (cutover criterion 2, deterministic half): with
 *       `swarm.projection=false` the journal store writes NO manifest.json,
 *       yet replays the SAME manifest as the file mode wrote — the journal
 *       alone carries the fleet.
 *   P6  Scan parity: both stores' scan() over the sandbox root agree.
 *
 * Fail-fast (AGENTS.md command discipline): every child spawn is bounded and a
 * top-level watchdog exits non-zero no matter what.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
	createFileManifestStore,
	createJournalManifestStore,
	type ExchangeManifest,
	type ManifestWorker,
} from "../src/manifest-store.ts";
import { createJournalReader } from "../src/swarm/journal-read.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-parity-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 30_000);
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-parity-"));
const EXCHANGE_ROOT = join(SANDBOX, "exchange");
const TASK = "task-parity";
const DIR = join(EXCHANGE_ROOT, TASK);
const WORKER = "par-w1";
const FIXED_TS = "2026-01-01T00:00:00.000Z";
const SESSION_ID = "parity-session";
const MODE_ENV_KEYS = ["SWARM_STORAGE", "SWARM_PROJECTION", "SWARM_JOURNAL_DB", "SWARM_SESSION_ID", "SWARM_FIXED_TS"] as const;

// All child/env access is sandboxed: the real exchange root and the real agent
// dir are never touched (field lesson 2026-09-10).
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_ROOT;

function rmProjection(): void {
	rmSync(join(DIR, "manifest.json"), { force: true });
}

/** Run one CLI verb (bounded) under the scenario's env. */
function runCli(
	args: string[],
	extraEnv: Record<string, string>,
	input?: string,
): { status: number | null; stdout: string; stderr: string } {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_ROOT;
	env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent");
	env.SWARM_TASK = TASK;
	env.SWARM_WORKER = WORKER;
	for (const k of MODE_ENV_KEYS) delete env[k];
	Object.assign(env, extraEnv);
	const res = spawnSync("bun", [CLI, ...args], { env, input, encoding: "utf8", timeout: 20_000 });
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function makeWorker(name: string): ManifestWorker {
	return {
		name,
		placement: {
			kind: "worktree",
			workspaceId: "ws-par",
			paneId: "pane-par",
			branch: `delegate/${name}`,
			checkoutPath: join(SANDBOX, "checkout"),
		} as ManifestWorker["placement"],
		briefPath: join(DIR, `brief-${name}.md`),
		reportPath: join(DIR, `report-${name}.json`),
		provider: "p",
		model: "m",
		thinking: "low",
		startedAt: FIXED_TS,
	};
}

const REPORT = {
	worker: WORKER,
	status: "pass",
	summary: "parity",
	artifacts: ["a.ts"],
	evidence: [{ claim: "verified", file: "a.ts:1" }],
};

interface Capture {
	manifest: string;
	report: string;
	question: string;
	progress: string;
}

/**
 * The scenario both modes run, byte for byte: spawn append → sessionPath stamp
 * → fleet description stamp → CLI report/ask/progress → collectedAt stamp.
 * Returns the captured projection bytes.
 */
async function runScenario(store: ReturnType<typeof createFileManifestStore>, modeEnv: Record<string, string>): Promise<Capture> {
	// 1. spawn append (the store-port-only tool-side append).
	await store.append(DIR, makeWorker(WORKER));
	// 2. per-field stamp from an update-fold diff (sessionPath).
	await store.update(DIR, (m) => ({
		...m,
		workers: m.workers.map((w) => (w.name === WORKER ? { ...w, sessionPath: "/sessions/par.jsonl" } : w)),
	}));
	// 3. fleet-scoped stamp (description) — the spawn flow's applyFleetTaskFields.
	await store.update(DIR, (m) => ({ ...m, description: "parity fleet" }));
	// 4. verb writes: report (also journals kind `report` in journal mode), ask, progress.
	const report = runCli(["write-report"], { ...modeEnv }, JSON.stringify(REPORT));
	const ask = runCli(["ask", "--question", "parity?"], { ...modeEnv });
	const progress = runCli(["write-progress", "--phase", "parity"], { ...modeEnv });
	if (report.status !== 0 || ask.status !== 0 || progress.status !== 0) {
		throw new Error(`verb failure: report=${report.status} ask=${ask.status} progress=${progress.status}`);
	}
	// 5. collect stamp (a worker-scoped stamp).
	await store.update(DIR, (m) => ({
		...m,
		workers: m.workers.map((w) => (w.name === WORKER ? { ...w, collectedAt: FIXED_TS } : w)),
	}));
	const read = (f: string): string => (existsSync(join(DIR, f)) ? readFileSync(join(DIR, f), "utf8") : "");
	return {
		manifest: read("manifest.json"),
		report: read(`report-${WORKER}.json`),
		question: read(`q-${WORKER}.json`),
		progress: read(`p-${WORKER}.jsonl`),
	};
}

try {
	// Fixture: the task dir + brief (the verbs validate against it).
	writeFileSync(join(SANDBOX, ".keep"), "");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(DIR, { recursive: true });
	writeFileSync(join(DIR, `brief-${WORKER}.md`), `# Brief — ${WORKER}\n\nDo the parity thing.\n`);

	const fileEnv: Record<string, string> = { SWARM_STORAGE: "files", SWARM_FIXED_TS: FIXED_TS };
	const journalEnv: Record<string, string> = {
		SWARM_STORAGE: "journal",
		SWARM_JOURNAL_DB: join(SANDBOX, "journal.db"),
		SWARM_SESSION_ID: SESSION_ID,
		SWARM_FIXED_TS: FIXED_TS,
	};

	// --- run 1: files mode (the frozen baseline projection) ------------------
	rmProjection();
	const fileStore = createFileManifestStore();
	const fileCapture = await runScenario(fileStore, fileEnv);
	const fileManifestObj = fileStore.read(DIR);
	check("P1.1 file-mode manifest.json written (baseline projection exists)", fileCapture.manifest.length > 0);

	// --- run 2: journal mode, over the SAME dir ------------------------------
	rmProjection();
	rmSync(join(DIR, `q-${WORKER}.json`), { force: true });
	rmSync(join(DIR, `p-${WORKER}.jsonl`), { force: true });
	const journalStore = createJournalManifestStore({
		dbPath: journalEnv.SWARM_JOURNAL_DB!,
		sessionId: SESSION_ID,
		projection: true,
	});
	const journalCapture = await runScenario(journalStore, journalEnv);
	const journalManifestObj = journalStore.read(DIR);

	check(
		"P2 manifest.json projection is byte-identical across storage modes",
		fileCapture.manifest.length > 0 && fileCapture.manifest === journalCapture.manifest,
		`file=${fileCapture.manifest.length}b journal=${journalCapture.manifest.length}b`,
	);
	check(
		"P3 verb artifacts (report/q/p) are byte-identical across storage modes",
		fileCapture.report === journalCapture.report &&
			fileCapture.question === journalCapture.question &&
			fileCapture.progress === journalCapture.progress,
		JSON.stringify({
			report: fileCapture.report === journalCapture.report,
			question: fileCapture.question === journalCapture.question,
			progress: fileCapture.progress === journalCapture.progress,
		}),
	);
	check(
		"P4 both stores read back the same manifest after the scenario",
		!!fileManifestObj && !!journalManifestObj && JSON.stringify(fileManifestObj) === JSON.stringify(journalManifestObj),
		`file=${JSON.stringify(fileManifestObj)?.slice(0, 80)} journal=${JSON.stringify(journalManifestObj)?.slice(0, 80)}`,
	);
	{
		const reader = createJournalReader({ dbPath: journalEnv.SWARM_JOURNAL_DB! });
		const kinds = reader.eventsAfter(0).map((e) => e.kind);
		check(
			"P4.1 the journal carries the spawn/stamp events plus the CLI `report` kind",
			kinds.includes("spawn") && kinds.includes("stamp") && kinds.includes("report"),
			kinds.join(","),
		);
		reader.close();
	}

	// --- projection disabled: journal alone (cutover criterion 2, deterministic) ---
	{
		const offDir = join(EXCHANGE_ROOT, "task-parity-off");
		mkdirSync(offDir, { recursive: true });
		writeFileSync(join(offDir, `brief-${WORKER}.md`), `# Brief — ${WORKER}\n`);
		const offStore = createJournalManifestStore({
			dbPath: join(SANDBOX, "journal-off.db"),
			sessionId: SESSION_ID,
			projection: false,
		});
		const offWorker: ManifestWorker = { ...makeWorker(WORKER), briefPath: join(offDir, `brief-${WORKER}.md`), reportPath: join(offDir, `report-${WORKER}.json`) };
		await offStore.append(offDir, offWorker);
		await offStore.update(offDir, (m) => ({
			...m,
			workers: m.workers.map((w) => (w.name === WORKER ? { ...w, collectedAt: FIXED_TS } : w)),
		}));
		const offManifest = offStore.read(offDir);
		check(
			"P5.1 projection=false writes NO manifest.json (journal is the only truth)",
			!existsSync(join(offDir, "manifest.json")),
		);
		check(
			"P5.2 the journal alone replays the fleet (append + stamp round-trip)",
			!!offManifest &&
				offManifest.workers.length === 1 &&
				offManifest.workers[0]!.name === WORKER &&
				offManifest.workers[0]!.collectedAt === FIXED_TS,
			JSON.stringify(offManifest?.workers),
		);
		check(
			"P5.3 the replayed fleet is a valid ExchangeManifest (schemaVersion + task/dir present)",
			!!offManifest && offManifest.schemaVersion === 1 && offManifest.task === "task-parity-off" && offManifest.dir === resolve(offDir),
			JSON.stringify(offManifest?.schemaVersion),
		);
	}

	// --- scan parity ---------------------------------------------------------
	{
		const fileScanned = fileStore.scan("herdr").map((m) => m.task).sort();
		const journalScanned = journalStore.scan("herdr").map((m) => m.task).sort();
		check(
			"P6 scan() agrees across modes over the sandbox exchange root",
			JSON.stringify(fileScanned) === JSON.stringify(journalScanned) &&
				JSON.stringify(fileScanned) === JSON.stringify(["task-parity"]),
			`file=${fileScanned.join(",")} journal=${journalScanned.join(",")}`,
		);
	}
} finally {
	rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nswarm-parity-check: all checks passed" : `\nswarm-parity-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);