/**
 * pi-delegate — src/stream-seam/fidelity-store.ts
 *
 * MODULE_CONTRACT — the per-worker full-fidelity console event buffer behind
 * the optional `Transport.streamConsole` seam method (src/host.ts). ONE store
 * instance is owned by the rpc adapter (created at construction, keyed by
 * worker name); the adapter's stdout pump is the single writer (append from
 * the event loop only), consumers read via subscribe/replay/snapshot/cursor.
 *
 * This module owns:
 *   - the authoritative per-worker event ring — drop-oldest, capped at
 *     DEFAULT_RING_CAP (20,000) events per worker; seq numbers stay monotonic
 *     across eviction (cursor() reports the last ASSIGNED seq), so replay
 *     within the retained window is exact and gap-free, and a consumer can
 *     detect eviction by comparing afterCursor + 1 against oldestSeq();
 *   - live subscription fan-out to any number of concurrent readers with
 *     per-subscriber bounded queues and a drop-with-gap-marker overflow
 *     policy (see below);
 *   - worker-termination close(): ends every live subscription of a worker
 *     (each drains its buffered backlog, then its iterator returns done —
 *     a for-await consumer never hangs on a dead worker); forget() applies
 *     the same ending and additionally drops the stored history (teardown);
 *   - replay-from-cursor (binary search over the retained window);
 *   - bounded snapshot assembly with the existing readConsole (last maxChars)
 *     semantics — the fallback for anything older than the retained window;
 *   - approximate byte accounting per worker (APPROX_BYTES_PER_EVENT_OVERHEAD
 *     + payload chars) so the memory bound is asserted, not assumed;
 *   - forget() — releases one worker's ring entirely (the adapter calls it
 *     from teardown; session lifetime owns what it mounted).
 *
 * Overflow policy (per SUBSCRIBER, chosen over an unbounded queue on
 * purpose): a subscriber that stops pulling fills its bounded queue; once
 * the limit is hit the pending batch AND the incoming event are replaced by
 * one merged `gap` marker naming the total dropped seq range and the
 * replay(afterCursor) recovery point; consecutive overflows merge into a
 * single range. Memory per subscriber stays O(bufferLimit) no matter how
 * slow the consumer is, the gap is visible in anything the subscriber
 * persists, and recovery is exact: replay(afterCursor) returns the retained
 * events contiguously. The STORE never silently drops within its window:
 * replay is always complete and gap-free relative to the retained window.
 * Initial backlog on subscribe bypasses the buffer limit deliberately — it
 * holds references to events the store already owns, so it costs no extra
 * copies. A backlog truncated by ring eviction OPENS with a `gap` marker
 * naming the first retained seq (the subscriber-local `gap` kind is defined
 * in src/host.ts and is never stored in the ring itself).
 *
 * This module never does: process spawning, filesystem or network access,
 * steering, or any rendering — storage and fan-out only; callers decide what
 * events exist. Node built-ins only (no runtime dependencies).
 */

import type { ConsoleEvent, ConsoleEventKind } from "../host.ts";
import type { ConsoleStream, Subscription, SubscriptionOptions } from "./types.ts";

/** Default per-worker ring cap (events). At realistic rpc payload sizes
 *  (~100 chars) this bounds the store at ~4.6 MB per worker (~235 MB at 50
 *  workers) while covering ~11 minutes of live activity at 30 events/s. */
export const DEFAULT_RING_CAP = 20_000;

/** Approximated envelope cost (bytes) of one stored event beyond its payload
 *  chars — covers the ConsoleEvent object, its fixed string/number fields and
 *  the array slot. Calibrated against the prototype's measured 233 B/event
 *  for ~100-char payloads. payload.length counts chars (a lower bound for
 *  ASCII, exact enough for a bound assertion). */
export const APPROX_BYTES_PER_EVENT_OVERHEAD = 128;

interface SubscriberState {
	workerName: string;
	pending: ConsoleEvent[];
	waiting: ((result: IteratorResult<ConsoleEvent>) => void) | null;
	closed: boolean;
	bufferLimit: number;
	/** First dropped seq of the gap marker currently leading pending, if any. */
	gapFirstSeq: number | null;
}

interface WorkerLog {
	/** Ring storage: the retained window is events[head..events.length). */
	events: ConsoleEvent[];
	/** Index of the oldest retained event inside events. */
	head: number;
	/** Next seq to assign; monotonic — eviction never rewinds it. */
	nextSeq: number;
	/** Approximate retained bytes (see APPROX_BYTES_PER_EVENT_OVERHEAD). */
	approxBytes: number;
	subscribers: Set<SubscriberState>;
}

export interface FidelityStoreOptions {
	/** Per-worker ring cap (events). Default DEFAULT_RING_CAP. */
	cap?: number;
}

export class FidelityStore implements ConsoleStream {
	private readonly cap: number;
	private logs = new Map<string, WorkerLog>();

	constructor(options: FidelityStoreOptions = {}) {
		this.cap = options.cap ?? DEFAULT_RING_CAP;
		if (!Number.isInteger(this.cap) || this.cap <= 0) {
			throw new Error(`FidelityStore: cap must be a positive integer, got ${this.cap}`);
		}
	}

	private logFor(workerName: string): WorkerLog {
		let log = this.logs.get(workerName);
		if (!log) {
			log = { events: [], head: 0, nextSeq: 1, approxBytes: 0, subscribers: new Set() };
			this.logs.set(workerName, log);
		}
		return log;
	}

	/** Retained event count for one worker's log. */
	private retained(log: WorkerLog): number {
		return log.events.length - log.head;
	}

	/** Append one event for a worker and fan it out to live subscribers.
	 *  Evicts the oldest retained events while over the ring cap. */
	append(workerName: string, kind: ConsoleEventKind, payload: string, timestamp?: number): ConsoleEvent {
		const log = this.logFor(workerName);
		const event: ConsoleEvent = {
			workerName,
			seq: log.nextSeq++,
			timestamp: timestamp ?? Date.now(),
			kind,
			payload,
		};
		log.events.push(event);
		log.approxBytes += payload.length + APPROX_BYTES_PER_EVENT_OVERHEAD;
		while (this.retained(log) > this.cap) {
			const evicted = log.events[log.head]!;
			log.approxBytes -= evicted.payload.length + APPROX_BYTES_PER_EVENT_OVERHEAD;
			log.head++;
		}
		// Amortized compaction: once the dead prefix is at least half the
		// array (and non-trivial), slice it off — keeps push O(1) amortized
		// without an O(n) shift on every append past the cap.
		if (log.head >= 1024 && log.head * 2 >= log.events.length) {
			log.events = log.events.slice(log.head);
			log.head = 0;
		}
		for (const sub of log.subscribers) {
			this.deliver(sub, event);
		}
		return event;
	}

	private deliver(sub: SubscriberState, event: ConsoleEvent): void {
		if (sub.closed) return;
		if (sub.pending.length >= sub.bufferLimit) {
			// Overflow: replace the pending batch AND the incoming event with one
			// gap marker; consecutive overflows merge into a single dropped range.
			const first = sub.gapFirstSeq ?? sub.pending[0]!.seq;
			sub.gapFirstSeq = first;
			const last = event.seq;
			const dropped = last - first + 1;
			const gap: ConsoleEvent = {
				workerName: sub.workerName,
				seq: last,
				timestamp: event.timestamp,
				kind: "gap",
				payload: `[gap] dropped ${dropped} events (seq ${first}..${last}); replay(afterCursor=${first - 1}) to recover, then resume live at seq ${last}`,
			};
			sub.pending = [gap];
		} else if (sub.waiting && sub.pending.length === 0) {
			const resolve = sub.waiting;
			sub.waiting = null;
			resolve({ value: event, done: false });
		} else {
			sub.pending.push(event);
		}
	}

	subscribe(workerName: string, options: SubscriptionOptions = {}): Subscription {
		const log = this.logFor(workerName);
		const fromCursor = options.fromCursor ?? 0;
		const sub: SubscriberState = {
			workerName,
			pending: [],
			waiting: null,
			closed: false,
			bufferLimit: options.bufferLimit ?? 1024,
			gapFirstSeq: null,
		};
		// Truncated-backlog marker: when the requested cursor points before the
		// retained window, the iteration opens with one gap marker naming the
		// first retained seq — everything after it is contiguous.
		const oldest = this.oldestSeq(workerName);
		if (oldest !== null && oldest > 1 && fromCursor < oldest - 1) {
			sub.pending.push({
				workerName,
				seq: oldest - 1,
				timestamp: log.events[log.head]!.timestamp,
				kind: "gap",
				payload: `[gap] events before seq ${oldest} were evicted (ring cap ${this.cap}); the retained window starts at seq ${oldest}; replay(afterCursor=${oldest - 1}) returns the retained suffix; older history is only available via the readConsole snapshot fallback`,
			});
		}
		// Backlog: references to already-stored events, bypasses bufferLimit
		// (see contract). Single-threaded append means no subscribe/append race.
		for (let i = log.head; i < log.events.length; i++) {
			const event = log.events[i]!;
			if (event.seq > fromCursor) sub.pending.push(event);
		}
		log.subscribers.add(sub);

		const iterator: AsyncIterator<ConsoleEvent> = {
			next: async (): Promise<IteratorResult<ConsoleEvent>> => {
				if (sub.pending.length > 0) {
					const value = sub.pending.shift()!;
					if (sub.pending.length === 0) sub.gapFirstSeq = null;
					return { value, done: false };
				}
				if (sub.closed) return { value: undefined, done: true };
				return new Promise((resolve) => {
					sub.waiting = resolve;
				});
			},
		};

		const subscription: Subscription = {
			[Symbol.asyncIterator]: () => iterator,
			next: iterator.next,
			unsubscribe: () => {
				if (sub.closed) return;
				sub.closed = true;
				// Buffered events stay pullable; only live delivery stops.
				log.subscribers.delete(sub);
				if (sub.waiting) {
					const resolve = sub.waiting;
					sub.waiting = null;
					resolve({ value: undefined, done: true });
				}
			},
		};
		return subscription;
	}

	replay(workerName: string, afterCursor: number): ConsoleEvent[] {
		const log = this.logs.get(workerName);
		if (!log) return [];
		// Retained events are sorted by seq; binary-search the first seq >
		// afterCursor within [head, events.length). A cursor below the window
		// yields the retained suffix — incompleteness is detectable via
		// oldestSeq (the Transport contract surfaces it as a leading gap marker).
		let lo = log.head;
		let hi = log.events.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (log.events[mid]!.seq > afterCursor) hi = mid;
			else lo = mid + 1;
		}
		return log.events.slice(lo);
	}

	snapshot(workerName: string, maxChars: number): string | null {
		const log = this.logs.get(workerName);
		if (!log) return null;
		// Walk backwards until we hold at least maxChars of transcript, then
		// join forward and clamp the tail. Reconstructed transcript = payloads
		// joined in seq order — same text readConsole would have kept.
		let i = log.events.length;
		let len = 0;
		while (i > log.head && len < maxChars) {
			len += log.events[i - 1]!.payload.length;
			i--;
		}
		let text = "";
		for (let j = i; j < log.events.length; j++) {
			text += log.events[j]!.payload;
		}
		return text.length > maxChars ? text.slice(text.length - maxChars) : text;
	}

	cursor(workerName: string): number | null {
		const log = this.logs.get(workerName);
		if (!log) return null;
		return log.nextSeq - 1;
	}

	oldestSeq(workerName: string): number | null {
		const log = this.logs.get(workerName);
		if (!log) return null;
		if (this.retained(log) === 0) return null;
		return log.events[log.head]!.seq;
	}

	/** Release one worker's ring entirely (teardown path — the adapter drops
	 *  the worker's console history when its placement is closed). Existing
	 *  subscriptions keep their already-buffered events pullable; live
	 *  delivery stops because the log object leaves the map; a subscriber
	 *  WAITING on next() is resolved done rather than left hanging. */
	forget(workerName: string): void {
		this.close(workerName);
		this.logs.delete(workerName);
	}

	/** End every live subscription of one worker — the worker-termination
	 *  path (the rpc adapter calls it from the child's exit handler). Each
	 *  subscriber drains its already-buffered backlog, then its iterator
	 *  returns done instead of waiting for events that can never come; a
	 *  subscriber WAITING on next() is resolved done immediately. Live
	 *  delivery stops (the subscriber leaves the fan-out set). */
	close(workerName: string): void {
		const log = this.logs.get(workerName);
		if (!log) return;
		for (const sub of log.subscribers) {
			sub.closed = true;
			if (sub.waiting) {
				const resolve = sub.waiting;
				sub.waiting = null;
				resolve({ value: undefined, done: true });
			}
		}
		log.subscribers.clear();
	}

	/** Approximate retained bytes for one worker (null when unknown). */
	approxBytes(workerName: string): number | null {
		const log = this.logs.get(workerName);
		if (!log) return null;
		return log.approxBytes;
	}

	/** Approximate retained bytes across all workers. */
	approxBytesTotal(): number {
		let n = 0;
		for (const log of this.logs.values()) n += log.approxBytes;
		return n;
	}

	/** Total RETAINED events across all workers (tests/benchmarks). */
	totalEvents(): number {
		let n = 0;
		for (const log of this.logs.values()) n += this.retained(log);
		return n;
	}
}
