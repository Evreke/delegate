/**
 * watch-schedule-durable-check — issue #12, watcher scheduled wakes, stage C
 * (durable schedules: survive a watcher remount, restore and dedup).
 *
 * Run with: bun test/watch-schedule-durable-check.ts   (from the extension dir).
 *
 * Everything times on the VirtualClock (src/clock.ts): no real waiting, no real
 * timers (ARCHITECTURE.md Law 10). The exchange root is a mkdtemp sandbox
 * ($PI_DELEGATE_EXCHANGE_ROOT), so the check never touches the live root, and
 * every scenario uses its OWN session identity so the per-session store file
 * cannot leak state between scenarios.
 *
 * Checks:
 *   DS1  store file: one JSON document per session under the exchange root,
 *        carrying the explicit schema version (Law 7) and the session identity.
 *   DS2  remount mid-schedule: a fresh store over the same session restores
 *        the pending wake and it fires EXACTLY ONCE after the remount; a
 *        remount after the delivery restores nothing and never re-delivers.
 *   DS3  stale identity: a fresh session's own file is empty; a store document
 *        carrying ANOTHER session's identity is dropped whole (Law 3).
 *   DS4  advisory restore: a corrupt store yields zero restored schedules and
 *        a warning, the store stays alive, and event wakes keep working.
 *   DS5  delivery records: a failed send leaves no record (the next tick
 *        retries); a successful send records the run so a remount cannot
 *        re-deliver it.
 *   DS6  Law 7: a wrong schemaVersion reads inert-with-warning.
 *   DS7  periodic schedules restore across a remount with their run count and
 *        cadence intact (no back-wake burst).
 *   DS8  no proven session identity → no persistence (fail-closed; the store
 *        stays in-memory and never writes a shared file).
 * Exit 0 only if all checks pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVirtualClock } from "../src/clock.ts";
import { createScheduleStore, type ScheduleStore } from "../src/watch-schedule.ts";
import { createSchedulePersistence } from "../src/watch-schedule-persist.ts";
import { createWatcher } from "../src/watcher.ts";
import { exchangeRoot } from "../src/exchange.ts";
import { watcherKeyFor } from "../src/watch-store.ts";
import { reportPathFor, scheduleStorePathFor } from "../src/expaths.ts";
import { EXCHANGE_SCHEMA_VERSION } from "../src/manifest-store.ts";
import { workersFromManifests, type SelfIdentity } from "../src/watch-detect.ts";
import type { ManifestWorker } from "../src/manifest-store.ts";
import type { Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const NOW = 2_000_000;
/** A distinct session identity per scenario — the store file is per session, so
 *  a shared identity would leak state between scenarios. */
const session = (tag: string): string => `/tmp/sessions/check-sched-${tag}.jsonl`;

// Hermetic exchange root: exchangeRoot() honors the override at CALL time, so
// setting it before any store call keeps every file inside the sandbox.
const root = mkdtempSync(join(tmpdir(), "sched-durable-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = root;

const storePath = (sessionPath: string): string => scheduleStorePathFor(exchangeRoot(), watcherKeyFor(sessionPath));

function mount(sessionPath: string, clock: ReturnType<typeof createVirtualClock>, warnings: string[]): ScheduleStore {
	return createScheduleStore({
		clock,
		persistence: createSchedulePersistence({ sessionPath, log: (m) => warnings.push(m) }),
	});
}

function watcherFor(
	store: ScheduleStore,
	sessionPath: string,
	send: (text: string) => unknown,
	opts: { warnings?: string[]; snapshot?: () => Promise<{ workers: ReturnType<typeof workersFromManifests>["workers"]; statusesKnown: boolean }> } = {},
): ReturnType<typeof createWatcher> {
	const transport = { backendName: () => "herdr", listStatuses: async () => [] } as unknown as Transport;
	return createWatcher({
		transport,
		intervalMs: 3_600_000, // hand-driven ticks — the check never waits on a timer
		self: { sessionFile: sessionPath, cwd: "/tmp" },
		send: send as never,
		snapshot: opts.snapshot ?? (async () => ({ workers: [], statusesKnown: true })),
		journal: null,
		durableDelivery: false,
		schedules: store,
		log: (m) => opts.warnings?.push(m),
	});
}

// ---------------------------------------------------------------------------
// DS1. Store file shape + Law 7 version
// ---------------------------------------------------------------------------

{
	const S = session("ds1");
	const clock = createVirtualClock(NOW);
	const warnings: string[] = [];
	const store = mount(S, clock, warnings);
	const accepted = store.schedule({ text: "check the build output now", delayMs: 60_000 });
	check("DS1.1 schedule accepted", accepted.ok && accepted.schedule.id === "w1", JSON.stringify(accepted));

	const path = storePath(S);
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = "";
	}
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		parsed = null;
	}
	check(
		"DS1.2 the store file is one JSON document per session at <root>/schedules-<key>.json",
		parsed !== null && path.startsWith(root),
		`path=${path} raw=${raw.slice(0, 120)}`,
	);
	check(
		"DS1.3 the file carries the explicit schema version (Law 7)",
		parsed !== null && parsed.schemaVersion === EXCHANGE_SCHEMA_VERSION,
		raw.slice(0, 200),
	);
	check(
		"DS1.4 the contents carry the schedule fields + the session identity",
		parsed !== null &&
			typeof parsed.sessionPath === "string" &&
			Array.isArray(parsed.schedules) &&
			(parsed.schedules as Array<Record<string, unknown>>)[0]?.text === "check the build output now" &&
			(parsed.schedules as Array<Record<string, unknown>>)[0]?.run === 1 &&
			(parsed.schedules as Array<Record<string, unknown>>)[0]?.kind === "once" &&
			(parsed.schedules as Array<Record<string, unknown>>)[0]?.dueAtMs === NOW + 60_000,
		raw.slice(0, 400),
	);
	check("DS1.5 a healthy write logs no warning", warnings.length === 0, warnings.join(" | "));
}

// ---------------------------------------------------------------------------
// DS2. Remount mid-schedule → exactly one delivery after the remount
// ---------------------------------------------------------------------------

{
	const S = session("ds2");
	const clock = createVirtualClock(NOW);
	const warnings: string[] = [];
	const storeA = mount(S, clock, warnings);
	storeA.schedule({ text: "wake me after the reload", delayMs: 60_000 });

	// REMOUNT before due time: a brand-new store + persistence over the same
	// session file (exactly what an extension reload does).
	const storeB = mount(S, clock, warnings);
	check(
		"DS2.1 the remount restores the still-pending schedule with its id and due time",
		storeB.list().length === 1 && storeB.list()[0]!.id === "w1" && storeB.list()[0]!.dueAtMs === NOW + 60_000,
		JSON.stringify(storeB.list()),
	);

	const sent: string[] = [];
	const handleB = watcherFor(storeB, S, (t: string) => {
		sent.push(t);
	});
	await handleB.tick();
	check("DS2.2 nothing fires before the due time after the remount", sent.length === 0 && storeB.activeCount() === 1);
	await clock.advance(60_000);
	await handleB.tick();
	await handleB.tick();
	await clock.advance(60_000);
	await handleB.tick();
	check(
		"DS2.3 the restored schedule fires EXACTLY once at its due time",
		sent.length === 1 && sent[0] === "scheduled wake (id w1): wake me after the reload",
		JSON.stringify(sent),
	);
	handleB.stop();

	// A THIRD mount after the delivery: nothing pending, no re-delivery.
	const storeC = mount(S, clock, warnings);
	check("DS2.4 a remount after the delivery restores nothing", storeC.list().length === 0, JSON.stringify(storeC.list()));
	const sentC: string[] = [];
	const handleC = watcherFor(storeC, S, (t: string) => {
		sentC.push(t);
	});
	await handleC.tick();
	check("DS2.5 the delivered wake is never re-delivered after a restart", sentC.length === 0, JSON.stringify(sentC));
	handleC.stop();
}

// ---------------------------------------------------------------------------
// DS3. Stale session identity → dropped (closed sessions never resurrect)
// ---------------------------------------------------------------------------

{
	const SA = session("ds3-a");
	const SB = session("ds3-b");
	const clock = createVirtualClock(NOW);
	const warningsA: string[] = [];
	const storeA = mount(SA, clock, warningsA);
	storeA.schedule({ text: "session A only", delayMs: 30_000 });

	// Natural isolation: a fresh session's own file does not exist yet.
	const warningsB: string[] = [];
	const storeB = mount(SB, clock, warningsB);
	check("DS3.1 a fresh session restores ZERO schedules (its own file is empty)", storeB.list().length === 0, JSON.stringify(storeB.list()));

	// The identity gate: a store document carrying ANOTHER session's identity
	// (a copied file / hash collision / shared degraded key) is dropped whole.
	writeFileSync(
		storePath(SB),
		`${JSON.stringify({
			schemaVersion: EXCHANGE_SCHEMA_VERSION,
			sessionPath: SA,
			schedules: [{ id: "w1", kind: "once", text: "session A only", createdAtMs: NOW, dueAtMs: NOW + 30_000, run: 1 }],
			delivered: [],
			seq: 1,
		}, null, "\t")}\n`,
	);
	const warningsB2: string[] = [];
	const storeB2 = mount(SB, clock, warningsB2);
	check("DS3.2 a foreign session identity restores ZERO schedules (stale, Law 3)", storeB2.list().length === 0, JSON.stringify(storeB2.list()));
	check(
		"DS3.3 the stale-identity drop is warned (advisory, never silent)",
		warningsB2.some((m) => /session|identity|stale/i.test(m)),
		warningsB2.join(" | "),
	);
	const sent: string[] = [];
	const handle = watcherFor(storeB2, SB, (t: string) => {
		sent.push(t);
	});
	await clock.advance(60_000);
	await handle.tick();
	check("DS3.4 the stale schedule never fires in the fresh session", sent.length === 0, JSON.stringify(sent));
	handle.stop();
}

// ---------------------------------------------------------------------------
// DS4. Corrupt store → warning + alive store + event wakes keep working
// ---------------------------------------------------------------------------

{
	const S = session("ds4");
	const clock = createVirtualClock(NOW);
	writeFileSync(storePath(S), "{half-written");
	const warnings: string[] = [];
	const store = mount(S, clock, warnings);
	check("DS4.1 a corrupt store yields ZERO restored schedules", store.list().length === 0, JSON.stringify(store.list()));
	check(
		"DS4.2 the corrupt restore is warned in the watcher log",
		warnings.some((m) => /store|restore|corrupt|fail/i.test(m)),
		warnings.join(" | "),
	);
	const accepted = store.schedule({ text: "still alive", delayMs: 5_000 });
	check("DS4.3 the watcher/store stays alive after a corrupt restore", accepted.ok, JSON.stringify(accepted));

	// Event wakes keep working: a valid report in a manifest produces a
	// report-ready event through the SAME tick that reads the corrupt store.
	const taskDir = join(root, "ds4-task");
	mkdirSync(taskDir, { recursive: true });
	const reportPath = reportPathFor(taskDir, "w-ev");
	writeFileSync(
		reportPath,
		JSON.stringify({
			worker: "w-ev",
			status: "pass",
			summary: "done",
			artifacts: [],
			evidence: [{ claim: "c", file: "f.ts:1" }],
		}),
	);
	const manifestWorker: ManifestWorker = {
		name: "w-ev",
		placement: { kind: "worktree", placementRef: "herdr:pane:xp", checkoutPath: "/tmp/wt/w-ev" },
		briefPath: join(taskDir, "brief-w-ev.md"),
		reportPath,
		provider: "p",
		model: "unknown-model",
		thinking: "low",
		startedAt: new Date(NOW - 10 * 60_000).toISOString(),
		orchestratorSessionPath: S,
	};
	const snap = workersFromManifests(
		[{ task: "ds4-task", dir: taskDir, workers: [manifestWorker] }],
		[{ name: "w-ev", status: "working" }],
		{ sessionFile: S } satisfies SelfIdentity,
		NOW,
	);
	const eventWarnings: string[] = [];
	const sent: string[] = [];
	const handle = watcherFor(store, S, (t: string) => {
		sent.push(t);
	}, { warnings: eventWarnings, snapshot: async () => snap });
	await handle.tick();
	check(
		"DS4.4 event wakes keep working while the schedule store is corrupt",
		sent.length === 1 && sent[0]!.includes("w-ev") && sent[0]!.includes("report-ready"),
		JSON.stringify(sent),
	);
	handle.stop();
}

// ---------------------------------------------------------------------------
// DS5. Delivery records: failure leaves no record; success cannot re-deliver
// ---------------------------------------------------------------------------

{
	const S = session("ds5");
	const clock = createVirtualClock(NOW);
	const warnings: string[] = [];
	const store = mount(S, clock, warnings);
	store.schedule({ text: "record me", delayMs: 1_000 });
	let broken = true;
	const sent: string[] = [];
	const handle = watcherFor(store, S, (t: string) => {
		if (broken) {
			broken = false;
			throw new Error("transient sink failure");
		}
		sent.push(t);
	});
	await clock.advance(1_000);
	await handle.tick();
	check("DS5.1 a failed send leaves the schedule pending (no record)", sent.length === 0 && store.activeCount() === 1, `sent=${sent.length} active=${store.activeCount()}`);
	await handle.tick();
	check("DS5.2 the next tick re-fires the still-due schedule", sent.length === 1, JSON.stringify(sent));
	handle.stop();

	// The successful send recorded the run: a remount can no longer re-deliver it.
	const storeB = mount(S, clock, warnings);
	check("DS5.3 the delivered one-shot is gone from the restored store", storeB.list().length === 0, JSON.stringify(storeB.list()));
	const sentB: string[] = [];
	const handleB = watcherFor(storeB, S, (t: string) => {
		sentB.push(t);
	});
	await handleB.tick();
	check("DS5.4 the delivered run is durably deduped (id#run record)", sentB.length === 0, JSON.stringify(sentB));
	handleB.stop();
}

// ---------------------------------------------------------------------------
// DS6. Law 7 — wrong schema version reads inert-with-warning
// ---------------------------------------------------------------------------

{
	const S = session("ds6");
	const clock = createVirtualClock(NOW);
	writeFileSync(
		storePath(S),
		`${JSON.stringify({
			schemaVersion: EXCHANGE_SCHEMA_VERSION + 41,
			sessionPath: S,
			schedules: [{ id: "w1", kind: "once", text: "future", createdAtMs: NOW, dueAtMs: NOW + 1_000, run: 1 }],
			delivered: [],
			seq: 1,
		}, null, "\t")}\n`,
	);
	const warnings: string[] = [];
	const store = mount(S, clock, warnings);
	check("DS6.1 an unsupported schemaVersion restores ZERO schedules (inert)", store.list().length === 0, JSON.stringify(store.list()));
	check(
		"DS6.2 the version refusal is warned",
		warnings.some((m) => /version|schema/i.test(m)),
		warnings.join(" | "),
	);
}

// ---------------------------------------------------------------------------
// DS7. Periodic schedules restore with run + cadence intact
// ---------------------------------------------------------------------------

{
	const S = session("ds7");
	const clock = createVirtualClock(NOW);
	const warnings: string[] = [];
	const storeA = mount(S, clock, warnings);
	const accepted = storeA.schedule({ text: "health-check {run}/{maxRuns}", everyMs: 10_000, maxRuns: 3 });
	check("DS7.1 periodic schedule accepted", accepted.ok && accepted.schedule.kind === "periodic", JSON.stringify(accepted));

	const sent: string[] = [];
	const handleA = watcherFor(storeA, S, (t: string) => {
		sent.push(t);
	});
	await clock.advance(10_000);
	await handleA.tick();
	handleA.stop();
	check("DS7.2 run 1 delivered before the remount", sent.length === 1 && sent[0]!.includes("run 1/3"), JSON.stringify(sent));

	// Remount before run 2 is due: the restored schedule must keep run 2 and
	// must NOT re-deliver run 1.
	const storeB = mount(S, clock, warnings);
	check(
		"DS7.3 the remount restores the periodic schedule at run 2",
		storeB.list().length === 1 && storeB.list()[0]!.run === 2 && storeB.list()[0]!.dueAtMs === NOW + 20_000,
		JSON.stringify(storeB.list()),
	);
	const sentB: string[] = [];
	const handleB = watcherFor(storeB, S, (t: string) => {
		sentB.push(t);
	});
	await handleB.tick();
	check("DS7.4 no back-wake burst immediately after the remount", sentB.length === 0, JSON.stringify(sentB));

	// A long sleep past two intervals: ONE coalesced wake (run 3), never a burst.
	await clock.advance(20_001);
	await handleB.tick();
	await handleB.tick();
	check(
		"DS7.5 missed intervals coalesce into ONE run-3 wake after the remount",
		sentB.length === 1 && sentB[0]!.includes("run 3/3") && sentB[0]!.includes("health-check 3/3"),
		JSON.stringify(sentB),
	);
	await clock.advance(60_000);
	await handleB.tick();
	check("DS7.6 the capped schedule never fires again", sentB.length === 1, JSON.stringify(sentB));
	handleB.stop();
}

// ---------------------------------------------------------------------------
// DS8. No proven session identity → no persistence (fail-closed)
// ---------------------------------------------------------------------------

{
	const clock = createVirtualClock(NOW);
	const warnings: string[] = [];
	const persistence = createSchedulePersistence({ sessionPath: undefined, log: (m) => warnings.push(m) });
	const store = createScheduleStore({ clock, persistence });
	const accepted = store.schedule({ text: "memory only", delayMs: 5_000 });
	check("DS8.1 an identity-less store still accepts schedules in memory", accepted.ok, JSON.stringify(accepted));
	const sent: string[] = [];
	const handle = watcherFor(store, "/tmp/sessions/check-sched-ds8.jsonl", (t: string) => {
		sent.push(t);
	});
	await clock.advance(5_000);
	await handle.tick();
	check("DS8.2 the identity-less store delivers normally in-process", sent.length === 1, JSON.stringify(sent));
	handle.stop();
	check("DS8.3 no shared 'anon' file is ever written (fail-closed)", !existsSync(join(root, "schedules-anon.json")));
}

// ---------------------------------------------------------------------------

rmSync(root, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\nwatch-schedule-durable: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nwatch-schedule-durable: all checks passed");
