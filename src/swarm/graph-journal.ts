/**
 * pi-delegate — src/swarm/graph-journal.ts — SwarmGraph journal projection.
 *
 * MODULE_CONTRACT — the journal-input fold of the SwarmGraph projector
 * (issue #29, ARCHITECTURE §4.1.2/§4.1.5). Pure and total: given the journal
 * events it contributes the task ids, session ids (+ paths learned from
 * `stamp` {field:"sessionPath"} rows) and the v1 edges (`spawned_by` from
 * `spawn`, `collected` from `collect`, `retired` from `retire`). NO writes,
 * never throws. Law 5 split out of ./graph-build.ts.
 *
 * The manifest projection remains the primary source for worker embodiments;
 * this fold is what lets a journal-only projection still produce session/task
 * nodes and edges (the two storage inputs are independently degraded).
 */

import type { JournalEvent } from "./journal-read.ts";
import { sessionIdFor } from "./nodes.ts";
import type { SwarmEdge } from "./edges.ts";

export interface JournalSessionContribution {
	id: string;
	path?: string;
	tasks: string[];
	/** Min `depth` learned from this session's `spawn` events (§4.1.5/#28). */
	depth?: number;
}

export interface JournalProjection {
	tasks: string[];
	sessions: JournalSessionContribution[];
	/** Per-task min `depth` from the task's `spawn` payloads. */
	taskDepths: Array<{ id: string; depth: number }>;
	edges: SwarmEdge[];
}

function nonEmpty(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Fold journal events into task/session contributions + v1 edges. Pure. */
export function projectJournal(events: JournalEvent[]): JournalProjection {
	const tasks = new Set<string>();
	const sessions = new Map<string, { path?: string; tasks: Set<string> }>();
	const edges: SwarmEdge[] = [];
	const stamped = new Map<string, string>();
	const sessionDepths = new Map<string, number[]>();
	const taskDepths = new Map<string, number>();
	const key = (sessionId: string, task: string, worker: string): string => `${sessionId}\u0000${task}\u0000${worker}`;

	const touch = (id: string, task?: string, path?: string): void => {
		let acc = sessions.get(id);
		if (!acc) {
			acc = { path, tasks: new Set() };
			sessions.set(id, acc);
		} else if (acc.path === undefined && path !== undefined) {
			acc.path = path;
		}
		if (task !== undefined) acc.tasks.add(task);
	};

	for (const e of events) {
		const task = nonEmpty(e.task);
		const sessionId = nonEmpty(e.sessionId);
		if (task !== undefined) tasks.add(task);
		if (sessionId !== undefined) touch(sessionId, task);
		if (e.kind === "stamp" && e.worker && task !== undefined && sessionId !== undefined) {
			const payload = e.payload as { field?: unknown; value?: unknown } | null;
			const field = payload !== null && typeof payload === "object" ? nonEmpty(payload.field) : undefined;
			const value = payload !== null && typeof payload === "object" ? nonEmpty(payload.value) : undefined;
			if (field === "sessionPath" && value !== undefined) {
				stamped.set(key(sessionId, task, e.worker), value);
				touch(sessionIdFor(value), task, value);
			}
		}
	}

	for (const e of events) {
		const task = nonEmpty(e.task);
		const sessionId = nonEmpty(e.sessionId);
		if (task === undefined || sessionId === undefined) continue;
		const childPath = e.worker ? stamped.get(key(sessionId, task, e.worker)) : undefined;
		const childId = childPath === undefined ? undefined : sessionIdFor(childPath);
		if (e.kind === "spawn") {
			const payload = e.payload as { depth?: unknown } | null;
			const depth =
				payload !== null && typeof payload === "object" && typeof payload.depth === "number" && Number.isFinite(payload.depth)
					? payload.depth
					: undefined;
			if (childId !== undefined) {
				edges.push({ kind: "spawned_by", from: childId, to: sessionId });
				if (depth !== undefined) {
					const list = sessionDepths.get(childId);
					if (list === undefined) sessionDepths.set(childId, [depth]);
					else list.push(depth);
				}
			}
			edges.push({ kind: "spawned_by", from: task, to: sessionId });
			if (depth !== undefined) {
				const current = taskDepths.get(task);
				taskDepths.set(task, current === undefined ? depth : Math.min(current, depth));
			}
		} else if (e.kind === "collect" && childId !== undefined) {
			edges.push({ kind: "collected", from: childId, to: task, at: e.ts });
		} else if (e.kind === "retire" && childId !== undefined) {
			edges.push({ kind: "retired", from: childId, to: task, at: e.ts });
		}
	}

	return {
		tasks: [...tasks],
		sessions: [...sessions.entries()].map(([id, acc]) => {
			const out: JournalSessionContribution = { id, tasks: [...acc.tasks] };
			if (acc.path !== undefined) out.path = acc.path;
			const depths = sessionDepths.get(id);
			if (depths !== undefined && depths.length > 0) out.depth = Math.min(...depths);
			return out;
		}),
		taskDepths: [...taskDepths.entries()].map(([id, depth]) => ({ id, depth })),
		edges,
	};
}