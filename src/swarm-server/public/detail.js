/**
 * detail.js — the v1 right detail panel (issue #66, dashboard shell).
 *
 * One panel, three tabs (console / brief / report) and the steering controls.
 * It renders exactly what the read-model and the console endpoint carry:
 * status line, task/lead/depth/model/elapsed, degraded chips (verbatim), the
 * context-usage bar (or an honest `usage-unavailable`), the last progress
 * event, the open-question banner and the optimistic steer/answer controls.
 *
 * Honesty rules: `model` and provider are NOT in the read-model — the panel
 * says so instead of inventing a value; brief/report have no v1 endpoint, so
 * those tabs state it rather than showing fake content; a foreign or terminal
 * worker renders its controls DISABLED WITH THE REASON, never hidden (Law 8).
 * #85 adds the panel header (name + id + task), the per-kind pending lines and
 * the no-session console pane; #93 marks a truncated console and makes ask
 * options fill the answer input. No framework; a pure view over the model +
 * the #54 console/steer views.
 */

import { el, on, renderDegradedChips, renderStatusMarker } from "./dom.js";

const TABS = ["console", "brief", "report"];

/**
 * #85a: the panel NAMES its subject — name, id and task. A stable header is
 * what tells the operator whose console this is when 25 workers are on screen;
 * `data-detail-for` alone was never a name and could render `undefined`.
 */
function renderHeader(doc, node, view) {
	const box = el(doc, "div", { class: "detail-header", "data-detail-header": "1" });
	const name = view.worker || node.worker || node.name || node.id || "unnamed";
	box.appendChild(el(doc, "span", { class: "detail-name", "data-detail-name": "1" }, name));
	box.appendChild(el(doc, "span", { class: "detail-id", "data-detail-id": "1" }, node.id ?? "unknown"));
	const task = node.task || view.task || (node.kind === "task" ? node.id : null);
	if (task) box.appendChild(el(doc, "span", { class: "detail-task", "data-detail-task": "1" }, `task: ${task}`));
	return box;
}

function renderStatusLine(doc, node) {
	const line = el(doc, "div", { class: "detail-status", "data-detail-status": node.status });
	line.appendChild(renderStatusMarker(doc, node.statusView));
	line.appendChild(el(doc, "span", { class: "detail-status-label" }, node.statusView.label));
	if (node.severity !== "clear") line.appendChild(el(doc, "span", { class: `severity severity-${node.severity}`, "data-severity": node.severity }, node.severity));
	if (node.foreign) line.appendChild(el(doc, "span", { class: "detail-readonly", "data-detail-readonly": "1" }, "foreign \u2014 read-only"));
	return line;
}

function renderFields(doc, view) {
	const box = el(doc, "div", { class: "detail-fields", "data-detail-fields": "1" });
	const node = view.subject;
	const rows = [
		["kind", node.kind],
		["task", node.task || view.task || null],
		["role", node.role || null],
		["lead", node.parentId || null],
		["depth", node.depth === null || node.depth === undefined ? null : node.depth],
		["elapsed", node.elapsedLabel],
	];
	for (const [label, value] of rows) {
		if (value === null || value === undefined || value === "") continue;
		box.appendChild(el(doc, "span", { class: "detail-field", "data-field": label }, `${label}: ${value}`));
	}
	// The read-model carries no provider/model for a node — say so, never guess.
	box.appendChild(el(doc, "span", { class: "detail-field detail-field-unavailable", "data-field": "model", "data-field-unavailable": "1" }, "model: not in read-model"));
	return box;
}

function renderContextBar(doc, node) {
	const usage = node.usage || {};
	if (usage.available && typeof usage.contextPct === "number") {
		const pct = Math.max(0, Math.min(100, usage.contextPct));
		const bar = el(doc, "div", { class: "context-bar", "data-context-bar": "1", "data-context-pct": pct });
		const fill = el(doc, "div", { class: "context-bar-fill", "data-context-fill": pct });
		fill.setAttribute("style", `width: ${pct}%`);
		bar.appendChild(fill);
		bar.appendChild(el(doc, "span", { class: "context-label" }, `context ${pct}%`));
		return bar;
	}
	return el(doc, "div", { class: "context-bar context-bar-unavailable", "data-context-bar": "1", "data-usage-unavailable": "1" }, "usage-unavailable");
}

function renderProgress(doc, node) {
	const box = el(doc, "div", { class: "last-progress", "data-last-progress": "1" });
	if (node.progress) {
		const label = `${node.progress.phase}${node.progress.pct === null ? "" : ` ${node.progress.pct}%`}`;
		box.appendChild(el(doc, "span", { class: "progress-label", "data-progress-pct": node.progress.pct ?? "" }, label));
		if (node.progress.note) box.appendChild(el(doc, "span", { class: "progress-note", "data-progress-note": "1" }, node.progress.note));
	} else {
		box.appendChild(el(doc, "span", { class: "progress-none", "data-progress-none": "1" }, "no progress events"));
	}
	return box;
}

function renderConsolePane(doc, view) {
	const panel = view.console;
	if (!panel) {
		// #85 ride-along: a worker with no session id can never open a stream —
		// an honest terminal pane, never an infinite 'waiting for the first frame'.
		const noSession = Boolean(view.worker) && !view.workerSessionId;
		return el(
			doc,
			"div",
			{ class: "detail-pane", "data-pane": "console", "data-pane-state": noSession ? "no-session" : "loading" },
			noSession ? "console: this worker has no session id \u2014 there is no stream to read" : "console: waiting for the first frame",
		);
	}
	const node = el(doc, "div", {
		class: "console",
		"data-console-for": panel.worker,
		"data-console-node": panel.nodeId,
		"data-console-state": panel.state,
		"data-console-retained": panel.retained ? "1" : "0",
		"data-pane": "console",
	});
	// #85a: the banner names its worker ('w4-1 · live'), never a bare state.
	const bannerLabel = panel.worker ? `${panel.worker} \u00b7 ${panel.label}` : panel.label;
	node.appendChild(el(doc, "div", { class: "console-banner", "data-console-banner": panel.state }, bannerLabel));
	if (panel.detail) node.appendChild(el(doc, "div", { class: "console-detail", "data-console-detail": panel.state }, panel.detail));
	// #93: a sliced tail is MARKED in the banner block, never read as the whole log.
	if (panel.truncation) node.appendChild(el(doc, "div", { class: "console-truncated", "data-console-truncated": "1" }, panel.truncation));
	node.appendChild(el(doc, "pre", { class: "console-tail", "data-console-tail": "1" }, panel.text || ""));
	return node;
}

function renderStaticPane(doc, name) {
	return el(doc, "div", { class: "detail-pane detail-pane-unavailable", "data-pane": name, "data-pane-unavailable": "1" }, `${name}: this server exposes no ${name} endpoint (v1)`);
}

function renderTabs(doc, view, ctx) {
	const tabs = el(doc, "div", { class: "detail-tabs", "data-detail-tabs": "1", role: "tablist" });
	for (const name of TABS) {
		const button = el(doc, "button", { class: "detail-tab", "data-detail-tab": name, "data-active": ctx.tab === name ? "1" : "0", type: "button" }, name);
		on(button, "click", () => ctx.dispatch?.({ type: "detail-tab", tab: name }));
		tabs.appendChild(button);
	}
	return tabs;
}

function renderAskBanner(doc, view) {
	const ask = view.ask;
	if (!ask) return null;
	const box = el(doc, "div", { class: "ask-banner", "data-ask-banner": view.worker || view.subject.id, "data-ask-seq": ask.seq });
	box.appendChild(el(doc, "span", { class: "ask-question", "data-ask-question": "1" }, ask.question));
	// #93: an option is a CLICK affordance that fills the answer input, not an
	// inert span; the text rides an attribute so the click never parses markup.
	for (const option of ask.options || []) box.appendChild(el(doc, "button", { class: "ask-option", "data-ask-option": "1", "data-ask-option-text": option, type: "button" }, option));
	return box;
}

function renderControls(doc, view, ctx) {
	const ctl = view.controls;
	if (!ctl) return null;
	const box = el(doc, "div", {
		class: "controls",
		"data-steer-worker": view.worker,
		"data-steer-node": view.workerSessionId,
		"data-steer-disabled": ctl.disabled ? "1" : "0",
	});
	if (ctl.disabled) box.appendChild(el(doc, "span", { class: "reason", "data-disabled-reason": ctl.reasonCode || "disabled" }, ctl.reason));
	const input = el(doc, "input", { class: "steer-input", "data-steer-input": "1", type: "text", value: view.draft || "", placeholder: "steer this worker\u2026" });
	const send = el(doc, "button", { class: "steer-send", "data-steer-send": "1", type: "button" }, "steer");
	if (ctl.disabled) {
		input.setAttribute("disabled", "disabled");
		send.setAttribute("disabled", "disabled");
	}
	// #85c/#93: the send outcome is STRUCTURED — the input clears only on a
	// confirmed send, and a dismissed token prompt keeps its `aborted` marker.
	on(input, "input", () => ctx.onDraft?.(view.worker, input.value));
	on(send, "click", async () => {
		const outcome = await ctx.onSend?.("steer", view.worker, input.value);
		if (outcome && outcome.sent) {
			input.value = "";
			ctx.onDraft?.(view.worker, "");
		}
	});
	box.appendChild(input);
	box.appendChild(send);
	if (view.pending) box.appendChild(el(doc, "span", { class: `pending pending-${view.pending.status}`, "data-steer-pending": view.pending.status }, view.pending.detail));
	if (view.ask) {
		const form = el(doc, "div", { class: "answer", "data-answer-worker": view.worker, "data-answer-seq": String(view.ask.seq) });
		const aInput = el(doc, "input", { class: "answer-input", "data-answer-input": "1", type: "text", value: view.answerDraft || "", placeholder: "answer\u2026" });
		const aSend = el(doc, "button", { class: "answer-send", "data-answer-send": "1", type: "button" }, "answer");
		if (ctl.disabled) {
			aInput.setAttribute("disabled", "disabled");
			aSend.setAttribute("disabled", "disabled");
		}
		on(aInput, "input", () => ctx.onDraft?.(`${view.worker}:answer`, aInput.value));
		on(aSend, "click", async () => {
			const outcome = await ctx.onSend?.("answer", view.worker, aInput.value);
			if (outcome && outcome.sent) {
				aInput.value = "";
				ctx.onDraft?.(`${view.worker}:answer`, "");
			}
		});
		form.appendChild(aInput);
		form.appendChild(aSend);
		// #85c: the answer form carries its OWN per-kind pending line.
		if (view.answerPending) form.appendChild(el(doc, "span", { class: `pending pending-${view.answerPending.status}`, "data-answer-pending-status": view.answerPending.status }, view.answerPending.detail));
		box.appendChild(form);
	}
	return box;
}

/** Every descendant carrying `attr` (a tiny querySelector for the headless
 *  seam — the check's fake document implements no querySelector). */
function findAttr(node, attr, out = []) {
	for (const child of node.childNodes ?? []) {
		if (child && child.attributes && child.attributes[attr] !== undefined) out.push(child);
		findAttr(child, attr, out);
	}
	return out;
}

/**
 * Render the detail panel into `root`.
 * <p>
 * FUNCTION_CONTRACT: Input — view ({ subject, worker, workerSessionId,
 *   console, controls, pending, answerPending, ask, tab, draft, answerDraft }),
 *   root, doc, opts ({ dispatch, onSend(kind, worker, text), onDraft(key,
 *   text) }). Output — none (root mutated).
 * Guarantees: a degraded/absent usage renders the honest `usage-unavailable`
 *   bar; foreign/terminal controls are disabled WITH their reason; brief and
 *   report state the absent endpoint. Raises: never on a well-formed view.
 */
export function renderDetail(view, root, doc, opts = {}) {
	while (root.firstChild) root.removeChild(root.firstChild);
	if (!view || !view.subject) {
		root.appendChild(el(doc, "div", { class: "detail-empty", "data-detail-empty": "1" }, "select a node"));
		return;
	}
	const node = view.subject;
	const ctx = { dispatch: opts.dispatch, tab: view.tab || "console", onSend: opts.onSend, onDraft: opts.onDraft };
	const panel = el(doc, "div", {
		class: "detail-panel",
		"data-detail": "1",
		// #85a: never the string 'undefined' — fall back to the focused worker.
		"data-detail-for": node.id ?? view.worker ?? node.name ?? "selected",
		"data-detail-kind": node.kind,
		"data-foreign": node.foreign ? "1" : "0",
	});
	panel.appendChild(renderHeader(doc, node, view));
	panel.appendChild(renderStatusLine(doc, node));
	panel.appendChild(renderFields(doc, view));
	for (const chip of renderDegradedChips(doc, node.degraded)) panel.appendChild(chip);
	panel.appendChild(renderContextBar(doc, node));
	panel.appendChild(renderProgress(doc, node));
	const ask = renderAskBanner(doc, view);
	if (ask) panel.appendChild(ask);
	panel.appendChild(renderTabs(doc, view, ctx));
	if (ctx.tab === "console") panel.appendChild(renderConsolePane(doc, view));
	else panel.appendChild(renderStaticPane(doc, ctx.tab));
	const controls = renderControls(doc, view, ctx);
	if (controls) panel.appendChild(controls);
	// #93: an ask option fills the answer input (a click, not an inert span).
	const answerInput = findAttr(panel, "data-answer-input")[0] ?? null;
	if (answerInput) {
		for (const option of findAttr(panel, "data-ask-option")) on(option, "click", () => (answerInput.value = option.attributes?.["data-ask-option-text"] ?? ""));
	}
	root.appendChild(panel);
}

/**
 * The panel's subject resolution: the selected node, else the first task with
 * a worker (so a fresh dashboard always shows something actionable). Pure.
 */
export function resolveDetailSubject(state, ui) {
	const selected = ui?.selection ? state.byId.get(ui.selection) : null;
	if (selected) return selected;
	const task = state.nodes.find((n) => n.kind === "task" && (n.workers || []).length > 0);
	if (task) return task;
	return state.nodes.find((n) => n.kind === "session") ?? null;
}

/** The worker a detail panel shows: the UI focus, else the subject's own. */
export function pickWorker(subject, ui) {
	if (subject.kind === "task") {
		const workers = subject.workers || [];
		if (ui.focusWorker) {
			const hit = workers.find((w) => w.name === ui.focusWorker);
			if (hit) return hit;
		}
		return workers.find((w) => w.sessionId) || workers[0] || null;
	}
	if (subject.worker) return { name: subject.worker, sessionId: subject.id, ask: subject.ask };
	return null;
}
