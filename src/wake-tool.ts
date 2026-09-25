/**
 * pi-delegate — wake-tool: the `delegate_wake` tool (issue #10, watcher
 * scheduled wakes, stage A).
 * <p>
 * MODULE_CONTRACT: registers the `delegate_wake` orchestrator tool over the
 * SESSION's schedule store (src/watch-schedule.ts). Three actions:
 *   schedule → accept `text` plus exactly one of `delayMs` (relative) or
 *     `at` (absolute ISO-8601), returning the new id and due time;
 *   cancel   → drop a pending schedule by id so it never fires;
 *   list     → the pending schedules with their due times.
 * <p>
 * The store is SESSION-scoped (ARCHITECTURE.md Law 3): index.ts creates it in
 * the session_start handler and injects a getter here — this module never
 * holds a module-global registry. The watcher tick (the same store instance,
 * threaded through compose.ts) is the only delivery path; this tool only
 * mutates the store.
 * <p>
 * Every refusal is a structured ToolResult with the E_SCHEDULE code and a
 * recovery hint (Law 8), never a throw. A scheduled wake is the orchestrator
 * mailing itself — it does NOT belong in delegate_mailbox, whose semantics
 * are worker mail.
 * <p>
 * Dependencies: tool-result.ts (ToolResult/fail/textResult — one shared
 * spelling), ui-text.ts (renderDelegateLines/clampLines), watch-schedule.ts
 * (the store + its E_SCHEDULE refusals), host.ts (DelegateErrorCode). No
 * filesystem, no transport.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fail, textResult } from "./tool-result.ts";
import { clampLines, renderDelegateLines } from "./ui-text.ts";
import type { ScheduleStore } from "./watch-schedule.ts";

/** The session's schedule store, or undefined before session_start / after
 *  session_shutdown (index.ts owns the lifecycle). */
export type WakeStoreProvider = () => ScheduleStore | undefined;

/** One rendered list row: `w1  due 1970-01-01T00:00:05.000Z  <text>`. */
function listLine(s: { id: string; dueAtMs: number; text: string }): string {
	return `${s.id}  due ${new Date(s.dueAtMs).toISOString()}  ${s.text}`;
}

/**
 * Register `delegate_wake` on the orchestrator's extension API.
 * <p>
 * FUNCTION_CONTRACT (tool `execute`):
 * Input:
 *   - action: "schedule" | "cancel" | "list"
 *   - text: the wake message (required for schedule)
 *   - delayMs: relative delay in ms (schedule; alternative to at)
 *   - at: absolute ISO-8601 due time (schedule; alternative to delayMs)
 *   - id: the schedule id (cancel)
 * Output: ToolResult — a readable text plus details{ok, …}; refusals carry
 *   details.code === "E_SCHEDULE" (never thrown)
 * Guarantees:
 *   - the store's own validation is the single source of truth: delay floor,
 *     cap, exactly-one-of at/delay and empty-text rules are enforced there
 *   - "list" is side-effect-free
 *   - a missing store (no live session) is a structured E_SCHEDULE refusal
 * Raises: never
 */
export function registerWakeTool(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	getStore: WakeStoreProvider,
): void {
	pi.registerTool({
		name: "delegate_wake",
		label: "Delegate Wake",
		description:
			"Schedule a one-shot wake for YOUR OWN orchestrator session: the background watcher " +
			"delivers the message as a followUp turn when due. action 'schedule' takes a free-form " +
			"'text' plus exactly one of 'delayMs' (relative, ms) or 'at' (absolute ISO-8601); " +
			"'cancel' drops a pending wake by 'id'; 'list' shows the pending wakes with their due " +
			"times. Use this after delegating a long-running external process (a build, a compose " +
			"stack, an install) that leaves no worker behind to watch — end your turn instead of " +
			"sleeping. Limits: a configured minimum delay (schedule.minDelayMs) and a cap on active " +
			"wakes per session (schedule.maxActive).",
		promptSnippet: "Schedule a one-shot wake for your own session (delegate_wake)",
		promptGuidelines: [
			"Use delegate_wake instead of sleeping when you must check on an external process later.",
			"A scheduled wake is your session mailing itself — worker mail still goes through delegate_mailbox.",
			"List pending wakes with action 'list'; cancel one by id when it is no longer needed.",
		],
		parameters: Type.Object({
			action: StringEnum(["schedule", "cancel", "list"] as const, {
				description:
					"schedule = one-shot wake at/delay T with text; cancel = drop a pending wake by id; list = pending wakes with due times",
			}),
			text: Type.Optional(
				Type.String({ description: "The wake message delivered verbatim (required for 'schedule')" }),
			),
			delayMs: Type.Optional(
				Type.Number({ description: "Relative delay in ms from now (schedule; exactly one of delayMs/at)" }),
			),
			at: Type.Optional(
				Type.String({ description: "Absolute ISO-8601 due time (schedule; exactly one of delayMs/at)" }),
			),
			id: Type.Optional(Type.String({ description: "Schedule id to cancel (e.g. 'w1')" })),
		}),
		renderCall(args, theme) {
			const action = typeof args?.action === "string" ? args.action : "?";
			const detail =
				typeof args?.id === "string"
					? args.id
					: typeof args?.delayMs === "number"
						? `+${args.delayMs}ms`
						: typeof args?.at === "string"
							? args.at
							: "";
			const head = theme.fg("toolTitle", theme.bold("delegate_wake "));
			return {
				render: (width?: number) => clampLines([`${head} ${theme.fg("muted", action)} ${theme.fg("accent", detail)}`], width),
				invalidate: () => {},
			};
		},
		renderResult(result, _options, theme) {
			const resultText = (result?.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const lines = renderDelegateLines("delegate_wake", resultText, theme);
			return { render: (width?: number) => clampLines(lines, width), invalidate: () => {} };
		},
		async execute(_toolCallId, params) {
			const store = getStore();
			if (store === undefined) {
				return fail(
					"E_SCHEDULE",
					"E_SCHEDULE — no active session schedule store; the watcher is not mounted for this session.",
					{ action: params.action },
				);
			}

			if (params.action === "list") {
				const rows = store.list();
				if (rows.length === 0) {
					return textResult("No pending scheduled wakes for this session.", { action: "list", schedules: [] });
				}
				return textResult(
					[`Pending scheduled wakes (${rows.length}):`, ...rows.map(listLine)].join("\n"),
					{ action: "list", schedules: rows },
				);
			}

			if (params.action === "cancel") {
				if (typeof params.id !== "string" || params.id.trim().length === 0) {
					return fail(
						"E_SCHEDULE",
						"E_SCHEDULE — cancel requires the schedule 'id' (e.g. \"w1\"); run action 'list' to see pending ids.",
						{ action: "cancel" },
					);
				}
				const res = store.cancel(params.id.trim());
				if (!res.ok) return fail(res.code, res.error, { action: "cancel", id: params.id, hint: res.hint });
				return textResult(
					`Cancelled scheduled wake ${res.schedule.id} (was due ${new Date(res.schedule.dueAtMs).toISOString()}) — it will never fire.`,
					{ action: "cancel", id: res.schedule.id, schedule: res.schedule },
				);
			}

			// schedule: the store validates text + exactly-one-of + floor + cap.
			let atMs: number | undefined;
			if (typeof params.at === "string" && params.at.trim().length > 0) {
				const parsed = Date.parse(params.at);
				if (!Number.isFinite(parsed)) {
					return fail(
						"E_SCHEDULE",
						`E_SCHEDULE — 'at' is not a parseable ISO-8601 timestamp: ${JSON.stringify(params.at)}.`,
						{ action: "schedule", at: params.at, hint: "Pass e.g. \"2026-09-25T12:00:00Z\", or use delayMs instead." },
					);
				}
				atMs = parsed;
			}
			const res = store.schedule({
				text: params.text ?? "",
				...(atMs !== undefined ? { atMs } : {}),
				...(typeof params.delayMs === "number" ? { delayMs: params.delayMs } : {}),
			});
			if (!res.ok) {
				return fail(res.code, res.error, {
					action: "schedule",
					...(atMs !== undefined ? { atMs } : {}),
					...(typeof params.delayMs === "number" ? { delayMs: params.delayMs } : {}),
					hint: res.hint,
				});
			}
			const s = res.schedule;
			return textResult(
				`Scheduled wake ${s.id} for ${new Date(s.dueAtMs).toISOString()} (run ${s.run}): "${s.text}". ` +
					`It fires once as a followUp turn; cancel it with action 'cancel', id '${s.id}'.`,
				{ action: "schedule", schedule: s },
			);
		},
	});
}
