/**
 * pi-delegate — watch-schedule: the scheduled-wake store and due computation
 * (issue #10 stage A one-shot; issue #11 stage B periodic).
 * <p>
 * MODULE_CONTRACT: owns the session's scheduled wakes — one-shot "wake me
 * at/delay T with M" and periodic "wake me every N with M until cancelled or
 * maxRuns". The store itself is pure and in-memory: no filesystem, no timers,
 * no transports. Time enters ONLY through the injected ClockPort
 * (src/clock.ts), so every timing regression runs on the VirtualClock
 * (ARCHITECTURE.md Law 10).
 * <p>
 * Durability (#12 stage C): the store is the CACHE; the persisted document is
 * the single source of truth (Law 9). A persistence port is INJECTED
 * (`SchedulePersistencePort`, implemented by src/watch-schedule-persist.ts) —
 * at construction the cache is rebuilt from the persisted state (the watcher
 * mount restore), and after every mutation the full snapshot (schedules +
 * retired `id#run` delivery keys + the id sequence) is written back. The
 * store imports no filesystem: with no port injected it is exactly the stage
 * A/B in-memory store. A corrupt/foreign document contributes nothing (the
 * port warns); in-memory behavior is unchanged.
 * <p>
 * Delivery key `id#run` (scheduleKey): one run can never wake twice. The
 * store does NOT deliver — dueWakes() is a non-mutating read and only
 * markDelivered(id, run), called by the watcher after a REAL send, retires a
 * run. A failed/silent delivery leaves the schedule pending; a periodic
 * schedule's next read coalesces the skipped interval and advances the run,
 * so a failing wake is skipped with its cadence preserved, never retried
 * unboundedly and never wedging the tick (Law 8). Silence is never a success (Law 2).
 * <p>
 * Coalescing (#11): dueWakes() reports ONE run — the latest interval whose
 * time has passed (`run + floor((now - dueAt) / interval)`, capped by
 * maxRuns) — and next-due advances only on markDelivered, so a burst of
 * missed intervals is ONE advanced wake, never a back-wake burst. The store
 * is the single source of truth for run counts and next-due (Law 9).
 * <p>
 * Limits (anti-spam), all from the `schedule` config section (defaults shared
 * with src/watch-config.ts, Law 9): minDelayMs (floors the one-shot delay AND
 * the periodic interval), maxActive (active schedules per session) and the
 * periodic run cap maxRuns.
 * <p>
 * Dependencies: src/clock.ts (the injected clock — a leaf port) and the
 * seam's DelegateErrorCode type (src/host.ts); a leaf module otherwise.
 */

import type { ClockPort } from "./clock.ts";
import type { DelegateErrorCode } from "./host.ts";

/** The schedule kind. Stage A added `once`; stage B (#11) ADDS `periodic` —
 *  the union grows by addition, never by redefining `once`. */
export type ScheduleKind = "once" | "periodic";

/** Default floor on the minimum delay (ms) before a scheduled wake may fire
 *  (config key `schedule.minDelayMs`). Canonically owned HERE; watch-config.ts
 *  imports it — one constant, never two (Law 9). */
export const SCHEDULE_DEFAULT_MIN_DELAY_MS = 1_000;
/** Default cap on active schedules per session (config key
 *  `schedule.maxActive`). Canonically owned HERE (see above). */
export const SCHEDULE_DEFAULT_MAX_ACTIVE = 8;
/** Default run cap for a periodic schedule (config key `schedule.maxRuns`, #11).
 *  Canonically owned HERE; watch-config.ts imports it — one constant, never
 *  two (Law 9). */
export const SCHEDULE_DEFAULT_MAX_RUNS = 100;

/** One pending scheduled wake. Stage A: one-shot. Stage B (#11): `periodic`
 *  wakes carry the interval and the run cap. `run` is the NEXT run to deliver
 *  (1 for a fresh schedule); a coalesced read reports `run + skipped` runs. */
export interface WakeSchedule {
	/** Store-assigned id (`w1`, `w2`, …) — stable, never reused. */
	id: string;
	kind: ScheduleKind;
	/** The message delivered verbatim (a periodic one MAY use the `{run}` /
	 *  `{maxRuns}` / `{elapsed}` placeholders — see formatScheduleWake). */
	text: string;
	createdAtMs: number;
	dueAtMs: number;
	/** The NEXT run to deliver (1 for a fresh schedule); the `id#run` key.
	 *  #11 periodic wakes advance it on a real delivery. */
	run: number;
	/** Periodic only (#11): the fire interval in ms (> 0). */
	intervalMs?: number;
	/** Periodic only (#11): the run cap — the schedule removes itself after
	 *  this many fires (config default when omitted). */
	maxRuns?: number;
}

/** A due wake as reported to the delivery path — the store's own record
 *  minus the mutable bookkeeping the tick must not see. For a periodic
 *  schedule `run` is the COALESCED run (the latest interval whose time has
 *  passed), never a burst of back-wakes (issue #11). */
export interface DueWake {
	id: string;
	run: number;
	kind: ScheduleKind;
	text: string;
	dueAtMs: number;
	/** Periodic only: the run cap (for the `run N/M` header). */
	maxRuns?: number;
	/** Periodic only: ms elapsed since the schedule was created — available to
	 *  the `{elapsed}` template placeholder. */
	elapsedMs?: number;
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
	/** The message delivered verbatim (periodic: may use `{run}` /
	 *  `{maxRuns}` / `{elapsed}`). Required, non-empty after trim. */
	text: string;
	/** Absolute due time (epoch ms). Exactly one of atMs / delayMs / everyMs. */
	atMs?: number;
	/** Relative delay (ms). Exactly one of atMs / delayMs / everyMs. */
	delayMs?: number;
	/** Periodic interval (ms, #11): fire every N until cancelled or maxRuns
	 *  (mutually exclusive with atMs / delayMs). */
	everyMs?: number;
	/** Periodic run cap (#11) — defaults to the store's maxRuns; only valid
	 *  together with everyMs. */
	maxRuns?: number;
}

export interface ScheduleStoreOptions {
	/** The injected clock (src/clock.ts). REQUIRED — the store never reads
	 *  wall time itself. */
	clock: ClockPort;
	/** Floor on the minimum delay (ms) — default SCHEDULE_DEFAULT_MIN_DELAY_MS. */
	minDelayMs?: number;
	/** Cap on active schedules — default SCHEDULE_DEFAULT_MAX_ACTIVE. */
	maxActive?: number;
	/** Default periodic run cap (#11); a per-schedule maxRuns overrides it. */
	maxRuns?: number;
	/** Durable persistence (#12). When present, the store restores its cache
	 *  from `read()` at construction and writes the full snapshot after every
	 *  mutation. Absent → the stage A/B in-memory store, byte-identical. */
	persistence?: SchedulePersistencePort;
}

/** The full durable state of the session's schedule store (issue #12): the
 *  pending schedules, the retired `id#run` delivery keys and the id sequence.
 *  The persisted document is the single source of truth; the in-memory store
 *  is a cache rebuilt from it (Law 9). */
export interface PersistedScheduleState {
	schedules: WakeSchedule[];
	/** Retired delivery keys (`scheduleKey`) — the durable delivery records: a
	 *  run recorded here can never wake again, across a watcher remount. */
	delivered: string[];
	/** The id sequence (`w<seq>`); persisted so a restored session never reuses
	 *  an id whose delivery key is already recorded (a reused id would be
	 *  suppressed forever — the restored store must stay total). */
	seq: number;
}

/** The durable half of the schedule store (#12): an injected leaf port so the
 *  store imports no filesystem. Implemented by src/watch-schedule-persist.ts. */
export interface SchedulePersistencePort {
	/** The persisted state for this session; a missing file reads as empty
	 *  (first run), a corrupt/unreadable/foreign one as empty WITH a warning.
	 *  Never throws. */
	read(): PersistedScheduleState;
	/** Persist the full snapshot (atomic, versioned). Advisory: never throws. */
	write(state: PersistedScheduleState): void;
}

export interface ScheduleStore extends SchedulePort {
	/** Accept a one-shot (`at`/`delayMs`) or periodic (`everyMs` + optional
	 *  `maxRuns`) schedule, or refuse with a structured E_SCHEDULE (empty text,
	 *  wrong number of at/delay/every, maxRuns without every, bad maxRuns,
	 *  below the floor, cap reached). */
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

/** The delivery key of one schedule run — `id#run`, the ONE spelling of the
 *  dedup key. */
export function scheduleKey(id: string, run: number): string {
	return `${id}#${run}`;
}

/** The delivered wake text: `scheduled wake (id w1): <text>` for a one-shot,
 *  `scheduled wake (id w2, run 3/10): <text>` for a periodic schedule (#11).
 *  Pure; a one-shot message is never reformatted. A periodic message may use
 *  `{run}`, `{maxRuns}` and `{elapsed}` placeholders, substituted here.
 *  <p>
 *  FUNCTION_CONTRACT:
 *  Input: w — the due wake (id, text, kind, run; maxRuns/elapsedMs for a
 *    periodic one)
 *  Output: the one-line wake text
 *  Guarantees: pure; `once` output is byte-identical to stage A
 *  Raises: never
 */
export function formatScheduleWake(
	w: Pick<DueWake, "id" | "text" | "kind" | "run"> & { maxRuns?: number; elapsedMs?: number },
): string {
	if (w.kind !== "periodic") return `scheduled wake (id ${w.id}): ${w.text}`;
	const cap = w.maxRuns === undefined ? "" : `/${w.maxRuns}`;
	return `scheduled wake (id ${w.id}, run ${w.run}${cap}): ${applyWakeTemplate(w.text, w)}`;
}

/** Human duration formatting — ONE spelling for `{elapsed}` and the tool's
 *  interval display (Law 9). */
export function formatDurationMs(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1_000));
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3_600);
	if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ""}`;
	if (m > 0) return `${m}m${s > 0 ? ` ${s}s` : ""}`;
	return `${s}s`;
}

/** Substitute the periodic placeholders `{run}` / `{maxRuns}` / `{elapsed}` (pure). */
function applyWakeTemplate(text: string, w: { run: number; maxRuns?: number; elapsedMs?: number }): string {
	if (!text.includes("{")) return text;
	return text
		.replaceAll("{run}", String(w.run))
		.replaceAll("{maxRuns}", w.maxRuns === undefined ? "?" : String(w.maxRuns))
		.replaceAll("{elapsed}", formatDurationMs(w.elapsedMs ?? 0));
}

function refuse(code: DelegateErrorCode, error: string, hint: string): ScheduleRefusal {
	return { ok: false, code, error, hint };
}

/**
 * Build the session's in-memory schedule store (#10 one-shot, #11 periodic).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts.clock (required ClockPort); opts.minDelayMs / opts.maxActive /
 *   opts.maxRuns (optional limits; defaults SCHEDULE_DEFAULT_*; floored
 *   defensively — minDelayMs ≥ 0, maxActive ≥ 1, maxRuns ≥ 1)
 * Output: a ScheduleStore (see the interface contracts above)
 * Guarantees:
 *   - every time read goes through opts.clock.now() — no Date.now() here
 *   - dueWakes() is non-mutating and idempotent; only markDelivered() (after
 *     a real send) retires/advances a run
 *   - ids are assigned monotonically (`w1`, `w2`, …) and never reused
 *   - schedule() is total: every invalid input returns a structured
 *     E_SCHEDULE refusal with a hint, never a throw
 *   - with a persistence port: the cache is rebuilt from it at construction,
 *     every mutation writes the full snapshot through it, and a port failure
 *     is advisory (never a throw) — the in-memory mutation stands
 * Raises: never
 */
export function createScheduleStore(opts: ScheduleStoreOptions): ScheduleStore {
	const clock = opts.clock;
	const minDelayMs = Math.max(0, opts.minDelayMs ?? SCHEDULE_DEFAULT_MIN_DELAY_MS);
	const maxActive = Math.max(1, Math.floor(opts.maxActive ?? SCHEDULE_DEFAULT_MAX_ACTIVE));
	const storeMaxRuns = Math.max(1, Math.floor(opts.maxRuns ?? SCHEDULE_DEFAULT_MAX_RUNS));
	// The pending set lives in insertion order; the read sorts by due time.
	const active = new Map<string, WakeSchedule>();
	// Retired delivery keys (`id#run`). #12 makes the set durable: it is part of
	// the persisted snapshot, so a remount cannot re-deliver a recorded run.
	const delivered = new Set<string>();
	let seq = 0;

	// Mount restore (#12): rebuild the cache from the durable document. The
	// port is total (a corrupt/foreign/missing document already warned and
	// contributed nothing), so this cannot break the mount (Law 8, advisory).
	const persistence = opts.persistence;
	if (persistence !== undefined) {
		const restored = persistence.read();
		for (const s of restored.schedules) active.set(s.id, { ...s });
		for (const key of restored.delivered) delivered.add(key);
		let maxId = 0;
		for (const s of restored.schedules) {
			const m = /^w(\d+)$/.exec(s.id);
			if (m !== null) maxId = Math.max(maxId, Number(m[1]));
		}
		seq = Math.max(restored.seq, maxId);
	}
	/** Write the full snapshot through the injected port (the port is
	 *  advisory: it never throws, and the in-memory mutation stands either way). */
	const persist = (): void => {
		if (persistence === undefined) return;
		persistence.write({ schedules: [...active.values()].map((s) => ({ ...s })), delivered: [...delivered], seq });
	};

	const byDue = (a: WakeSchedule, b: WakeSchedule): number =>
		a.dueAtMs - b.dueAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

	/** The run a due schedule reports NOW — the latest interval whose time has
	 *  passed, capped by the run cap. Missed intervals coalesce into ONE run
	 *  (#11); a one-shot is always its `run`. */
	const effectiveRun = (s: WakeSchedule, now: number): number => {
		if (s.kind !== "periodic" || s.intervalMs === undefined || s.intervalMs <= 0) return s.run;
		const skipped = Math.max(0, Math.floor((now - s.dueAtMs) / s.intervalMs));
		const advanced = s.run + skipped;
		return s.maxRuns === undefined ? advanced : Math.min(advanced, s.maxRuns);
	};

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
			const hasEvery = typeof input.everyMs === "number" && Number.isFinite(input.everyMs);
			const picked = (hasDelay ? 1 : 0) + (hasAt ? 1 : 0) + (hasEvery ? 1 : 0);
			if (picked !== 1) {
				return refuse(
					"E_SCHEDULE",
					"E_SCHEDULE — pass exactly one of 'delayMs' (relative), 'at' (absolute ISO-8601) or 'every' (periodic interval ms); " +
						(picked > 1 ? "more than one was given." : "none was given."),
					"Pass exactly one of 'delayMs: <ms>', 'at: <ISO-8601>' or 'every: <ms>' — a one-shot and a periodic wake are mutually exclusive.",
				);
			}
			if (input.maxRuns !== undefined && !hasEvery) {
				return refuse(
					"E_SCHEDULE",
					"E_SCHEDULE — 'maxRuns' applies only to a periodic 'every' schedule; a one-shot has exactly one run.",
					"Drop 'maxRuns' for a one-shot, or use 'every: <ms>' for a periodic wake with a run cap.",
				);
			}
			if (hasEvery && input.maxRuns !== undefined && (!Number.isInteger(input.maxRuns) || input.maxRuns < 1)) {
				return refuse(
					"E_SCHEDULE",
					`E_SCHEDULE — 'maxRuns' must be a positive integer (got ${JSON.stringify(input.maxRuns)}).`,
					"Pass e.g. 'maxRuns: 10', or omit it to use the configured schedule.maxRuns cap.",
				);
			}
			const now = clock.now();
			// A periodic schedule's first due is now + the interval, so the same
			// minimum-delay floor guards the interval (anti-spam).
			const dueAtMs = hasDelay ? now + input.delayMs! : hasAt ? input.atMs! : now + input.everyMs!;
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
				kind: hasEvery ? "periodic" : "once",
				text,
				createdAtMs: now,
				dueAtMs,
				run: 1,
			};
			if (hasEvery) {
				schedule.intervalMs = input.everyMs!;
				schedule.maxRuns = input.maxRuns ?? storeMaxRuns;
			}
			active.set(schedule.id, schedule);
			persist();
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
			persist();
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
				.map((s) => {
					const wake: DueWake = {
						id: s.id,
						run: effectiveRun(s, now),
						kind: s.kind,
						text: s.text,
						dueAtMs: s.dueAtMs,
					};
					if (s.kind === "periodic") {
						wake.maxRuns = s.maxRuns;
						wake.elapsedMs = now - s.createdAtMs;
					}
					return wake;
				});
		},

		markDelivered(id: string, run: number): void {
			delivered.add(scheduleKey(id, run));
			const found = active.get(id);
			if (found === undefined) {
				persist(); // the delivery key itself is the durable fact
				return;
			}
			if (found.kind !== "periodic") {
				// One-shot: a matching delivery retires the schedule (stage A).
				if (found.run === run) active.delete(id);
				persist();
				return;
			}
			// Periodic (#11): the delivered run advances the next-due past NOW
			// (`covered` intervals = this run plus the skipped ones it coalesced,
			// so the cadence stays anchored to the original interval grid). A
			// stale/unknown run changes nothing; reaching the cap removes the
			// schedule. Advancing only HERE (never in dueWakes) keeps the store
			// the single source of truth for run counts and next-due (Law 9).
			if (run < found.run) {
				persist(); // the key is recorded even when it changes no schedule
				return;
			}
			const nextRun = run + 1;
			if (found.maxRuns !== undefined && nextRun > found.maxRuns) {
				active.delete(id);
				persist();
				return;
			}
			const covered = run - found.run + 1;
			found.dueAtMs += covered * (found.intervalMs ?? 0);
			found.run = nextRun;
			persist();
		},
	};
}
