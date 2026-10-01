/**
 * ui-log-check — the ONE terminal-writer choke point (src/ui-log.ts).
 *
 * Run with: bun test/ui-log-check.ts   (from repo root)
 *
 * Background (the four-times-reported "JSON logs in the TUI" bug class):
 * inside the pi TUI the process's stderr IS the terminal the TUI renders
 * on — any raw stderr write from extension code corrupts the session UI.
 * Every diagnostic therefore routes through uiLog(): a TUI session installs
 * a sink (the composition root, session_start, ctx.hasUI) and lines surface
 * as notifications; a headless session installs nothing and uiLog falls
 * back to one stderr line — the exact bytes the pre-router call sites wrote
 * (the contract the swarm-server lifecycle checks parse).
 *
 * Checks:
 *   U1  no sink installed → one stderr line, exact bytes (trailing newline)
 *   U2  the installed TUI sink receives the line verbatim; stderr silent
 *   U3  installUiLogSink REPLACES (last install wins — one TUI per process)
 *   U4  a throwing sink degrades to the stderr fallback (uiLog is total)
 *   U5  makeTuiNotifySink: JSON line → `[pi-delegate] <event> — k=v …` with
 *       the notify level from `level`; a non-JSON line surfaces verbatim
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog. Exit 0 only
 * if all checks pass.
 */

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("ui-log-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 10_000);
watchdog.unref();

import { installUiLogSink, makeTuiNotifySink, uiLog } from "../src/ui-log.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// Stderr spy — the fallback channel every leg below is measured against.
const captured: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
	captured.push(s);
	return true;
};

// U1 — fallback: no sink installed → one stderr line, exact bytes.
uiLog("headless line");
check(
	"U1 no sink installed → ONE stderr line, exact bytes (trailing newline added here, never by a call site)",
	captured.length === 1 && captured[0] === "headless line\n",
	JSON.stringify(captured),
);

// U2 — the installed TUI sink receives the line verbatim; stderr stays silent.
const seen: string[] = [];
installUiLogSink((line) => {
	seen.push(line);
});
uiLog("tui line");
check(
	"U2 the installed TUI sink receives the line verbatim and stderr stays silent",
	seen.length === 1 && seen[0] === "tui line" && captured.length === 1,
	JSON.stringify({ seen, captured }),
);

// U3 — replacement semantics: last install wins.
const second: string[] = [];
installUiLogSink((line) => {
	second.push(line);
});
uiLog("again");
check(
	"U3 installUiLogSink REPLACES (last install wins — the new session's TUI, never the old one)",
	second.length === 1 && second[0] === "again" && seen.length === 1,
	JSON.stringify({ second, seen }),
);

// U4 — a throwing sink degrades to the stderr fallback (uiLog is total).
let threw = false;
installUiLogSink(() => {
	throw new Error("broken TUI");
});
try {
	uiLog("through broken");
} catch (err) {
	threw = true;
}
check(
	"U4 a throwing sink degrades to the stderr fallback — uiLog never propagates",
	!threw && captured.length === 2 && captured[1] === "through broken\n",
	JSON.stringify({ threw, captured }),
);

// U5 — makeTuiNotifySink: the human rendering the composition root installs.
const notes: Array<{ message: string; type?: string }> = [];
const sink = makeTuiNotifySink((message, type) => {
	notes.push({ message, type });
});
sink('{"level":"warn","component":"swarm-server","event":"operator-token","token":"abc"}');
check(
	"U5.1 a JSON line renders `[pi-delegate] <event> — k=v …` with level=warning from the warn level",
	notes[0]?.message === "[pi-delegate] operator-token — token=abc" && notes[0]?.type === "warning",
	JSON.stringify(notes),
);
sink('{"level":"info","component":"swarm-server","event":"dashboard","url":"http://127.0.0.1:8117/","link":"http://127.0.0.1:8117/#t=x"}');
check(
	"U5.2 the dashboard line renders the copyable link with level=info",
	notes[1]?.message === "[pi-delegate] dashboard — url=http://127.0.0.1:8117/ link=http://127.0.0.1:8117/#t=x" &&
		notes[1]?.type === "info",
	JSON.stringify(notes),
);
sink("[pi-delegate watch] plain text line");
check(
	"U5.3 a non-JSON line surfaces verbatim with level=info (it already carries its prefix)",
	notes[2]?.message === "[pi-delegate watch] plain text line" && notes[2]?.type === "info",
	JSON.stringify(notes),
);

realWrite(`\n${failures === 0 ? "ALL UI-LOG CHECKS PASSED" : `${failures} UI-LOG CHECK(S) FAILED`}\n`);
if (failures > 0) process.exit(1);
