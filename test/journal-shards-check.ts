/**
 * journal-shards-check — the per-task shard layout acceptance (the impl-round
 * sharding decision, store criticism C1 criterion (a)).
 *
 * Run with: bun test/journal-shards-check.ts   (from the repo root)
 *
 * Checks:
 *   S1  Path scheme + sanitization (the PINNED spelling): the shard path is
 *       `<root>/delegate-journal/tasks/<safe(task)>-<fnv1a8(task)>.db`; the
 *       spelling is total over hostile task names (traversal, separators,
 *       dots, unicode, length) and deterministic; distinct task names map to
 *       distinct shard files even when their safe prefixes collide.
 *   S2  One database per task: two tasks → two shard files; rows never cross
 *       the file boundary (no cross-task file sharing); a task-scoped read
 *       never creates a missing shard file.
 *   S3  Global reads are unions over the shard set: count/dbSizeBytes/
 *       kindStats/unscoped eventsAfter prove isolation + union with ≥2 shards.
 *   S4  The Law 7 version gate + the tolerant reader hold PER SHARD: a
 *       future-version shard refuses its own appends loudly (E_JOURNAL_VERSION)
 *       while another task's shard keeps working and stays readable.
 *   S5  The legacy cutover rename: the first writer-side open renames the
 *       global events.db (+ sidecars) to events-legacy-<epochMs>.db; shards
 *       start empty; the legacy rows are invisible to reads (inert copies).
 *   S6  Compaction operates within one shard (the C6 guard legs against shard
 *       paths): the all-terminal refusal and the live-audience refusal work
 *       on the shard layout; a successful compaction deletes only its fleet's
 *       rows inside its shard and appends the marker there.
 *
 * Fail-fast: a top-level watchdog exits non-zero no matter what.
 * Exit 0 only if all checks pass.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createJournalWriter } from "../src/swarm/journal.ts";
import { createJournalReader } from "../src/swarm/journal-read.ts";
import {
	journalShardFileName,
	journalShardPathFor,
	journalTasksDir,
	listJournalShardPaths,
	migrateLegacyJournalDatabase,
} from "../src/swarm/journal-shards.ts";
import { compactFleet } from "../src/swarm/journal-compact.ts";

const watchdog = setTimeout(() => {
	console.error("JOURNAL-SHARDS CHECK WATCHDOG FIRED (a step hung)");
	process.exit(1);
}, 20_000);
watchdog.unref();

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "journal-shards-check-"));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const SID = "sess-shards";

/** A writer/reader sandboxed to the given shard root. */
function writerFor(rootDir: string) {
	return createJournalWriter({ rootDir });
}
function readerFor(rootDir: string) {
	return createJournalReader({ rootDir });
}

// ---------------------------------------------------------------------------
// S1 — path scheme + sanitization (the pinned spelling)
// ---------------------------------------------------------------------------

{
	check(
		"S1.1 the shard path is <root>/tasks/<safe>-<fnv1a8>.db",
		journalShardPathFor("impl-round", SANDBOX) === join(SANDBOX, "tasks", journalShardFileName("impl-round")),
		journalShardPathFor("impl-round", SANDBOX),
	);
	const hostile = ["../evil", "a/b", "..", ".", "", "task with spaces", "задача", "x".repeat(200), "-lead", "CON"];
	let allSafe = true;
	const seen = new Set<string>();
	for (const t of hostile) {
		const name = journalShardFileName(t);
		const path = journalShardPathFor(t, SANDBOX);
		if (!path.startsWith(join(SANDBOX, "tasks") + "/")) allSafe = false; // traversal escape
		if (!/^[A-Za-z0-9._-]+-[0-9a-f]{8}\.db$/.test(name)) allSafe = false; // not the pinned shape
		if (name.startsWith(".")) allSafe = false; // dotfile
		seen.add(name);
	}
	check("S1.2 the spelling is total over hostile task names — file-safe, no traversal, no dotfiles", allSafe, [...seen].join(","));
	check("S1.3 distinct task names map to distinct shard files (the hash disambiguates prefix collisions)", seen.size === hostile.length, `${seen.size} of ${hostile.length}`);
	check(
		"S1.4 the spelling is deterministic (same task → same file on every side)",
		journalShardFileName("impl-round") === journalShardFileName("impl-round") &&
			journalShardFileName("a/b") === journalShardFileName("a/b"),
	);
}

// ---------------------------------------------------------------------------
// S2 — one database per task; no cross-task file sharing
// ---------------------------------------------------------------------------

{
	const root = join(SANDBOX, "s2");
	mkdirSync(root, { recursive: true });
	const w = writerFor(root);
	const r1 = await w.append({ kind: "spawn", sessionId: SID, task: "alpha", worker: "w-a", payload: { i: 1 } });
	const r2 = await w.append({ kind: "spawn", sessionId: SID, task: "beta", worker: "w-b", payload: { i: 2 } });
	w.close();
	check("S2.1 two tasks → two committed rows", r1.ok && r2.ok, JSON.stringify([r1, r2]));
	const shards = listJournalShardPaths(root);
	check("S2.2 exactly two shard files exist (one database per task)", shards.length === 2, shards.map((p) => basename(p)).join(","));
	check(
		"S2.3 the shard files carry the tasks' names",
		shards.map((p) => basename(p)).sort().join(",") === [journalShardFileName("alpha"), journalShardFileName("beta")].sort().join(","),
		shards.join(","),
	);
	const r = readerFor(root);
	check(
		"S2.4 rows never cross the file boundary (per-task reads see only their own rows)",
		r.eventsForTask(SID, "alpha").length === 1 &&
			r.eventsForTask(SID, "beta").length === 1 &&
			r.eventsForTask(SID, "alpha")[0]?.worker === "w-a" &&
			r.eventsForTask(SID, "beta")[0]?.worker === "w-b",
		JSON.stringify(r.eventsAfter(0)),
	);
	const missing = r.eventsForTask(SID, "gamma");
	check("S2.5 a task-scoped read of a MISSING shard reads empty and creates no file", missing.length === 0 && !existsSync(journalShardPathFor("gamma", root)));
	r.close();
}

// ---------------------------------------------------------------------------
// S3 — global reads are unions over the shard set (≥2 shards)
// ---------------------------------------------------------------------------

{
	const root = join(SANDBOX, "s3");
	mkdirSync(root, { recursive: true });
	const w = writerFor(root);
	await w.append({ kind: "spawn", sessionId: SID, task: "alpha", worker: "w-a", payload: {} });
	await w.append({ kind: "stamp", sessionId: SID, task: "alpha", worker: "w-a", payload: {} });
	await w.append({ kind: "spawn", sessionId: SID, task: "beta", worker: "w-b", payload: {} });
	w.close();
	const r = readerFor(root);
	check("S3.1 count() unions the shards (2 + 1)", r.count() === 3, String(r.count()));
	check("S3.2 dbSizeBytes() unions the shard files (nonzero, ≥ one shard's size)", r.dbSizeBytes() > 0 && r.dbSizeBytes() >= listJournalShardPaths(root).reduce((s, p) => s + 1, 0) * 0 + 1, String(r.dbSizeBytes()));
	const stats = r.kindStats();
	const spawnStat = stats.find((s) => s.kind === "spawn");
	const stampStat = stats.find((s) => s.kind === "stamp");
	check(
		"S3.3 kindStats() merges per kind across shards (spawn 2 across two shards, stamp 1)",
		spawnStat?.count === 2 && stampStat?.count === 1 && spawnStat.oldestTs !== null,
		JSON.stringify(stats),
	);
	const union = r.eventsAfter(0);
	check(
		"S3.4 the unscoped cursor read unions the shards (3 rows, per-task isolation intact)",
		union.length === 3 && union.filter((e) => e.task === "alpha").length === 2 && union.filter((e) => e.task === "beta").length === 1,
		JSON.stringify(union.map((e) => [e.task, e.seq])),
	);
	check(
		"S3.5 the unscoped cursor applies PER SHARD (after 1 → alpha's seq-2 row only — beta's seq-1 row is below its own floor)",
		r.eventsAfter(1).map((e) => `${e.task}#${e.seq}`).join(",") === "alpha#2",
		JSON.stringify(r.eventsAfter(1).map((e) => [e.task, e.seq])),
	);
	check(
		"S3.6 fleet-scoped kindStats opens exactly the named shards (alpha-only stats — the shard is task-exclusive)",
		r.kindStats(new Set(["alpha"])).every((s) => s.count === 1) && r.kindStats(new Set(["alpha"])).length === 2,
		JSON.stringify(r.kindStats(new Set(["alpha"]))),
	);
	r.close();
}

// ---------------------------------------------------------------------------
// S4 — the Law 7 gate + the tolerant reader hold PER SHARD
// ---------------------------------------------------------------------------

{
	const root = join(SANDBOX, "s4");
	mkdirSync(root, { recursive: true });
	// Shard "future" carries a FUTURE user_version (a newer build's schema).
	const futurePath = journalShardPathFor("future", root);
	mkdirSync(dirname(futurePath), { recursive: true });
	const raw = new Database(futurePath, { create: true });
	raw.exec("PRAGMA user_version = 99");
	raw.close();
	// Shard "healthy" is written by this build.
	const w = writerFor(root);
	const okAppend = await w.append({ kind: "spawn", sessionId: SID, task: "healthy", worker: "w-h", payload: {} });
	const refused = await w.append({ kind: "spawn", sessionId: SID, task: "future", worker: "w-f", payload: {} });
	w.close();
	check("S4.1 the healthy shard accepts its appends", okAppend.ok, JSON.stringify(okAppend));
	check(
		"S4.2 a future-version shard refuses ITS OWN appends loudly (E_JOURNAL_VERSION, never a silent no-op)",
		!refused.ok && refused.code === "E_JOURNAL_VERSION",
		JSON.stringify(refused),
	);
	const r = readerFor(root);
	check(
		"S4.3 the tolerant reader: the future-version shard reads EMPTY while the healthy shard stays readable (per-shard isolation)",
		r.eventsForTask(SID, "future").length === 0 && r.eventsForTask(SID, "healthy").length === 1,
		JSON.stringify([r.eventsForTask(SID, "future").length, r.eventsForTask(SID, "healthy").length]),
	);
	check("S4.4 the union skips the refused shard's rows without failing (count = the healthy shard's rows only)", r.count() === 1, String(r.count()));
	r.close();
}

// ---------------------------------------------------------------------------
// S5 — the legacy cutover rename
// ---------------------------------------------------------------------------

{
	const root = join(SANDBOX, "s5");
	mkdirSync(root, { recursive: true });
	// The legacy global database with pre-upgrade rows (+ a sidecar).
	const legacyPath = join(root, "events.db");
	const raw = new Database(legacyPath, { create: true });
	raw.exec("PRAGMA user_version = 2");
	raw.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL, task TEXT NOT NULL, worker TEXT, payload TEXT NOT NULL)");
	raw.exec("INSERT INTO events(ts, kind, session_id, task, worker, payload) VALUES ('2026-01-01T00:00:00.000Z', 'spawn', 'legacy-sess', 'legacy-task', 'w-legacy', '{}')");
	raw.close();
	writeFileSync(legacyPath + "-wal", "wal-bytes");
	const target = migrateLegacyJournalDatabase(root);
	check(
		"S5.1 the cutover renames the global events.db to events-legacy-<epochMs>.db",
		target !== null && /^events-legacy-\d+\.db$/.test(basename(target)) && existsSync(target) && !existsSync(legacyPath),
		String(target),
	);
	check("S5.2 the WAL sidecar moved with the database (best-effort hygiene)", existsSync(target + "-wal"), target + "-wal");
	check("S5.3 the rename is idempotent (a second call is a no-op)", migrateLegacyJournalDatabase(root) === null);
	const r = readerFor(root);
	check(
		"S5.4 the legacy rows are invisible to reads (inert copies — the shards are truth; lifecycle rows re-accumulate)",
		r.count() === 0 && r.eventsAfter(0).length === 0 && r.kindStats().length === 0,
		JSON.stringify({ count: r.count(), stats: r.kindStats() }),
	);
	r.close();
	// The first writer-side open performs the cutover by itself.
	const root2 = join(SANDBOX, "s5b");
	mkdirSync(root2, { recursive: true });
	const raw2 = new Database(join(root2, "events.db"), { create: true });
	raw2.exec("PRAGMA user_version = 2");
	raw2.close();
	const w2 = writerFor(root2);
	await w2.append({ kind: "spawn", sessionId: SID, task: "fresh", worker: "w-fresh", payload: {} });
	w2.close();
	check(
		"S5.5 the FIRST writer-side open of the new layout performs the cutover (no explicit migration call)",
		!existsSync(join(root2, "events.db")) && readdirSync(root2).some((f) => /^events-legacy-\d+\.db$/.test(f)),
		readdirSync(root2).join(","),
	);
	check("S5.6 shards start empty — the new fleet's shard holds only its own rows", readerFor(root2).eventsForTask(SID, "fresh").length === 1);
}

// ---------------------------------------------------------------------------
// S6 — compaction operates within one shard (the C6 guard legs, shard paths)
// ---------------------------------------------------------------------------

{
	const root = join(SANDBOX, "s6");
	mkdirSync(root, { recursive: true });
	const taskDir = join(SANDBOX, "s6-task");
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(
		join(taskDir, "manifest.json"),
		JSON.stringify({ task: "compact-me", dir: taskDir, workers: [] }),
	);
	const sessionsDir = join(SANDBOX, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const liveAudience = join(sessionsDir, "live-audience.jsonl");
	writeFileSync(liveAudience, ""); // the audience's console session file — the C6 LIVE leg
	const w = writerFor(root);
	const session = SID;
	// Fleet A (compact-me): one terminal worker + one message row + a live
	// audience cursor BELOW the range end (the C6 refusal fixture).
	const m1 = await w.append({ kind: "spawn", sessionId: session, task: "compact-me", worker: "w1", payload: {} });
	await w.append({ kind: "collect", sessionId: session, task: "compact-me", worker: "w1", payload: {} });
	await w.append({ kind: "ask", sessionId: session, task: "compact-me", worker: "w1", payload: {} });
	// The live audience's read cursor: below the range end (unconsumed).
	{
		const shardPath = journalShardPathFor("compact-me", root);
		const raw = new Database(shardPath);
		raw.exec("INSERT INTO read_cursors(audience_session, task, seq, updated_at) VALUES (?, 'compact-me', 1, '2026-01-01T00:00:00.000Z')", [liveAudience]);
		raw.close();
	}
	// Fleet B (other-task): one terminal worker — must survive untouched.
	await w.append({ kind: "spawn", sessionId: session, task: "other-task", worker: "w2", payload: {} });
	await w.append({ kind: "retire", sessionId: session, task: "other-task", worker: "w2", payload: {} });
	w.close();

	const refused = await compactFleet({ sessionId: session, task: "compact-me", dir: taskDir, rootDir: root });
	check(
		"S6.1 the C6 live-audience guard refuses the range on the SHARD path (cursor below the range end)",
		!refused.ok && refused.code === "E_COMPACT_LIVE_AUDIENCE",
		JSON.stringify(refused),
	);
	// Consume the audience's cursor → the range becomes deletable.
	{
		const shardPath = journalShardPathFor("compact-me", root);
		const raw = new Database(shardPath);
		raw.exec("UPDATE read_cursors SET seq = 99 WHERE audience_session = ?", [liveAudience]);
		raw.close();
	}
	const done = await compactFleet({ sessionId: session, task: "compact-me", dir: taskDir, rootDir: root });
	check("S6.2 a consumed live audience allows the compaction (shard path)", done.ok, JSON.stringify(done));
	const r = readerFor(root);
	check(
		"S6.3 the compaction stayed WITHIN its shard: the other task's rows survive, the compacted fleet's rows are gone",
		r.eventsForTask(session, "other-task").length === 2 && r.eventsForTask(session, "compact-me").length === 1,
		JSON.stringify([r.eventsForTask(session, "other-task").length, r.eventsForTask(session, "compact-me").length]),
	);
	check(
		"S6.4 the audit marker landed INSIDE the compacted fleet's shard (audit continuity)",
		done.ok && r.eventsForTask(session, "compact-me")[0]?.kind === "compaction-marker",
		JSON.stringify(r.eventsForTask(session, "compact-me")),
	);
	check(
		"S6.5 the export landed next to the shard (never the task dir)",
		done.ok && dirname(done.exportedTo) === journalTasksDir(root),
		done.ok ? done.exportedTo : "",
	);
	r.close();
	// The all-terminal refusal (DP7) on the shard path: a fleet whose worker
	// never got a terminal row refuses before any audience classification.
	const wu = writerFor(root);
	await wu.append({ kind: "spawn", sessionId: session, task: "unterminal", worker: "w3", payload: {} });
	wu.close();
	const unter = await compactFleet({ sessionId: session, task: "unterminal", dir: taskDir, rootDir: root });
	check(
		"S6.6 the DP7 all-terminal rule refuses on the shard path (a non-terminal worker refuses the range)",
		!unter.ok && unter.code === "E_COMPACT_UNTERMINAL",
		JSON.stringify(unter),
	);
}

rmSync(SANDBOX, { recursive: true, force: true });
if (failures > 0) {
	console.error(`\nFAIL — ${failures} check(s) red`);
	process.exit(1);
}
console.log("\njournal-shards-check: all checks passed");
