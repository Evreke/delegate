/**
 * pi-delegate — watch-schedule: the scheduled-wake store and due computation
 * (issue #10, watcher scheduled wakes, stage A).
 * <p>
 * MODULE_CONTRACT: owns the session's scheduled wakes — the one-shot
 * "wake me at/delay T with message M" records the orchestrator mails to its
 * OWN watcher. Pure and in-memory: no filesystem, no timers, no transports.
 * Time enters ONLY through the injected ClockPort (src/clock.ts), so every
 * timing regression runs on the VirtualClock — deterministic, no real
 * waiting in tests (the fail-fast discipline; ARCHITECTURE.md Law 10).
 * <p>
 * Delivery key: `id#run` (scheduleKey) — one run can never wake twice. The
 * store does NOT deliver: dueWakes() is a non-mutating read, and only
 * markDelivered(id, run) — called by the watcher tick AFTER a successful
 * send through the guarded sink — retires the run. A failed (or silent)
 * delivery therefore leaves the schedule pending and it re-fires while due;
 * silence is never recorded as a success (Law 2).
 * <p>
 * Limits (anti-spam): a configuration floor on the minimum delay (a wake may
 * not be scheduled to fire sooner than minDelayMs from now) and a cap on the
 * number of active schedules per session. Both are resolved from the
 * `schedule` config section (src/watch-config.ts) and share their default
 * constants with it — one source of truth (Law 9).
 * <p>
 * Scope: stage A is ONE-SHOT only. The `kind` field and the run-numbered
 * delivery key are the extension seam for #11 (periodic wakes) and #12
 * (durable persistence) — neither is implemented here.
 * <p>
 * Dependencies: src/clock.ts (the injected clock — a leaf port) and the
 * seam's DelegateErrorCode type (src/host.ts). A leaf module otherwise:
 * nothing above the seam imports anything from here except the watcher tick
 * (the SchedulePort read) and the delegate_wake tool.
 */

import type { ClockPort } from "./clock.ts";
import type { DelegateErrorCode } from "./host.ts";

/** The stage-A schedule kind. The union grows by ADDITION (#11 periodic) —
 *  never by redefining `once`. */
export type ScheduleKind = "once";

/** Default floor on the minimum delay (ms) before a scheduled wake may fire
 *  (config key `schedule.minDelayMs`). Canonically owned HERE; watch-config.ts
 *  imports it — one constant, never two (Law 9). */
export const SCHEDULE_DEFAULT_MIN_DELAY_MS = 1_000;
/** Default cap on active schedules per session (config key
 *  `schedule.maxActive`). Canonically owned HERE (see above). */
export const SCHEDULE_DEFAULT_MAX_ACTIVE = 8;

/** One pending scheduled wake (stage A: one-shot). */
export interface WakeSchedule {
	/** Store-assigned id (`w1`, `w2`, …) — stable, never reused. */
	id: string;
	kind: ScheduleKind;
	/** The free-form message the watcher delivers verbatim. */
	text: string;
	createdAtMs: number;
	dueAtMs: number;
	/** The run number of THIS schedule instance (1 for a one-shot). The
	 *  delivery key is `id#run`; #11 periodic wakes increment it. */
	run: number;
}

/** A due wake as reported to the delivery path — the store's own record
 *  minus the mutable bookkeeping the tick must not see. */
export interface DueWake {
	id: string;
	run: number;
	kind: ScheduleKind;
	text: string;
	dueAtMs: number;
}

/** The read/delivery half of the store the watcher tick consumes — the
 *  dependency kept deliberately narrow (deep-leaf discipline). */
export interface SchedulePort {
	/** Every due, not-yet-delivered wake, oldest due first. NON-MUTATING: a
	 *  read that never retires — only markDelivered does. */
	dueWakes(): DueWake[];
	/** Retire one run after a SUCCESSFUL delivery (id+run). Idempotent; a
	 *  mismatched/unknown pair is still recorded so the key can never
	 *  re-fire. */
	markDelivered(id: string, run: number): void;
}

/** A structured refusal (ARCHITECTURE.md Law 8): the E_* code plus a
 *  recovery hint the orchestrator can act on. */
export interface ScheduleRefusal {
	ok: false;
	code: DelegateErrorCode;
	error: string;
	hint: string;
}

export interface ScheduleAccepted {
	ok: true;
	schedule: WakeSchedule;
}

export type ScheduleResult = ScheduleAccepted | ScheduleRefusal;
export type ScheduleCancelResult = { ok: true; schedule: WakeSchedule } | ScheduleRefusal;

export interface ScheduleInput {
	/** The message to deliver verbatim (required, non-empty after trim). */
	text: string;
	/** Absolute due time (epoch ms). Exactly one of atMs / delayMs. */
	atMs?: number;
	/** Relative delay (ms). Exactly one of atMs / delayMs. */
	delayMs?: number;
}

export interface ScheduleStoreOptions {
	/** The injected clock (src/clock.ts). REQUIRED — the store never reads
	 *  wall time itself. */
	clock: ClockPort;
	/** Floor on the minimum delay (ms) — default SCHEDULE_DEFAULT_MIN_DELAY_MS. */
	minDelayMs?: number;
	/** Cap on active schedules — default SCHEDULE_DEFAULT_MAX_ACTIVE. */
	maxActive?: number;
}

export interface ScheduleStore extends SchedulePort {
	/** Accept a new one-shot schedule, or refuse with E_SCHEDULE (empty
	 *  text, both/neither of at/delay, below the delay floor, cap reached). */
	schedule(input: ScheduleInput): ScheduleResult;
	/** Cancel a pending schedule by id. Unknown/cancelled ids are refused
	 *  with E_SCHEDULE. */
	cancel(id: string): ScheduleCancelResult;
	/** Pending schedules, oldest due first (a snapshot — callers must not
	 *  mutate). */
	list(): WakeSchedule[];
	/** Number of pending (not yet delivered/cancelled) schedules. */
	activeCount(): number;
}

/** The delivery key of one schedule run — `id#run`. The ONE spelling of the
 *  dedup key (the watcher and the tool both go through it). */
export function scheduleKey(id: string, run: number): string {
	return `${id}#${run}`;
}

/** The delivered wake text — the exact format the issue specifies:
 *  `scheduled wake (id w1): check the build output now`. Pure; the message
 *  is never truncated or reformatted here. */
export function formatScheduleWake(w: Pick<DueWake, "id" | "text">): string {
	return `scheduled wake (id ${w.id}): ${w.text}`;
}

function refuse(code: DelegateErrorCode, error: string, hint: string): ScheduleRefusal {
	return { ok: false, code, error, hint };
}

/**
 * Build the session's in-memory schedule store (issue #10, stage A).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts.clock (required ClockPort), opts.minDelayMs / opts.maxActive
 *   (optional limits; defaults SCHEDULE_DEFAULT_MIN_DELAY_MS /
 *   SCHEDULE_DEFAULT_MAX_ACTIVE; values are floored defensively —
 *   minDelayMs ≥ 0, maxActive ≥ 1)
 * Output: a ScheduleStore (see the interface contracts above)
 * Guarantees:
 *   - every time read goes through opts.clock.now() — no Date.now() here
 *   - dueWakes() is non-mutating and idempotent; only markDelivered() (after
 *     a real send) retires a run — a failed/silent delivery re-fires
 *   - ids are assigned monotonically (`w1`, `w2`, …) and never reused; a
 *     cancelled id is dead forever
 *   - schedule() is total: every invalid input returns a structured
 *     E_SCHEDULE refusal with a hint, never a throw
 * Raises: never
 */
export function createScheduleStore(opts: ScheduleStoreOptions): ScheduleStore {
	const clock = opts.clock;
	const minDelayMs = Math.max(0, opts.minDelayMs ?? SCHEDULE_DEFAULT_MIN_DELAY_MS);
	const maxActive = Math.max(1, Math.floor(opts.maxActive ?? SCHEDULE_DEFAULT_MAX_ACTIVE));
	// The pending set lives in insertion order; the read sorts by due time.
	const active = new Map<string, WakeSchedule>();
	// Retired delivery keys (`id#run`) — the stage-A in-memory dedup. #12
	// replaces this with the durable store.
	const delivered = new Set<string>();
	let seq = 0;

	const byDue = (a: WakeSchedule, b: WakeSchedule): number =>
		a.dueAtMs - b.dueAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

	return {
		schedule(input: ScheduleInput): ScheduleResult {
			const text = typeof input.text === "string" ? input.text.trim() : "";
			if (text.length === 0) {
				return refuse(
					"E_SCHEDULE",
					"E_SCHEDULE — scheduled wake text is required (pass the message the watcher should deliver).",
					"Call delegate_wake with action 'schedule' and a non-empty 'text'.",
				);
			}
			const hasDelay = typeof input.delayMs === "number" && Number.isFinite(input.delayMs);
			const hasAt = typeof input.atMs === "number" && Number.isFinite(input.atMs);
			if (hasDelay === hasAt) {
				return refuse(
					"E_SCHEDULE",
					"E_SCHEDULE — pass exactly one of 'delayMs' (relative) or 'at' (absolute ISO-8601); " +
						(hasDelay ? "both were given." : "neither was given."),
					"Pass 'delayMs: <ms>' for a relative wake or 'at: <ISO-8601>' for an absolute one — never both.",
				);
			}
			const now = clock.now();
			const dueAtMs = hasDelay ? now + input.delayMs! : input.atMs!;
			if (dueAtMs - now < minDelayMs) {
				return refuse(
					"E_SCHEDULE",
					"E_SCHEDULE — scheduled wake due time is too soon (" + (dueAtMs - now) + " ms from now); " +
						`the configured minimum delay is ${minDelayMs} ms.`,
					"Schedule at least " + minDelayMs + " ms out, or lower schedule.minDelayMs in ~/.pi/agent/pi-delegate.config.json.",
				);
			}
			if (active.size >= maxActive) {
				return refuse(
					"E_SCHEDULE",
					`E_SCHEDULE — active schedule cap reached (${maxActive}); cancel a pending wake or wait for one to fire.`,
					"List pending wakes with delegate_wake action 'list', cancel one with action 'cancel' (id), " +
						"or raise schedule.maxActive in ~/.pi/agent/pi-delegate.config.json.",
				);
			}
			const schedule: WakeSchedule = {
				id: `w${++seq}`,
				kind: "once",
				text,
				createdAtMs: now,
				dueAtMs,
				run: 1,
			};
			active.set(schedule.id, schedule);
			return { ok: true, schedule };
		},

		cancel(id: string): ScheduleCancelResult {
			const found = active.get(id);
			if (found === undefined) {
				return refuse(
					"E_SCHEDULE",
					`E_SCHEDULE — no pending scheduled wake with id "${id}".`,
					"Run delegate_wake action 'list' to see the pending ids; a cancelled or already-fired id cannot be reused.",
				);
			}
			active.delete(id);
			return { ok: true, schedule: found };
		},

		list(): WakeSchedule[] {
			return [...active.values()].sort(byDue).map((s) => ({ ...s }));
		},

		activeCount(): number {
			return active.size;
		},

		dueWakes(): DueWake[] {
			const now = clock.now();
			return [...active.values()]
				.filter((s) => s.dueAtMs <= now && !delivered.has(scheduleKey(s.id, s.run)))
				.sort(byDue)
				.map((s) => ({ id: s.id, run: s.run, kind: s.kind, text: s.text, dueAtMs: s.dueAtMs }));
		},

		markDelivered(id: string, run: number): void {
			delivered.add(scheduleKey(id, run));
			const found = active.get(id);
			if (found !== undefined && found.run === run) active.delete(id);
		},
	};
}
