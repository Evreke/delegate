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

function scheduleConfigInHome(configJson: string): { minDelayMs: number; maxActive: number; raw: string } {
	const home = mkdtempSync(join(tmpdir(), "schedule-check-home-"));
	const configDir = join(home, ".pi", "agent");
	mkdirSync(configDir, { recursive: true });
	if (configJson !== "") writeFileSync(join(configDir, "pi-delegate.config.json"), configJson);
	const src = `import {resolveScheduleConfig} from ${JSON.stringify(WATCH_MOD)}; console.log(JSON.stringify(resolveScheduleConfig()))`;
	const res = spawnSync("bun", ["-e", src], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20_000 });
	rmSync(home, { recursive: true, force: true });
	const raw = res.stdout.toString().trim();
	try {
		return { ...(JSON.parse(raw) as { minDelayMs: number; maxActive: number }), raw };
	} catch {
		return { minDelayMs: -1, maxActive: -1, raw: `SPAWN FAILED: ${res.stderr.slice(0, 200)}` };
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

if (failures > 0) {
	console.error(`\n${failures} WATCH-SCHEDULE CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nwatch-schedule: all checks passed");
