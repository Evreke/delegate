/**
 * swarm-api-check — issue #30 acceptance (ARCHITECTURE §4.1.1/§4.1.2, Law 13):
 * the two orchestrator-side read verbs — `swarm snapshot` and
 * `swarm events --after <seq>` — the read API for external UIs.
 *
 * Run with: bun test/swarm-api-check.ts   (from repo root)
 *
 * Covers (issue acceptance 1 + 2):
 *   A1  events golden: seeded journal (fixed clock), --after 1 → rows 2..4
 *       verbatim + journal {count, dbSizeBytes} (DP7 retention visibility).
 *       Byte-exact against the pinned golden except journal.dbSizeBytes (the
 *       sqlite layout size — type/range-pinned instead: machine-independent).
 *   A2  events golden, absent journal: FULL byte-exact static literal
 *       (events: [], count: 0, dbSizeBytes: 0) — a zero-substitution pin.
 *   A3  events cursor semantics: strictly seq > after; negative clamps to 0.
 *   A4  usage failures are structured E_SWARM_USAGE: missing/non-integer/
 *       dangling --after; stray positionals on both verbs; unknown verb lists
 *       the closed seven-verb set.
 *   A5  snapshot golden, files mode: full SwarmGraph wire form — byte-exact
 *       against the pinned golden except the sandbox exchange-root path
 *       inside task.dir (mkdtemp isolation; substituted at compare time).
 *       Degraded sources (liveStatus/usage false) surface as per-node
 *       degraded flags, never a failure (Law 13 degraded-fields contract).
 *   A6  snapshot, journal mode: manifest truth replayed from the journal
 *       (read-only scan), journal-derived session/task nodes + edges merged;
 *       determinism (two runs byte-equal).
 *   A7  snapshot with NO exchange root and NO journal: still a valid
 *       (available: true) empty graph — every source degraded, no crash.
 *   A8  zero writes (the read API is a pure read): files mode leaves the
 *       default journal location uncreated; journal mode leaves events.db
 *       byte-identical (size + mtime) and writes no manifest.json projection.
 *   A9  identity-free: both verbs succeed with NO SWARM_TASK/SWARM_WORKER in
 *       the environment (orchestrator-side reads — the documented decision).
 *   A10 schema-stability: envelope key order + event row key order pinned;
 *        `help` surfaces both read verbs.
 *
 * Fail-fast (AGENTS.md command discipline): every child spawn is bounded,
 * plus a top-level watchdog. Exit 0 only if all checks pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { manifestPath } from "../src/manifest-store.ts";
import { createJournalWriter, type JournalAppendInput } from "../src/swarm/journal.ts";
import { swarmSessionIdFor } from "../src/swarm/storage.ts";

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("swarm-api-check WATCHDOG TIMEOUT");
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

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const CLI = join(ROOT, "src", "swarm", "cli.ts");
/** Deterministic file hash for pure-read verification — catches any byte-level
 *  modification including WAL checkpoint writes that might race mtime. */
function fileHash(filePath: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(filePath)).digest("hex");
	} catch {
		return null;
	}
}

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-api-check-"));
const AGENT = join(SANDBOX, "agent"); // hermetic config tier (no real ~/.pi/agent)
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
const NOJ_DB = join(SANDBOX, "nojournal", "events.db");
mkdirSync(join(EX, "alpha-fleet"), { recursive: true });
mkdirSync(AGENT, { recursive: true });

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	json: Record<string, unknown> | null;
}

/** Spawn the CLI (bounded). NO worker identity is set anywhere in this check
 *  (A9): the read verbs must not need it. */
function runCli(args: string[], env: Record<string, string> = {}): RunResult {
	const e: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
	delete e.SWARM_TASK;
	delete e.SWARM_WORKER;
	e.PI_DELEGATE_EXCHANGE_ROOT = EX;
	e.PI_CODING_AGENT_DIR = AGENT;
	e.SWARM_JOURNAL_DB = DB;
	Object.assign(e, env);
	const res = spawnSync("bun", [CLI, ...args], { env: e, encoding: "utf8", timeout: 15_000 });
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse((res.stdout ?? "").trim()) as Record<string, unknown>;
	} catch {
		// leave null; the failing check prints stdout
	}
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", json };
}

const errCode = (r: RunResult): unknown => (r.json?.error as { code?: unknown } | undefined)?.code;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed-clock journal seeder (deterministic rows: ts pinned per row). */
async function seedJournal(dbPath: string, rows: JournalAppendInput[]): Promise<void> {
	const FIXED_MS = Date.parse("2026-06-01T00:00:00.000Z");
	const clock = { now: () => FIXED_MS, delay: () => Promise.resolve() };
	const w = createJournalWriter({ dbPath, clock });
	try {
		for (const r of rows) {
			const res = await w.append(r);
			if (!res.ok) throw new Error(`seed append failed: ${res.code}`);
		}
	} finally {
		w.close();
	}
}

const SEED_ROWS: JournalAppendInput[] = [
	{
		kind: "spawn",
		sessionId: "sess-alpha",
		task: "alpha-fleet",
		worker: "w1",
		payload: { backend: "fake", placementRef: "fake:w1", briefPath: "/tmp/ex/alpha-fleet/brief-w1.md", briefText: "# Brief w1" },
	},
	{ kind: "progress", sessionId: "sess-alpha", task: "alpha-fleet", worker: "w1", payload: { phase: "build", pct: 50 } },
	{ kind: "ask", sessionId: "sess-alpha", task: "alpha-fleet", worker: "w1", payload: { text: "which color?" } },
	{ kind: "reconcile-summary", sessionId: "sess-alpha", task: "alpha-fleet", worker: null, payload: { lost: ["w2"], collectedBeforeLoss: 0 } },
];

/** The files-mode manifest fixture (the same bytes golden A5 pins). */
function writeGoldenManifest(): void {
	const dir = join(EX, "alpha-fleet");
	const manifest = {
		task: "alpha-fleet",
		dir,
		masterSessionPath: "/sessions/orch.jsonl",
		description: "golden fleet",
		workers: [
			{
				name: "w1",
				placement: { kind: "tab", checkoutPath: "/repo", backend: "herdr", placementRef: "herdr:pane:1" },
				briefPath: join(dir, "brief-w1.md"),
				reportPath: join(dir, "report-w1.json"),
				provider: "p",
				model: "m",
				thinking: "low",
				startedAt: "2026-06-01T00:10:00.000Z",
				sessionPath: "/sessions/w1.jsonl",
				orchestratorSessionPath: "/sessions/orch.jsonl",
				depth: 0,
				collectedAt: "2026-06-02T00:00:00.000Z",
			},
			{
				name: "w2",
				placement: { kind: "tab", checkoutPath: "/repo", backend: "herdr", placementRef: "herdr:pane:2" },
				briefPath: join(dir, "brief-w2.md"),
				reportPath: join(dir, "report-w2.json"),
				provider: "p",
				model: "m",
				thinking: "low",
				startedAt: "2026-06-01T00:11:00.000Z",
				sessionPath: "/sessions/w2.jsonl",
				orchestratorSessionPath: "/sessions/orch.jsonl",
				depth: 0,
			},
		],
	};
	writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Goldens (Law 7 schema-stability pins — a shape change turns these red)
// ---------------------------------------------------------------------------

/** A1: everything byte-pinned except journal.dbSizeBytes (sqlite layout size —
 *  machine/bun dependent; type+range-pinned separately below). */
const GOLDEN_A1 =
	'{"ok":true,"verb":"events","schemaVersion":1,"after":1,"events":[{"seq":2,"ts":"2026-06-01T00:00:00.000Z","kind":"progress","sessionId":"sess-alpha","task":"alpha-fleet","worker":"w1","payload":{"phase":"build","pct":50}},{"seq":3,"ts":"2026-06-01T00:00:00.000Z","kind":"ask","sessionId":"sess-alpha","task":"alpha-fleet","worker":"w1","payload":{"text":"which color?"}},{"seq":4,"ts":"2026-06-01T00:00:00.000Z","kind":"reconcile-summary","sessionId":"sess-alpha","task":"alpha-fleet","worker":null,"payload":{"lost":["w2"],"collectedBeforeLoss":0}}],"journal":{"count":4,"dbSizeBytes":DBSIZE}}';

/** A2: fully static — zero substitutions. */
const GOLDEN_A2 =
	'{"ok":true,"verb":"events","schemaVersion":1,"after":0,"events":[],"journal":{"count":0,"dbSizeBytes":0}}';

/** A5: everything byte-pinned except the sandbox exchange-root path inside
 *  task.dir (mkdtemp isolation). */
const GOLDEN_A5 =
	'{"ok":true,"verb":"snapshot","snapshot":{"schemaVersion":1,"available":true,"sources":{"journal":true,"manifests":true,"liveStatus":false,"usage":false},"nodes":[{"kind":"session","id":"1b863e90","sessionPath":"/sessions/w1.jsonl","role":"worker","isWorker":true,"ownsChildren":false,"tasks":["alpha-fleet"],"degraded":[{"flag":"no-live-status"},{"flag":"usage-unavailable"}],"depth":0},{"kind":"session","id":"27c50675","sessionPath":"/sessions/w2.jsonl","role":"worker","isWorker":true,"ownsChildren":false,"tasks":["alpha-fleet"],"degraded":[{"flag":"no-live-status"},{"flag":"usage-unavailable"}],"depth":0},{"kind":"session","id":"36f9edae","sessionPath":"/sessions/orch.jsonl","role":"orchestrator","isWorker":false,"ownsChildren":true,"tasks":["alpha-fleet"],"degraded":[]},{"kind":"task","id":"alpha-fleet","dir":"EXPATH/alpha-fleet","description":"golden fleet","workers":[{"name":"w1","run":null,"placementRef":"herdr:pane:1","sessionId":"1b863e90","sessionPath":"/sessions/w1.jsonl","depth":0,"backend":"herdr","startedAt":"2026-06-01T00:10:00.000Z","collectedAt":"2026-06-02T00:00:00.000Z","manifestRef":{"task":"alpha-fleet","worker":"w1","run":null,"placementRef":"herdr:pane:1"},"degraded":[{"flag":"no-live-status"}]},{"name":"w2","run":null,"placementRef":"herdr:pane:2","sessionId":"27c50675","sessionPath":"/sessions/w2.jsonl","depth":0,"backend":"herdr","startedAt":"2026-06-01T00:11:00.000Z","manifestRef":{"task":"alpha-fleet","worker":"w2","run":null,"placementRef":"herdr:pane:2"},"degraded":[{"flag":"no-live-status"}]}],"degraded":[{"flag":"usage-unavailable"}],"depth":0}],"edges":[{"kind":"collected","from":"1b863e90","to":"alpha-fleet","at":"2026-06-02T00:00:00.000Z"},{"kind":"spawned_by","from":"1b863e90","to":"36f9edae"},{"kind":"spawned_by","from":"27c50675","to":"36f9edae"},{"kind":"spawned_by","from":"alpha-fleet","to":"36f9edae"}],"orphans":[]}}';

// ---------------------------------------------------------------------------
// A1 + A2 + A3 — the events verb
// ---------------------------------------------------------------------------

await seedJournal(DB, SEED_ROWS);

{
	const r = runCli(["events", "--after", "1"]);
	const size = (r.json?.journal as { dbSizeBytes?: unknown } | undefined)?.dbSizeBytes;
	check(
		"A1.1 events --after 1: exit 0 + ok + byte-exact golden (dbSizeBytes substituted)",
		r.status === 0 &&
			r.json?.ok === true &&
			r.stdout.trim() === GOLDEN_A1.replace("DBSIZE", String(size)),
		r.stdout,
	);
	check(
		"A1.2 journal.dbSizeBytes is a positive integer (the one non-byte-pinned field)",
		typeof size === "number" && Number.isInteger(size) && (size as number) > 0,
		String(size),
	);
	const rows = (r.json?.events as Array<Record<string, unknown>> | undefined) ?? [];
	check(
		"A1.3 event row key order pinned: seq,ts,kind,sessionId,task,worker,payload",
		rows.length > 0 && rows.every((row) => Object.keys(row).join(",") === "seq,ts,kind,sessionId,task,worker,payload"),
		JSON.stringify(rows[0] && Object.keys(rows[0])),
	);
}

{
	const r = runCli(["events", "--after", "0"], { SWARM_JOURNAL_DB: NOJ_DB });
	check(
		"A2 events over an ABSENT journal: byte-exact static golden (empty-but-valid, exit 0 — never a crash)",
		r.status === 0 && r.stdout.trim() === GOLDEN_A2,
		r.stdout,
	);
}

{
	const atMax = runCli(["events", "--after", "4"]);
	const events = (atMax.json?.events as unknown[] | undefined) ?? [];
	check("A3.1 --after 4 (last seq) → strictly-greater cursor: no rows, count still 4", atMax.status === 0 && events.length === 0 && ((atMax.json?.journal as { count?: unknown } | undefined)?.count === 4), atMax.stdout);

	const neg = runCli(["events", "--after", "-3"]);
	const negEvents = (neg.json?.events as unknown[] | undefined) ?? [];
	check("A3.2 --after -3 clamps to cursor 0 (all rows) and echoes the effective cursor", neg.status === 0 && neg.json?.after === 0 && negEvents.length === 4, neg.stdout);
}

// ---------------------------------------------------------------------------
// A4 — usage failures (structured E_*, Law 8)
// ---------------------------------------------------------------------------

{
	const missing = runCli(["events"]);
	check("A4.1 events without --after → E_SWARM_USAGE", missing.status !== 0 && errCode(missing) === "E_SWARM_USAGE", missing.stdout);

	const nan = runCli(["events", "--after", "notanint"]);
	check("A4.2 events --after notanint → E_SWARM_USAGE", nan.status !== 0 && errCode(nan) === "E_SWARM_USAGE", nan.stdout);

	const dangling = runCli(["events", "--after"]);
	check("A4.3 events --after (dangling value) → E_SWARM_USAGE", dangling.status !== 0 && errCode(dangling) === "E_SWARM_USAGE", dangling.stdout);

	const strayE = runCli(["events", "--after", "0", "stray"]);
	check("A4.4 events with a stray positional → E_SWARM_USAGE", strayE.status !== 0 && errCode(strayE) === "E_SWARM_USAGE", strayE.stdout);

	const strayS = runCli(["snapshot", "stray"]);
	check("A4.5 snapshot with a stray positional → E_SWARM_USAGE", strayS.status !== 0 && errCode(strayS) === "E_SWARM_USAGE", strayS.stdout);

	const bogus = runCli(["bogus"]);
	const msg = ((bogus.json?.error as { message?: unknown } | undefined)?.message ?? "") as string;
	check(
		"A4.6 unknown verb → E_SWARM_USAGE listing the closed seven-verb set",
		bogus.status !== 0 && errCode(bogus) === "E_SWARM_USAGE" && msg.includes("snapshot") && msg.includes("events") && msg.includes("write-report"),
		bogus.stdout,
	);
}

// ---------------------------------------------------------------------------
// A5 + A7 + A8a — the snapshot verb, files mode
// ---------------------------------------------------------------------------

writeGoldenManifest();

{
	const r = runCli(["snapshot"], { SWARM_JOURNAL_DB: NOJ_DB });
	check(
		"A5.1 snapshot (files mode, journal absent): exit 0 + ok + byte-exact golden (sandbox path substituted)",
		r.status === 0 && r.json?.ok === true && r.stdout.trim() === GOLDEN_A5.replaceAll("EXPATH", EX),
		r.stdout,
	);
	check(
		"A5.2 envelope key order pinned: ok,verb,snapshot",
		r.json !== null && Object.keys(r.json).join(",") === "ok,verb,snapshot",
		r.json ? Object.keys(r.json).join(",") : "null",
	);
	const g = r.json?.snapshot as Record<string, unknown> | undefined;
	check(
		"A5.3 degraded sources are degraded FIELDS: liveStatus/usage false, per-node flags, available stays true",
		g !== undefined &&
			JSON.stringify((g as { sources: Record<string, unknown> }).sources) === '{"journal":true,"manifests":true,"liveStatus":false,"usage":false}' &&
			g.available === true,
		JSON.stringify(g?.sources),
	);
	const r2 = runCli(["snapshot"], { SWARM_JOURNAL_DB: NOJ_DB });
	check("A5.4 determinism: two snapshot runs byte-equal", r2.status === 0 && r2.stdout === r.stdout, "");
}

{
	// A7 — every durable source absent: still a valid empty graph (no crash).
	const r = runCli(["snapshot"], { PI_DELEGATE_EXCHANGE_ROOT: join(SANDBOX, "absent-root"), SWARM_JOURNAL_DB: join(SANDBOX, "absent-db", "events.db") });
	const g = (r.json?.snapshot ?? null) as Record<string, unknown> | null;
	check(
		"A7 snapshot with NO exchange root and NO journal: valid empty graph (available true, empty collections)",
		r.status === 0 &&
			g !== null &&
			g.available === true &&
			JSON.stringify(g.sources) === '{"journal":true,"manifests":true,"liveStatus":false,"usage":false}' &&
			Array.isArray(g.nodes) && (g.nodes as unknown[]).length === 0 &&
			Array.isArray(g.edges) && (g.edges as unknown[]).length === 0 &&
			Array.isArray(g.orphans) && (g.orphans as unknown[]).length === 0,
		r.stdout,
	);
}

{
	// A8a — files mode: the default journal location is never created (pure read).
	const r = runCli(["snapshot"], { SWARM_JOURNAL_DB: "" });
	check(
		"A8a files-mode snapshot creates no journal database at the default location",
		r.status === 0 && !existsSync(join(AGENT, "delegate-journal", "events.db")),
		r.stdout,
	);
}

// ---------------------------------------------------------------------------
// A6 + A8b — snapshot in journal mode (read-only replay, zero writes)
// ---------------------------------------------------------------------------

{
	// Seed a SECOND fleet (its own task dir, deliberately WITHOUT a manifest.json
	// file) whose session id is the canonical dir hash (the spelling the
	// journal-mode manifest scan replays by).
	const betaDir = join(EX, "beta-fleet");
	mkdirSync(betaDir, { recursive: true });
	const sid = swarmSessionIdFor(betaDir, { storage: "journal", projection: false, warnings: [] });
	await seedJournal(DB, [
		{
			kind: "spawn",
			sessionId: sid,
			task: "beta-fleet",
			worker: "jw1",
			payload: {
				backend: "herdr",
				placementRef: "herdr:pane:7",
				briefPath: "/b.md",
				briefText: "# j",
				entry: {
					name: "jw1",
					placement: { kind: "tab", checkoutPath: "/repo", backend: "herdr", placementRef: "herdr:pane:7" },
					briefPath: "/b.md",
					reportPath: "/r.json",
					provider: "p",
					model: "m",
					thinking: "low",
					startedAt: "2026-06-01T00:20:00.000Z",
					sessionPath: "/sessions/jw1.jsonl",
					orchestratorSessionPath: "/sessions/orch.jsonl",
					depth: 1,
				},
			},
		},
		{ kind: "stamp", sessionId: sid, task: "beta-fleet", worker: "jw1", payload: { field: "sessionPath", value: "/sessions/jw1.jsonl", entryIndex: 0 } },
	]);

	// A8b precondition: snapshot must not modify the seeded database, and the
	// beta-fleet dir must start projection-free.
	// Note: WAL/SHM sidecars may be created by SQLite even on a read-only open
	// of a WAL-mode database — that is a reader artifact, not a mutation of the
	// DB file. The pure-read contract covers the main database file and the
	// manifest projection.
	const before = statSync(DB);
	const beforeHash = fileHash(DB);
	const manifestFile = manifestPath(betaDir);

	const r = runCli(["snapshot"], { SWARM_STORAGE: "journal" });
	const after = statSync(DB);
	const afterHash = fileHash(DB);
	const g = (r.json?.snapshot ?? null) as
		| { nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>>; sources?: Record<string, unknown> }
		| null;
	const task = g?.nodes?.find((n) => n.kind === "task" && n.id === "beta-fleet") as { workers?: Array<Record<string, unknown>> } | undefined;
	const jw1 = task?.workers?.find((w) => w.name === "jw1");
	check(
		"A6.1 journal-mode snapshot replays the manifest from the journal (worker jw1 present, truth = journal)",
		r.status === 0 && g !== null && jw1 !== undefined && g.sources?.manifests === true,
		r.stdout.slice(0, 400),
	);
	const edges = g?.edges ?? [];
	check(
		"A6.2 journal-derived edges merged (spawned_by from both the replayed manifest and the raw events)",
		edges.some((e) => e.kind === "spawned_by" && e.from === "alpha-fleet" && e.to === "sess-alpha"),
		JSON.stringify(edges),
	);
	const r2 = runCli(["snapshot"], { SWARM_STORAGE: "journal" });
	check("A6.3 determinism: two journal-mode snapshot runs byte-equal", r2.status === 0 && r2.stdout === r.stdout, "");
	check(
		"A8b journal-mode snapshot is a PURE READ: events.db size+mtime+hash unchanged, no manifest.json projection written",
		r.status === 0
			&& before.size === after.size
			&& before.mtimeMs === after.mtimeMs
			&& beforeHash === afterHash
			&& !existsSync(manifestFile),
		`size ${before.size}→${after.size}, mtime ${before.mtimeMs}→${after.mtimeMs}, hash ${beforeHash?.slice(0,8)}→${afterHash?.slice(0,8)}, projection ${existsSync(manifestFile)}`,
	);
}

// ---------------------------------------------------------------------------
// A9 + A10 — identity-free + surface
// ---------------------------------------------------------------------------

{
	// A9 is structural: every runCli in this check executes with SWARM_TASK /
	// SWARM_WORKER explicitly deleted (see runCli) — the goldens above ARE the
	// proof. One explicit re-run for the named assertion:
	const r = runCli(["events", "--after", "0"]);
	check("A9 both read verbs need NO worker identity (env stripped in every run)", r.status === 0 && r.json?.ok === true, r.stdout);
}

{
	const help = runCli(["help"]);
	check("A10 help surfaces both read verbs (surface addition)", help.status === 0 && help.stdout.includes("snapshot") && help.stdout.includes("events"), help.stdout);
}

// ---------------------------------------------------------------------------

if (failures > 0) {
	console.error(`\nswarm-api-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\nswarm-api-check: all checks passed");
process.exit(0);
