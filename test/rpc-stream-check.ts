/**
 * rpc-stream-check — deterministic checks for the rpc adapter's console-stream
 * wiring (src/host/rpc.ts): the streamConsole seam method, the full-fidelity
 * record mirror in the stdout pump, the dialog-relay policy flag (default
 * OFF, byte-identical legacy behavior), and the structured-error contract.
 * NO real pi process and NO LLM call — the child-process factory is injected.
 *
 * Run with: bun test/rpc-stream-check.ts   (from repo root)
 *
 * Complements test/rpc-host-unit-check.ts (pump/status contract) and
 * test/stream-seam-check.ts (the fidelity store's own contracts).
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { createRpcTransport } from "../src/host/rpc.ts";
import { createHerdrTransport } from "../src/herdr/host.ts";
import { FakeWorkerHost } from "../src/host/fake.ts";
import {
	DelegateErrorImpl,
	type ConsoleEvent,
	type Placement,
	type Transport,
} from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// Fake child process — the injected seam double (rpc-host-unit-check pattern)
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
	readonly writes: Array<Record<string, unknown>> = [];
	readonly kills: string[] = [];
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin: { write: (s: string | Buffer) => boolean };

	constructor() {
		super();
		this.stdin = {
			write: (s: string | Buffer): boolean => {
				const cmd = JSON.parse(String(s)) as Record<string, unknown> & { id?: string };
				this.writes.push(cmd);
				if (cmd.type === "get_state") {
					queueMicrotask(() =>
						this.emitLine({
							type: "response",
							command: "get_state",
							id: cmd.id,
							success: true,
							data: { sessionFile: "/tmp/rpc-stream-fake-session.jsonl" },
						}),
					);
				} else if (cmd.type === "extension_ui_response") {
					queueMicrotask(() =>
						this.emitLine({ type: "response", command: "extension_ui_response", id: cmd.id, success: true }),
					);
				} else if (cmd.type === "abort") {
					// The teardown abort write settles the graceful path immediately.
					queueMicrotask(() => this.emit("exit", 0, null));
				}
				return true;
			},
		};
	}

	kill(signal?: NodeJS.Signals): this {
		this.kills.push(signal ?? "SIGTERM");
		return this;
	}

	/** Test helper: feed one JSON record over the fake stdout (LF-framed). */
	emitLine(obj: unknown): void {
		this.stdout.emit("data", `${JSON.stringify(obj)}\n`);
	}
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const WORKTREE_ROOT = join(tmpdir(), `rpc-stream-wt-${process.pid}`);
const repos: string[] = [];

interface Rig {
	host: Transport;
	child: FakeChildProcess;
	name: string;
	placement: Placement;
}

async function startWithFakeChild(opts: { dialogRelay?: boolean; name?: string } = {}): Promise<Rig> {
	const child = new FakeChildProcess();
	const host = createRpcTransport({
		worktreeRoot: WORKTREE_ROOT,
		subOrchestrator: false,
		...(opts.dialogRelay !== undefined ? { dialogRelay: opts.dialogRelay } : {}),
		spawnProcess: () => child as unknown as ChildProcess,
	});
	const repo = mkdtempSync(join(tmpdir(), "rpc-stream-repo-"));
	repos.push(repo);
	const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "stream" });
	const name = opts.name ?? "stream-worker";
	const start = await host.startAgent({
		name,
		placementRef: placement.placementRef ?? "",
		provider: "p",
		model: "m",
		thinking: "low",
		timeoutMs: 5_000,
	});
	return { host, child, name: start.name, placement };
}

// FAIL-FAST WATCHDOG — this script must never hang. Whatever is wrong, it exits
// non-zero within WATCHDOG_MS so a direct `bun test/<file>.ts` run cannot block
// an agent forever. Run the suite via test/run-checks.sh instead (per-check
// timeout, structured report).
const WATCHDOG_MS = 20_000;
setTimeout(() => {
	console.error(`WATCHDOG: check script exceeded ${WATCHDOG_MS}ms — fail-fast exit (a check awaited something unbounded; fix the check, do not raise this)`);
	process.exit(1);
}, WATCHDOG_MS);

async function drain(stream: AsyncIterable<ConsoleEvent>, ms = 2_000): Promise<ConsoleEvent[]> {
	// Bounded drain: collect events until the stream ENDS or `ms` elapse,
	// whichever first. A live subscription only ends when the worker's process
	// exits — a rig that never exits must never be awaited to completion.
	const out: ConsoleEvent[] = [];
	const pump = (async () => {
		for await (const e of stream) out.push(e); // iterate the ITERABLE, not the iterator
	})();
	pump.catch(() => {}); // post-deadline close may reject; never an unhandled rejection
	await Promise.race([pump, new Promise((r) => setTimeout(r, ms))]);
	return out;
}

function isE(err: unknown, code: string): boolean {
	return err instanceof DelegateErrorImpl && err.code === code;
}

try {
	// --- S1: capability contract (the degrade pattern) -----------------------
	{
		const rig = await startWithFakeChild();
		const streamer = rig.host as { streamConsole?: unknown };
		check(
			"S1.1 the rpc adapter IMPLEMENTS the optional streamConsole seam method",
			typeof streamer.streamConsole === "function",
		);
		// Unbound extraction stays safe (the readConsole BUG_FIX_CONTEXT class).
		const extracted = streamer.streamConsole as (name: string) => AsyncIterable<ConsoleEvent>;
		let unboundOk = false;
		try {
			for await (const _ of extracted(rig.name)) break; // starts, no events yet
			unboundOk = true;
		} catch {
			unboundOk = false;
		}
		check("S1.2 streamConsole survives unbound extraction (constructor-bound, same hazard class as readConsole)", unboundOk);

		const herdr = createHerdrTransport();
		const fake = new FakeWorkerHost({ repoPath: "/tmp" });
		check(
			"S1.3 herdr adapter and the fake host do NOT implement streamConsole — callers MUST degrade to readConsole polling",
			typeof (herdr as { streamConsole?: unknown }).streamConsole !== "function" &&
				typeof (fake as { streamConsole?: unknown }).streamConsole !== "function" &&
				typeof (herdr as { readConsole?: unknown }).readConsole === "function",
		);
		// The caller-side degrade branch, exercised as spawn.ts's probe probes:
		const degrade = async (t: Transport, name: string): Promise<string | null> => {
			if (typeof (t as { streamConsole?: unknown }).streamConsole === "function") return "stream";
			if (typeof (t as { readConsole?: unknown }).readConsole === "function") return "poll";
			return null;
		};
		check(
			"S1.4 the degrade probe picks streaming on rpc, readConsole polling on herdr, and the status-based fallback on the fake host (neither method present)",
			(await degrade(rig.host, rig.name)) === "stream" &&
				(await degrade(herdr, "x")) === "poll" &&
				(await degrade(fake as unknown as Transport, "x")) === null,
		);
	}

	// --- S2: full-fidelity mirror through the REAL pump ----------------------
	{
		const rig = await startWithFakeChild();
		rig.child.emitLine({ type: "agent_start" });
		rig.child.emitLine({ type: "message_update", delta: "hello " });
		rig.child.emitLine({ type: "message_update", delta: "world" });
		rig.child.emitLine({ type: "tool_execution_start", toolName: "bash", args: { cmd: "ls" } });
		rig.child.emitLine({ type: "agent_settled" });

		const events = drain((rig.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(rig.name));
		// Give the (synchronous, event-loop-driven) pump a tick to have finished.
		await new Promise((r) => setTimeout(r, 10));
		const got = await events;
		// Seq 1 is the get_state RESPONSE (the startAgent round-trip) — mirrored
		// as kind "raw": full fidelity of the stream in hand, responses included.
		const kinds = got.map((e) => e.kind).join(",");
		check(
			"S2.1 every parsed rpc record reached the stream in order, seq contiguous from 1 (incl. the get_state response as 'raw')",
			kinds ===
				"raw,agent_start,message_update,message_update,tool_execution_start,agent_settled" &&
				got.every((e, i) => e.seq === i + 1) &&
				got.every((e) => e.workerName === rig.name),
			kinds,
		);
		check(
			"S2.2 payloads are the records' verbatim JSON (full fidelity, no re-encoding)",
			got[0]!.kind === "raw" &&
				JSON.parse(got[0]!.payload).command === "get_state" &&
				got[2]!.payload === JSON.stringify({ type: "message_update", delta: "hello " }) &&
				JSON.parse(got[4]!.payload).toolName === "bash",
		);
		check(
			"S2.3 unknown worker → structured E_STATUS throw (Law 8), same contract as readConsole",
			await (async () => {
				try {
					(rig.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole("nobody");
					return false;
				} catch (err) {
					return isE(err, "E_STATUS");
				}
			})(),
		);
	}

	// --- S3: afterSeq replay semantics ---------------------------------------
	{
		const rig = await startWithFakeChild();
		for (const delta of ["a", "b", "c", "d"]) rig.child.emitLine({ type: "message_update", delta });
		await new Promise((r) => setTimeout(r, 10));
		const tail = await drain(
			(rig.host as { streamConsole: (n: string, o?: { afterSeq?: number }) => AsyncIterable<ConsoleEvent> }).streamConsole(rig.name, { afterSeq: 2 }),
		);
		// Store seqs: 1 = get_state response, 2..5 = deltas a,b,c,d.
		check(
			"S3.1 afterSeq=2 delivers exactly the seq>2 backlog (cursors replay from the store, oldest first)",
			tail.map((e) => e.seq).join(",") === "3,4,5" && tail[0]!.payload === JSON.stringify({ type: "message_update", delta: "b" }),
			tail.map((e) => e.seq).join(","),
		);
	}

	// --- S4: dialog-relay OFF (default) — legacy behavior, byte-identical ----
	{
		const rig = await startWithFakeChild(); // dialogRelay defaults to false
		rig.child.writes.length = 0; // drop the get_state bookkeeping write
		rig.child.emitLine({ type: "message_update", delta: "before" });
		rig.child.emitLine({ type: "extension_ui_request", id: "ui-1", method: "select", options: ["a", "b"] });
		await new Promise((r) => setTimeout(r, 10));

		const dialogWrites = rig.child.writes.filter((w) => w.type === "extension_ui_response");
		check(
			"S4.1 OFF: the blocking dialog is auto-cancelled over stdin — exactly one extension_ui_response write, cancelled:true (the legacy auto-cancel branch, byte-identical)",
			dialogWrites.length === 1 &&
				dialogWrites[0]!.id === "ui-1" &&
				dialogWrites[0]!.cancelled === true &&
				JSON.stringify(dialogWrites[0]!) === JSON.stringify({ type: "extension_ui_response", id: "ui-1", cancelled: true }),
			JSON.stringify(rig.child.writes),
		);
		const status = await rig.host.getStatus(rig.name);
		check("S4.2 OFF: the adapter never stays blocked on the dialog (status not 'blocked')", status?.status !== "blocked");

		const events = await drain(
			(rig.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(rig.name),
		);
		check(
			"S4.3 OFF: no dialog/ui offers reach the stream; non-dialog records still mirror",
			!events.some((e) => e.kind === "dialog" || e.kind === "ui") &&
				events.some((e) => e.kind === "message_update"),
		);
	}

	// --- S5: dialog-relay ON -------------------------------------------------
	{
		const rig = await startWithFakeChild({ dialogRelay: true });
		rig.child.writes.length = 0;
		rig.child.emitLine({ type: "agent_start" });
		rig.child.emitLine({ type: "extension_ui_request", id: "ui-2", method: "confirm", message: "proceed?" });
		await new Promise((r) => setTimeout(r, 10));

		check(
			"S5.1 ON: NO auto-cancel write — the stdin extension_ui_response path is left to the consumer",
			rig.child.writes.every((w) => w.type !== "extension_ui_response"),
			JSON.stringify(rig.child.writes),
		);
		const status = await rig.host.getStatus(rig.name);
		check("S5.2 ON: the dialog stays pending → status 'blocked' (honest sensor)", status?.status === "blocked");

		const events = await drain(
			(rig.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(rig.name),
		);
		const dialogEvent = events.find((e) => e.kind === "dialog");
		const offer = dialogEvent ? (JSON.parse(dialogEvent.payload) as { id?: string; method?: string }) : undefined;
		check(
			"S5.3 ON: the dialog offer is on the stream as kind 'dialog', payload carries the correlation id",
			dialogEvent !== undefined && offer?.id === "ui-2" && offer?.method === "confirm",
		);

		// Answer over the existing extension_ui_response stdin path.
		await (rig.host as unknown as { answerDialog: (r: { name: string; id: string; value: unknown }) => Promise<void> }).answerDialog({
			name: rig.name,
			id: "ui-2",
			value: true,
		});
		const answerWrite = rig.child.writes.find((w) => w.type === "extension_ui_response");
		const statusAfter = await rig.host.getStatus(rig.name);
		check(
			"S5.4 answerDialog writes the RAW extension_ui_response stdin command (dialog id on the wire, unclobbered by command correlation) with the value and clears the blocked state",
			answerWrite?.id === "ui-2" && answerWrite.value === true && answerWrite.cancelled === undefined && statusAfter?.status === "working",
			JSON.stringify({ write: answerWrite, status: statusAfter?.status }),
		);
	}

	// --- S6: fire-and-forget UI records ---------------------------------------
	{
		const off = await startWithFakeChild({ name: "ui-off" });
		off.child.emitLine({ type: "extension_ui_request", id: "ui-3", method: "setWidget", widget: { x: 1 } });
		await new Promise((r) => setTimeout(r, 10));
		const offEvents = await drain(
			(off.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(off.name),
		);

		const on = await startWithFakeChild({ dialogRelay: true, name: "ui-on" });
		on.child.emitLine({ type: "extension_ui_request", id: "ui-4", method: "setWidget", widget: { x: 1 } });
		await new Promise((r) => setTimeout(r, 10));
		const onEvents = await drain(
			(on.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(on.name),
		);

		check(
			"S6.1 fire-and-forget records: mirrored as kind 'ui' ONLY when the flag is on (off-stream when off, advisory console line unchanged in both)",
			!offEvents.some((e) => e.kind === "ui") && onEvents.some((e) => e.kind === "ui" && e.payload.includes("setWidget")),
		);
	}

	// --- S7: raw fidelity (stderr / unparsed / exit) --------------------------
	{
		const rig = await startWithFakeChild({ name: "raw-worker" });
		rig.child.stdout.emit("data", "not json at all\n");
		rig.child.stderr.emit("data", "boom trace\n");
		rig.child.emit("exit", 0, null);
		await new Promise((r) => setTimeout(r, 10));
		const events = await drain(
			(rig.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(rig.name),
		);
		const raws = events.filter((e) => e.kind === "raw").map((e) => e.payload);
		check(
			"S7.1 unparsed stdout, stderr lines and the exit notice reach the stream verbatim as kind 'raw'",
			raws.includes("not json at all") && raws.includes("boom trace") && raws.some((p) => p.startsWith("[process exited")),
			JSON.stringify(raws),
		);
	}

	// --- S9: iteration lifetime — settled stays open, exited ends the stream -
	{
		const rig = await startWithFakeChild({ name: "lifetime-worker" });
		const stream = (rig.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(rig.name);
		rig.child.emitLine({ type: "agent_start" });
		rig.child.emitLine({ type: "agent_settled" });
		await new Promise((r) => setTimeout(r, 10));
		// A settled worker is still ALIVE — the stream must NOT end: prove it by
		// appending a post-settle record and receiving it on the same iterator.
		rig.child.emitLine({ type: "message_update", delta: "after-settle" });
		const nextAfterSettle = await Promise.race([
			drain(stream, 300).then((events) => events.some((e) => e.payload.includes("after-settle"))),
			new Promise<boolean>((r) => setTimeout(() => r(false), 1_000)),
		]);
		check(
			"S9.1 agent_settled does NOT end the stream — a post-settle record still reaches a subscriber attached before the settle",
			nextAfterSettle,
		);

		// The child exits: every subscription must COMPLETE (drain backlog →
		// done) within a bounded window — the for-await-never-hangs contract.
		// A FRESH subscriber proves the full history (incl. the final record)
		// is delivered before the ended iterator closes the for-await.
		rig.child.emitLine({ type: "message_update", delta: "final-record" });
		await new Promise((r) => setTimeout(r, 10));
		const stream2 = (rig.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(rig.name);
		rig.child.emit("exit", 0, null);
		const completed = await Promise.race([
			drain(stream2, 1_000).then((events) => ({
				completed: true,
				hasFinal: events.some((e) => e.payload.includes("final-record")),
			})),
			new Promise<{ completed: boolean; hasFinal: boolean }>((r) => setTimeout(() => r({ completed: false, hasFinal: false }), 2_000)),
		]);
		check(
			"S9.2 after child exit the for-await consumer COMPLETES (backlog drained incl. the final record, then done) — never hangs",
			completed.completed && completed.hasFinal,
			JSON.stringify(completed),
		);
	}

	// --- S8: teardown releases the worker's ring ------------------------------
	{
		const rig = await startWithFakeChild({ name: "teardown-worker" });
		rig.child.emitLine({ type: "message_update", delta: "will be forgotten" });
		await new Promise((r) => setTimeout(r, 10));
		await rig.host.teardown({ name: rig.name, placement: rig.placement, force: true });
		// The teardown path forgot the ring — a NEW streamConsole subscription
		// refuses with E_STATUS (the agent is gone from the registry anyway).
		let threwE = false;
		try {
			(rig.host as { streamConsole: (n: string) => AsyncIterable<ConsoleEvent> }).streamConsole(rig.name);
		} catch (err) {
			threwE = isE(err, "E_STATUS");
		}
		check("S8.1 after teardown the worker's console ring is released (new subscriptions refuse with E_STATUS)", threwE);
	}
} finally {
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
	rmSync(WORKTREE_ROOT, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nrpc-stream-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-stream-check: all green");
process.exit(0);
