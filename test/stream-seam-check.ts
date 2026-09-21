/**
 * stream-seam-check — deterministic checks for the console fidelity store
 * (src/stream-seam/fidelity-store.ts): replay-from-cursor exactness, snapshot
 * parity with the legacy readConsole last-maxChars semantics, the
 * drop-with-gap-marker backpressure policy, the ring cap and its memory
 * bound, and the beyond-cap (evicted-window) path. No I/O, no timers, no
 * fixtures — a deterministic LCG generator stands in for the rpc pump.
 *
 * Run with: bun test/stream-seam-check.ts   (from repo root)
 */

import {
	APPROX_BYTES_PER_EVENT_OVERHEAD,
	DEFAULT_RING_CAP,
	FidelityStore,
} from "../src/stream-seam/fidelity-store.ts";
import type { ConsoleEvent, ConsoleEventKind } from "../src/host.ts";
import type { Subscription } from "../src/stream-seam/types.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

/** Deterministic LCG — machine-independent fixture generation (Law 10). */
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

const WORDS =
	"const return async await worker stream buffer event cursor replay snapshot " +
	"manifest subscriber fidelity delta toolcall pending queue marker transcript " +
	"session orchestrator child process stdout jsonl payload bounded ring policy".split(" ");

function text(rng: () => number, chars: number): string {
	let out = "";
	while (out.length < chars) out += WORDS[Math.floor(rng() * WORDS.length)] + " ";
	return out.slice(0, chars);
}

/** Generate one deterministic synthetic rpc session into the store. */
function emitSession(store: FidelityStore, workerName: string, total: number, seed = 42): ConsoleEvent[] {
	const rng = makeRng(seed);
	const out: ConsoleEvent[] = [];
	const push = (kind: ConsoleEventKind, payload: string) => {
		out.push(store.append(workerName, kind, payload));
	};
	push("agent_start", JSON.stringify({ type: "agent_start" }));
	let i = 1;
	while (i < total - 1) {
		const r = rng();
		if (r < 0.6) push("message_update", text(rng, 20 + Math.floor(rng() * 80)));
		else if (r < 0.8) push("toolcall_update", JSON.stringify({ type: "partialResult", content: text(rng, 120) }));
		else if (r < 0.9) push("tool_execution_update", JSON.stringify({ type: "tool_execution_update" }));
		else push("queue_update", JSON.stringify({ type: "queue_update", depth: Math.floor(rng() * 4) }));
		i++;
	}
	push("agent_settled", JSON.stringify({ type: "agent_settled" }));
	return out;
}

// FAIL-FAST WATCHDOG — this script must never hang (the rpc-stream-check hang
// class, 2026-09-15). Whatever is wrong, exit non-zero within WATCHDOG_MS.
const WATCHDOG_MS = 20_000;
setTimeout(() => {
	console.error(`WATCHDOG: check script exceeded ${WATCHDOG_MS}ms — fail-fast exit (a check awaited something unbounded; fix the check, do not raise this)`);
	process.exit(1);
}, WATCHDOG_MS);

/** Pull from a subscription until it completes or BOUND_MS elapse, whichever
 * first — a subscription that never completes must fail the check, not hang
 * the agent running it. */
const BOUND_MS = 5_000;
async function drain(sub: Subscription): Promise<ConsoleEvent[]> {
	const out: ConsoleEvent[] = [];
	const pump = (async () => {
		for (;;) {
			const r = await sub.next();
			if (r.done) break;
			out.push(r.value);
		}
	})();
	pump.catch(() => {}); // post-deadline close may reject; never unhandled
	await Promise.race([pump, new Promise((r) => setTimeout(r, BOUND_MS))]);
	return out;
}

function transcript(events: ConsoleEvent[]): string {
	return events.map((e) => e.payload).join("");
}

/** Reference implementation of today's lossy readConsole semantics. */
function legacyReadConsole(events: ConsoleEvent[], maxChars: number): string {
	let textOut = "";
	for (const e of events) textOut += e.payload;
	return textOut.length > maxChars ? textOut.slice(textOut.length - maxChars) : textOut;
}

// ---------------------------------------------------------------------------
// R1 — replay-from-cursor exactness
// ---------------------------------------------------------------------------
{
	const store = new FidelityStore();
	const emitted = emitSession(store, "w1", 3000);

	const subA = store.subscribe("w1", { fromCursor: 0 });
	const subB = store.subscribe("w1", { fromCursor: 1000 });
	const subC = store.subscribe("w1", { fromCursor: 2900 });
	subA.unsubscribe();
	subB.unsubscribe();
	subC.unsubscribe();
	const [a, b, c] = await Promise.all([drain(subA), drain(subB), drain(subC)]);

	const canonical = transcript(store.replay("w1", 0));
	check(
		"R1.1 cursor-0 subscriber reconstructs the exact full transcript, gap-free",
		transcript(a) === canonical && !a.some((e) => e.kind === "gap") && a.length === 3000,
		`a.length=${a.length}`,
	);
	check(
		"R1.2 cursor-1000 subscriber sees exactly the tail after seq 1000 (char-level suffix of the canonical transcript)",
		transcript(b) === transcript(store.replay("w1", 1000)) &&
			b.length === 2000 &&
			b[0]!.seq === 1001 &&
			canonical.endsWith(transcript(b)),
	);
	check(
		"R1.3 cursor-2900 subscriber's tail nests inside the cursor-1000 tail",
		b && transcript(b).endsWith(transcript(c)) && c.length === 100 && c[0]!.seq === 2901,
	);
	check(
		"R1.4 store-side replay equals the emitted session event-for-event",
		store.replay("w1", 0).length === emitted.length &&
			store.replay("w1", 0).every((e, i) => e.seq === emitted[i]!.seq && e.payload === emitted[i]!.payload),
	);
	check("R1.5 unknown worker: replay empty, cursor null", store.replay("nobody", 0).length === 0 && store.cursor("nobody") === null);
}
{
	// Live fan-out: subscribers attached before the pump all get the identical
	// full stream (two subscribers, interleaved append/pull-free).
	const store = new FidelityStore();
	const subs = [
		store.subscribe("w2", { fromCursor: 0, bufferLimit: 4096 }),
		store.subscribe("w2", { fromCursor: 0, bufferLimit: 4096 }),
	];
	emitSession(store, "w2", 500);
	subs.forEach((s) => s.unsubscribe());
	const streams = await Promise.all(subs.map(drain));
	const canonical = transcript(store.replay("w2", 0));
	check(
		"R1.6 two pre-attached subscribers receive the identical full stream",
		transcript(streams[0]!) === canonical && transcript(streams[1]!) === canonical,
	);
}

// ---------------------------------------------------------------------------
// R2 — snapshot parity with legacy readConsole semantics
// ---------------------------------------------------------------------------
{
	const store = new FidelityStore();
	emitSession(store, "w3", 3000);
	const allEvents = store.replay("w3", 0);
	let snapOk = true;
	for (const maxChars of [1, 137, 1000, 4000, 10_000]) {
		if (store.snapshot("w3", maxChars) !== legacyReadConsole(allEvents, maxChars)) snapOk = false;
	}
	check(
		"R2.1 snapshot matches the legacy last-maxChars reference byte-for-byte at clamps 1/137/1000/4000/10000",
		snapOk,
	);
	const huge = store.snapshot("w3", 10_000_000);
	check("R2.2 snapshot larger than the transcript returns the full transcript", huge === allEvents.map((e) => e.payload).join(""));
	store.append("w3-empty", "agent_start", "");
	check(
		"R2.3 empty worker → empty snapshot; unknown worker → null",
		store.snapshot("w3-empty", 4000) === "" && store.snapshot("unknown-worker", 4000) === null,
	);
}

// ---------------------------------------------------------------------------
// R3 — drop-with-gap-marker backpressure
// ---------------------------------------------------------------------------
{
	const store = new FidelityStore();
	const limit = 64;
	const sub = store.subscribe("w4", { bufferLimit: limit });
	for (let i = 0; i < 1000; i++) store.append("w4", "message_update", `event-${i} `);
	sub.unsubscribe();
	const received = await drain(sub);
	const seqs = received.map((e) => e.seq);
	const gap = received[0]!;
	const tailContiguous =
		seqs.slice(1).every((s, i) => s === gap.seq + 1 + i) && seqs[seqs.length - 1] === 1000;
	check(
		"R3.1 slow subscriber: one merged gap marker first, then a contiguous live tail to seq 1000",
		gap.kind === "gap" && gap.payload.includes("seq 1..") && tailContiguous,
		JSON.stringify({ first: gap.kind, seqs: seqs.slice(0, 3) }),
	);
	check(
		"R3.2 slow subscriber is bounded: at most one gap + one full buffer survived (<= limit+1 deliveries, < 1000)",
		received.length <= limit + 1 && received.length < 1000,
		`received=${received.length}`,
	);
	check(
		"R3.3 gap payload names the replay recovery cursor",
		gap.payload.includes("replay(afterCursor=0)"),
	);
}
{
	const store = new FidelityStore();
	const sub = store.subscribe("w5");
	for (let i = 0; i < 5000; i++) store.append("w5", "message_update", `e${i} `);
	sub.unsubscribe();
	const delivered = await drain(sub);
	const replayed = store.replay("w5", 0);
	check(
		"R3.4 store-side replay stays complete and gap-free after subscriber overflow",
		delivered.some((e) => e.kind === "gap") && replayed.length === 5000 && replayed.every((e) => e.kind !== "gap"),
	);
}
{
	const store = new FidelityStore();
	const sub = store.subscribe("w6", { bufferLimit: 8 });
	const seqs: number[] = [];
	for (let i = 0; i < 50; i++) {
		store.append("w6", "message_update", `e${i}`);
		seqs.push(((await sub.next()) as { value: ConsoleEvent }).value.seq);
	}
	check(
		"R3.5 fast interleaved subscriber misses nothing (control)",
		seqs.join(",") === Array.from({ length: 50 }, (_, i) => i + 1).join(","),
	);
	sub.unsubscribe();
	await drain(sub);
}
{
	const store = new FidelityStore();
	const sub = store.subscribe("w7");
	store.append("w7", "message_update", "first");
	sub.unsubscribe();
	const received = await drain(sub);
	check(
		"R3.6 unsubscribe stops live delivery but buffered events stay pullable; appends to a dead subscription never throw",
		received.map((e) => e.payload).join() === "first" &&
			(() => {
				try {
					store.append("w7", "message_update", "after");
					return true;
				} catch {
					return false;
				}
			})() &&
			((await sub.next()).done === true),
	);
}

// ---------------------------------------------------------------------------
// R4 — ring cap, memory bound, beyond-cap path (QI2/QI3)
// ---------------------------------------------------------------------------
{
	const store = new FidelityStore(); // default cap DEFAULT_RING_CAP = 20_000
	const payload = text(makeRng(7), 100); // realistic ~100-char rpc record
	for (let i = 0; i < 25_000; i++) store.append("w8", "message_update", payload);

	const bytes = store.approxBytes("w8")!;
	const perWorkerBoundMb = bytes / (1024 * 1024);
	check(
		"R4.1 ring cap holds: 25k appended → exactly 20k retained per worker, total across store matches",
		store.totalEvents() === DEFAULT_RING_CAP && store.replay("w8", 0).length === DEFAULT_RING_CAP,
		`totalEvents=${store.totalEvents()}`,
	);
	check(
		"R4.2 memory bound as landed: per-worker retained bytes stay under ~5 MB at cap with ~100-char payloads (accounting: cap x (payload + 128B envelope))",
		bytes === DEFAULT_RING_CAP * (payload.length + APPROX_BYTES_PER_EVENT_OVERHEAD) && perWorkerBoundMb < 5,
		`approxBytes=${bytes} (${perWorkerBoundMb.toFixed(2)} MB/worker; 50 workers ≈ ${(perWorkerBoundMb * 50).toFixed(0)} MB)`,
	);
	check(
		"R4.3 seq numbers stay monotonic across eviction: cursor reports the last ASSIGNED seq (25000), not the retained count",
		store.cursor("w8") === 25_000,
		`cursor=${store.cursor("w8")}`,
	);
	check(
		"R4.4 replay from before the window returns the retained suffix (seq 5001..25000)",
		store.replay("w8", 0)[0]!.seq === 5_001 &&
			store.replay("w8", 0).length === 20_000 &&
			store.replay("w8", 25_000).length === 0,
	);
	check(
		"R4.5 beyond-cap detection: oldestSeq names the retained-window boundary a consumer compares afterCursor+1 against",
		store.oldestSeq("w8") === 5_001 && store.oldestSeq("w9") === null,
	);

	// The beyond-cap subscribe path: a truncated backlog OPENS with a gap
	// marker naming the first retained seq, then a contiguous retained tail.
	const sub = store.subscribe("w8", { fromCursor: 0, bufferLimit: 4096 });
	sub.unsubscribe();
	const received = await drain(sub);
	const gap = received[0]!;
	const tailContiguous = received
		.slice(1)
		.every((e, i) => e.seq === gap.seq + 1 + i);
	check(
		"R4.6 subscriber asking for an evicted window gets a leading gap marker naming the first retained seq, then a contiguous tail",
		gap.kind === "gap" &&
			gap.seq === 5_000 &&
			gap.payload.includes("seq 5001") &&
			tailContiguous &&
			received.length === 20_001,
		JSON.stringify({ first: gap.kind, gapSeq: gap.seq, len: received.length }),
	);
	// A cursor inside the window gets NO marker — replay stays exact.
	const sub2 = store.subscribe("w8", { fromCursor: 20_000, bufferLimit: 4096 });
	sub2.unsubscribe();
	const received2 = await drain(sub2);
	check(
		"R4.7 cursor inside the retained window: no gap marker, exact tail from seq 20001",
		received2[0]!.kind !== "gap" && received2[0]!.seq === 20_001 && received2.length === 5_000,
	);

	// forget() releases the ring (teardown path).
	store.forget("w8");
	check(
		"R4.8 forget() releases the worker's ring: cursor null, replay empty, store total drops",
		store.cursor("w8") === null && store.replay("w8", 0).length === 0 && store.totalEvents() === 0,
	);

	// Multi-worker isolation: a second worker's ring is independent.
	emitSession(store, "wa", 100, 99);
	emitSession(store, "wb", 200, 98);
	check(
		"R4.9 per-worker rings are independent (counts and transcripts)",
		store.replay("wa", 0).length === 100 &&
			store.replay("wb", 0).length === 200 &&
			transcript(store.replay("wa", 0)) !== transcript(store.replay("wb", 0)),
	);

	// Invalid cap is a constructor-time refusal (fail fast, no silent uncap).
	let threw = false;
	try {
		new FidelityStore({ cap: 0 });
	} catch {
		threw = true;
	}
	check("R4.10 non-positive cap is refused at construction", threw);
}

// ---------------------------------------------------------------------------
// R5 — worker-termination close() (the for-await-never-hangs contract)
// ---------------------------------------------------------------------------
{
	const store = new FidelityStore();
	// Subscriber 1: empty pending, WAITING on next() when the worker dies —
	// must be resolved done, never left hanging (the 35-min-hang class).
	const subWaiting = store.subscribe("wc");
	const waiting = subWaiting.next();
	store.close("wc");
	const resolvedDone = await Promise.race([
		waiting.then((r) => r.done === true),
		new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
	]);
	check(
		"R5.1 close() resolves a waiting next() with done immediately (no hang)",
		resolvedDone,
	);
	// Subscriber 2: buffered backlog (never pulled) — close() must let the
	// backlog drain fully, then end the iterator.
	const subBacklog = store.subscribe("wc2");
	store.append("wc2", "message_update", "backlog-1");
	store.append("wc2", "message_update", "backlog-2");
	store.close("wc2");
	const rest = await drain(subBacklog);
	check(
		"R5.2 after close() the buffered backlog drains fully, then the iterator returns done",
		rest.map((e) => e.payload).join(",") === "backlog-1,backlog-2" && (await subBacklog.next()).done === true,
	);
	// After close, appends never throw and never resurrect the subscription.
	store.append("wc2", "message_update", "after-close");
	check("R5.3 appends after close() never throw and are not delivered", (await subBacklog.next()).done === true);
}

if (failures > 0) {
	console.error(`\nstream-seam-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nstream-seam-check: all green");
process.exit(0);
