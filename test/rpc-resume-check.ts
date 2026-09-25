/**
 * rpc-resume-check — durable rpc child sessions (issue #16).
 *
 * Deterministic checks for the two halves of the primitive:
 *   A. the RESUME affordance on the rpc adapter (src/host/rpc.ts):
 *      a resume request produces a start whose extraArgs carry the documented
 *      `--session <path>` argument, and a resume with no stored session (or a
 *      vanished session file) refuses with the structured E_START shape;
 *   B. PERSISTENCE: the sessionPath the adapter captures (StartResult) is
 *      stamped into the worker's manifest entry; the field round-trips through
 *      the manifest store and legacy entries without it keep parsing.
 *
 * No real pi process, no real time, no LLM: the adapter runs on an injected
 * child-process factory (the same test seam as rpc-host-unit-check.ts) and the
 * spawn-flow leg runs on an in-memory transport double. The "prior session's
 * context" is a scripted session JSONL fixture on disk — the exact file the
 * resumed child is pointed at.
 *
 * Run with: bun test/rpc-resume-check.ts   (from repo root)
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Placement, PlacementReq, Transport } from "../src/host.ts";
import { DelegateErrorImpl, sessionHasReply } from "../src/host.ts";
import { readManifest, updateManifest } from "../src/manifest-store.ts";
import { registerDelegateTool } from "../src/spawn.ts";
import { createRpcTransport } from "../src/host/rpc.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function isE(err: unknown, code: string): boolean {
	return err instanceof DelegateErrorImpl && err.code === code;
}

// ---------------------------------------------------------------------------
// Fixtures — a scripted session file ("the prior session's context") and the
// sandbox exchange root for the persistence leg.
// ---------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), `rpc-resume-${process.pid}-`));
const SESSION_FIXTURE = join(ROOT, "prior-session.jsonl");
writeFileSync(
	SESSION_FIXTURE,
	[
		JSON.stringify({ type: "session", version: 3 }),
		JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "EARLIER TASK: build the thing" }] },
		}),
		JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "PRIOR-CONTEXT-SENTINEL: half done" }] },
		}),
		"",
	].join("\n"),
);

const EXCHANGE_SANDBOX = mkdtempSync(join(tmpdir(), "rpc-resume-exchange-"));
process.env.PI_DELEGATE_EXCHANGE_ROOT = EXCHANGE_SANDBOX;

// ---------------------------------------------------------------------------
// Fake child process — the injected spawn seam (mirrors rpc-host-unit-check)
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
	readonly writes: Array<Record<string, unknown>> = [];
	readonly kills: string[] = [];
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin: { write: (s: string | Buffer) => boolean };
	constructor(private readonly sessionFile: string) {
		super();
		this.stdin = {
			write: (s: string | Buffer): boolean => {
				const cmd = JSON.parse(String(s)) as Record<string, unknown> & { id?: string };
				this.writes.push(cmd);
				if (cmd.type === "get_state") {
					queueMicrotask(() =>
						this.emitLine({
							type: "response",
							command: "get_state",
							id: cmd.id,
							success: true,
							data: { sessionFile },
						}),
					);
				}
				return true;
			},
		};
	}
	kill(signal?: NodeJS.Signals): this {
		this.kills.push(signal ?? "SIGTERM");
		return this;
	}
	emitLine(obj: unknown): void {
		this.stdout.emit("data", `${JSON.stringify(obj)}\n`);
	}
}

interface ResumeHost {
	place(req: PlacementReq): Promise<Placement>;
	resumeAgent(req: {
		name: string;
		placementRef: string;
		sessionPath?: string;
		provider: string;
		model: string;
		thinking: string;
		timeoutMs: number;
	}): Promise<{ name: string; sessionPath?: string }>;
}

const repos: string[] = [];

/** An rpc adapter with a scripted child; the recorded spawn args are returned
 *  through a mutable holder so the resume assertions can read them. */
function makeResumeHost(sessionFile: string, opts: { sessionPath?: string } = {}): {
	host: ResumeHost;
	child: FakeChildProcess;
	captured: { args?: readonly string[]; options?: SpawnOptions };
} {
	const child = new FakeChildProcess(sessionFile);
	const captured: { args?: readonly string[]; options?: SpawnOptions } = {};
	const transport = createRpcTransport({
		worktreeRoot: join(ROOT, "wt"),
		subOrchestrator: false,
		spawnProcess: (_cmd, args, options) => {
			captured.args = [...args];
			captured.options = options;
			return child as unknown as ChildProcess;
		},
	});
	return { host: transport as unknown as ResumeHost, child, captured };
}

async function newPlacement(host: ResumeHost): Promise<string> {
	const repo = mkdtempSync(join(tmpdir(), "rpc-resume-repo-"));
	repos.push(repo);
	const p = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "resume" });
	return p.placementRef ?? "";
}

try {
	// --- A0: the fixture really carries prior context ----------------------
	{
		check(
			"A0.1 the scripted session fixture is a real pi session with an assistant reply (prior context present)",
			sessionHasReply(SESSION_FIXTURE) && readFileSync(SESSION_FIXTURE, "utf8").includes("PRIOR-CONTEXT-SENTINEL"),
		);
	}

	// --- A1..A4: the pure resume-argument affordance -----------------------
	{
		const rpcModule = (await import("../src/host/rpc.ts")) as unknown as Record<string, unknown>;
		const resumeExtraArgs = rpcModule.resumeExtraArgs as ((p: unknown) => string[]) | undefined;

		const mapped = (() => {
			if (typeof resumeExtraArgs !== "function") return null;
			try {
				return resumeExtraArgs(SESSION_FIXTURE);
			} catch {
				return null;
			}
		})();
		check(
			"A1.1 resumeExtraArgs maps a stored session path to the documented ['--session', path] argument",
			JSON.stringify(mapped) === JSON.stringify(["--session", SESSION_FIXTURE]),
			JSON.stringify(mapped),
		);

		const refusesEmpty = (() => {
			if (typeof resumeExtraArgs !== "function") return null;
			try {
				resumeExtraArgs(undefined);
				return null;
			} catch (err) {
				return err;
			}
		})();
		check(
			"A1.2 a resume with NO stored session refuses with the structured E_START shape (code + guidance)",
			refusesEmpty !== null &&
				isE(refusesEmpty, "E_START") &&
				(refusesEmpty as DelegateErrorImpl).guidance.length > 0,
			String(refusesEmpty),
		);
	}

	// --- A2: the adapter resume produces a start whose args carry --session --
	{
		const { host, captured } = makeResumeHost(SESSION_FIXTURE);
		const ref = await newPlacement(host);
		let result: { name: string; sessionPath?: string } | null = null;
		let err: unknown = null;
		try {
			result = await host.resumeAgent({
				name: "resumed-worker",
				placementRef: ref,
				sessionPath: SESSION_FIXTURE,
				provider: "p",
				model: "m",
				thinking: "low",
				timeoutMs: 5_000,
			});
		} catch (e) {
			err = e;
		}
		const args = captured.args ?? [];
		const sessionIdx = args.indexOf("--session");
		check(
			"A2.1 the resumed start's extraArgs contain the stored session file (--session <fixture>)",
			err === null &&
				sessionIdx >= 0 &&
				args[sessionIdx + 1] === SESSION_FIXTURE &&
				args.includes("--mode") &&
				args[args.indexOf("--mode") + 1] === "rpc",
			`err=${String(err)} args=${JSON.stringify(args)}`,
		);
		check(
			"A2.2 the resumed child re-enters the SAME session file the fixture leads (context accumulation point)",
			result !== null && result.sessionPath === SESSION_FIXTURE,
			JSON.stringify(result ?? null),
		);
	}

	// --- A3: no stored session → E_START and NO child spawned ---------------
	{
		const { host, captured } = makeResumeHost(SESSION_FIXTURE);
		const ref = await newPlacement(host);
		let err: unknown = null;
		try {
			await host.resumeAgent({
				name: "no-session-worker",
				placementRef: ref,
				provider: "p",
				model: "m",
				thinking: "low",
				timeoutMs: 5_000,
			});
		} catch (e) {
			err = e;
		}
		check(
			"A3.1 a resume for a worker with no stored session fails with E_START and spawns nothing",
			isE(err, "E_START") && captured.args === undefined,
			`err=${String(err)} spawned=${JSON.stringify(captured.args)}`,
		);
	}

	// --- A4: a vanished session file is refused, not silently fresh-started --
	{
		const { host, captured } = makeResumeHost(SESSION_FIXTURE);
		const ref = await newPlacement(host);
		let err: unknown = null;
		try {
			await host.resumeAgent({
				name: "gone-session-worker",
				placementRef: ref,
				sessionPath: join(ROOT, "never-existed.jsonl"),
				provider: "p",
				model: "m",
				thinking: "low",
				timeoutMs: 5_000,
			});
		} catch (e) {
			err = e;
		}
		check(
			"A4.1 a resume whose stored session file is missing refuses with E_START (never a silent fresh start)",
			isE(err, "E_START") && captured.args === undefined,
			`err=${String(err)} spawned=${JSON.stringify(captured.args)}`,
		);
	}

	// --- B1..B2: the spawn flow stamps the captured sessionPath -------------
	{
		const taskDir = join(EXCHANGE_SANDBOX, "resume-task");
		mkdirSync(taskDir, { recursive: true });
		const repoDir = mkdtempSync(join(tmpdir(), "rpc-resume-spawnrepo-"));
		let seq = 0;
		const double: Transport = {
			place: async (_req: PlacementReq): Promise<Placement> => {
				const n = ++seq;
				return {
					kind: "tab",
					checkoutPath: repoDir,
					backend: "fake",
					placementRef: `fake:resume:${n}`,
				};
			},
			startAgent: async (req) => ({ name: req.name, sessionPath: SESSION_FIXTURE }),
			submitPrompt: async () => {},
			waitSettle: async () => ({ kind: "settled", status: "idle" }),
			getStatus: async () => null,
			listStatuses: async () => [],
			teardown: async () => ({ alreadyGone: false }),
			capabilities: () => ({ worktrees: true, authority: "root" }),
			backendName: () => "fake",
		};
		let capturedTool!: { execute: (...a: unknown[]) => Promise<unknown> };
		const fakePi = { registerTool: (tl: never) => (capturedTool = tl as never) };
		registerDelegateTool(fakePi as never, double);

		const briefPath = join(taskDir, "brief-persist-worker.md");
		writeFileSync(briefPath, "# brief persist\n\nOUTPUT: report-persist-worker.json\n");
		await capturedTool.execute(
			"t1",
			{
				name: "persist-worker",
				briefPath,
				mode: "shared",
				provider: "p",
				model: "m",
				thinking: "low",
				waitMs: 1000,
				repoPath: repoDir,
			},
			undefined,
			() => {},
			{ cwd: repoDir, hasUI: false },
		);

		const entry = readManifest(taskDir)?.workers.find((w) => w.name === "persist-worker");
		check(
			"B1.1 after start, the manifest entry carries the captured sessionPath",
			entry?.sessionPath === SESSION_FIXTURE,
			JSON.stringify(entry ?? null),
		);
		const raw = JSON.parse(readFileSync(join(taskDir, "manifest.json"), "utf8")) as {
			schemaVersion?: number;
			workers?: Array<{ sessionPath?: string }>;
		};
		check(
			"B1.2 the additive field lands on disk with NO schemaVersion bump (stays 1)",
			raw.schemaVersion === 1 && raw.workers?.[0]?.sessionPath === SESSION_FIXTURE,
			JSON.stringify(raw),
		);
	}

	// --- B2: round-trip through the manifest store + legacy tolerance -------
	{
		const dir = join(EXCHANGE_SANDBOX, "resume-roundtrip");
		const entry = {
			name: "roundtrip-worker",
			placement: { kind: "tab" as const, checkoutPath: ROOT, backend: "rpc" },
			briefPath: join(dir, "brief.md"),
			reportPath: join(dir, "report.json"),
			provider: "p",
			model: "m",
			thinking: "low",
			startedAt: "2026-01-01T00:00:00.000Z",
			sessionPath: SESSION_FIXTURE,
		};
		const written = await updateManifest(dir, (m) => ({ ...m, workers: [...m.workers, entry] }));
		const readBack = readManifest(dir);
		check(
			"B2.1 sessionPath round-trips through the manifest store byte-identically; schemaVersion stays 1",
			readBack?.workers[0]?.sessionPath === SESSION_FIXTURE && written.schemaVersion === 1,
			JSON.stringify(readBack?.workers[0] ?? null),
		);

		const legacyDir = join(EXCHANGE_SANDBOX, "resume-legacy");
		const { sessionPath: _omitted, ...legacyEntry } = entry;
		await updateManifest(legacyDir, (m) => ({ ...m, workers: [...m.workers, legacyEntry] }));
		const legacy = readManifest(legacyDir);
		check(
			"B2.2 a legacy entry without sessionPath parses unchanged (absent, not null)",
			legacy?.workers.length === 1 && legacy.workers[0]?.sessionPath === undefined,
			JSON.stringify(legacy?.workers[0] ?? null),
		);
	}
} finally {
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(EXCHANGE_SANDBOX, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nrpc-resume-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-resume-check: all green");
process.exit(0);
