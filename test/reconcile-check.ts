/**
 * reconcile-check — issue #27 acceptance (ARCHITECTURE §4.1.4).
 *
 * Run with: bun test/reconcile-check.ts   (from the repo root)
 *
 * Simulated reboot: the journal is present (durable), the exchange root and
 * every live placement are gone. Reconciliation must give an honest picture:
 *
 *   R1  exactly ONE `reconcile-summary` for the affected owned fleet
 *       (idempotent across a repeated session_start);
 *   R2  un-terminated dead workers get `dead-reboot`; collected workers do not;
 *   R3  a live placement (Transport getStatus non-null) is NOT marked dead;
 *   R4  foreign fleets and owner-less legacy fleets are untouched (fail-closed);
 *   R5  a degraded liveness read (transport throws) never marks a false death;
 *   R6  no self identity → nothing is reconciled (fail-closed);
 *   R7  the frozen per-fleet summary text shape;
 *   R8  the production gate: files mode → no reconciliation; journal mode runs.
 *
 * RPC_E2E leg: when `RPC_E2E=1` the liveness seam is the REAL `pi --mode rpc`
 * adapter (no placements exist → dead-reboot); without the gate it is an
 * HONEST SKIP with its repro command.
 *
 * Fail-fast: a top-level watchdog exits non-zero no matter what.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "../src/host.ts";
import { FakeWorkerHost } from "../src/host/fake.ts";
import { createJournalWriter } from "../src/swarm/journal.ts";
import { createJournalReader, type JournalEvent } from "../src/swarm/journal-read.ts";
import {
	reconcileFleets,
	reconcileSessionStart,
	reconcileSummaryText,
} from "../src/swarm/reconcile.ts";

const watchdog = setTimeout(() => {
	console.error("reconcile-check WATCHDOG FIRED (a step hung)");
	process.exit(1);
}, 30_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const SELF = "/tmp/pi-sessions/self.jsonl";
const OTHER = "/tmp/pi-sessions/other.jsonl";

interface SeededWorker {
	name: string;
	owner?: string;
	collectedAt?: string;
}

function spawnPayload(w: SeededWorker): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		name: w.name,
		placement: { kind: "tab", backend: "fake", placementRef: `fake:${w.name}` },
		briefPath: `/tmp/brief-${w.name}.md`,
		reportPath: `/tmp/report-${w.name}.json`,
		provider: "p",
		model: "m",
		thinking: "off",
		startedAt: "2026-01-01T00:00:00.000Z",
	};
	if (w.owner !== undefined) entry.orchestratorSessionPath = w.owner;
	return {
		backend: "fake",
		placementRef: `fake:${w.name}`,
		briefPath: entry.briefPath,
		briefText: `brief ${w.name}`,
		entry,
	};
}

/** Seed one fleet: spawn events, an optional master stamp, collectedAt stamps. */
async function seedFleet(
	writer: ReturnType<typeof createJournalWriter>,
	fleet: { sessionId: string; task: string; master?: string; workers: SeededWorker[] },
): Promise<void> {
	if (fleet.master !== undefined) {
		await writer.append({
			kind: "stamp",
			sessionId: fleet.sessionId,
			task: fleet.task,
			worker: null,
			payload: { field: "masterSessionPath", value: fleet.master },
		});
	}
	for (const w of fleet.workers) {
		await writer.append({
			kind: "spawn",
			sessionId: fleet.sessionId,
			task: fleet.task,
			worker: w.name,
			payload: spawnPayload(w),
		});
		if (w.collectedAt !== undefined) {
			await writer.append({
				kind: "stamp",
				sessionId: fleet.sessionId,
				task: fleet.task,
				worker: w.name,
				payload: { field: "collectedAt", value: w.collectedAt },
			});
		}
	}
}

function count(events: JournalEvent[], kind: string, worker?: string): number {
	return events.filter((e) => e.kind === kind && (worker === undefined || e.worker === worker)).length;
}

// ---------------------------------------------------------------------------
// Deterministic leg — fake transport, no live placements, journal present
// ---------------------------------------------------------------------------

const SANDBOX = mkdtempSync(join(tmpdir(), "reconcile-check-"));
{
	const DB = join(SANDBOX, "events.db");
	const seed = createJournalWriter({ dbPath: DB });
	await seedFleet(seed, {
		sessionId: "sess-owned",
		task: "reboot-task",
		master: SELF,
		workers: [
			{ name: "w-dead", owner: SELF },
			{ name: "w-collected", owner: SELF, collectedAt: "2026-01-01T00:00:00.000Z" },
		],
	});
	await seedFleet(seed, { sessionId: "sess-owned", task: "live-task", master: SELF, workers: [{ name: "w-live", owner: SELF }] });
	await seedFleet(seed, { sessionId: "sess-foreign", task: "foreign-task", master: OTHER, workers: [{ name: "w-foreign", owner: OTHER }] });
	await seedFleet(seed, { sessionId: "sess-legacy", task: "legacy-task", workers: [{ name: "w-legacy" }] });
	seed.close();

	const transport = new FakeWorkerHost({ repoPath: process.cwd() });
	const placement = await transport.place({
		mode: "tab",
		repoPath: process.cwd(),
		branch: "",
		label: "w-live",
	});
	await transport.startAgent({
		name: "w-live",
		placementRef: placement.placementRef!,
		provider: "p",
		model: "m",
		thinking: "off",
		timeoutMs: 1000,
	});

	const reader = createJournalReader({ dbPath: DB });
	const writer = createJournalWriter({ dbPath: DB });
	const run1 = await reconcileFleets({
		transport,
		self: { sessionFile: SELF, cwd: process.cwd() },
		reader,
		writer,
	});

	const events1 = reader.eventsAfter(0);
	check("R1.1 exactly ONE reconcile-summary after the simulated reboot", count(events1, "reconcile-summary") === 1, JSON.stringify(events1.filter((e) => e.kind === "reconcile-summary")));
	check("R1.2 the summary is fleet-scoped (worker NULL)", events1.find((e) => e.kind === "reconcile-summary")?.worker === null);
	check(
		"R1.3 the summary payload is {lost:[w-dead], collectedBeforeLoss:1}",
		JSON.stringify((events1.find((e) => e.kind === "reconcile-summary")?.payload as { lost?: unknown })?.lost) === '["w-dead"]' &&
			(events1.find((e) => e.kind === "reconcile-summary")?.payload as { collectedBeforeLoss?: unknown })?.collectedBeforeLoss === 1,
		JSON.stringify(events1.find((e) => e.kind === "reconcile-summary")?.payload),
	);
	check("R1.4 the run reports exactly the w-dead loss and one summary", run1.lost.join(",") === "w-dead" && run1.summaries === 1, JSON.stringify(run1));

	check("R2.1 the un-terminated dead worker gets a dead-reboot event", count(events1, "dead-reboot", "w-dead") === 1, JSON.stringify(events1.filter((e) => e.kind === "dead-reboot")));
	check("R2.2 the collected worker is NOT marked dead", count(events1, "dead-reboot", "w-collected") === 0);
	check("R2.3 every dead-reboot payload carries detectedAt + lastSeq", events1.filter((e) => e.kind === "dead-reboot").every((e) => {
		const p = e.payload as { detectedAt?: unknown; lastSeq?: unknown };
		return typeof p.detectedAt === "string" && typeof p.lastSeq === "number";
	}));

	check("R3 a live placement (getStatus non-null) is NOT marked dead", count(events1, "dead-reboot", "w-live") === 0);
	check("R4.1 foreign fleets are untouched (no dead-reboot)", count(events1, "dead-reboot", "w-foreign") === 0);
	check("R4.2 foreign fleets are untouched (no summary)", count(events1, "reconcile-summary", undefined) === 1);
	check("R4.3 owner-less legacy fleets are untouched (fail-closed)", count(events1, "dead-reboot", "w-legacy") === 0);
	check("R4.4 only owned fleets are inspected", run1.fleets === 2, String(run1.fleets));

	// Repeat session_start over the same reboot — restart idempotency.
	const run2 = await reconcileFleets({
		transport,
		self: { sessionFile: SELF, cwd: process.cwd() },
		reader,
		writer,
	});
	const events2 = reader.eventsAfter(0);
	check("R1.5 a repeated reconciliation appends NO second summary", count(events2, "reconcile-summary") === 1, String(count(events2, "reconcile-summary")));
	check("R1.6 a repeated reconciliation marks no worker twice", count(events2, "dead-reboot", "w-dead") === 1 && run2.lost.length === 0, JSON.stringify(run2));

	// R6 — no self identity → fail-closed, nothing inspected.
	const run3 = await reconcileFleets({ transport, self: {}, reader, writer });
	check("R6 a degraded self-id reconciles nothing (fail-closed)", run3.fleets === 0 && run3.lost.length === 0 && run3.summaries === 0, JSON.stringify(run3));

	// R7 — the frozen summary text.
	check(
		"R7 the frozen summary text shape",
		reconcileSummaryText("reboot-task", { lost: ["w-dead"], collectedBeforeLoss: 1 }) ===
			"fleet reboot-task: 1 workers lost to reboot, briefs preserved, 1 reports collected before loss",
		reconcileSummaryText("reboot-task", { lost: ["w-dead"], collectedBeforeLoss: 1 }),
	);

	// R8 — production gate: files mode is inert, journal mode runs.
	const filesGate = await reconcileSessionStart(transport, { sessionFile: SELF }, { SWARM_STORAGE: "files" });
	check("R8.1 files mode runs no reconciliation (Phase A no-op)", filesGate.ran === false, JSON.stringify(filesGate));
	const journalGate = await reconcileSessionStart(transport, { sessionFile: SELF }, { SWARM_STORAGE: "journal", SWARM_JOURNAL_DB: DB });
	check("R8.2 journal mode scans the journal", journalGate.ran === true, JSON.stringify(journalGate));

	reader.close();
	writer.close();
}

// ---------------------------------------------------------------------------
// R5 — a degraded liveness read must not fake a death
// ---------------------------------------------------------------------------

{
	const DB = join(SANDBOX, "fault.db");
	const seed = createJournalWriter({ dbPath: DB });
	await seedFleet(seed, { sessionId: "sess-owned", task: "fault-task", master: SELF, workers: [{ name: "w-unknown", owner: SELF }] });
	seed.close();
	const reader = createJournalReader({ dbPath: DB });
	const writer = createJournalWriter({ dbPath: DB });
	const down = { getStatus: async () => { throw new Error("backend unreachable"); } } as unknown as Transport;
	const run = await reconcileFleets({ transport: down, self: { sessionFile: SELF }, reader, writer });
	const events = reader.eventsAfter(0);
	check("R5.1 an unprovable liveness read marks no worker dead", count(events, "dead-reboot") === 0, JSON.stringify(run));
	check("R5.2 no summary is appended when nothing was marked", count(events, "reconcile-summary") === 0);
	reader.close();
	writer.close();
}

// ---------------------------------------------------------------------------
// RPC_E2E leg — the REAL rpc adapter answers the liveness seam
// ---------------------------------------------------------------------------

if (process.env.RPC_E2E !== "1") {
	console.log("SKIP  R9 rpc-backend liveness leg — set RPC_E2E=1 to run (real pi --mode rpc adapter, no placements).");
	console.log("      repro: RPC_E2E=1 bun test/reconcile-check.ts");
} else {
	const DB = join(SANDBOX, "rpc.db");
	const seed = createJournalWriter({ dbPath: DB });
	await seedFleet(seed, { sessionId: "sess-owned", task: "rpc-task", master: SELF, workers: [{ name: "w-rpc", owner: SELF }] });
	seed.close();
	const { createRpcTransport } = await import("../src/host/rpc.ts");
	const reader = createJournalReader({ dbPath: DB });
	const writer = createJournalWriter({ dbPath: DB });
	const run = await reconcileFleets({ transport: createRpcTransport(), self: { sessionFile: SELF }, reader, writer });
	const events = reader.eventsAfter(0);
	check("R9.1 the real rpc adapter answers getStatus and the absent placement is dead", count(events, "dead-reboot", "w-rpc") === 1, JSON.stringify(run));
	check("R9.2 the rpc leg appends exactly one summary", count(events, "reconcile-summary") === 1);
	reader.close();
	writer.close();
}

rmSync(SANDBOX, { recursive: true, force: true });

console.log(failures === 0 ? "\nreconcile-check: all checks passed" : `\nreconcile-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);