/**
 * pi-delegate — src/swarm-server/primary-watch.ts — the one-server-per-machine
 * takeover watch (issue #65 item 3b, ARCHITECTURE §4.2.8).
 *
 * MODULE_CONTRACT — D1 makes one session per machine the PRIMARY (the holder
 * of the configured `swarm.server.port`) and every later session a SECONDARY
 * whose fleets the primary serves read-only. This module is the advisory
 * mechanism that restores the canonical URL after the primary dies: every
 * non-primary mounted session runs a lightweight watch that PROBES the
 * canonical port and, when it stops answering as a delegate server, attempts
 * to bind it. The OS is the arbiter — the first successful bind wins, there
 * is no election protocol and no new store (the shared journal already makes
 * every fleet visible).
 *
 * ADVISORY BY CONTRACT (Law 8): the watch never blocks session work. Each
 * tick is a bounded probe + a bounded bind attempt; a failed attempt is
 * logged and retried with a multiplicative backoff capped at
 * `maxIntervalMs`. The timer is `unref()`d so an otherwise-idle process can
 * still exit. `stop()` is idempotent and the final state change is delivered
 * exactly once through `onPromoted`.
 *
 * Token continuity (Law 11, item 3b): the watch never touches a token — each
 * session keeps ITS OWN operator token (a token authenticates the operator to
 * a session, not to a port); the promoted session's mount re-surfaces its
 * dashboard link if the effective port changed.
 *
 * Dependencies: node:net only (a leaf). No herdr import (Law 4); no store.
 *
 * Critical invariants:
 *   - total: a throwing probe/bind is swallowed and the watch keeps ticking;
 *   - at most one bind attempt is in flight at a time (busy guard);
 *   - `probe()` true = the port answers → no bind attempt, backoff resets;
 *   - the first successful bind stops the watch (single promotion).
 */

import { connect } from "node:net";

/** Default tick interval and its backoff cap (ms). */
export const PRIMARY_WATCH_DEFAULT_INTERVAL_MS = 500;
export const PRIMARY_WATCH_MAX_INTERVAL_MS = 5_000;

/** Bounded deadline of one liveness probe (a hung peer is "dead"). */
export const PRIMARY_WATCH_PROBE_TIMEOUT_MS = 500;

export interface PrimaryWatchOptions {
	/** The canonical (configured) port to watch and take over. */
	port: number;
	/** True when the canonical port currently answers (the primary is alive). */
	probe: () => Promise<boolean>;
	/** Attempt to bind the canonical port; resolves a handle or null. */
	bind: () => Promise<{ port: number; address: string; close(): void } | null>;
	/** Called exactly once, after the first successful bind. */
	onPromoted: (handle: { port: number; address: string; close(): void }) => void;
	/** Structured advisory log sink (the mount's stderr line shape). */
	log: (event: string, fields: Record<string, unknown>) => void;
	intervalMs?: number;
	maxIntervalMs?: number;
}

export interface PrimaryWatchHandle {
	/** Stop watching (idempotent; a promotion after stop is impossible). */
	stop(): void;
}

/**
 * Probe whether a loopback port is occupied (TCP connect + bounded deadline).
 * <p>
 * FUNCTION_CONTRACT: Input — port, timeoutMs. Output — true when the connect
 * succeeds (something listens), false on refusal/timeout. Total; never throws.
 */
export function probePort(port: number, timeoutMs: number = PRIMARY_WATCH_PROBE_TIMEOUT_MS): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let done = false;
		const sock = connect(port, "127.0.0.1");
		const finish = (alive: boolean): void => {
			if (done) return;
			done = true;
			sock.destroy();
			resolve(alive);
		};
		sock.once("connect", () => finish(true));
		sock.once("error", () => finish(false));
		sock.setTimeout(timeoutMs, () => finish(false));
	});
}

/**
 * Start the takeover watch (issue #65 item 3b).
 * <p>
 * FUNCTION_CONTRACT:
 * Input: opts — the canonical port, the probe + bind seams, the promotion
 *   callback, the log sink and the backoff bounds
 * Output: the stop handle
 * Guarantees:
 *   - advisory: a throwing probe/bind never propagates, never blocks;
 *   - at most one in-flight attempt; failed binds back off multiplicatively
 *     up to `maxIntervalMs`;
 *   - a live primary (probe true) resets the backoff;
 *   - the FIRST successful bind fires `onPromoted` exactly once and stops.
 * Raises: never
 */
export function startPrimaryWatch(opts: PrimaryWatchOptions): PrimaryWatchHandle {
	const base = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : PRIMARY_WATCH_DEFAULT_INTERVAL_MS;
	const cap = opts.maxIntervalMs && opts.maxIntervalMs >= base ? opts.maxIntervalMs : PRIMARY_WATCH_MAX_INTERVAL_MS;
	let stopped = false;
	let busy = false;
	let interval = base;
	let attempts = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const schedule = (): void => {
		if (stopped) return;
		timer = setTimeout(() => void tick(), interval);
		// Never hold the process open on its own.
		timer.unref?.();
	};

	const tick = async (): Promise<void> => {
		if (stopped || busy) return;
		busy = true;
		try {
			if (await opts.probe()) {
				attempts = 0;
				interval = base;
				return;
			}
			attempts += 1;
			const promoted = await opts.bind();
			if (promoted !== null && !stopped) {
				stopped = true;
				opts.log("primary-takeover", { port: opts.port, attempts });
				opts.onPromoted(promoted);
				return;
			}
			opts.log("primary-watch-failed", { port: opts.port, attempts, intervalMs: interval });
			interval = Math.min(interval * 2, cap);
		} catch (err) {
			opts.log("primary-watch-failed", { port: opts.port, attempts, intervalMs: interval, error: String((err as Error).message ?? err) });
			interval = Math.min(interval * 2, cap);
		} finally {
			busy = false;
		}
		if (!stopped) schedule();
	};

	schedule();
	return {
		stop() {
			stopped = true;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
