/**
 * swarm-announce-check — the swarm-server announcement seam (the
 * startup-noise round): the mount's startup events (dashboard link,
 * operator token, advisories) reach the operator through ONE sink. In a
 * UI session that sink is pi's `ctx.ui.notify` — NOTHING hits
 * process.stderr, whose raw bytes were landing as JSON garbage under the
 * [Extensions] header (operator finding, 2026-09). In headless mode (no
 * UI) the sink is the historical structured stderr JSON line, unchanged
 * shape, so machines and the existing checks keep parsing it.
 *
 * Run with: bun test/swarm-announce-check.ts   (from repo root)
 *
 * Covers (sink level):
 *   A1  UI mode: `operator-token` → NO row at all (the token rides the
 *       dashboard link's #t= fragment), and NO stderr byte.
 *   A2  UI mode: `dashboard` → exactly ONE info row naming the link; a
 *       secondary role gets the "served by the primary session" suffix.
 *   A3  UI mode: `secondary-mount` → NO row (normal D1 operation; the role
 *       hint rides the dashboard row).
 *   A4  UI mode: any other warn event → ONE warning row, message carries
 *       the event name and its fields.
 *   A5  UI mode: across A1–A4 process.stderr receives ZERO bytes.
 *   A6  headless mode (hasUI:false): every event → the exact historical
 *       stderr JSON shape (level/component:"swarm-server"/event/fields),
 *       notify NEVER called.
 * Mount level:
 *   M1  mountSwarmServer with a capturing sink → the dashboard + operator
 *       token events arrive on the sink with the role field, and stderr
 *       receives ZERO bytes (the TUI contract at the composition root).
 *   M2  mountSwarmServer with deps.announce absent → stderr JSON as before
 *       (pinned by swarm-server-fault/mutation checks; here: the dashboard
 *       line still lands on stderr).
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog. Exit 0 only
 * if all checks pass.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Top-level watchdog (a hanging check is a bug in the check).
const watchdog = setTimeout(() => {
	console.error("swarm-announce-check WATCHDOG TIMEOUT");
	process.exit(1);
}, 25_000);
watchdog.unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

type NotifySpy = { rows: Array<{ message: string; type: string }>; notify(message: string, type?: "info" | "warning" | "error"): void };
function notifySpy(): NotifySpy {
	const rows: Array<{ message: string; type: string }> = [];
	return { rows, notify(message, type = "info") { rows.push({ message, type }); } };
}

/** Capture every stderr write made by `fn` (the fault-check pattern). */
async function withStderr<T>(fn: () => Promise<T> | T): Promise<{ result: T; bytes: string }> {
	let bytes = "";
	const realWrite = process.stderr.write.bind(process.stderr);
	(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
		bytes += s;
		return true;
	};
	try {
		return { result: await fn(), bytes };
	} finally {
		(process.stderr as unknown as { write: (s: string) => boolean }).write = realWrite;
	}
}

const asJson = (line: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
};

async function main(): Promise<void> {
	const { createAnnounceSink, stderrAnnounceSink } = await import("../src/swarm-server/announce.ts");

	// --- A1–A5: UI mode -----------------------------------------------------
	{
		const ui = notifySpy();
		const sink = createAnnounceSink(ui, true);
		const LINK = "http://127.0.0.1:7331/#t=aa55";
		const { bytes } = await withStderr(() => {
			sink({ level: "info", event: "operator-token", token: "aa55" });
			sink({ level: "info", event: "dashboard", url: "http://127.0.0.1:7331/", link: LINK, role: "primary" });
			sink({ level: "warn", event: "secondary-mount", port: 7331, reason: "primary holds the port" });
			sink({ level: "warn", event: "bind-failed", port: 1, code: "EACCES" });
		});
		const dashRows = ui.rows.filter((r) => r.message.includes("Fleet dashboard"));
		check("A1.1 operator-token → NO notify row (token rides the link)", !ui.rows.some((r) => r.message.includes("aa55") && !r.message.includes("Fleet dashboard")), JSON.stringify(ui.rows));
		check("A2.1 dashboard → exactly ONE info row carrying the link", dashRows.length === 1 && dashRows[0].type === "info" && dashRows[0].message.includes(LINK), JSON.stringify(ui.rows));
		check("A2.2 primary role → no serving suffix", dashRows[0]?.message.includes("served by the primary") === false, dashRows[0]?.message);
		check("A3.1 secondary-mount → NO row in UI mode", !ui.rows.some((r) => r.message.includes("secondary-mount")), JSON.stringify(ui.rows));
		const warnRows = ui.rows.filter((r) => r.type === "warning");
		check("A4.1 other warn events → ONE warning row naming event + fields", warnRows.length === 1 && warnRows[0].message.includes("bind-failed") && warnRows[0].message.includes("EACCES"), JSON.stringify(warnRows));
		check("A5.1 UI mode wrote ZERO bytes to stderr", bytes === "", JSON.stringify(bytes.slice(0, 120)));
	}

	{
		// A2b: a SECONDARY's row says who serves it.
		const ui = notifySpy();
		const sink = createAnnounceSink(ui, true);
		await withStderr(() => sink({ level: "info", event: "dashboard", url: "http://127.0.0.1:7331/", link: "http://127.0.0.1:7331/#t=bb66", role: "secondary" }));
		check("A2.3 secondary role → the row names the primary session as the server", ui.rows.length === 1 && ui.rows[0].message.includes("served by the primary session"), JSON.stringify(ui.rows));
	}

	// --- A6: headless mode → historical stderr JSON, notify untouched -------
	{
		const ui = notifySpy();
		const sink = createAnnounceSink(ui, false);
		const { bytes } = await withStderr(() => {
			sink({ level: "info", event: "operator-token", token: "cc77" });
			sink({ level: "info", event: "dashboard", url: "http://127.0.0.1:7331/", link: "http://127.0.0.1:7331/#t=cc77", role: "primary" });
			sink({ level: "warn", event: "secondary-mount", port: 7331 });
		});
		const lines = bytes.split("\n").filter(Boolean).map(asJson);
		const token = lines.find((j) => j?.event === "operator-token");
		const dash = lines.find((j) => j?.event === "dashboard");
		const sec = lines.find((j) => j?.event === "secondary-mount");
		check("A6.1 headless: every event is a structured stderr JSON line", token != null && dash != null && sec != null && lines.length === 3, bytes.slice(0, 200));
		check("A6.2 headless: the historical shape is preserved (component swarm-server, level, fields)", token?.component === "swarm-server" && token?.level === "info" && token?.token === "cc77" && sec?.level === "warn" && sec?.port === 7331, bytes.slice(0, 200));
		check("A6.3 headless: notify is NEVER called", ui.rows.length === 0, JSON.stringify(ui.rows));
	}

	// --- stderrAnnounceSink is the exact legacy emitter ---------------------
	{
		const { bytes } = await withStderr(() => stderrAnnounceSink({ level: "info", event: "dashboard", url: "http://x/", link: "http://x/#t=1" }));
		const j = asJson(bytes.trim());
		check("A6.4 stderrAnnounceSink: one JSON line, component swarm-server, fields spread", j?.component === "swarm-server" && j?.event === "dashboard" && j?.url === "http://x/" && bytes.endsWith("\n"), bytes);
	}

	// --- M1: mount routes through the sink; stderr stays clean --------------
	{
		const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-announce-mount-"));
		process.env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent");
		const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
		const transport = { backendName: () => "herdr", listStatuses: async () => [] };
		const events: Array<Record<string, unknown>> = [];
		const env = { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" };
		const { bytes } = await withStderr(async () => {
			const h = await mountSwarmServer({ sessionFile: "/sessions/announce-m1.jsonl", transport, env, announce: (e) => events.push({ ...e }) });
			h?.stop();
		});
		const dash = events.find((e) => e.event === "dashboard");
		const tok = events.find((e) => e.event === "operator-token");
		check("M1.1 mount announces operator-token + dashboard on the sink", tok != null && dash != null, JSON.stringify(events).slice(0, 200));
		check("M1.2 the dashboard event carries the ACTUAL port and role:primary", dash != null && String(dash.url).startsWith("http://127.0.0.1:") && dash.role === "primary" && String(dash.link).includes("#t="), JSON.stringify(dash));
		check("M1.3 with a sink provided, mount wrote ZERO stderr bytes", bytes === "", bytes.slice(0, 200));
	}

	// --- M2: mount without a sink → historical stderr line ------------------
	{
		const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-announce-legacy-"));
		process.env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent");
		const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
		const transport = { backendName: () => "herdr", listStatuses: async () => [] };
		const env = { ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" };
		const { bytes } = await withStderr(async () => {
			const h = await mountSwarmServer({ sessionFile: "/sessions/announce-m2.jsonl", transport, env });
			h?.stop();
		});
		const dash = bytes.split("\n").filter(Boolean).map(asJson).find((j) => j?.event === "dashboard");
		check("M2.1 no sink → the dashboard line lands on stderr as before", dash != null && dash.component === "swarm-server" && String(dash.link).includes("#t="), bytes.slice(0, 200));
	}

	if (failures > 0) {
		console.error(`swarm-announce-check: ${failures} FAILURE(S)`);
		process.exit(1);
	}
	console.log("swarm-announce-check: ALL PASS");
}

main().catch((err) => {
	console.error("swarm-announce-check CRASHED:", err);
	process.exit(1);
});
