/**
 * pi-delegate — src/swarm-server/console-buffer.ts — the bounded console
 * backlog behind the worker-console endpoint (issue #52, ARCHITECTURE §4.2,
 * Law 1/Law 8).
 *
 * MODULE_CONTRACT — the push half of one worker's console ENDPOINT: consume
 * the Transport's optional `streamConsole` seam (src/host.ts — the rpc
 * adapter's FidelityStore-backed stream; adapters without capture have no
 * such method), concatenate the retained event payloads into ONE transcript,
 * and serve CHARACTER-offset reads out of it.
 *
 * BACKLOG CAP (explicit, drop-oldest): the transcript is bounded by pi's
 * `DEFAULT_MAX_BYTES` (50 KB — Law 1: the ONE truncation constant, never a
 * re-invented number; see the tool-return truncation duty in src/text-cap.ts
 * for the sibling use of the same constants). Eviction is by WHOLE retained
 * event, oldest first, while the retained bytes exceed the cap; a single
 * event larger than the cap is itself capped with pi's `truncateTail` (the
 * Law-1 helper — no hand-rolled truncator). Whole-event eviction is
 * deliberate: `truncateTail` on the joined transcript could drop a trailing
 * newline (its line split/join), which would break the append-only suffix
 * invariant the offsets rely on.
 *
 * OFFSET MODEL: `offset` is the CHARACTER position in the worker's
 * transcript as seen by THIS server session, counted from the first payload
 * it observed. Dropping the oldest events advances `oldestOffset`; text is
 * only ever appended at the end, so a client that feeds back `nextOffset`
 * replays exactly the bytes after it — no duplication, no loss, for as long
 * as the cursor sits at or above `oldestOffset`. Below it the read is served
 * from `oldestOffset` with `dropped: true` (the client re-syncs).
 *
 * ADVISORY (Law 8): a failing subscribe or a throwing iterator is a degraded
 * capture, never a thrown error; the endpoint reports the degradation and
 * the pipeline (spawn/collect/watcher) never sees it.
 *
 * Dependencies: @earendil-works/pi-coding-agent (`DEFAULT_MAX_BYTES`,
 * `truncateTail` — Law 1), and TYPE-ONLY src/host.ts (ConsoleEvent) plus
 * src/stream-seam/types.ts (SubscriptionOptions shape is not imported; the
 * seam's own `streamConsole` signature is used through a structural type so
 * nothing above src/ is imported at runtime). No durable store, no journal
 * writer, no backend adapter (Law 4/Law 13 — pinned for the family).
 */

import { DEFAULT_MAX_BYTES, truncateTail } from "@earendil-works/pi-coding-agent";
import type { ConsoleEvent } from "../host.ts";

/** Per-worker retained-backlog byte cap (Law 1 constant — documented above). */
export const CONSOLE_BACKLOG_MAX_BYTES = DEFAULT_MAX_BYTES;

/** Per-read character cap (an upper bound on one response `chunk`). */
export const CONSOLE_CHUNK_MAX_CHARS = DEFAULT_MAX_BYTES;

/** The iterator shape the seam's optional streamConsole returns. */
export interface ConsoleStreamLike extends AsyncIterable<ConsoleEvent> {
	unsubscribe?(): void;
}

/** The structural transport slice this module consumes (capability-optional,
 *  exactly the seam's optionality pattern). */
export interface ConsoleStreamSource {
	streamConsole?(name: string, opts?: { afterSeq?: number }): ConsoleStreamLike;
}

/** One read result: the chunk + its absolute position bookkeeping. */
export interface ConsoleRead {
	chunk: string;
	/** Absolute offset the NEXT read should pass (chunk start + length). */
	nextOffset: number;
	/** Lowest offset still retained (the drop-oldest frontier). */
	oldestOffset: number;
	/** True when the requested offset fell below oldestOffset. */
	dropped: boolean;
}

interface Piece {
	payload: string;
	bytes: number;
}

/**
 * The bounded transcript of ONE worker. Pure string bookkeeping — no I/O.
 */
export class ConsoleBacklog {
	private pieces: Piece[] = [];
	private joined = "";
	private bytes = 0;
	private charsDropped = 0;

	constructor(private readonly capBytes: number = CONSOLE_BACKLOG_MAX_BYTES) {}

	/** Append one payload, evicting whole events until the byte cap holds. */
	append(payload: string): void {
		if (payload.length === 0) return;
		let p = payload;
		let b = Buffer.byteLength(p, "utf8");
		if (b > this.capBytes) {
			// Single event over the cap: keep its tail with the Law-1 helper.
			p = truncateTail(p, { maxBytes: this.capBytes, maxLines: Number.MAX_SAFE_INTEGER }).content;
			b = Buffer.byteLength(p, "utf8");
		}
		this.pieces.push({ payload: p, bytes: b });
		this.joined += p;
		this.bytes += b;
		while (this.bytes > this.capBytes && this.pieces.length > 1) {
			const evicted = this.pieces.shift()!;
			this.bytes -= evicted.bytes;
			this.charsDropped += evicted.payload.length;
			this.joined = this.joined.slice(evicted.payload.length);
		}
	}

	/** Absolute offset of the first retained character. */
	oldestOffset(): number {
		return this.charsDropped;
	}

	/** Absolute offset just past the last retained character. */
	nextOffset(): number {
		return this.charsDropped + this.joined.length;
	}

	/** Retained byte count (the bounded quantity). */
	retainedBytes(): number {
		return this.bytes;
	}

	/** Read at most maxChars characters starting at the requested offset. */
	read(offset: number, maxChars: number = CONSOLE_CHUNK_MAX_CHARS): ConsoleRead {
		const oldest = this.charsDropped;
		const next = this.nextOffset();
		const requested = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
		const dropped = requested < oldest;
		const start = Math.min(Math.max(requested, oldest), next);
		const rel = start - oldest;
		const chunk = this.joined.slice(rel, rel + Math.max(0, maxChars));
		return { chunk, nextOffset: start + chunk.length, oldestOffset: oldest, dropped };
	}
}

type DrainSentinel = typeof DRAIN;
const DRAIN = Symbol("console-drain");

/** Max events consumed in the synchronous drain phase (a safety bound). */
const MAX_DRAIN_EVENTS = 100_000;

interface Capture {
	backlog: ConsoleBacklog;
	sub: ConsoleStreamLike | null;
	ready: Promise<void>;
	markReady: () => void;
	ended: boolean;
	failed: boolean;
}

/**
 * Per-worker console capture: lazily subscribes one worker's Transport
 * console stream, drains the already-retained backlog synchronously, then
 * keeps a background pump attached for live events. One instance per server
 * session; `stop()` unsubscribes everything it mounted (Law 3).
 */
export class ConsoleCapture {
	private readonly captures = new Map<string, Capture>();
	/** Set when a subscribe/pump threw — the endpoint degrades honestly. */
	private failure: string | null = null;

	constructor(private readonly source: ConsoleStreamSource, private readonly maxDrainEvents: number = MAX_DRAIN_EVENTS) {}

	/** True when the transport exposes any console capture method at all. */
	static canCapture(source: ConsoleStreamSource): boolean {
		return typeof source.streamConsole === "function";
	}

	/**
	 * Ensure a worker's capture exists and its already-retained backlog is
	 * in the buffer; returns the backlog (or null when capture failed).
	 * Total: never throws (Law 8).
	 */
	async ensure(name: string): Promise<ConsoleBacklog | null> {
		let cap = this.captures.get(name);
		if (!cap) {
			let markReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				markReady = resolve;
			});
			cap = { backlog: new ConsoleBacklog(), sub: null, ready, markReady, ended: false, failed: false };
			this.captures.set(name, cap);
			try {
				const sub: ConsoleStreamLike | undefined = this.source.streamConsole?.(name, { afterSeq: 0 });
				if (!sub) {
					cap.failed = true;
					cap.markReady();
				} else {
					cap.sub = sub;
					void this.pump(name, cap, sub);
				}
			} catch (err) {
				cap.failed = true;
				this.failure = errText(err);
				cap.markReady();
			}
		}
		await cap.ready;
		return cap.failed ? null : cap.backlog;
	}

	/** The last capture failure (diagnostic; null when none). */
	lastFailure(): string | null {
		return this.failure;
	}

	/** Unsubscribe every mounted stream (server stop — Law 3). Idempotent. */
	stop(): void {
		for (const cap of this.captures.values()) {
			try {
				cap.sub?.unsubscribe?.();
			} catch {
				// advisory — a failing unsubscribe never propagates past stop()
			}
		}
		this.captures.clear();
	}

	private async pump(name: string, cap: Capture, sub: ConsoleStreamLike): Promise<void> {
		const iterator = sub[Symbol.asyncIterator]();
		try {
			// Phase 1 — the already-retained backlog resolves synchronously;
			// stop as soon as next() has to WAIT (an idle live worker).
			for (let i = 0; i < this.maxDrainEvents; i++) {
				const r = await Promise.race([iterator.next(), Promise.resolve<DrainSentinel>(DRAIN)]);
				if (r === DRAIN) break;
				if (r.done) {
					cap.ended = true;
					break;
				}
				cap.backlog.append(r.value.payload);
			}
			cap.markReady();
			if (cap.ended) {
				try {
					sub.unsubscribe?.();
				} catch {
					// advisory
				}
				return;
			}
			// Phase 2 — live tail for the worker's lifetime.
			for (;;) {
				const r = await iterator.next();
				if (r.done) {
					cap.ended = true;
					break;
				}
				cap.backlog.append(r.value.payload);
			}
		} catch (err) {
			cap.failed = true;
			this.failure = errText(err);
			cap.markReady();
		}
	}
}

function errText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}