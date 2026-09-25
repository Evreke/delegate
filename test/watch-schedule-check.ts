/**
 * watch-schedule-check — issue #10, watcher scheduled wakes, stage A
 * (one-shot delayed wake: wake me at/delay T with message M).
 *
 * Run with: bun test/watch-schedule-check.ts   (from the extension dir).
 *
 * Everything times on the VirtualClock (src/clock.ts): no real waiting, no
 * real timers — the whole scheduling sequence space is deterministic and
 * instant (fail-fast discipline, ARCHITECTURE.md Law 10).
 *
 * Checks:
 *   WS1  store: a one-shot fires exactly once at its due time, the message
 *        text is intact, delivery is idempotent under markDelivered.
 *   WS2  store: cancel by id prevents the fire; unknown ids are refused.
 *   WS3  store: the active-schedule cap and the minimum-delay floor refuse
 *        with E_SCHEDULE; a free slot re-accepts.
 *   WS4  store: list() shows pending schedules with their due times.
 *   WS5  tool `delegate_wake`: schedule/cancel/list round trip + the
 *        structured E_SCHEDULE refusals.
 *   WS6  watcher tick integration (the acceptance path): schedule 5 virtual
 *        seconds out → not before due, one wake at due with the intact text,
 *        never twice; cancel prevents it.
 *   WS7  watcher tick integration: a failed send keeps the schedule pending
 *        (re-fires while due); a silent sink suppresses in memory without
 *        claiming a delivery.
 *   WS8  config: schedule.minDelayMs / schedule.maxActive defaults, floors
 *        and overrides (child bun with $HOME set at spawn time).
 *   WS10 acceptance wiring: the TOOL schedules into ONE store and the WATCHER
 *        (mounted on that same instance) delivers the wake text as the
 *        orchestrator's next turn, 5 virtual seconds later.
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createVirtualClock } from "../src/clock.ts";
import {
	createScheduleStore,
	formatScheduleWake,
	SCHEDULE_DEFAULT_MAX_ACTIVE,
	SCHEDULE_DEFAULT_MAX_RUNS,
	SCHEDULE_DEFAULT_MIN_DELAY_MS,
	scheduleKey,
} from "../src/watch-schedule.ts";
import { createWatcher, formatEventBatch } from "../src/watcher.ts";
import { registerWakeTool } from "../src/wake-tool.ts";
import { resolveScheduleConfig } from "../src/watch-config.ts";
import type { Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const NOW = 1_000_000;

// ---------------------------------------------------------------------------
// WS1–WS4. The store (pure, on the VirtualClock)
// ---------------------------------------------------------------------------

{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });

	const acc = store.schedule({ text: "check the build output now", delayMs: 5_000 });
	check(
		"WS1.1 schedule(delay 5000) accepted with id w1, run 1 and the due time now+5000",
		acc.ok && acc.schedule.id === "w1" && acc.schedule.run === 1 && acc.schedule.dueAtMs === NOW + 5_000,
		JSON.stringify(acc),
	);
	check("WS1.2 nothing is due before the due time", store.dueWakes().length === 0);
	check(
		"WS1.3 list() shows the pending schedule with its due time",
		store.list().length === 1 && store.list()[0]!.dueAtMs === NOW + 5_000 && store.activeCount() === 1,
		JSON.stringify(store.list()),
	);

	await clock.advance(4_999);
	check("WS1.4 still nothing due one virtual ms short", store.dueWakes().length === 0);
	await clock.advance(1);
	const due = store.dueWakes();
	check(
		"WS1.5 due exactly at the boundary — one wake with the run-1 key",
		due.length === 1 && due[0]!.id === "w1" && due[0]!.run === 1 && scheduleKey(due[0]!.id, due[0]!.run) === "w1#1",
		JSON.stringify(due),
	);
	check("WS1.6 dueWakes() is non-mutating (a second read is identical)", store.dueWakes().length === 1);
	check(
		"WS1.7 the wake text is intact",
		formatScheduleWake(due[0]!) === "scheduled wake (id w1): check the build output now",
		formatScheduleWake(due[0]!),
	);
	store.markDelivered("w1", 1);
	check("WS1.8 a delivered run never fires twice", store.dueWakes().length === 0 && store.activeCount() === 0);
	await clock.advance(60_000);
	check("WS1.9 still silent far past the due time", store.dueWakes().length === 0);

	// cancel by id
	const c1 = store.schedule({ text: "cancel me", delayMs: 1_000 });
	check("WS1.10 second schedule gets a fresh id", c1.ok && c1.schedule.id === "w2", JSON.stringify(c1));
	const cancelled = store.cancel("w2");
	check("WS1.11 cancel by id returns the cancelled schedule", cancelled.ok && cancelled.schedule.id === "w2");
	await clock.advance(2_000);
	check("WS1.12 a cancelled schedule never fires", store.dueWakes().length === 0);
	const miss = store.cancel("w404");
	check(
		"WS1.13 cancelling an unknown id is a structured E_SCHEDULE refusal",
		!miss.ok && miss.code === "E_SCHEDULE" && miss.error.includes("w404"),
		JSON.stringify(miss),
	);
}

// ---------------------------------------------------------------------------
// WS3. Cap + minimum-delay floor
// ---------------------------------------------------------------------------

{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock, minDelayMs: 1_000, maxActive: 2 });
	check("WS3.1 the floor refuses a delay below the configured minimum", !store.schedule({ text: "x", delayMs: 999 }).ok);
	const below = store.schedule({ text: "x", delayMs: 999 });
	check("WS3.2 the refusal names the code and the floor", !below.ok && below.code === "E_SCHEDULE" && below.error.includes("1000"), JSON.stringify(below));
	check("WS3.3 an absolute time too close to now is refused too", !store.schedule({ text: "x", atMs: NOW + 10 }).ok);
	check("WS3.4 exactly at the floor is accepted", store.schedule({ text: "a", delayMs: 1_000 }).ok);
	check("WS3.5 a second slot is accepted", store.schedule({ text: "b", delayMs: 2_000 }).ok);
	const capped = store.schedule({ text: "c", delayMs: 3_000 });
	check("WS3.6 the cap refuses a third active schedule", !capped.ok && capped.code === "E_SCHEDULE" && capped.error.includes("2"), JSON.stringify(capped));
	check("WS3.7 cancelling frees a slot", store.cancel("w1").ok && store.schedule({ text: "c", delayMs: 3_000 }).ok);
	check("WS3.8 empty text is refused", !store.schedule({ text: "   ", delayMs: 1_000 }).ok);
	check("WS3.9 both at and delayMs is refused", !store.schedule({ text: "x", delayMs: 1_000, atMs: NOW + 9_000 }).ok);
	check("WS3.10 neither at nor delayMs is refused", !store.schedule({ text: "x" }).ok);
}

// ---------------------------------------------------------------------------
// WS5. Tool surface — `delegate_wake`
// ---------------------------------------------------------------------------

{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	let captured: {
		name: string;
		parameters: unknown;
		execute: (...a: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	} | undefined;
	registerWakeTool({ registerTool: (t: never) => (captured = t as never) } as never, () => store);
	check("WS5.1 the tool is registered as delegate_wake", captured?.name === "delegate_wake", captured?.name);
	check("WS5.2 the tool declares an action parameter schema", captured?.parameters !== undefined);

	const sch = await captured!.execute("t1", { action: "schedule", text: "check the build output now", delayMs: 5_000 });
	check("WS5.3 schedule via the tool returns the new id and due time", sch.details.ok === true && (sch.details.schedule as { id: string }).id === "w1", JSON.stringify(sch.details));

	const list = await captured!.execute("t2", { action: "list" });
	const listText = list.content.map((c) => c.text).join("\n");
	check(
		"WS5.4 list renders the pending schedule with its due time",
		list.details.ok === true && listText.includes("w1") && listText.includes(new Date(NOW + 5_000).toISOString()),
		listText,
	);

	const bad = await captured!.execute("t3", { action: "schedule", text: "too soon", delayMs: 10 });
	check("WS5.5 a floor breach returns a failed E_SCHEDULE result", bad.details.ok === false && bad.details.code === "E_SCHEDULE", JSON.stringify(bad.details));

	const cancel = await captured!.execute("t4", { action: "cancel", id: "w1" });
	check("WS5.6 cancel via the tool reports the cancelled id", cancel.details.ok === true && cancel.details.id === "w1", JSON.stringify(cancel.details));
	const cancelMissing = await captured!.execute("t5", { action: "cancel", id: "w404" });
	check("WS5.7 cancelling an unknown id is a failed E_SCHEDULE result", cancelMissing.details.ok === false && cancelMissing.details.code === "E_SCHEDULE", JSON.stringify(cancelMissing.details));

	// A session without a mounted watcher exposes no store → the tool refuses
	// honestly instead of accepting a wake that could never fire (Law 2).
	let noStore: typeof captured;
	registerWakeTool({ registerTool: (t: never) => (noStore = t as never) } as never, () => undefined);
	const orphan = await noStore!.execute("t6", { action: "schedule", text: "never fires", delayMs: 5_000 });
	check("WS5.8 schedule without a mounted watcher is a failed E_SCHEDULE result", orphan.details.ok === false && orphan.details.code === "E_SCHEDULE", JSON.stringify(orphan.details));
}

// ---------------------------------------------------------------------------
// WS6–WS7. Watcher tick integration (the acceptance path)
// ---------------------------------------------------------------------------

function makeScheduledWatcher(
	clock: ReturnType<typeof createVirtualClock>,
	store: ReturnType<typeof createScheduleStore>,
	send: (text: string) => unknown,
): ReturnType<typeof createWatcher> {
	const transport = { backendName: () => "herdr", listStatuses: async () => [] } as unknown as Transport;
	return createWatcher({
		transport,
		intervalMs: 3_600_000, // hand-driven ticks — the check never waits on a timer
		send: send as never,
		snapshot: async () => ({ workers: [], statusesKnown: true }),
		journal: null,
		schedules: store,
		log: () => {},
	});
}

{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	const sent: string[] = [];
	const handle = makeScheduledWatcher(clock, store, (t: string) => {
		sent.push(t);
	});

	check("WS6.1 schedule accepted for the watcher scenario", store.schedule({ text: "check the build output now", delayMs: 5_000 }).ok);
	await handle.tick();
	check("WS6.2 a tick before the due time delivers nothing", sent.length === 0 && store.activeCount() === 1);

	await clock.advance(4_999);
	await handle.tick();
	check("WS6.3 one virtual ms short is still silent", sent.length === 0);

	await clock.advance(1);
	await handle.tick();
	check(
		"WS6.4 at the due time the orchestrator receives the wake, text intact",
		sent.length === 1 && sent[0] === "scheduled wake (id w1): check the build output now",
		JSON.stringify(sent),
	);
	check("WS6.5 the delivered schedule left the pending set", store.activeCount() === 0 && store.list().length === 0, `active=${store.activeCount()} list=${JSON.stringify(store.list())}`);

	await handle.tick();
	await clock.advance(60_000);
	await handle.tick();
	check("WS6.6 the wake fires exactly once — never twice", sent.length === 1, JSON.stringify(sent));
	handle.stop();

	// cancel prevents the fire end-to-end
	const clock2 = createVirtualClock(NOW);
	const store2 = createScheduleStore({ clock: clock2 });
	const sent2: string[] = [];
	const handle2 = makeScheduledWatcher(clock2, store2, (t: string) => {
		sent2.push(t);
	});
	store2.schedule({ text: "never mind", delayMs: 5_000 });
	store2.cancel("w1");
	await clock2.advance(10_000);
	await handle2.tick();
	check("WS6.7 cancel by id prevents the fire in the tick loop", sent2.length === 0, JSON.stringify(sent2));
	handle2.stop();
}

{
	// A failed send must NOT consume the schedule: it stays pending and
	// re-fires on a later tick (the event-rollback discipline).
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	const sent: string[] = [];
	let broken = true;
	const handle = makeScheduledWatcher(clock, store, (t: string) => {
		if (broken) {
			broken = false;
			throw new Error("transient sink failure");
		}
		sent.push(t);
	});
	store.schedule({ text: "retry me", delayMs: 1_000 });
	await clock.advance(1_000);
	await handle.tick();
	check("WS7.1 a failed send leaves the schedule pending", sent.length === 0 && store.activeCount() === 1);
	await handle.tick();
	check("WS7.2 the next tick re-fires the still-due schedule", sent.length === 1 && sent[0] === "scheduled wake (id w1): retry me", JSON.stringify(sent));
	handle.stop();

	// A silent (headless) sink is inert: suppress in memory, claim nothing.
	const clock3 = createVirtualClock(NOW);
	const store3 = createScheduleStore({ clock: clock3 });
	let sends = 0;
	const handle3 = makeScheduledWatcher(clock3, store3, () => {
		sends++;
		return { delivered: false, mode: "silent" };
	});
	store3.schedule({ text: "headless", delayMs: 1_000 });
	await clock3.advance(1_000);
	await handle3.tick();
	await handle3.tick();
	check("WS7.3 a silent sink is inert and never re-offers the same schedule every tick", sends === 1, String(sends));
	check("WS7.4 silence is not a delivery — the schedule is still pending", store3.activeCount() === 1 && store3.list().length === 1);
	handle3.stop();

	// An advisory wrap (Law 8): a throwing schedule port costs the tick's
	// scheduled wakes, never the tick itself.
	const clock4 = createVirtualClock(NOW);
	const sent4: string[] = [];
	const transport = { backendName: () => "herdr", listStatuses: async () => [] } as unknown as Transport;
	const throwing = createWatcher({
		transport,
		intervalMs: 3_600_000,
		send: (t: string) => {
			sent4.push(t);
		},
		snapshot: async () => ({ workers: [], statusesKnown: true }),
		journal: null,
		schedules: {
			dueWakes: () => {
				throw new Error("port exploded");
			},
			markDelivered: () => {},
		},
		log: () => {},
	});
	let survived = true;
	try {
		await throwing.tick();
	} catch {
		survived = false;
	}
	check("WS7.5 a throwing schedule port never breaks the tick (advisory)", survived && sent4.length === 0, String(sent4.length));
	throwing.stop();
}

// ---------------------------------------------------------------------------
// WS10. Acceptance wiring: the TOOL schedules, the WATCHER delivers — ONE
// store instance (exactly how index.ts mounts it).
// ---------------------------------------------------------------------------

{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	let tool: {
		execute: (...a: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	} | undefined;
	registerWakeTool({ registerTool: (t: never) => (tool = t as never) } as never, () => store);
	const sent: string[] = [];
	const handle = makeScheduledWatcher(clock, store, (t: string) => {
		sent.push(t);
	});

	const scheduled = await tool!.execute("a1", { action: "schedule", text: "check the build output now", delayMs: 5_000 });
	check("WS10.1 the tool accepted the 5-virtual-second wake", scheduled.details.ok === true, JSON.stringify(scheduled.details));
	await handle.tick();
	check("WS10.2 before the due time the orchestrator is not woken", sent.length === 0);
	await clock.advance(5_000);
	await handle.tick();
	check(
		"WS10.3 after 5 virtual seconds the wake text is the orchestrator's next turn",
		sent.length === 1 && sent[0] === "scheduled wake (id w1): check the build output now",
		JSON.stringify(sent),
	);
	const listed = await tool!.execute("a2", { action: "list" });
	check("WS10.4 list is empty after the fire", Array.isArray(listed.details.schedules) && (listed.details.schedules as unknown[]).length === 0);
	handle.stop();
}

// ---------------------------------------------------------------------------
// WS8. Config plumbing — schedule.minDelayMs / schedule.maxActive
// ---------------------------------------------------------------------------

const WATCH_MOD = new URL("../src/watch-config.ts", import.meta.url).pathname;

function scheduleConfigInHome(configJson: string): { minDelayMs: number; maxActive: number; maxRuns: number; raw: string } {
	const home = mkdtempSync(join(tmpdir(), "schedule-check-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== "") writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
	const src = `import {resolveScheduleConfig} from ${JSON.stringify(WATCH_MOD)}; console.log(JSON.stringify(resolveScheduleConfig()))`;
	const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
	rmSync(home, { recursive: true, force: true });
	const raw = res.stdout.toString().trim();
	try {
		return { ...(JSON.parse(raw) as { minDelayMs: number; maxActive: number; maxRuns: number }), raw };
	} catch {
		return { minDelayMs: -1, maxActive: -1, maxRuns: -1, raw: `SPAWN FAILED: ${res.stderr.slice(0, 200)}` };
	}
}

{
	const d = scheduleConfigInHome("");
	check(
		"WS8.1 no config → defaults (minDelayMs 1000, maxActive 8)",
		d.minDelayMs === SCHEDULE_DEFAULT_MIN_DELAY_MS && d.maxActive === SCHEDULE_DEFAULT_MAX_ACTIVE,
		d.raw,
	);
	const o = scheduleConfigInHome(JSON.stringify({ schedule: { minDelayMs: 2_500, maxActive: 3 } }));
	check("WS8.2 schedule section overrides both limits", o.minDelayMs === 2_500 && o.maxActive === 3, o.raw);
	const bad = scheduleConfigInHome(JSON.stringify({ schedule: { minDelayMs: -5, maxActive: 0 } }));
	check(
		"WS8.3 garbage floors fall back to the defaults",
		bad.minDelayMs === SCHEDULE_DEFAULT_MIN_DELAY_MS && bad.maxActive === SCHEDULE_DEFAULT_MAX_ACTIVE,
		bad.raw,
	);
	check("WS8.4 resolveScheduleConfig() is total in-process", resolveScheduleConfig().maxActive >= 1);
}

// ---------------------------------------------------------------------------
// Batch formatting (a schedule must live in the same ONE wake-up message)
// ---------------------------------------------------------------------------

{
	const text = formatEventBatch([{ worker: "w1", dir: "/tmp/exchange/t", kind: "report-ready", message: "read /x/y" }]);
	check("WS9.1 formatEventBatch keeps its existing single-argument shape", text.includes("w1") && text.includes("report-ready"));
}

// ---------------------------------------------------------------------------
// WS11–WS17. Periodic wakes (#11, stage B): every N, run-numbered, capped and
// coalesced. All on the VirtualClock — no real waiting.
// ---------------------------------------------------------------------------

{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	const acc = store.schedule({ text: "health-check the port", everyMs: 5_000, maxRuns: 3 });
	check(
		"WS11.1 every schedule is periodic: run 1/3, due now+5000, interval recorded",
		acc.ok &&
			acc.schedule.kind === "periodic" &&
			acc.schedule.run === 1 &&
			acc.schedule.dueAtMs === NOW + 5_000 &&
			acc.schedule.maxRuns === 3 &&
			acc.schedule.intervalMs === 5_000,
		JSON.stringify(acc),
	);
	await clock.advance(4_999);
	check("WS11.2 periodic is silent one virtual ms short", store.dueWakes().length === 0);
	await clock.advance(1);
	let due = store.dueWakes();
	check(
		"WS11.3 the first fire is run 1 of the periodic schedule",
		due.length === 1 && due[0]!.run === 1 && due[0]!.kind === "periodic" && due[0]!.maxRuns === 3,
		JSON.stringify(due),
	);
	check(
		"WS11.4 the periodic wake text carries id and run/maxRuns",
		due.length === 1 && formatScheduleWake(due[0]!) === "scheduled wake (id w1, run 1/3): health-check the port",
		JSON.stringify(due),
	);
	store.markDelivered("w1", 1);
	check(
		"WS11.5 after run 1 the schedule stays pending at run 2, next interval",
		store.activeCount() === 1 && store.list()[0]!.run === 2 && store.list()[0]!.dueAtMs === NOW + 10_000,
		JSON.stringify(store.list()),
	);
	await clock.advance(5_000);
	due = store.dueWakes();
	check("WS11.6 the second fire is run 2", due.length === 1 && due[0]!.run === 2, JSON.stringify(due));
	store.markDelivered("w1", 2);
	await clock.advance(5_000);
	due = store.dueWakes();
	check("WS11.7 the third fire is run 3", due.length === 1 && due[0]!.run === 3, JSON.stringify(due));
	store.markDelivered("w1", 3);
	check(
		"WS11.8 maxRuns=3 removes the schedule after the third fire",
		store.activeCount() === 0 && store.list().length === 0 && store.dueWakes().length === 0,
		JSON.stringify(store.list()),
	);
	await clock.advance(600_000);
	check("WS11.9 there is never a fourth fire", store.dueWakes().length === 0 && store.activeCount() === 0);
}

// WS12. Coalescing under a burst of missed intervals
{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	store.schedule({ text: "poll me", everyMs: 5_000, maxRuns: 10 });
	await clock.advance(5_000);
	store.markDelivered("w1", 1); // now due NOW+10000 at run 2
	await clock.advance(12_000); // NOW+17000: intervals at 10k and 15k passed
	const due = store.dueWakes();
	check("WS12.1 a burst of missed intervals yields exactly ONE wake", due.length === 1, JSON.stringify(due));
	check(
		"WS12.2 the coalesced run advanced by the number of missed intervals (2 → 3)",
		due[0]?.run === 3,
		JSON.stringify(due),
	);
	check("WS12.3 a second read is still one wake — never a back-wake burst", store.dueWakes().length === 1);
	store.markDelivered("w1", due[0]?.run ?? 0);
	check(
		"WS12.4 the next due is the first interval AFTER now (cadence preserved), run 4",
		store.list()[0]?.dueAtMs === NOW + 20_000 && store.list()[0]?.run === 4,
		JSON.stringify(store.list()),
	);
	await clock.advance(2_999);
	check("WS12.5 no premature fire after the coalesced delivery", store.dueWakes().length === 0);
	await clock.advance(1);
	check("WS12.6 cadence resumes cleanly at run 4", store.dueWakes()[0]?.run === 4, JSON.stringify(store.dueWakes()));
}

// WS13. A burst PAST the cap coalesces to the capped run and terminates
{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	store.schedule({ text: "cap me", everyMs: 5_000, maxRuns: 3 });
	await clock.advance(20_000); // four intervals passed in one jump
	const due = store.dueWakes();
	check(
		"WS13.1 a burst beyond the cap coalesces to run maxRuns (3/3)",
		due.length === 1 && due[0]!.run === 3,
		JSON.stringify(due),
	);
	check(
		"WS13.2 the capped wake names the cap",
		due.length === 1 && formatScheduleWake(due[0]!) === "scheduled wake (id w1, run 3/3): cap me",
		JSON.stringify(due),
	);
	store.markDelivered("w1", 3);
	check("WS13.3 the capped schedule removes itself", store.activeCount() === 0 && store.list().length === 0);
	await clock.advance(600_000);
	check("WS13.4 no further fires after termination", store.dueWakes().length === 0 && store.activeCount() === 0);
}

// WS14. Cancel mid-cycle
{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	store.schedule({ text: "cancel me", everyMs: 5_000, maxRuns: 5 });
	await clock.advance(5_000);
	store.markDelivered("w1", 1); // run 2 pending
	const c = store.cancel("w1");
	check("WS14.1 cancel mid-cycle returns the schedule at its current run", c.ok && c.schedule.run === 2, JSON.stringify(c));
	await clock.advance(600_000);
	check("WS14.2 a cancelled periodic never fires again", store.dueWakes().length === 0 && store.activeCount() === 0);
	check("WS14.3 cancel stays one-shot: a second cancel is refused", !store.cancel("w1").ok);
}

// WS15. Store validation of the periodic surface
{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock, maxRuns: 4 });
	check("WS15.1 every + delayMs is refused", !store.schedule({ text: "x", everyMs: 5_000, delayMs: 1_000 }).ok);
	check("WS15.2 every + at is refused", !store.schedule({ text: "x", everyMs: 5_000, atMs: NOW + 9_000 }).ok);
	check(
		"WS15.3 the refusal is structured E_SCHEDULE naming the exclusivity",
		(() => {
			const r = store.schedule({ text: "x", everyMs: 5_000, delayMs: 1_000 });
			return !r.ok && r.code === "E_SCHEDULE" && r.error.includes("every");
		})(),
	);
	const a = store.schedule({ text: "x", everyMs: 5_000 });
	check(
		"WS15.4 every without maxRuns uses the store's configured run cap",
		a.ok && a.schedule.kind === "periodic" && a.schedule.maxRuns === 4,
		JSON.stringify(a),
	);
	const b = store.schedule({ text: "y", everyMs: 5_000, maxRuns: 2 });
	check("WS15.5 a per-schedule maxRuns overrides the configured cap", b.ok && b.schedule.maxRuns === 2);
	check("WS15.6 maxRuns below 1 is refused", !store.schedule({ text: "z", everyMs: 5_000, maxRuns: 0 }).ok);
	check("WS15.7 a non-integer maxRuns is refused", !store.schedule({ text: "z", everyMs: 5_000, maxRuns: 2.5 }).ok);
	check(
		"WS15.8 the interval must clear the minimum-delay floor",
		!createScheduleStore({ clock, minDelayMs: 6_000 }).schedule({ text: "x", everyMs: 5_000 }).ok,
	);
	check(
		"WS15.9 maxRuns without every is refused (a one-shot has exactly one run)",
		!store.schedule({ text: "z", delayMs: 5_000, maxRuns: 3 }).ok,
	);
}

// WS16. Tool surface — delegate_wake gains `every` + `maxRuns`
{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	let captured: {
		execute: (...a: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	} | undefined;
	registerWakeTool({ registerTool: (t: never) => (captured = t as never) } as never, () => store);

	const sch = await captured!.execute("p1", { action: "schedule", text: "health-check the port", every: 5_000, maxRuns: 3 });
	check(
		"WS16.1 the tool accepts every + maxRuns and returns the periodic schedule",
		sch.details.ok === true && (sch.details.schedule as { kind: string }).kind === "periodic",
		JSON.stringify(sch.details),
	);
	const badMutual = await captured!.execute("p2", { action: "schedule", text: "x", every: 5_000, delayMs: 1_000 });
	check(
		"WS16.2 every + delayMs is a failed E_SCHEDULE result",
		badMutual.details.ok === false && badMutual.details.code === "E_SCHEDULE",
		JSON.stringify(badMutual.details),
	);
	const badAt = await captured!.execute("p3", { action: "schedule", text: "x", every: 5_000, at: new Date(NOW + 9_000).toISOString() });
	check(
		"WS16.3 every + at is a failed E_SCHEDULE result",
		badAt.details.ok === false && badAt.details.code === "E_SCHEDULE",
		JSON.stringify(badAt.details),
	);
	const listText = (await captured!.execute("p4", { action: "list" })).content.map((c) => c.text).join("\n");
	check(
		"WS16.4 list shows the periodic schedule with its run/interval info",
		listText.includes("w1") && listText.includes("run 1/3"),
		listText,
	);
	const cancel = await captured!.execute("p5", { action: "cancel", id: "w1" });
	check("WS16.5 cancel mid-cycle reports the cancelled periodic id", cancel.details.ok === true && cancel.details.id === "w1");
}

// WS17. Watcher tick integration for periodic wakes (the acceptance path)
{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	const sent: string[] = [];
	const handle = makeScheduledWatcher(clock, store, (t: string) => {
		sent.push(t);
	});
	store.schedule({ text: "health-check the port", everyMs: 5_000, maxRuns: 3 });
	await clock.advance(5_000);
	await handle.tick();
	check(
		"WS17.1 the tick delivers run 1 through the same guarded send",
		sent.length === 1 && sent[0] === "scheduled wake (id w1, run 1/3): health-check the port",
		JSON.stringify(sent),
	);
	await clock.advance(12_000); // 17k: intervals at 10k and 15k missed
	await handle.tick();
	check(
		"WS17.2 the tick coalesces the burst into ONE advanced wake (run 3/3)",
		sent.length === 2 && sent[1] === "scheduled wake (id w1, run 3/3): health-check the port",
		JSON.stringify(sent),
	);
	await handle.tick();
	check("WS17.3 the coalesced wake never re-fires", sent.length === 2, JSON.stringify(sent));
	await clock.advance(600_000);
	await handle.tick();
	check("WS17.4 after the cap the schedule is gone from the tick loop", sent.length === 2 && store.activeCount() === 0, JSON.stringify(sent));
	handle.stop();
}

// WS17b. Law 8: a failed periodic send is skipped, never wedges the loop,
// and the cadence (run advance) is preserved
{
	const clock = createVirtualClock(NOW);
	const store = createScheduleStore({ clock });
	const sent: string[] = [];
	let broken = true;
	const handle = makeScheduledWatcher(clock, store, (t: string) => {
		if (broken) {
			broken = false;
			throw new Error("transient sink failure");
		}
		sent.push(t);
	});
	store.schedule({ text: "retry me", everyMs: 5_000, maxRuns: 5 });
	await clock.advance(5_000);
	await handle.tick();
	check("WS17b.1 a failed periodic send leaves the schedule pending, loop survives", sent.length === 0 && store.activeCount() === 1);
	await clock.advance(5_000);
	await handle.tick();
	check(
		"WS17b.2 cadence preserved: the next tick delivers the ADVANCED run (2/5)",
		sent.length === 1 && sent[0] === "scheduled wake (id w1, run 2/5): retry me",
		JSON.stringify(sent),
	);
	handle.stop();
}

// WS18. Config plumbing — schedule.maxRuns
{
	const d = scheduleConfigInHome("");
	check("WS18.1 no config → maxRuns default", d.maxRuns === SCHEDULE_DEFAULT_MAX_RUNS, d.raw);
	const o = scheduleConfigInHome(JSON.stringify({ schedule: { maxRuns: 7 } }));
	check("WS18.2 schedule.maxRuns overrides the default", o.maxRuns === 7, o.raw);
	const bad = scheduleConfigInHome(JSON.stringify({ schedule: { maxRuns: 0 } }));
	check("WS18.3 a garbage maxRuns falls back to the default", bad.maxRuns === SCHEDULE_DEFAULT_MAX_RUNS, bad.raw);
}

if (failures > 0) {
	console.error(`\n${failures} WATCH-SCHEDULE CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nwatch-schedule: all checks passed");
