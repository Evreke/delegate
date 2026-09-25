/**
 * swarm-console-rest-check — issue #52 acceptance 1/3/4/5/6/7 (ARCHITECTURE
 * §4.2.5, Law 1/Law 8/Law 13): the worker-console REST endpoint
 * `GET /api/workers/:id/console?offset=<n>` as observed by an HTTP client.
 *
 * Run with: bun test/swarm-console-rest-check.ts   (from repo root)
 *
 * The WS live-tail (`/api/workers/:id/console/stream`) has its own check
 * (test/swarm-console-ws-check.ts). This file covers:
 *   C1  identity + ownership: the fixture worker resolves; a foreign-owned
 *       worker, an unknown id and a task id are refused IDENTICALLY with
 *       E_CONSOLE_WORKER_REFUSED (fail-closed regression, acceptance 4).
 *   C2  rpc-style backend: live console frames via REST; golden envelope
 *       (schemaVersion, fixed shape, acceptance 6); offset reconnects never
 *       duplicate or lose bytes inside the retained window (acceptance 1).
 *   C3  ended workers: state transitions to ended-with-retained-backlog
 *       (backend retains) and ended (backend dropped) — both golden-pinned
 *       (acceptance 2).
 *   C4  backend honesty: a transport without console capture returns
 *       state "unavailable" + E_CONSOLE_UNAVAILABLE + hint, HTTP 200, no
 *       crash/hang (acceptance 3). A capture that throws degrades to the
 *       same structured shape instead of a 500 (advisory, Law 8).
 *   C5  buffer cap: ConsoleBacklog keeps retainedBytes <= DEFAULT_MAX_BYTES
 *       (drop-oldest) and the endpoint flags a below-frontier offset with
 *       dropped/oldestOffset (acceptance 5).
 *   C6  usage: non-numeric/negative offsets are 400 E_CONSOLE_USAGE.
 *
 * Fail-fast (AGENTS.md command discipline): top-level watchdog; every fetch
 * is loopback and bounded by it. Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { FidelityStore } from "../src/stream-seam/fidelity-store.ts";
import { sessionIdFor } from "../src/swarm/nodes.ts";
import type { SwarmGraph } from "../src/swarm/graph.ts";
import type { AgentStatusName } from "../src/host.ts";

const watchdog = setTimeout(() => {
	console.error("swarm-console-rest-check WATCHDOG TIMEOUT");
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

const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-console-rest-"));
const AGENT = join(SANDBOX, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.SWARM_JOURNAL_DB = join(SANDBOX, "journal", "events.db");

const ORCH = "/sessions/orch.jsonl";
const OTHER = "/sessions/other.jsonl";
const W1 = "/sessions/w1.jsonl";
const W2 = "/sessions/w2.jsonl";

/** A worker fixture graph: w1 owned by ORCH, w2 owned by OTHER. */
function fixtureGraph(): SwarmGraph {
	const orchId = sessionIdFor(ORCH);
	const otherId = sessionIdFor(OTHER);
	const w1Id = sessionIdFor(W1);
	const w2Id = sessionIdFor(W2);
	const session = (id: string, path: string, isWorker: boolean) => ({
		kind: "session" as const,
		id,
		sessionPath: path,
		role: isWorker ? ("worker" as const) : ("orchestrator" as const),
		isWorker,
		ownsChildren: !isWorker,
		tasks: ["alpha"],
		degraded: [],
	});
	return {
		schemaVersion: 1,
		available: true,
		sources: { journal: true, manifests: true, liveStatus: true, usage: false },
		nodes: [
			session(orchId, ORCH, false),
			session(otherId, OTHER, false),
			session(w1Id, W1, true),
			session(w2Id, W2, true),
			{
				kind: "task",
				id: "alpha",
				workers: [
					{ name: "w1", run: 1, sessionId: w1Id, sessionPath: W1, manifestRef: { task: "alpha", worker: "w1", run: 1 }, degraded: [] },
					{ name: "w2", run: 1, sessionId: w2Id, sessionPath: W2, manifestRef: { task: "alpha", worker: "w2", run: 1 }, degraded: [] },
				],
				degraded: [],
			},
		],
		edges: [
			{ kind: "spawned_by", from: w1Id, to: orchId },
			{ kind: "spawned_by", from: w2Id, to: otherId },
			{ kind: "spawned_by", from: "alpha", to: orchId },
		],
		orphans: [],
	};
}

function workerId(path: string): string {
	return sessionIdFor(path);
}

/** The rpc-shaped fake: the real FidelityStore behind the seam, like the
 *  rpc adapter — retention/close/forget semantics included. */
class FakeConsoleTransport {
	readonly store = new FidelityStore({ cap: 100 });
	readonly names = new Set<string>();
	statuses: Array<{ name: string; status: AgentStatusName; placementRef?: string }> = [];
	/** Fault injection: throw from streamConsole while still listed live. */
	throwOnStream = false;

	backendName() {
		return "fake";
	}
	add(name: string) {
		this.names.add(name);
		this.statuses.push({ name, status: "working", placementRef: `fake:${name}` });
	}
	end(name: string) {
		this.statuses = this.statuses.map((s) => (s.name === name ? { ...s, status: "done" as AgentStatusName } : s));
		this.store.close(name);
	}
	forget(name: string) {
		this.names.delete(name);
		this.statuses = this.statuses.filter((s) => s.name !== name);
		this.store.forget(name);
	}
	async listStatuses() {
		return this.statuses.map((s) => ({ ...s }));
	}
	async readConsole(name: string) {
		if (!this.names.has(name)) throw new Error(`no live agent ${name}`);
		return this.store.snapshot(name, 4000) ?? "";
	}
	streamConsole(name: string, opts?: { afterSeq?: number }) {
		if (this.throwOnStream) throw new Error("injected console failure");
		if (!this.names.has(name)) throw new Error(`no live agent ${name}`);
		return this.store.subscribe(name, { fromCursor: opts?.afterSeq ?? 0 });
	}
}

/** A herdr-shaped fake: no console capture methods at all. */
const capturelessTransport = () => ({
	backendName: () => "herdr",
	listStatuses: async () => [] as Array<{ name: string; status: AgentStatusName; placementRef?: string }>,
});

type Handle = { stop(): void; port: number; address: string };

async function main(): Promise<void> {
	const { mountSwarmServer } = await import("../src/swarm-server/mount.ts");
	const { ConsoleBacklog } = await import("../src/swarm-server/console-buffer.ts");
	const { resolveConsoleTarget } = await import("../src/swarm-server/console.ts");

	const env = (): NodeJS.ProcessEnv => ({ ...process.env, SWARM_SERVER_ENABLED: "1", SWARM_SERVER_PORT: "0" });
	const get = async (port: number, path: string): Promise<{ status: number; body: string }> => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`);
		return { status: res.status, body: await res.text() };
	};
	const mounted: Handle[] = [];
	const mount = async (transport: unknown): Promise<Handle> => {
		// The registry key IS the ownership self: mount as the fixture's owner
		// (ORCH) so the gate proves ownership; each scenario stops its handle.
		const h = await mountSwarmServer({ sessionFile: ORCH, transport: transport as never, graph: fixtureGraph(), env: env() });
		if (!h) throw new Error("mount failed");
		mounted.push(h);
		return h;
	};

	// C1 — identity + ownership (fail-closed)
	{
		const graph = fixtureGraph();
		const mine = resolveConsoleTarget(graph, workerId(W1), ORCH);
		check("C1.1 an owned worker session resolves", mine.ok === true && mine.target.name === "w1" && mine.target.task === "alpha", JSON.stringify(mine));
		const foreign = resolveConsoleTarget(graph, workerId(W2), ORCH);
		check("C1.2 a foreign-owned worker is refused", foreign.ok === false, JSON.stringify(foreign));
		const unknown = resolveConsoleTarget(graph, "does-not-exist", ORCH);
		check("C1.3 an unknown node id is refused", unknown.ok === false, JSON.stringify(unknown));
		const taskNode = resolveConsoleTarget(graph, "alpha", ORCH);
		check("C1.4 a task node id is refused (not a worker session)", taskNode.ok === false, JSON.stringify(taskNode));
		const noSelf = resolveConsoleTarget(graph, workerId(W1), undefined);
		check("C1.5 a degraded self-id is refused (no-self-id, no escape)", noSelf.ok === false, JSON.stringify(noSelf));
	}

	// C2 — live console frames + offset reconnect (golden envelope)
	{
		const t = new FakeConsoleTransport();
		t.add("w1");
		t.store.append("w1", "raw", "hello ");
		t.store.append("w1", "raw", "world");
		const h = await mount(t);

		const first = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console`);
		const golden = `{"ok":true,"schemaVersion":1,"worker":"w1","nodeId":${JSON.stringify(workerId(W1))},"task":"alpha","state":"live","chunk":"hello world","nextOffset":11,"oldestOffset":0,"dropped":false}`;
		check("C2.1 GET console offset 0 → byte-exact live envelope (schemaVersion 1)", first.status === 200 && first.body === golden, `${first.status} ${first.body}`);

		t.store.append("w1", "raw", "!");
		const second = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console?offset=11`);
		const secondJson = JSON.parse(second.body) as { chunk: string; nextOffset: number };
		check("C2.2 reconnect with nextOffset → only the new bytes (no dup)", second.status === 200 && secondJson.chunk === "!" && secondJson.nextOffset === 12, second.body);

		t.store.append("w1", "raw", "more");
		const third = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console?offset=12`);
		const thirdJson = JSON.parse(third.body) as { chunk: string };
		const joined = "hello world" + secondJson.chunk + thirdJson.chunk;
		check("C2.3 the paged reads reassemble the transcript exactly (no loss)", joined === "hello world!more", joined);

		const usage = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console?offset=abc`);
		let usageJson: { error?: { code?: string } } | null = null;
		try {
			usageJson = JSON.parse(usage.body) as { error?: { code?: string } };
		} catch {
			/* detail below */
		}
		check("C6.1 non-numeric offset → 400 E_CONSOLE_USAGE", usage.status === 400 && usageJson?.error?.code === "E_CONSOLE_USAGE", usage.body);
		const neg = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console?offset=-1`);
		check("C6.2 negative offset → 400 E_CONSOLE_USAGE", neg.status === 400, neg.body);
		h.stop();
	}

	// C3 — ended variants
	{
		const t = new FakeConsoleTransport();
		t.add("w1");
		t.store.append("w1", "raw", "bye");
		const h = await mount(t);
		await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console`);
		t.end("w1");
		const endedRetained = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console`);
		const gEndedRetained = `{"ok":true,"schemaVersion":1,"worker":"w1","nodeId":${JSON.stringify(workerId(W1))},"task":"alpha","state":"ended-with-retained-backlog","chunk":"bye","nextOffset":3,"oldestOffset":0,"dropped":false}`;
		check("C3.1 ended + backend retains → ended-with-retained-backlog (golden)", endedRetained.status === 200 && endedRetained.body === gEndedRetained, endedRetained.body);

		t.forget("w1");
		const ended = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console`);
		const gEnded = `{"ok":true,"schemaVersion":1,"worker":"w1","nodeId":${JSON.stringify(workerId(W1))},"task":"alpha","state":"ended","chunk":"","nextOffset":0,"oldestOffset":0,"dropped":false}`;
		check("C3.2 ended + backend dropped → ended (golden)", ended.status === 200 && ended.body === gEnded, ended.body);
		h.stop();

		// A server that first SEES an ended-but-retained worker still seeds its backlog.
		const t2 = new FakeConsoleTransport();
		t2.add("w1");
		t2.store.append("w1", "raw", "history");
		t2.end("w1");
		const h2 = await mount(t2);
		const cold = await get(h2.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console`);
		const coldJson = JSON.parse(cold.body) as { state: string; chunk: string };
		check("C3.3 cold read of an ended-retained worker serves the retained backlog", coldJson.state === "ended-with-retained-backlog" && coldJson.chunk === "history", cold.body);
		h2.stop();
	}

	// C4 — backend honesty + advisory capture failure
	{
		const h = await mount(capturelessTransport());
		const r = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console`);
		const j = JSON.parse(r.body) as { ok: boolean; state: string; chunk: string; error?: { code?: string; hint?: string } };
		check(
			"C4.1 captureless backend → HTTP 200, state unavailable, E_CONSOLE_UNAVAILABLE + hint (never fabricated)",
			r.status === 200 && j.ok === true && j.state === "unavailable" && j.chunk === "" && j.error?.code === "E_CONSOLE_UNAVAILABLE" && typeof j.error?.hint === "string" && j.error.hint.length > 0,
			r.body,
		);
		h.stop();

		const t = new FakeConsoleTransport();
		t.add("w1");
		t.throwOnStream = true;
		const h2 = await mount(t);
		const r2 = await get(h2.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console`);
		const j2 = JSON.parse(r2.body) as { state: string; error?: { code?: string } };
		check("C4.2 a throwing console stream degrades to unavailable (advisory, no 500)", r2.status === 200 && j2.state === "unavailable" && j2.error?.code === "E_CONSOLE_UNAVAILABLE", r2.body);
		const healthy = await get(h2.port, "/api/version");
		check("C4.3 a console failure leaves the rest of the read server healthy (advisory by contract)", healthy.status === 200 && healthy.body.includes('"ok":true'), `${healthy.status} ${healthy.body}`);
		h2.stop();
	}

	// C5 — bounded buffer
	{
		const b = new ConsoleBacklog();
		for (let i = 0; i < 20; i++) b.append("x".repeat(5000));
		check(
			"C5.1 ConsoleBacklog keeps retainedBytes <= DEFAULT_MAX_BYTES (drop-oldest)",
			b.retainedBytes() <= DEFAULT_MAX_BYTES && b.oldestOffset() > 0,
			`bytes=${b.retainedBytes()} oldest=${b.oldestOffset()}`,
		);

		const t = new FakeConsoleTransport();
		t.add("w1");
		for (let i = 0; i < 20; i++) t.store.append("w1", "raw", "y".repeat(5000));
		const h = await mount(t);
		const r = await get(h.port, `/api/workers/${encodeURIComponent(workerId(W1))}/console?offset=0`);
		const j = JSON.parse(r.body) as { dropped: boolean; oldestOffset: number; chunk: string };
		check(
			"C5.2 a below-frontier offset is flagged dropped + oldestOffset, chunk stays bounded",
			r.status === 200 && j.dropped === true && j.oldestOffset > 0 && Buffer.byteLength(j.chunk, "utf8") <= DEFAULT_MAX_BYTES,
			`dropped=${j.dropped} oldest=${j.oldestOffset} bytes=${Buffer.byteLength(j.chunk, "utf8")}`,
		);
		h.stop();
	}

	// C7 — refusals over HTTP (acceptance 4 regression)
	{
		const t = new FakeConsoleTransport();
		t.add("w1");
		const h = await mount(t);
		for (const [label, id] of [
			["foreign worker", workerId(W2)],
			["unknown id", "nope"],
			["task id", "alpha"],
		] as const) {
			const r = await get(h.port, `/api/workers/${encodeURIComponent(id)}/console`);
			const j = JSON.parse(r.body) as { ok: boolean; error?: { code?: string; hint?: string } };
			check(
				`C7 refusal (${label}) → 404 E_CONSOLE_WORKER_REFUSED, fail-closed`,
				r.status === 404 && j.ok === false && j.error?.code === "E_CONSOLE_WORKER_REFUSED" && typeof j.error?.hint === "string",
				`${r.status} ${r.body}`,
			);
		}
		h.stop();
	}

	for (const h of mounted) h.stop();
}

await main()
	.then(() => {
		clearTimeout(watchdog);
		console.log(failures === 0 ? "\nALL CONSOLE REST CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch((err) => {
		clearTimeout(watchdog);
		console.error("swarm-console-rest-check CRASHED", err);
		process.exit(1);
	});