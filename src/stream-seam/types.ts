/**
 * pi-delegate — src/stream-seam/types.ts (worker console stream surface).
 *
 * The console-stream surface the FidelityStore implements and the rpc adapter
 * consumes. The WIRE ENVELOPE (ConsoleEvent / ConsoleEventKind) lives in the
 * Transport seam itself (src/host.ts) — this module only adds the store-level
 * subscription/replay/snapshot contracts on top of it.
 *
 * MODULE_CONTRACT: pure types — no I/O, no state, no dependencies beyond the
 * seam types in ../host.ts. Behavioral truth lives in fidelity-store.ts's
 * module contract.
 */

import type { ConsoleEvent, ConsoleEventKind } from "../host.ts";

export type { ConsoleEvent, ConsoleEventKind };

export interface SubscriptionOptions {
	/** Deliver only events with seq > fromCursor; omit or 0 for the whole
	 *  RETAINED history (the store may have evicted events older than its
	 *  ring cap — a truncated backlog opens with a `gap` marker). */
	fromCursor?: number;
	/**
	 * Max events buffered for this subscriber while it is not pulling.
	 * On overflow the whole pending batch is dropped and one merged gap
	 * marker is emitted instead. Default 1024.
	 */
	bufferLimit?: number;
}

/**
 * A live subscription to one worker's console stream. Async-iterable (pull
 * based: a slow consumer simply stops calling next(), which is what makes
 * the bounded-queue overflow policy observable and testable), plus an
 * explicit unsubscribe for early teardown.
 */
export interface Subscription extends AsyncIterable<ConsoleEvent> {
	next(): Promise<IteratorResult<ConsoleEvent>>;
	/** Stops live delivery; already-buffered events stay pullable. */
	unsubscribe(): void;
}

/**
 * The store-level console stream (the dashboard-facing shape as prototyped in
 * dash-proto). Implemented by FidelityStore; a file-spilling backend could
 * implement the same interface behind the consumer's back. The Transport seam
 * method (`Transport.streamConsole`, src/host.ts) is the constrained view the
 * adapters expose: subscribe + the { afterSeq } option only.
 */
export interface ConsoleStream {
	/**
	 * Subscribe to a worker's console stream. Historical events (seq >
	 * fromCursor) are delivered first, then live events as they are appended.
	 * A backlog truncated by ring eviction opens with a `gap` marker.
	 */
	subscribe(workerName: string, options?: SubscriptionOptions): Subscription;
	/**
	 * Replay RETAINED stored events with seq > afterCursor, oldest first.
	 * Never contains gap markers; may be a suffix of the full history when
	 * the ring evicted the older events (see oldestSeq).
	 */
	replay(workerName: string, afterCursor: number): ConsoleEvent[];
	/**
	 * Bounded fallback with the existing readConsole semantics: the last
	 * maxChars of the worker's reconstructed transcript (payloads joined in
	 * seq order). Returns null when the worker is unknown.
	 */
	snapshot(workerName: string, maxChars: number): string | null;
	/** Latest ASSIGNED seq for a worker (even if evicted), or null when unknown. */
	cursor(workerName: string): number | null;
	/** Lowest seq still retained for a worker, or null when unknown/empty —
	 *  the boundary a consumer compares afterCursor+1 against to detect a
	 *  replay truncated by ring eviction. */
	oldestSeq(workerName: string): number | null;
	/** End every live subscription of one worker (worker-termination path):
	 *  each subscriber drains its buffered backlog, then its iterator returns
	 *  done. Live delivery stops. */
	close(workerName: string): void;
	/** Release one worker's ring entirely (teardown path): close() semantics
	 *  plus the stored history is dropped. */
	forget(workerName: string): void;
}
