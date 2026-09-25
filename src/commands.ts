/**
 * pi-delegate — commands: the /delegate-teardown command —
 * extracted verbatim from observe.ts (Wave 3, audit Law 5: modules are
 * responsibilities; the code's own history: verbatim move from index.ts in
 * W6 — ex src/commands.ts, absorbed there in W5).
 * <p>
 * MODULE_CONTRACT: registers the user-invoked teardown command (exact name,
 * frozen surface). /delegate-teardown confirms, then tears workers down
 * SEQUENTIALLY (one mutating op at a time is also enforced inside the
 * transport), pre-logging every planned op to <exchange dir>/teardown.log
 * before it runs. Never runs on its own — user-invoked command only.
 * Dependencies: worker-view.ts (the shared read-model), expaths.ts +
 * exchange.ts (the shared teardown-audit trail helpers), manifest-store.ts
 * (issue #15 — the partial-report manifest stamp), host.ts (the
 * Transport seam + DelegateError), watcher.ts (errText — one spelling until
 * step 4 moves it to tool-result.ts). The teardown state this command drives
 * lives in watcher.ts (mount registry). The /delegate-fleet overlay command
 * and the ambient widget were removed (operator decision — TUI surfaces are
 * out of scope); disposeFleetUI calls went with them.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { partialReportPathFor, TEARDOWN_LOG_NAME } from "./expaths.ts";
import { stampPartialReportPath } from "./manifest-store.ts";
import { teardownLogLine } from "./exchange.ts";
import { buildWorkerView } from "./worker-view.ts";
// Wave 3 decomposition (step 4): errText lives in src/tool-result.ts — the
// commands copy is deleted (audit finding 7, one definition per helper).
import { asDelegateError, errText } from "./tool-result.ts";
import { type DelegateError, type Transport } from "./host.ts";

// ===========================================================================
// SECTION 3/3 — the /delegate-teardown command
// (verbatim move from index.ts in W6 — ex src/commands.ts, absorbed there in
// W5; this module owns the watcher/teardown state these commands drive. The
// commands.ts errText copy is NOT re-duplicated: observe already has an
// identical errText (watcher loop), so the moved code uses that one.)
// ===========================================================================

/**
 * Interactive teardown: lists workers, confirms, then tears each down
 * SEQUENTIALLY (one mutating op at a time is also enforced inside the
 * transport). Every planned op is pre-logged to <exchange dir>/teardown.log
 * before it runs. Never runs on its own — user-invoked command only.
 */

async function logTo(dir: string, line: string): Promise<void> {
	try {
		await appendFile(join(dir, TEARDOWN_LOG_NAME), teardownLogLine(line));
	} catch {
		// best-effort audit log — never block teardown on logging failure
	}
}

export function registerCommands(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerCommand("delegate-teardown", {
		description: "Confirm + sequentially tear down all delegate workers (pre-logged, never automatic)",
		async handler(_args, ctx) {
			// Headless guard (pi docs Mode Behavior): the confirm/notify dialogs
			// below need a UI, and a headless session must NOT auto-confirm a
			// destructive teardown — refuse with a text-only note instead (console
			// is the headless channel, same as the watcher sink).
			if (!ctx.hasUI || !ctx.ui) {
				console.error(
					"[pi-delegate] /delegate-teardown needs a UI session (it confirms before tearing down) — run it in the interactive session that owns the workers.",
				);
				return;
			}
			const views = await buildWorkerView(transport);
			if (views.length === 0) {
				ctx.ui.notify("No delegate workers to tear down.", "info");
				return;
			}

			// Manifest history vs actionable workers (UX fix, 2026-09-10): manifest
			// worker entries are NEVER deleted, so the scan returns every worker
			// ever spawned — the wall of “✗ tab_not_found” for long-closed workers
			// looked like a catastrophe while meaning “nothing to close”. Retired
			// entries are HISTORY: skipped with a count, never attempted.
			const retiredViews = views.filter((v) => v.retired === true);
			const actionable = views.filter((v) => v.retired !== true);
			if (actionable.length === 0) {
				ctx.ui.notify(
					`Nothing to tear down — all ${views.length} manifest entries are retired history.`,
					"info",
				);
				return;
			}

			const list = actionable
				.map((v) => `${v.name} (${v.kind}${v.branch ? `, branch ${v.branch}` : ""})`)
				.join(", ");
			const retiredNote = retiredViews.length > 0 ? ` (plus ${retiredViews.length} retired history entries skipped)` : "";
			const confirmed = await ctx.ui.confirm(
				"Tear down delegate workers?",
				`${actionable.length} worker(s): ${list}${retiredNote}`,
			);
			if (!confirmed) {
				ctx.ui.notify("Teardown cancelled — workers left running.", "info");
				return;
			}

			const outcomes: string[] = [];
			for (const v of actionable) {
				// Pre-log the planned mutating op BEFORE executing it (audit trail).
				await logTo(
					v.dir,
					`plan: teardown worker=${v.name} kind=${v.kind} workspace=${v.placement.workspaceId ?? "-"} pane=${v.placement.paneId ?? "-"}`,
				);
				try {
					// EXTERNAL_DEPENDENCY: herdr teardown via the injected transport
					// (mutating pane/workspace IPC — the only mutating call here).
					// Migration stage 1 (extensibility-defect 1): the "already gone"
					// case is the structured alreadyGone field on the RESULT (before
					// this: a thrown error matched by the isAlreadyGone message regex).
					// Issue #15: give the still-live worker one bounded chance to hand
					// off a partial report before the kill; the destination is the
					// caller's (the adapter knows nothing about the exchange layout).
					const partialReportPath = partialReportPathFor(v.dir, v.name);
					const res = await transport.teardown({
						name: v.name,
						placement: v.placement,
						force: true,
						partialReportPath,
					});
					if (res?.alreadyGone) {
						await logTo(v.dir, `done: teardown worker=${v.name} no-op (already gone)`);
						outcomes.push(`✓ ${v.name} (${v.kind}) — already closed, no-op`);
						continue;
					}
					await logTo(v.dir, `done: teardown worker=${v.name} ok`);
					// Issue #15: the captured partial report is referenced from the
					// worker's manifest entry (best-effort — a stamp failure is
					// advisory and never fails the teardown).
					if (res?.partialReportPath) {
						let stamped = false;
						try {
							await stampPartialReportPath(v.dir, v.name, v.placement.placementRef, res.partialReportPath);
							stamped = true;
							await logTo(v.dir, `done: partial report worker=${v.name} → ${res.partialReportPath}`);
						} catch (stampErr) {
							await logTo(v.dir, `warn: partial report stamp worker=${v.name} failed: ${errText(stampErr)}`);
						}
						outcomes.push(
							stamped
								? `✓ ${v.name} (${v.kind}) torn down — partial report: ${res.partialReportPath}`
								: `✓ ${v.name} (${v.kind}) torn down (partial report captured, manifest stamp failed)`,
						);
					} else {
						outcomes.push(`✓ ${v.name} (${v.kind}) torn down`);
					}
				} catch (err) {
					// A throw is now ALWAYS a genuine failure (not-found shapes resolve
					// as alreadyGone inside the adapters) — parity with the retire pass.
					await logTo(v.dir, `error: teardown worker=${v.name} failed: ${errText(err)}`);
					const de = asDelegateError(err);
					const advice = de?.guidance
						? ` — ${de.guidance}`
						// No structured guidance: fall back to the generic recovery recipe.
						// Migration stage 3 (audit step 9): no herdr token in the hint —
						// the wt-directory refusal itself is the structured E_PLACE signal
						// raised at the segment boundary (expaths.isDirUnder, Windows fix);
						// backend-specific CLI tokens never reach the model-facing text.
						: " — reconcile via /delegate-teardown; for a worktree-link failure, recover via the host workspace listing/close.";
					outcomes.push(`✗ ${v.name}: ${errText(err)}${advice}`);
				}
			}

			ctx.ui.notify(`Teardown finished:\n${outcomes.join("\n")}`, "info");
		},
	});
}
