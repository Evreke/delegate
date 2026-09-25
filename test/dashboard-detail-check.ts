/**
 * dashboard-detail-check — issues #85 / #90 / #91 / #92 / #93 (dashboard DETAIL
 * surface fixes).
 *
 * Headless acceptance for the fixes this worker owns:
 *   D1 #85a — the panel header names its subject (name + id + task) and a
 *      worker row carries a stable id (never `data-detail-for="undefined"`);
 *      the console banner names its worker; a sessionless worker gets an
 *      honest terminal console pane; a non-worker keeps a visible controls box
 *      with its disabled reason.
 *   D2 #85b — a rail worker row dispatches `select-node` with focusWorker.
 *   D3 #85c — the answer form renders its OWN per-kind pending line.
 *   D4 #90  — every flag has a plain-language gloss (title/aria-label), a
 *      distinct shape glyph/left-border accent, and an overlay-footer legend.
 *   D5 #91  — rail rows carry a visually-hidden status label; the attention
 *      strip is aria-live=polite; the overlay is an aria-modal dialog with
 *      focus-on-open, Escape-close and focus-return.
 *   D6 #92  — buildDashboardState accepts the UI's expansion Set.
 *   D7 #93  — a truncated console tail is marked; a refusal is labelled
 *      `refused — foreign`; a dismissed token prompt emits `no token — nothing
 *      sent`; an ask option fills the answer input.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; no unbounded
 * waits. Exit 0 only if all checks pass.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const watchdog = setTimeout(() => {
	console.error("dashboard-detail-check WATCHDOG TIMEOUT");
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

const publicUrl = (f: string): string => new URL(`../src/swarm-server/public/${f}`, import.meta.url).href;
const PUBLIC_DIR = fileURLToPath(new URL("../src/swarm-server/public/", import.meta.url));
const readAsset = (name: string): string => readFileSync(join(PUBLIC_DIR, name), "utf8");

// ---------------------------------------------------------------------------
// Fake DOM seam (fake doc + listener/focus/query support for the app wiring)
// ---------------------------------------------------------------------------

class FakeEl {
	attributes: Record<string, string> = {};
	childNodes: any[] = [];
	text = "";
	listeners: Record<string, Array<(e?: any) => void>> = {};
	value = "";
	parentNode: any = null;
	ownerDoc: any = null;
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
		c.parentNode = this;
		if (this.ownerDoc && !c.ownerDoc) c.ownerDoc = this.ownerDoc;
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
	set className(v: string) {
		this.attributes.class = v;
	}
	get className() {
		return this.attributes.class ?? "";
	}
	set textContent(v: string) {
		this.text = v;
		this.childNodes = [];
	}
	get textContent(): string {
		return this.text + this.childNodes.map((c: any) => c.textContent ?? "").join("");
	}
	addEventListener(type: string, fn: (e?: any) => void) {
		(this.listeners[type] ??= []).push(fn);
	}
	removeEventListener(type: string, fn: (e?: any) => void) {
		this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
	}
	fire(type: string, event: any = {}) {
		for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
	}
	focus() {
		if (this.ownerDoc) this.ownerDoc.activeElement = this;
	}
	querySelector(sel: string) {
		return queryAll(this, sel)[0] ?? null;
	}
	querySelectorAll(sel: string) {
		return queryAll(this, sel);
	}
}

function walk(n: any, out: any[] = []): any[] {
	out.push(n);
	for (const c of n?.childNodes ?? []) walk(c, out);
	return out;
}
function attrMatch(el: any, sel: string): boolean {
	const m = sel.match(/^\[([^\]=\s]+)(?:="([^"]*)")?\]$/);
	if (m) return m[2] === undefined ? el.attributes[m[1]] !== undefined : el.attributes[m[1]] === m[2];
	if (sel.startsWith(".")) return String(el.attributes.class ?? "").split(/\s+/).includes(sel.slice(1));
	return el.tagName === sel;
}
function queryAll(root: any, sel: string): any[] {
	return walk(root).filter((e) => e instanceof FakeEl && attrMatch(e, sel));
}
function byAttr(root: any, attr: string): any[] {
	return walk(root).filter((e) => e instanceof FakeEl && e.attributes[attr] !== undefined);
}

function fakeDoc(): any {
	const els = new Map<string, any>();
	const doc: any = {
		activeElement: null,
		body: null,
		listeners: {} as Record<string, Array<(e?: any) => void>>,
		addEventListener(type: string, fn: (e?: any) => void) {
			(doc.listeners[type] ??= []).push(fn);
		},
		removeEventListener(type: string, fn: (e?: any) => void) {
			doc.listeners[type] = (doc.listeners[type] ?? []).filter((f: any) => f !== fn);
		},
		fire(type: string, event: any = {}) {
			for (const fn of [...(doc.listeners[type] ?? [])]) fn(event);
		},
		createElement(tag: string) {
			const el = new FakeEl(tag);
			el.ownerDoc = doc;
			return el;
		},
		createTextNode(text: string) {
			return { ownerDoc: doc, textContent: text, childNodes: [] };
		},
		querySelector(sel: string) {
			return queryAll(doc.body, sel)[0] ?? null;
		},
		querySelectorAll(sel: string) {
			return queryAll(doc.body, sel);
		},
		getElementById(id: string) {
			let el = els.get(id);
			if (!el) {
				el = doc.createElement("div");
				el.attributes.id = id;
				els.set(id, el);
				doc.body.appendChild(el);
			}
			return el;
		},
	};
	doc.body = doc.createElement("body");
	doc.activeElement = doc.body;
	return doc;
}

function fakeStorage() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, String(v)),
		removeItem: (k: string) => void m.delete(k),
	};
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SELF = "/sessions/orch.jsonl";
const WORKERPATH = "/sessions/w1.jsonl";

function fixture() {
	const graph = {
		schemaVersion: 1,
		available: true,
		sources: { journal: true, manifests: true, liveStatus: true, usage: true },
		nodes: [
			{ kind: "session", id: "orch", sessionPath: SELF, role: "orchestrator", isWorker: false, ownsChildren: true, tasks: ["t1"], degraded: [] },
			{ kind: "session", id: "w1-node", sessionPath: WORKERPATH, role: "worker", isWorker: true, ownsChildren: false, tasks: ["t1"], liveStatus: "working", degraded: [] },
			{ kind: "session", id: "w2-node", sessionPath: "/sessions/w2.jsonl", role: "worker", isWorker: true, ownsChildren: false, tasks: ["t1"], liveStatus: "working", degraded: [{ flag: "no-session-path" }] },
			{
				kind: "task",
				id: "t1",
				dir: "/exchange/t1",
				depth: 0,
				workers: [
					{ name: "w1", run: 1, sessionId: "w1-node", sessionPath: WORKERPATH, liveStatus: "working", degraded: [] },
					{ name: "w2", run: 1, sessionId: "w2-node", sessionPath: "/sessions/w2.jsonl", liveStatus: "working", degraded: [] },
				],
				degraded: [{ flag: "no-live-status" }],
			},
		],
		edges: [
			{ kind: "spawned_by", from: "t1", to: "orch" },
			{ kind: "spawned_by", from: "w1-node", to: "orch" },
			{ kind: "spawned_by", from: "w2-node", to: "orch" },
		],
		orphans: [] as unknown[],
	};
	const events = [{ seq: 1, kind: "ask", worker: "w1", task: "t1", payload: { question: "which port?", options: ["7331", "0"] } }];
	return { graph, events };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const stateMod = (await import(publicUrl("state.js"))) as any;
	const railMod = (await import(publicUrl("rail.js"))) as any;
	const attentionMod = (await import(publicUrl("attention.js"))) as any;
	const detailMod = (await import(publicUrl("detail.js"))) as any;
	const consoleMod = (await import(publicUrl("console.js"))) as any;
	const degradeMod = (await import(publicUrl("degrade.js"))) as any;
	const mutationsMod = (await import(publicUrl("mutations.js"))) as any;
	const steerMod = (await import(publicUrl("steer.js"))) as any;
	const appMod = (await import(publicUrl("app.js"))) as any;

	const { graph, events } = fixture();
	const model = stateMod.buildDashboardState({ graph, events, ownSessionPath: SELF, nowMs: Date.parse("2026-09-20T02:00:00.000Z") });
	const task = model.byId.get("t1");

	// -- D1 — #85a the panel names its subject ------------------------------
	{
		check(
			"D1.1 every worker row carries a stable id + kind (never the string 'undefined')",
			task.workers.every((w: any) => typeof w.id === "string" && w.id.length > 0 && w.id !== "undefined" && w.kind === "worker" && w.task === "t1"),
			JSON.stringify(task.workers.map((w: any) => [w.id, w.kind])),
		);
		const doc = fakeDoc();
		const root = doc.createElement("div");
		detailMod.renderDetail(
			{ subject: task, worker: "w1", workerSessionId: "w1-node", console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "console" },
			root,
			doc,
			{},
		);
		check(
			"D1.2 the panel renders a header with name + id + task",
			byAttr(root, "data-detail-header").length === 1 && byAttr(root, "data-detail-name")[0].textContent === "w1" && byAttr(root, "data-detail-id")[0].textContent === "t1" && byAttr(root, "data-detail-task")[0].textContent.includes("t1"),
			JSON.stringify(byAttr(root, "data-detail-name").map((e: any) => e.textContent)),
		);
		check("D1.3 data-detail-for is the node id, never 'undefined'", byAttr(root, "data-detail-for")[0].attributes["data-detail-for"] === "t1");

		// A worker as the direct subject: its own stable id, never undefined.
		const w1 = task.workers.find((w: any) => w.name === "w1");
		const doc2 = fakeDoc();
		const root2 = doc2.createElement("div");
		detailMod.renderDetail({ subject: w1, worker: "w1", workerSessionId: "w1-node", console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "console" }, root2, doc2, {});
		check("D1.4 a worker subject renders data-detail-for = its stable worker id", byAttr(root2, "data-detail-for")[0].attributes["data-detail-for"] === w1.id && w1.id !== "undefined");

		// Console banner names its worker.
		const doc3 = fakeDoc();
		const root3 = doc3.createElement("div");
		detailMod.renderDetail(
			{ subject: task, worker: "w1", workerSessionId: "w1-node", console: { state: "live", label: "live", detail: "", retained: false, text: "boot", worker: "w1", nodeId: "w1-node", truncated: false, truncation: "" }, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "console" },
			root3,
			doc3,
			{},
		);
		check("D1.5 the console banner names its worker ('w1 · live')", byAttr(root3, "data-console-banner")[0].textContent.includes("w1") && byAttr(root3, "data-console-banner")[0].textContent.includes("live"));

		// No-session worker: honest terminal pane, not an infinite loading pane.
		const doc4 = fakeDoc();
		const root4 = doc4.createElement("div");
		detailMod.renderDetail({ subject: task, worker: "wX", workerSessionId: null, console: null, controls: { disabled: true, reasonCode: "no-session", reason: "disabled: no session id" }, pending: null, ask: null, draft: "", tab: "console" }, root4, doc4, {});
		check("D1.6 a sessionless worker gets an honest terminal console pane (not 'loading')", byAttr(root4, "data-pane")[0].attributes["data-pane-state"] === "no-session" && byAttr(root4, "data-pane")[0].textContent.includes("no session id"));

		// Non-worker subject keeps a VISIBLE controls box with its disabled reason.
		const doc5 = fakeDoc();
		const root5 = doc5.createElement("div");
		detailMod.renderDetail({ subject: model.byId.get("orch"), worker: null, workerSessionId: null, console: null, controls: { disabled: true, reasonCode: "not-a-worker", reason: "disabled: this node is not a steerable worker", pendingAsk: null }, pending: null, ask: null, draft: "", tab: "console" }, root5, doc5, {});
		check("D1.7 a non-worker renders the controls box with its disabled reason", byAttr(root5, "data-steer-disabled")[0].attributes["data-steer-disabled"] === "1" && byAttr(root5, "data-disabled-reason")[0].textContent.includes("not a steerable worker"));
	}

	// -- D2 — #85b rail worker row click dispatch ---------------------------
	{
		const doc = fakeDoc();
		const root = doc.createElement("div");
		const dispatched: any[] = [];
		railMod.renderRail(model, root, doc, { dispatch: (a: any) => dispatched.push(a), selection: null });
		const row = byAttr(root, "data-rail-worker").find((r: any) => r.attributes["data-rail-worker"] === "w1");
		row.fire("click");
		const action = dispatched.find((a) => a.type === "select-node");
		check(
			"D2.1 a rail worker row dispatches select-node with focusWorker + the task spotlight",
			action !== undefined && action.id === "t1" && action.focusWorker === "w1" && action.spotlightIds.includes("t1") && action.spotlightIds.includes("w1-node"),
			JSON.stringify(action),
		);
		check("D2.2 a worker row carries its stable worker id", row.attributes["data-worker-id"] === "t1/w1", row.attributes["data-worker-id"]);
	}

	// -- D3 — #85c answer pending render ------------------------------------
	{
		const doc = fakeDoc();
		const root = doc.createElement("div");
		detailMod.renderDetail(
			{ subject: task, worker: "w1", workerSessionId: "w1-node", console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: { status: "confirmed", detail: "confirmed by journal #9" }, answerPending: { status: "pending", detail: "awaiting journal confirmation…" }, ask: { question: "which port?", options: ["7331"], seq: 1 }, draft: "", tab: "console" },
			root,
			doc,
			{},
		);
		const answerPending = byAttr(root, "data-answer-pending-status")[0];
		const steerPending = byAttr(root, "data-steer-pending")[0];
		check(
			"D3.1 the answer form renders its OWN per-kind pending line (steer stays separate)",
			answerPending !== undefined && answerPending.attributes["data-answer-pending-status"] === "pending" && answerPending.textContent.includes("awaiting") && steerPending.attributes["data-steer-pending"] === "confirmed",
			JSON.stringify({ answer: answerPending?.attributes, steer: steerPending?.attributes }),
		);
	}

	// -- D4 — #90 glosses + shape + legend ----------------------------------
	{
		const glosses = degradeMod.DEGRADED_FLAGS.map((f: string) => degradeMod.degradedGloss(f));
		const glyphs = degradeMod.DEGRADED_FLAGS.map((f: string) => degradeMod.degradedGlyph(f));
		check(
			"D4.1 every flag has a non-trivial plain-language gloss and a distinct glyph",
			glosses.every((g: string) => typeof g === "string" && g.length > 10) && new Set(glosses).size === 4 && new Set(glyphs).size === 4,
			JSON.stringify({ glosses, glyphs }),
		);
		const doc = fakeDoc();
		const chips = (await import(publicUrl("dom.js"))).renderDegradedChips(doc, degradeMod.degradeViews(["no-session-path", "no-live-status", "legacy-orphan", "usage-unavailable"]));
		check(
			"D4.2 a chip carries its gloss as title + aria-label and a shape glyph (text stays the verbatim flag)",
			chips.length === 4 && chips.every((c: any) => c.attributes.title.includes(c.attributes["data-degraded-flag"]) && c.attributes["aria-label"].length > 10 && c.attributes["data-degraded-glyph"].length > 0) && chips.every((c: any) => c.textContent === c.attributes["data-degraded-flag"]),
			JSON.stringify(chips.map((c: any) => c.attributes)),
		);
		const css = readAsset("detail.css");
		check(
			"D4.3 detail.css gives every flag a distinct left-border accent AND a distinct ::before glyph",
			degradeMod.DEGRADED_FLAGS.every((f: string) => css.includes(`.degraded-flag-${f}`)) && ["2205", "25cb", "2691", "25d4"].every((code) => css.toLowerCase().includes(`\\${code}`)) && (css.match(/border-left:\s*3px/g) ?? []).length >= 4,
			degradeMod.DEGRADED_FLAGS.join(","),
		);
		const doc2 = fakeDoc();
		const root2 = doc2.createElement("div");
		attentionMod.renderAttention(model, root2, doc2, { overlay: "ask" });
		const legend = byAttr(root2, "data-attention-legend")[0];
		const legendItems = byAttr(root2, "data-legend-flag");
		check(
			"D4.4 the attention overlay footer carries a 4-flag legend with a gloss per flag",
			legend !== undefined && legendItems.length === 4 && legendItems.every((i: any) => i.attributes.title.length > 10 && i.textContent.includes("—")),
			JSON.stringify(legendItems.map((i: any) => i.attributes["data-legend-flag"])),
		);
	}

	// -- D5 — #91 a11y -------------------------------------------------------
	{
		const doc = fakeDoc();
		const root = doc.createElement("div");
		railMod.renderRail(model, root, doc, {});
		const rows = byAttr(root, "data-node-id");
		check(
			"D5.1 every rail row carries a visually-hidden status label (color+shape is not the only channel)",
			rows.length > 0 && rows.every((r: any) => byAttr(r, "data-rail-status-label").length === 1 && byAttr(r, "data-rail-status-label")[0].textContent.length > 0),
			`rows=${rows.length}`,
		);
		check("D5.2 the status marker stays aria-hidden (the label is the accessible text)", byAttr(root, "data-status-marker").every((m: any) => m.attributes["aria-hidden"] === "true"));
		const doc2 = fakeDoc();
		const root2 = doc2.createElement("div");
		attentionMod.renderAttention(model, root2, doc2, {});
		const strip = byAttr(root2, "data-attention-strip")[0];
		check("D5.3 the attention strip is an aria-live=polite status region", strip.attributes["aria-live"] === "polite" && strip.attributes.role === "status");
		const doc3 = fakeDoc();
		const root3 = doc3.createElement("div");
		attentionMod.renderAttention(model, root3, doc3, { overlay: "degraded" });
		const dialog = byAttr(root3, "data-attention-overlay")[0];
		check("D5.4 the queue overlay is an aria-modal dialog with a focusable tabindex", dialog.attributes["aria-modal"] === "true" && dialog.attributes.tabindex === "-1" && dialog.attributes.role === "dialog", JSON.stringify(dialog.attributes));
		check("D5.5 the connection pill already carries role=status + aria-live (from #79)", /id="connection-state"[^>]*role="status"[^>]*aria-live="polite"/.test(readAsset("index.html")));
		check("D5.6 a11y wiring is real (not a dead attribute): app.js handles Escape + focuses the overlay", readAsset("app.js").includes("keydown") && readAsset("app.js").includes("data-attention-overlay") && readAsset("app.js").includes("activeElement"));
	}

	// -- D6 — #92 expansion Set ---------------------------------------------
	{
		const asSet = stateMod.buildDashboardState({ graph, events, ownSessionPath: SELF, expansion: new Set(["agg:1"]) });
		const asArray = stateMod.buildDashboardState({ graph, events, ownSessionPath: SELF, expansion: ["agg:1"] });
		const asNone = stateMod.buildDashboardState({ graph, events, ownSessionPath: SELF });
		check(
			"D6.1 buildDashboardState accepts the UI's expansion Set (an array still works; absent stays empty)",
			asSet.graph.expansion instanceof Set && asSet.graph.expansion.has("agg:1") && asArray.graph.expansion.has("agg:1") && asNone.graph.expansion.size === 0,
			JSON.stringify([[...asSet.graph.expansion], [...asArray.graph.expansion], [...asNone.graph.expansion]]),
		);
	}

	// -- D7 — #93 console honesty -------------------------------------------
	{
		// Truncation: feed enough to trip the cap and mark it.
		let st = consoleMod.initialConsoleState(0);
		for (let i = 0; i < 20; i++) st = consoleMod.reduceConsoleFrame(st, { ok: true, state: "live", chunk: "x".repeat(2000), nextOffset: (i + 1) * 2000, oldestOffset: 0, dropped: false });
		const banner = consoleMod.consoleBanner(st);
		check(
			"D7.1 a capped tail is MARKED ('truncated (dropped since offset N)')",
			st.capped === true && banner.truncated === true && banner.truncation.includes("truncated") && banner.truncation.includes("dropped since offset"),
			JSON.stringify(banner.truncation),
		);
		const dropped = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), { ok: true, state: "live", chunk: "tail", nextOffset: 40, oldestOffset: 42, dropped: true });
		const droppedBanner = consoleMod.consoleBanner(dropped);
		check("D7.2 a frame-level `dropped` surfaces the offset in the banner", droppedBanner.truncated === true && droppedBanner.truncation.includes("42"), droppedBanner.truncation);
		// The panel renders the marker element.
		const doc = fakeDoc();
		const root = doc.createElement("div");
		detailMod.renderDetail({ subject: model.byId.get("t1"), worker: "w1", workerSessionId: "w1-node", console: { ...banner, worker: "w1", nodeId: "w1-node" }, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: null, draft: "", tab: "console" }, root, doc, {});
		check("D7.3 detail.js renders the truncation marker element", byAttr(root, "data-console-truncated").length === 1 && byAttr(root, "data-console-truncated")[0].textContent.includes("dropped since offset"));

		// Refusal is distinct from captureless 'unavailable'.
		const refused = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), { ok: false, error: { code: "E_CONSOLE_WORKER_REFUSED", message: "not owned" } });
		const unavailable = consoleMod.reduceConsoleFrame(consoleMod.initialConsoleState(0), { ok: true, state: "unavailable", chunk: "", nextOffset: 0, oldestOffset: 0, dropped: false });
		const refusedBanner = consoleMod.consoleBanner(refused);
		const unavailableBanner = consoleMod.consoleBanner(unavailable);
		check(
			"D7.4 a refusal is labelled 'refused — foreign', never conflated with 'unavailable'",
			refusedBanner.label === "refused \u2014 foreign" && unavailableBanner.label === "unavailable" && refusedBanner.label !== unavailableBanner.label,
			JSON.stringify([refusedBanner.label, unavailableBanner.label]),
		);

		// Token abort: a dismissed prompt emits the honest marker, not null.
		const storage = fakeStorage();
		const mut = mutationsMod.createMutations({ fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }), storage, prompt: () => null, currentSeq: () => 0, onChange() {}, onTokenState() {} });
		const empty = await mut.sendSteer("w1", "   ");
		const aborted = await mut.sendSteer("w1", "hello");
		const marker = mut.latestPending("w1", "steer");
		check("D7.5 empty text is a structured no-op ({sent:false,reason:'empty'})", empty.sent === false && empty.reason === "empty");
		check(
			"D7.6 a dismissed token prompt returns a structured outcome AND an 'aborted' marker reading 'no token — nothing sent'",
			aborted.sent === false && aborted.reason === "no-token" && marker !== null && marker.status === "aborted" && marker.label === "not sent" && marker.detail.includes("no token") && marker.detail.includes("nothing sent"),
			JSON.stringify({ aborted, marker }),
		);
		check("D7.7 the pendingView renders the aborted state", steerMod.pendingView({ status: "aborted", error: "no token — nothing sent" }).detail.includes("nothing sent"));

		// Ask option click-to-fill.
		const doc2 = fakeDoc();
		const root2 = doc2.createElement("div");
		detailMod.renderDetail({ subject: task, worker: "w1", workerSessionId: "w1-node", console: null, controls: { disabled: false, reasonCode: null, reason: "" }, pending: null, ask: { question: "which port?", options: ["7331", "0"], seq: 1 }, draft: "", answerDraft: "", tab: "console" }, root2, doc2, {});
		const option = byAttr(root2, "data-ask-option")[0];
		const answerInput = byAttr(root2, "data-answer-input")[0];
		option.fire("click");
		check(
			"D7.8 an ask option fills the answer input on click (no longer an inert span)",
			option.tagName === "button" && answerInput.value === "7331",
			JSON.stringify({ tag: option.tagName, value: answerInput.value, text: option.attributes["data-ask-option-text"] }),
		);
	}

	// -- D8 — app wiring: non-worker controls, focus, Escape, send seams -----
	{
		const doc = fakeDoc();
		const shell = doc.getElementById("fleet-tree");
		let keydowns = 0;
		const app = appMod.createFleetApp({
			doc,
			fetch: async (url: string) => {
				if (url.includes("/api/swarm/fleets")) return { json: async () => ({ ok: true, fleets: [] }) };
				if (url.startsWith("/api/swarm/snapshot")) return { json: async () => ({ ok: true, snapshot: graph }) };
				if (url.startsWith("/api/swarm/events")) return { json: async () => ({ ok: true, events, journal: { count: 1, dbSizeBytes: 2 } }) };
				if (url.includes("/console")) return { json: async () => ({ ok: true, worker: "w1", nodeId: "w1-node", state: "live", chunk: "hi", nextOffset: 2, oldestOffset: 0, dropped: false }) };
				throw new Error(`unexpected fetch ${url}`);
			},
			storage: null,
			location: { protocol: "http:", host: "h", pathname: "/", search: "", hash: "" },
			stream: () => ({ state: { lastSeq: 0 }, close() {} }),
			consoleTail: () => ({ close() {} }),
			ownSessionPath: SELF,
			prompt: () => null,
		});
		await app.start();
		// The default subject is the task (worker w1) — the header names it.
		check("D8.1 a started app renders a named detail header", byAttr(shell, "data-detail-header").length === 1 && byAttr(shell, "data-detail-name").length === 1);
		// Select the orchestrator (no worker) → visible disabled controls box.
		app.dispatch({ type: "select-node", id: "orch" });
		check(
			"D8.2 a non-worker subject keeps a VISIBLE controls box with its disabled reason",
			byAttr(shell, "data-steer-disabled").length === 1 && byAttr(shell, "data-steer-disabled")[0].attributes["data-steer-disabled"] === "1" && byAttr(shell, "data-disabled-reason")[0].textContent.includes("not a steerable worker"),
			JSON.stringify(byAttr(shell, "data-disabled-reason").map((e: any) => e.textContent)),
		);
		// Focus management: open the overlay from a focused chip, Escape restores it.
		const chip = byAttr(shell, "data-attention-chip").find((c: any) => c.attributes["data-attention-chip"] === "ask");
		doc.activeElement = chip;
		app.dispatch({ type: "chip-click", kind: "ask" });
		const dialog = byAttr(shell, "data-attention-overlay")[0];
		check("D8.3 opening the queue moves focus into the dialog", dialog !== undefined && doc.activeElement === dialog, JSON.stringify({ tag: doc.activeElement?.tagName, for: doc.activeElement?.attributes?.["data-attention-overlay"] }));
		doc.fire("keydown", { key: "Escape" });
		keydowns++;
		check(
			"D8.4 Escape closes the dialog and restores focus to the opener",
			byAttr(shell, "data-attention-overlay").length === 0 && doc.activeElement === chip && app.ui.overlay === null,
			JSON.stringify({ open: byAttr(shell, "data-attention-overlay").length, restored: doc.activeElement === chip }),
		);
		// A send from the UI uses the onSend seam and clears the draft on success.
		const sendResult = await app.sendSteer("w1", "go");
		check("D8.5 app.sendSteer returns the structured outcome (no token → not sent)", sendResult.sent === false && sendResult.reason === "no-token");
		check("D8.6 app.pending exposes the aborted marker for the panel", app.pending.length === 1 && app.pending[0].status === "aborted");
		void keydowns;
		app.close();
	}
}

await main()
	.then(() => {
		clearTimeout(watchdog);
		console.log(failures === 0 ? "\nALL DASHBOARD DETAIL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		clearTimeout(watchdog);
		console.error("dashboard-detail-check CRASHED", err);
		process.exit(1);
	});
