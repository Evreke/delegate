/**
 * pi-delegate — src/ui-log.ts — the ONE terminal-writer choke point.
 *
 * MODULE_CONTRACT — every diagnostic line this extension wants to put in
 * front of a human routes through `uiLog()`. Inside the pi TUI the process's
 * stderr IS the terminal the TUI renders on: any raw stderr/console write
 * from extension code corrupts the session UI (the recurring "JSON logs in
 * the TUI" bug class — fixed four times at the symptom level before this
 * router existed). The composition root therefore installs a TUI sink once
 * per session_start when `ctx.hasUI` — diagnostics surface as TUI
 * notifications through `ctx.ui.notify`. Everywhere else (headless workers,
 * RPC sessions, the spawned CLI, tests) NO sink is installed and `uiLog`
 * falls back to one stderr line — the headless diagnostic channel, the same
 * bytes the pre-router call sites wrote.
 *
 * The static pin in test/static-check.ts bans direct stderr/console writes
 * in src/** outside this module — this file is the only door.
 *
 * Dependencies: none above node (a leaf). No pi import (the notify shape is
 * structural). No herdr import (Law 4); no store (Law 13).
 *
 * Critical invariants:
 *   - `uiLog` is TOTAL: a throwing sink degrades to stderr; a throwing
 *     stderr is swallowed — logging never propagates;
 *   - `installUiLogSink` REPLACES (last install wins — one TUI per process;
 *     session_start reinstalls on new/resume/fork);
 *   - the fallback writes ONE line per call (the trailing newline is added
 *     here, never by a call site);
 *   - no session-lifetime cleanup: the sink is process-wide diagnostic
 *     state (a diagnostic, not ownership state — Law 3 does not apply).
 */

/** Structural shape of pi's `ExtensionUIContext.notify` (no pi import — a
 *  leaf must stay importable from the spawned CLI and every check). */
export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

/** A sink receives ONE diagnostic line (no trailing newline). */
export type UiLogSink = (line: string) => void;

let sink: UiLogSink | undefined;

/** Install (replace) the session's UI sink. The composition root calls this
 *  once per session_start when a TUI owns the terminal; last install wins. */
export function installUiLogSink(next: UiLogSink): void {
	sink = next;
}

/** The ONE diagnostic channel. Routes to the installed TUI sink; falls back
 *  to one stderr line headless. Total — never throws. */
export function uiLog(line: string): void {
	if (sink) {
		try {
			sink(line);
			return;
		} catch {
			// a broken TUI sink degrades to the stderr fallback below
		}
	}
	try {
		process.stderr.write(`${line}\n`);
	} catch {
		// stderr itself is advisory
	}
}

/** Build the TUI sink: one notification per line. A structured JSON line
 *  renders human-readable (`[pi-delegate] <event> — k=v …`) with the notify
 *  level taken from its `level` field; a non-JSON line (the watcher/config
 *  text lines) surfaces verbatim — it already carries its prefix. */
export function makeTuiNotifySink(notify: NotifyFn): UiLogSink {
	return (line) => {
		const raw = line.trim();
		let message = raw;
		let type: "info" | "warning" | "error" = "info";
		try {
			const o = JSON.parse(raw) as Record<string, unknown> | null;
			if (o !== null && typeof o === "object") {
				const fields = Object.entries(o)
					.filter(([k]) => k !== "level" && k !== "component" && k !== "event")
					.map(([k, v]) => `${k}=${String(v)}`)
					.join(" ");
				message = `[pi-delegate] ${String(o.event ?? "log")}${fields ? ` — ${fields}` : ""}`;
				if (o.level === "warn") type = "warning";
				else if (o.level === "error") type = "error";
			}
		} catch {
			// not JSON — surface verbatim
		}
		notify(message, type);
	};
}
