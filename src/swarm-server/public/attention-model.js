/**
 * attention-model.js — the attention strip + queue read-model fold (#66, #83).
 *
 * `buildAttention(nodes, journal, expansion)` is a PURE projection of the
 * enriched node set into the attention surface: one item per OWN worker/node
 * (a foreign fleet never raises attention), severity-ordered, with chips that
 * exist ONLY while their kind has a non-zero count (a red `0 dead-reboot`
 * reads as a death). Split out of state.js (Law 5 size cap); no DOM, total
 * and pure.
 */

import { severityRank, worstSeverity } from "./degrade.js";

/** Attention strip + queue: OWN fleets only, one item per worker/node. */
export function buildAttention(nodes, journal, expansion) {
	const items = [];
	const seenWorkers = new Set();
	const degradeItem = (node) => {
		if (!node.degraded || node.degraded.length === 0) return;
		items.push({
			kind: "degraded",
			nodeId: node.id,
			worker: node.worker ?? null,
			severity: worstSeverity(node.degraded.map((d) => d.severity)),
			label: `degraded: ${node.id}`,
			detail: node.degraded.map((d) => d.flag).join(", "),
			focusIds: [node.id, node.parentId].filter(Boolean),
		});
	};
	const workerItem = (kind, workerName, taskId, sessionId, parentId, severity, detail) => {
		const key = `${taskId}:${workerName}`;
		if (seenWorkers.has(key)) return;
		seenWorkers.add(key);
		items.push({
			kind,
			nodeId: sessionId || taskId,
			worker: workerName,
			severity,
			label: `${kind}: ${workerName}`,
			detail,
			focusIds: [sessionId, taskId, parentId].filter(Boolean),
		});
	};
	for (const n of nodes) {
		if (n.foreign) continue;
		if (n.kind === "session") {
			if (n.worker) {
				if (n.ask) workerItem("ask", n.worker, n.task ?? n.id, n.id, n.parentId, "warn", n.ask.question);
				if (n.status === "dead") workerItem("dead-reboot", n.worker, n.task ?? n.id, n.id, n.parentId, "crit", "worker reaped as dead");
			}
			degradeItem(n);
		} else if (n.kind === "task") {
			for (const w of n.workers) {
				if (w.ask) workerItem("ask", w.name, n.id, w.sessionId, n.parentId, "warn", w.ask.question);
				if (w.status === "dead") workerItem("dead-reboot", w.name, n.id, w.sessionId, n.parentId, "crit", "worker reaped as dead");
			}
			degradeItem(n);
		}
	}
	items.sort((a, b) => {
		if (severityRank(a.severity) !== severityRank(b.severity)) return severityRank(b.severity) - severityRank(a.severity);
		if (a.label !== b.label) return a.label < b.label ? -1 : 1;
		return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
	});
	const askCount = items.filter((i) => i.kind === "ask").length;
	const deadCount = items.filter((i) => i.kind === "dead-reboot").length;
	const degradedCount = items.filter((i) => i.kind === "degraded").length;
	const clear = items.length === 0;
	// #83: a chip exists ONLY when its kind has a non-zero count — the strip is
	// the "what needs me?" answer and a red `0 dead-reboot` reads as a death.
	const chips = clear
		? [{ kind: "clear", label: "all clear", count: 0 }]
		: [
				{ kind: "ask", label: `${askCount} ask${askCount === 1 ? "" : "s"} waiting`, count: askCount },
				{ kind: "dead-reboot", label: `${deadCount} dead-reboot`, count: deadCount },
				{ kind: "degraded", label: `${degradedCount} degraded`, count: degradedCount },
			].filter((chip) => chip.count > 0);
	return { items, chips, clear, askCount, deadCount, degradedCount, expansion: expansion ?? null };
}
