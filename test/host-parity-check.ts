/**
 * host-parity-check — the WorkerHost parity pin (the backend-neutral seam
 * shipped in 1.16.0).
 *
 * The SAME place → manifest → teardown flow is driven against BOTH adapters:
 *   - the in-memory fake (src/host/fake.ts) — always runs (CI leg);
 *   - the real herdr adapter (src/herdr/host.ts) — skip-guarded on
 *     `herdr --version` (same guard shape as transport-contract.ts; on a
 *     herdr-less host the herdr leg is skipped, never failed).
 *
 * Parity is asserted at the SEAM level only: identical flow steps must
 * produce identical seam-level outcomes (Placement shape incl. the opaque
 * placementRef + backend tag ALONGSIDE legacy fields, manifest round-trip
 * through the tolerant reader, teardown idempotency, ref-based dedup
 * identity, and a read model that leaks no backend ids).
 *
 * Exit 0 only if all checks pass (skips are not failures).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readManifest, updateManifest, type ManifestWorker } from "../src/exchange.ts";
import { FakeWorkerHost } from "../src/host/fake.ts";
import { createHerdrTransport } from "../src/herdr/host.ts";
import { createRpcTransport } from "../src/host/rpc.ts";
import { installSignalCleanup, sweepStaleHerdrFixtures } from "./herdr-hygiene-fixture.ts";
import type { Placement, Transport } from "../src/host.ts";

const execFileP = promisify(execFile);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// Skip guards (transport-contract shape): the herdr leg needs the real herdr
// binary; the rpc leg needs the real pi binary (the adapter spawns `pi --mode
// rpc`). On a herdr-less/pi-less host the respective leg is skipped, never failed.
let herdrAvailable = false;
try {
	await execFileP("herdr", ["--version"], { timeout: 10_000 });
	herdrAvailable = true;
} catch {
	herdrAvailable = false;
}
let piAvailable = false;
try {
	await execFileP("pi", ["--version"], { timeout: 10_000 });
	piAvailable = true;
} catch {
	piAvailable = false;
}

// The rpc parity leg's worker tier — same defaults as rpc-host-e2e-check.ts
// (the spawned pi is NEVER prompted, so no LLM call and no token burn; these
// only need to be values pi accepts at startup).
const RPC_PROVIDER = process.env.RPC_E2E_PROVIDER ?? "beta";
const RPC_MODEL = process.env.RPC_E2E_MODEL ?? "flash";
const RPC_THINKING = process.env.RPC_E2E_THINKING ?? "medium";

// Shared fixture: one throwaway repo + one sandboxed exchange dir per leg
// (fixture hygiene: NEVER the live /tmp/exchange root — $PI_DELEGATE_EXCHANGE_
// ROOT override, see exchange.ts exchangeRoot()).

// --- stale-fixture sweep + SIGTERM-safe cleanup (herdr-hygiene-fixture) -----
// The herdr leg places REAL herdr worktrees from a throwaway
// host-parity-repo-herdr-* repo. Sweep LEFTOVER state from previous
// killed/crashed runs BEFORE creating any new fixture, and arm the bounded
// signal handler so THIS run's cleanup also fires on the runner's
// `timeout 30` SIGTERM (finally never runs on signal death). The fake leg
// leaves no herdr state — the sweep prefix covers only the HERDR leg's repo
// prefix (driveParityFlow label "herdr" → mkdtemp prefix
// "host-parity-repo-herdr-").
{
	const swept = await sweepStaleHerdrFixtures(["host-parity-repo-herdr-"]);
	console.log(`swept stale host-parity-repo-herdr-* fixtures: closed ${swept.closed.length} / failed ${swept.failed.length}`);
}

// Module-scope handles for the signal-handler cleanup (the herdr leg's
// try/finally body, extracted): the cwd restore target and the throwaway
// root-cwd dir it created. Undefined until the herdr leg starts.
let parityPrevCwd: string | undefined;
let parityRootCwd: string | undefined;

// Idempotent module-scope cleanup — the signal handler (installSignalCleanup
// below) and the herdr leg's `finally` both call this; the guard makes double
// invocation harmless.
let parityCleaned = false;
async function cleanupAll() {
	if (parityCleaned) return;
	parityCleaned = true;
	// Each step individually guarded: a signal may arrive before the herdr leg
	// ever ran (both handles still undefined) — partial cleanup beats none.
	if (parityPrevCwd !== undefined) {
		try { process.chdir(parityPrevCwd); } catch { /* cwd already gone */ }
	}
	if (parityRootCwd !== undefined) {
		try { rmSync(parityRootCwd, { recursive: true, force: true }); } catch { /* already gone */ }
		parityRootCwd = undefined;
	}
	// Fixture sweep: every `herdr worktree create` against the fixture repo
	// ALSO creates a repo-level shell workspace whose checkout_path IS the
	// /tmp host-parity-repo-herdr-* repo itself (is_linked_worktree: false);
	// the flow's teardown never touches that shell, and on a mid-run signal
	// the branch worktree workspace leaks too — once driveParityFlow's
	// finally rm's the repo dir (or a signal kills the process before it),
	// the shells become "(deleted)" ghost tabs (the 2026-09 incident shape).
	// The sweep closes them best-effort on BOTH the normal and the signal path.
	await sweepStaleHerdrFixtures(["host-parity-repo-herdr-"]);
	try { rmSync(EXCHANGE_SANDBOX, { recursive: true, force: true }); } catch { /* already gone */ }
}
installSignalCleanup(cleanupAll);

const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), "host-parity-exchange-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;

interface FlowResult {
	placement: Placement;
	manifestEntry: ManifestWorker | undefined;
	teardownCalls: number;
	secondTeardownOk: boolean;
	/** Migration stage 1: the structured alreadyGone field on BOTH closes. */
	firstTeardownAlreadyGone: boolean | undefined;
	secondTeardownAlreadyGone: boolean | undefined;
	dedupSurvivor: string | undefined;
	/** rpc leg only: the StartResult of the (never-prompted) live worker. */
	startResult: Awaited<ReturnType<Transport["startAgent"]>> | undefined;
}

/**
 * Drive the shared parity flow on any adapter.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: host — the adapter under test; label — unique task-dir slug
 * Output: seam-level observations of the place → manifest → teardown flow
 * Guarantees:
 *   - identical steps for every adapter (parity means: same script, same
 *     seam-level assertions — only the adapter binding differs)
 *   - the exchange dir is sandboxed; cleaned up by the caller
 * Raises:
 *   - propagates adapter failures (a leg that throws FAILS its checks —
 *     parity includes "does not throw")
 */
async function driveParityFlow(
	host: Transport,
	label: string,
	mode: "worktree" | "tab",
	opts: { withStart?: boolean; provider?: string; model?: string; thinking?: string } = {},
): Promise<FlowResult> {
	const repoDir = mkdtempSync(join(tmpdir(), `host-parity-repo-${label}-`));
	try {
		// herdr worktree actions require the --cwd source to be a git repo
		// (not_git_worktree guard) — init a throwaway repo (same fixture shape
		// as transport-contract's qa-t2-repo); harmless for the fake leg.
		const git = async (...args: string[]) => execFileP("git", args, { cwd: repoDir, encoding: "utf8" });
		await git("init", "-b", "main");
		await git("config", "user.email", "qa@test");
		await git("config", "user.name", "qa");
		await execFileP("bash", ["-c", "echo hello > README.md"], { cwd: repoDir });
		await git("add", ".");
		await git("commit", "-m", "init");

		// 1. place — worktree for herdr (real isolation), tab for the fake
		// (it fakes no filesystem isolation; the KIND difference is adapter-
		// legitimate, the SEAM-level fields below are the parity surface).
		const placement = await host.place({
			mode,
			repoPath: repoDir,
			branch: `delegate/parity-${label}`,
			label: `parity-${label}`,
		});

		// 2. manifest write (spawn.ts entry shape) → tolerant-reader round-trip.
		const dir = join(EXCHANGE_SANDBOX, `parity-${label}`);
		mkdirSync(dir, { recursive: true });
		const entry: ManifestWorker = {
			name: `parity-${label}`,
			placement,
			briefPath: join(dir, "brief.md"),
			reportPath: join(dir, "report.json"),
			provider: "p",
			model: "m",
			thinking: "low",
			startedAt: new Date().toISOString(),
		};
		await updateManifest(dir, (m) => ({ ...m, workers: [...m.workers, entry] }));
		const manifestEntry = readManifest(dir)?.workers.find((w) => w.name === entry.name);

		// 2b. rpc leg only: start the REAL worker (pi --mode rpc child). The
		// worker is never prompted — get_state (the readiness round-trip) is the
		// only traffic, no LLM call. Teardown below kills it.
		let startResult: Awaited<ReturnType<Transport["startAgent"]>> | undefined;
		if (opts.withStart) {
			startResult = await host.startAgent({
				name: entry.name,
				placementRef: placement.placementRef ?? placement.paneId ?? "",
				provider: opts.provider ?? "p",
				model: opts.model ?? "m",
				thinking: opts.thinking ?? "low",
				timeoutMs: 60_000,
			});
		}

		// 3. teardown ×2 — second close resolves as an idempotent no-op, and BOTH
		// closes report the structured alreadyGone field (migration stage 1).
		let teardownCalls = 0;
		let secondTeardownOk = true;
		const firstRes = await host.teardown({ name: entry.name, placement, force: true });
		teardownCalls++;
		let secondRes: Awaited<ReturnType<Transport["teardown"]>> | undefined;
		try {
			secondRes = await host.teardown({ name: entry.name, placement, force: true });
			teardownCalls++;
		} catch (err) {
			secondTeardownOk = false;
			void err;
		}

		// 4. ref-based dedup identity (spawn.ts logic, ref form): the entry
		// THIS flow appended is identified by name + placementRef — a same-name
		// entry with a DIFFERENT ref must survive.
		const survivor = "parity-other";
		await updateManifest(dir, (m) => ({
			...m,
			workers: [
				...m.workers,
				{
					...entry,
					name: survivor,
					placement: { ...placement, placementRef: `${placement.placementRef ?? "x"}-other` },
				},
			],
		}));
		const ref = placement.placementRef ?? placement.paneId;
		const after = (readManifest(dir)?.workers ?? []).filter(
			(w) => !(w.name === entry.name && (w.placement.placementRef ?? w.placement.paneId) === ref),
		);
		const dedupSurvivor = after.find((w) => w.name === survivor)?.name;

		return {
			placement,
			manifestEntry,
			teardownCalls,
			secondTeardownOk,
			firstTeardownAlreadyGone: firstRes?.alreadyGone,
			secondTeardownAlreadyGone: secondRes?.alreadyGone,
			dedupSurvivor,
			startResult,
		};
	} finally {
		rmSync(repoDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Leg 1 — the fake (always runs)
// ---------------------------------------------------------------------------
const fakeHost = new FakeWorkerHost({ repoPath: EXCHANGE_SANDBOX });
const fakeFlow = await driveParityFlow(fakeHost, "fake", "tab");

check("P1.fake place → placementRef (opaque, fake:<n>) + backend:'fake'", /^fake:\d+$/.test(fakeFlow.placement.placementRef ?? "") && fakeFlow.placement.backend === "fake", JSON.stringify(fakeFlow.placement));
check(
	"P1.fake legacy fields ride ALONGSIDE (kind/checkoutPath/paneId/workspaceId)",
	typeof fakeFlow.placement.paneId === "string" &&
		typeof fakeFlow.placement.workspaceId === "string" &&
		typeof fakeFlow.placement.checkoutPath === "string",
);
check(
	"P2.fake manifest round-trip: ref + backend + legacy fields through the tolerant reader",
	!!fakeFlow.manifestEntry &&
		fakeFlow.manifestEntry.placement.placementRef === fakeFlow.placement.placementRef &&
		fakeFlow.manifestEntry.placement.backend === "fake" &&
		typeof fakeFlow.manifestEntry.placement.paneId === "string" &&
		typeof fakeFlow.manifestEntry.placement.checkoutPath === "string",
);
check("P3.fake teardown ×2: both calls resolve (second = idempotent no-op)", fakeFlow.secondTeardownOk && fakeFlow.teardownCalls === 2, `calls=${fakeFlow.teardownCalls}`);
check(
	"P3b.fake alreadyGone field: first close = false (closed something), second = true (already gone)",
	fakeFlow.firstTeardownAlreadyGone === false && fakeFlow.secondTeardownAlreadyGone === true,
	`first=${fakeFlow.firstTeardownAlreadyGone} second=${fakeFlow.secondTeardownAlreadyGone}`,
);
check("P4.fake ref-based dedup: only THIS flow's entry removed, same-name other-ref survives", fakeFlow.dedupSurvivor === "parity-other");

// Read-model parity: the fake's statuses leak no backend ids. The pin reads
// via `in` deliberately — AgentStatus is the seam read model and does not
// DECLARE the legacy id fields; the check must stay a runtime probe, not a
// typed property access (QA D3: TS2339 on the untyped reads).
const fakeStatus = await fakeHost.getStatus("parity-fake");
check(
	"P5.fake read model carries no backend ids (only name/status/placementRef)",
	fakeStatus === null || (!("paneId" in fakeStatus) && !("tabId" in fakeStatus) && !("workspaceId" in fakeStatus)),
	JSON.stringify(fakeStatus),
);

// ---------------------------------------------------------------------------
// Leg 2 — real herdr (skip-guarded)
// ---------------------------------------------------------------------------
if (!herdrAvailable) {
	console.log("SKIP  herdr leg — no herdr binary on PATH (skip guard, transport-contract shape)");
} else {
	// Authority model (design §4.3): worktree placement is ROOT-only — the
	// authority derives from process.cwd() vs the herdr worktree root. This
	// test itself may RUN inside a worktree (agent worktree), so the herdr leg
	// chdirs out for the placement ops and restores afterwards. The handles
	// are module-scope so the signal-handler cleanup (cleanupAll) can reach
	// them on a mid-run SIGTERM.
	parityPrevCwd = process.cwd();
	parityRootCwd = mkdtempSync(join(tmpdir(), "host-parity-cwd-"));
	process.chdir(parityRootCwd);
	try {
		const herdrHost2 = createHerdrTransport();
		const h = await driveParityFlow(herdrHost2, "herdr", "worktree");

	check("P1.herdr place → placementRef 'herdr:pane:<id>' + backend:'herdr'", /^herdr:pane:.+$/.test(h.placement.placementRef ?? "") && h.placement.backend === "herdr", JSON.stringify(h.placement));
	check(
		"P1.herdr legacy fields ride ALONGSIDE (kind/workspaceId/paneId/checkoutPath/isLinkedWorktree)",
		typeof h.placement.paneId === "string" &&
			typeof h.placement.workspaceId === "string" &&
			typeof h.placement.checkoutPath === "string",
	);
	check(
		"P2.herdr manifest round-trip: ref + backend + legacy fields through the tolerant reader",
		!!h.manifestEntry &&
			h.manifestEntry.placement.placementRef === h.placement.placementRef &&
			h.manifestEntry.placement.backend === "herdr" &&
			typeof h.manifestEntry.placement.paneId === "string" &&
			typeof h.manifestEntry.placement.workspaceId === "string",
	);
	check("P3.herdr teardown ×2: both calls resolve (second = idempotent no-op)", h.secondTeardownOk && h.teardownCalls === 2, `calls=${h.teardownCalls}`);
check(
	"P3b.herdr alreadyGone field: first close = false (closed something), second = true (already gone)",
	h.firstTeardownAlreadyGone === false && h.secondTeardownAlreadyGone === true,
	`first=${h.firstTeardownAlreadyGone} second=${h.secondTeardownAlreadyGone}`,
);
	check("P4.herdr ref-based dedup: only THIS flow's entry removed, same-name other-ref survives", h.dedupSurvivor === "parity-other");

	// Read-model parity on the live adapter: statuses carry the ref, never ids.
	const statuses = await herdrHost2.listStatuses();
	const withIds = statuses.filter((s) => (s as { paneId?: unknown }).paneId !== undefined || (s as { tabId?: unknown }).tabId !== undefined);
	check("P5.herdr listStatuses leaks no backend ids (read model = name/status/placementRef)", withIds.length === 0, JSON.stringify(withIds[0]));
	} finally {
		await cleanupAll();
	}
}

// ---------------------------------------------------------------------------
// Leg 3 — real rpc adapter (skip-guarded on `pi --version`; NO LLM calls:
// the spawned worker is never prompted — get_state is the only traffic)
// ---------------------------------------------------------------------------
if (!piAvailable) {
	console.log("SKIP  rpc leg — no pi binary on PATH (skip guard, transport-contract shape)");
} else {
	const rpcWorktreeRoot = join(tmpdir(), `host-parity-rpc-wt-${process.pid}`);
	const rpcHost = createRpcTransport({ worktreeRoot: rpcWorktreeRoot, subOrchestrator: false });
	const r = await driveParityFlow(rpcHost, "rpc", "tab", {
		withStart: true,
		provider: RPC_PROVIDER,
		model: RPC_MODEL,
		thinking: RPC_THINKING,
	});

	check("P1.rpc place → placementRef 'rpc:shared:<n>' + backend:'rpc'", /^rpc:shared:\d+$/.test(r.placement.placementRef ?? "") && r.placement.backend === "rpc", JSON.stringify(r.placement));
	check(
		"P1.rpc legacy fields ride ALONGSIDE (kind/checkoutPath/paneId/workspaceId)",
		typeof r.placement.paneId === "string" &&
			typeof r.placement.workspaceId === "string" &&
			typeof r.placement.checkoutPath === "string",
	);
	check(
		"P2.rpc manifest round-trip: ref + backend + legacy fields through the tolerant reader",
		!!r.manifestEntry &&
			r.manifestEntry.placement.placementRef === r.placement.placementRef &&
			r.manifestEntry.placement.backend === "rpc" &&
			typeof r.manifestEntry.placement.paneId === "string",
	);
	// rpc-leg-specific: the live worker's StartResult shape (name read-back,
	// session path captured via get_state — the budget gauges' input).
	check(
		"P6.rpc StartResult shape: canonical name read back, sessionPath reported ending .jsonl",
		!!r.startResult &&
			r.startResult.name === "parity-rpc" &&
			typeof r.startResult.sessionPath === "string" &&
			r.startResult.sessionPath.endsWith(".jsonl"),
		JSON.stringify(r.startResult),
	);
	check("P3.rpc teardown ×2: both calls resolve (second = idempotent no-op; the first kills the live child)", r.secondTeardownOk && r.teardownCalls === 2, `calls=${r.teardownCalls}`);
	check(
		"P3b.rpc alreadyGone field: first close = false (closed something), second = true (already gone)",
		r.firstTeardownAlreadyGone === false && r.secondTeardownAlreadyGone === true,
		`first=${r.firstTeardownAlreadyGone} second=${r.secondTeardownAlreadyGone}`,
	);
	check("P4.rpc ref-based dedup: only THIS flow's entry removed, same-name other-ref survives", r.dedupSurvivor === "parity-other");
	// Registry gone after teardown: the worker is unlisted, its placement closed.
	check("P7.rpc worker registry gone after teardown (status null, unlisted)", (await rpcHost.getStatus("parity-rpc")) === null && !(await rpcHost.listStatuses()).some((s) => s.name === "parity-rpc"));

	try { rmSync(rpcWorktreeRoot, { recursive: true, force: true }); } catch { /* advisory */ }
}

// --- self cleanup -----------------------------------------------------------

// The herdr leg's cleanupAll() already removed EXCHANGE_SANDBOX on the normal
// path; this idempotent rm covers the herdr-less path (cleanupAll only runs
// there via a signal).
rmSync(EXCHANGE_SANDBOX, { recursive: true, force: true });

// P.H — herdr state self-clean (regression pin for the run-checks `timeout`
// leak, 2026-09 incident: 32 ghost workspaces + 332 orphan dirs). Re-runs the
// sweep's list step after the run: if the herdr leg left any
// 'host-parity-repo-herdr-' workspace behind (or a previous run's leftover
// could not be cleaned), the sweep reports it via closed/failed and this
// check FAILS the test.
{
	const selfClean = await sweepStaleHerdrFixtures(["host-parity-repo-herdr-"]);
	check(
		"P.H herdr state self-clean: no 'host-parity-repo-herdr-' workspaces remain after the run",
		selfClean.closed.length === 0 && selfClean.failed.length === 0,
		JSON.stringify(selfClean),
	);
}

if (failures > 0) {
	console.error(`\n${failures} HOST-PARITY CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL HOST-PARITY CHECKS PASSED");
