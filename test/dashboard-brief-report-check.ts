/**
 * dashboard-brief-report-check — issue #87 acceptance (ARCHITECTURE §4.2,
 * Law 7/Law 8): the dashboard's brief/report tabs serve the REAL exchange
 * files instead of a dead-end placeholder.
 *
 * The surface under test:
 *   - the read model carries the task `dir` (state.js) onto task nodes, worker
 *     rows and worker session nodes — the detail panel's path to the files;
 *   - two additive read-only GET routes (server.ts):
 *       GET /api/workers/:id/brief   → brief-<name>.md text
 *       GET /api/workers/:id/report  → report-<name>.json text
 *     owner-gated FAIL-CLOSED with the console route's ownership verdict, an
 *     honest `absent:true` (200) for a missing file, and a traversal-proof
 *     filename assembly;
 *   - the detail panel (detail.js) fetches + renders the text for a resolvable
 *     worker (id + name + dir), and keeps the honest states otherwise.
 *
 * Run with: bun test/dashboard-brief-report-check.ts   (from repo root)
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every wait
 * has its own deadline; the server is stopped on every path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureConsoleGraph, fixtureConsoleWorkerId, fixtureForeignWorkerId } from "./swarm-http-goldens.ts";

const watchdog = setTimeout(() => {
	console.error("dashboard-brief-report-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "dashboard-briefreport-"));
const AGENT = join(SANDBOX, "agent");
const EX = join(SANDBOX, "ex");
const DB = join(SANDBOX, "journal", "events.db");
const TASK_DIR = join(EX, "alpha");
mkdirSync(AGENT, { recursive: true });
mkdirSync(TASK_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_DELEGATE_EXCHANGE_ROOT = EX;
process.env.SWARM_JOURNAL_DB = DB;

const SELF = "/sessions/brief-report-self.jsonl";
const BRIEF_TEXT = "# brief w1\n\nDo the thing.\nOUTPUT: report-fix.json\n";
const REPORT_TEXT = '{"worker":"w1","status":"pass","summary":"ok"}\n';

/** The mount env (files storage, OS-assigned port). */
const env = (): NodeJS.ProcessEnv => ({ ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0", SWARM_STORAGE: "files" });

type Handle = { stop(): void; port: number };
type GetResult = { status: number; json: Record<string, unknown> };

async function get(port: number, path: string): Promise<GetResult> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) });
	const text = await res.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		/* the assertion below reports the raw body via detail */
	}
	return { status: res.status, json: Object.keys(json).length > 0 ? json : { __raw: text } };
}

/** The refusal code of an envelope (undefined for a success). */
function errorCode(json: Record<string, unknown>): string | undefined {
	const err = json.error as { code?: unknown } | undefined;
	return err && typeof err.code === "string" ? err.code : undefined;
}

// ---------------------------------------------------------------------------
// The headless DOM seam (detail.js's document contract)
// ---------------------------------------------------------------------------

class FakeEl {
	attributes: Record<string, string> = {};
	childNodes: any[] = [];
	text = "";
	constructor(readonly tagName: string) {}
	setAttribute(k: string, v: string) {
		this.attributes[k] = String(v);
	}
	getAttribute(k: string) {
		return this.attributes[k] ?? null;
	}
	removeAttribute(k: string) {
		delete this.attributes[k];
	}
	appendChild(c: any) {
		this.childNodes.push(c);
		return c;
	}
	removeChild(c: any) {
		const i = this.childNodes.indexOf(c);
		if (i >= 0) this.childNodes.splice(i, 1);
		return c;
	}
	get firstChild() {
		return this.childNodes[0] ?? null;
	}
	set textContent(v: string) {
		this.text = v;
		this.childNodes = [];
	}
	get textContent(): string {
		return this.text + this.childNodes.map((c) => c.textContent ?? "").join("");
	}
}

function fakeDoc(): any {
	return {
		createElement: (t: string) => new FakeEl(t),
		createTextNode: (t: string) => ({ textContent: t, childNodes: [] }),
	};
}

function walk(n: any, out: any[] = []): any[] {
	out.push(n);
	for (const c of n.childNodes ?? []) walk(c, out);
	return out;
}

function byAttr(root: any, attr: string): any[] {
	return walk(root).filter((e) => e instanceof FakeEl && e.attributes[attr] !== undefined);
}

async function main(): Promise<void> {
	const stateMod = (await import(new URL("../src/swarm-server/public/state.js", import.meta.url).href)) as any;
	const detailMod = (await import(new URL("../src/swarm-server/public/detail.js", import.meta.url).href)) as any;
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");

	const workerId = fixtureConsoleWorkerId();

	// -----------------------------------------------------------------------
	// R — the read model carries `dir` (state.js)
	// -----------------------------------------------------------------------
	const graph = fixtureConsoleGraph(SELF);
	const alphaTask = graph.nodes.find((n: any) => n.kind === "task" && n.id === "alpha") as any;
	alphaTask.dir = TASK_DIR;
	writeFileSync(join(TASK_DIR, "brief-w1.md"), BRIEF_TEXT, "utf8");
	{
		const model = stateMod.buildDashboardState({ graph, events: [], ownSessionPath: SELF });
		const task = model.byId.get("alpha");
		const worker = task.workers.find((w: any) => w.name === "w1");
		const session = model.byId.get(workerId);
		check("R1 the task node carries its exchange dir", task.dir === TASK_DIR, JSON.stringify(task.dir));
		check("R2 the worker row carries its task's exchange dir", worker.dir === TASK_DIR, JSON.stringify(worker.dir));
		check("R3 a worker session node carries its task's exchange dir (the detail subject path)", session && session.dir === TASK_DIR && session.task === "alpha", JSON.stringify(session && { dir: session.dir, task: session.task }));
		const foreign = model.byId.get("beta");
		check("R4 each task keeps its OWN dir (no cross-contamination)", foreign.dir === "/checkouts/beta", JSON.stringify(foreign.dir));
	}

	// -----------------------------------------------------------------------
	// S — the two routes over a mounted server
	// -----------------------------------------------------------------------
	const h = (await mountSwarmServer({ sessionFile: SELF, graph, env: env() })) as Handle | null;
	check("S0 the brief/report mount returns a handle", h !== null);
	if (!h) throw new Error("cannot continue without a mounted server");
	try {
		const brief = await get(h.port, `/api/workers/${workerId}/brief`);
		check(
			"S1 GET /api/workers/:id/brief → 200 with the real file text",
			brief.status === 200 && brief.json.ok === true && brief.json.schemaVersion === 1 && brief.json.kind === "brief" && brief.json.worker === "w1" && brief.json.task === "alpha" && brief.json.absent === false && brief.json.text === BRIEF_TEXT,
			JSON.stringify(brief),
		);

		const absent = await get(h.port, `/api/workers/${workerId}/report`);
		check(
			"S2 a missing file → 200 {ok:true, absent:true, text:null} (honest absent, never a fabricated stream)",
			absent.status === 200 && absent.json.ok === true && absent.json.kind === "report" && absent.json.absent === true && absent.json.text === null,
			JSON.stringify(absent),
		);

		writeFileSync(join(TASK_DIR, "report-w1.json"), REPORT_TEXT, "utf8");
		const report = await get(h.port, `/api/workers/${workerId}/report`);
		check(
			"S3 GET /api/workers/:id/report → 200 with the real report text once it lands",
			report.status === 200 && report.json.ok === true && report.json.absent === false && report.json.text === REPORT_TEXT,
			JSON.stringify(report),
		);

		const foreign = await get(h.port, `/api/workers/${fixtureForeignWorkerId()}/brief`);
		check(
			"S4 a foreign worker id → 404 E_EXCHANGE_FILE_REFUSED (fail-closed, no existence oracle)",
			foreign.status === 404 && errorCode(foreign.json) === "E_EXCHANGE_FILE_REFUSED",
			JSON.stringify(foreign),
		);

		const unknown = await get(h.port, "/api/workers/deadbeef/brief");
		check(
			"S5 an unknown id → 404 E_EXCHANGE_FILE_REFUSED (indistinguishable from the foreign refusal)",
			unknown.status === 404 && errorCode(unknown.json) === "E_EXCHANGE_FILE_REFUSED",
			JSON.stringify(unknown),
		);

		const post = await fetch(`http://127.0.0.1:${h.port}/api/workers/${workerId}/brief`, { method: "POST", signal: AbortSignal.timeout(5_000) });
		check("S6 the brief route is read-only (POST → 405)", post.status === 405, String(post.status));
	} finally {
		h.stop();
	}

	// -----------------------------------------------------------------------
	// T — path traversal is refused (name `../evil`, NUL/relative dirs)
	// -----------------------------------------------------------------------
	const SECRET = join(SANDBOX, "secret.md");
	writeFileSync(SECRET, "TOP SECRET", "utf8");
	const travSelf = "/sessions/brief-traversal.jsonl";
	const travGraph = fixtureConsoleGraph(travSelf);
	const travTask = travGraph.nodes.find((n: any) => n.kind === "task" && n.id === "alpha") as any;
	travTask.dir = TASK_DIR;
	travTask.workers[0].name = "../secret";
	const travId = fixtureConsoleWorkerId();
	const ht = (await mountSwarmServer({ sessionFile: travSelf, graph: travGraph, env: env() })) as Handle | null;
	check("T0 the traversal mount returns a handle", ht !== null);
	if (!ht) throw new Error("cannot continue without the traversal server");
	try {
		const trav = await get(ht.port, `/api/workers/${travId}/brief`);
		const raw = JSON.stringify(trav.json);
		check(
			"T1 a worker name carrying `..` is refused (never a path outside the task dir)",
			trav.status === 404 && errorCode(trav.json) === "E_EXCHANGE_FILE_REFUSED" && !raw.includes("TOP SECRET"),
			JSON.stringify(trav),
		);
	} finally {
		ht.stop();
	}

	// Direct unit leg on the exported path builder (no server): NUL + relative.
	{
		const mod = (await import("../src/swarm-server/server.ts")) as any;
		const nul = mod.exchangeFilePath(TASK_DIR, "w\u00001", "brief");
		const rel = mod.exchangeFilePath("relative/dir", "w1", "brief");
		const ok = mod.exchangeFilePath(TASK_DIR, "w1", "brief");
		check(
			"T2 the path builder refuses NUL/relative inputs and contains the positive case",
			nul.ok === false && rel.ok === false && ok.ok === true && ok.path === join(TASK_DIR, "brief-w1.md") && !mod.exchangeFilePath(TASK_DIR, "../secret", "report").ok,
			JSON.stringify({ nul: nul.ok, rel: rel.ok, ok: ok.ok && ok.path }),
		);
	}

	// -----------------------------------------------------------------------
	// D — the detail panel renders the files (or its honest states)
	// -----------------------------------------------------------------------
	{
		const model = stateMod.buildDashboardState({ graph, events: [], ownSessionPath: SELF });
		const task = model.byId.get("alpha");
		const store = (state: any) => ({ get: () => state, load: () => Promise.resolve(state) });

		const readyDoc = fakeDoc();
		const readyRoot = readyDoc.createElement("div");
		detailMod.renderDetail({ subject: task, worker: "w1", workerSessionId: workerId, console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "brief" }, readyRoot, readyDoc, { fileStore: store({ status: "ready", text: BRIEF_TEXT, error: null }) });
		const readyText = byAttr(readyRoot, "data-file-text");
		check("D1 the brief tab renders the fetched text and clears the unavailable marker", readyText.length === 1 && readyText[0].textContent === BRIEF_TEXT && byAttr(readyRoot, "data-pane")[0].attributes["data-pane-state"] === "ready" && byAttr(readyRoot, "data-pane")[0].attributes["data-pane-unavailable"] === "0", JSON.stringify(byAttr(readyRoot, "data-pane")[0]?.attributes));

		const absentDoc = fakeDoc();
		const absentRoot = absentDoc.createElement("div");
		detailMod.renderDetail({ subject: task, worker: "w1", workerSessionId: workerId, console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "report" }, absentRoot, absentDoc, { fileStore: store({ status: "absent", text: null, error: null }) });
		check("D2 the report tab renders the honest absent state (no text element)", byAttr(absentRoot, "data-pane")[0].attributes["data-pane-state"] === "absent" && byAttr(absentRoot, "data-file-text").length === 0 && byAttr(absentRoot, "data-file-banner")[0].textContent.includes("absent"), JSON.stringify(byAttr(absentRoot, "data-pane")[0]?.attributes));

		const refusedDoc = fakeDoc();
		const refusedRoot = refusedDoc.createElement("div");
		detailMod.renderDetail({ subject: task, worker: "w1", workerSessionId: workerId, console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "brief" }, refusedRoot, refusedDoc, { fileStore: store({ status: "refused", text: null, error: { code: "E_EXCHANGE_FILE_REFUSED", message: "nope" } }) });
		check("D3 the refused state is distinct from absent (own state + banner)", byAttr(refusedRoot, "data-pane")[0].attributes["data-pane-state"] === "refused" && byAttr(refusedRoot, "data-file-banner")[0].textContent.includes("refused"), String(byAttr(refusedRoot, "data-file-banner")[0]?.textContent));

		const noDirTask = { ...task, dir: null };
		const noDirDoc = fakeDoc();
		const noDirRoot = noDirDoc.createElement("div");
		detailMod.renderDetail({ subject: noDirTask, worker: "w1", workerSessionId: workerId, console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "brief" }, noDirRoot, noDirDoc, { fileStore: store(null) });
		check("D4 a node with no exchange dir keeps the honest unavailable pane", byAttr(noDirRoot, "data-pane")[0].attributes["data-pane-unavailable"] === "1", JSON.stringify(byAttr(noDirRoot, "data-pane")[0]?.attributes));

		// The reducer + store legs (pure, no DOM).
		check("D5 reduceFileFrame maps present/absent/refused distinctly", detailMod.reduceFileFrame(null, { ok: true, absent: false, text: "x" }).status === "ready" && detailMod.reduceFileFrame(null, { ok: true, absent: true, text: null }).status === "absent" && detailMod.reduceFileFrame(null, { ok: false, error: { code: "E_EXCHANGE_FILE_REFUSED" } }).status === "refused" && detailMod.reduceFileFrame(null, { ok: false, error: { code: "E_SWARM_IO" } }).status === "error");
		let calls = 0;
		const fsStore = detailMod.createFileStore({ fetch: async (url: string) => { calls += 1; return { json: async () => ({ ok: true, absent: false, text: `text:${url}` }) }; } });
		const first = await fsStore.load(workerId, "brief");
		const second = await fsStore.load(workerId, "brief");
		check("D6 the store fetches once per (id, kind) and caches", calls === 1 && first.text === second.text && first.text === `text:${detailMod.exchangeFileUrl(workerId, "brief")}`, `calls=${calls}`);
		const failStore = detailMod.createFileStore({ fetch: async () => { throw new Error("boom"); } });
		const failed = await failStore.load(workerId, "report");
		check("D7 a fetch failure is an honest error state, never a throw", failed.status === "error" && failed.error.code === "E_EXCHANGE_FILE_ERROR", JSON.stringify(failed));
	}
}

await main().catch((err) => {
	console.error("UNEXPECTED CHECK ERROR:", err);
	process.exit(1);
});

watchdog.close?.();
try {
	rmSync(SANDBOX, { recursive: true, force: true });
} catch {
	/* the sandbox is in tmp */
}
if (failures > 0) {
	console.error(`\ndashboard-brief-report-check: ${failures} FAILURE(S)`);
	process.exit(1);
}
console.log("\ndashboard-brief-report-check: all checks passed");
process.exit(0);
