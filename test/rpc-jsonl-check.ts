/**
 * rpc-jsonl-check — strict byte-buffer JSONL parsing for the rpc adapter's
 * stdout pump (src/host/rpc.ts pumpStdout) and its leaf parser module
 * (src/host/rpc-jsonl.ts), with NO real pi process and NO LLM call.
 *
 * RED-GREEN discipline (issue #13): the first behavior — a JSONL record
 * carrying a multi-byte UTF-8 character split strictly INSIDE that character
 * across two stdout chunks must round-trip EXACTLY — failed against the
 * per-chunk string-decoding pump (chunk.toString("utf8") mangles the split
 * character into U+FFFD). The leaf parser (Buffer accumulation, LF-only
 * framing, one CR strip) is the fix; the pump consumes it.
 *
 * Run with: bun test/rpc-jsonl-check.ts   (from repo root)
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { DEFAULT_MAX_RECORD_BYTES, RpcJsonlParser } from "../src/host/rpc-jsonl.ts";
import { createRpcTransport } from "../src/host/rpc.ts";
import type { Placement, Transport } from "../src/host.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// Fake child process — the injected seam double (mirrors rpc-host-unit-check)
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
	readonly kills: string[] = [];
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin: { write: (s: string | Buffer) => boolean };

	constructor() {
		super();
		this.stdin = {
			write: (s: string | Buffer): boolean => {
				const cmd = JSON.parse(String(s)) as { type?: string; id?: string };
				if (cmd.type === "get_state") {
					queueMicrotask(() =>
						this.stdout.emit(
							"data",
							`${JSON.stringify({ type: "response", command: "get_state", id: cmd.id, success: true, data: { sessionFile: "/tmp/rpc-jsonl-fake-session.jsonl" } })}\n`,
						),
					);
				}
				return true;
			},
		};
	}

	kill(): this {
		this.kills.push("SIGKILL");
		return this;
	}

	simulateExit(code: number | null, signal: string | null): void {
		this.emit("exit", code, signal);
	}
}

// ---------------------------------------------------------------------------
// Rig: one adapter + one fake child, driven through the REAL pump
// ---------------------------------------------------------------------------

const WORKTREE_ROOT = join(tmpdir(), `rpc-jsonl-wt-${process.pid}`);
const repos: string[] = [];

interface Rig {
	host: Transport;
	child: FakeChildProcess;
	name: string;
}

async function startWithFakeChild(): Promise<Rig> {
	const child = new FakeChildProcess();
	const host = createRpcTransport({
		worktreeRoot: WORKTREE_ROOT,
		subOrchestrator: false,
		spawnProcess: () => child as unknown as ChildProcess,
	});
	const repo = mkdtempSync(join(tmpdir(), "rpc-jsonl-repo-"));
	repos.push(repo);
	const placement = await host.place({ mode: "tab", repoPath: repo, branch: "", label: "jsonl" });
	const name = "jsonl-worker";
	await host.startAgent({
		name,
		placementRef: placement.placementRef ?? "",
		provider: "p",
		model: "m",
		thinking: "low",
		timeoutMs: 5_000,
	});
	return { host, child, name };
}

/** Split a UTF-8 buffer at the given BYTE index (may land inside a multi-byte
 *  character) and emit both halves as separate stdout data events. */
function emitSplit(child: FakeChildProcess, text: string, splitByte: number): void {
	const buf = Buffer.from(text, "utf8");
	child.stdout.emit("data", buf.subarray(0, splitByte));
	child.stdout.emit("data", buf.subarray(splitByte));
}

try {
	// --- Slice 1 (issue #13): mid-character chunk split round-trips --------
	{
		// The first Cyrillic character "П" of the assistant text starts at a
		// known byte offset; splitByte lands strictly inside its two UTF-8
		// bytes. Worked example (independent source): the record below has an
		// all-ASCII prefix up to and including the opening quote of the text
		// value; +1 puts the split inside "П" (bytes 0xD0 0x9F).
		const record =
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Привет мир"}]}}\n';
		const asciiPrefix = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"'.length;
		const splitByte = asciiPrefix + 1; // inside "П" (bytes 0xD0 0x9F)

		// Seam 1 — the parser module's public interface: feed byte chunks in,
		// records out, exact round-trip.
		{
			const parser = new RpcJsonlParser();
			const buf = Buffer.from(record, "utf8");
			const recs = [...parser.feed(buf.subarray(0, splitByte)), ...parser.feed(buf.subarray(splitByte))];
			check(
				"parser: mid-Cyrillic split round-trips exactly",
				recs.length === 1 &&
					!recs[0].malformed &&
					(recs[0].parsed as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text ===
						"Привет мир",
				JSON.stringify(recs[0].raw.toString("utf8")),
			);
			// The incomplete final record is retained until the next chunk (or
			// close) — close() flushes the retained BYTES verbatim (the record is
			// incomplete by construction, so exactness is byte equality, and the
			// mid-character cut is NOT a decode corruption: no decode happened).
			{
				const p2 = new RpcJsonlParser();
				const prefixBytes = Buffer.from(record, "utf8").subarray(0, splitByte);
				const half = p2.feed(prefixBytes);
				const rest = p2.close();
				check(
					"parser: incomplete final buffer retained, close() flushes the exact bytes",
					half.length === 0 && rest.length === 1 && rest[0].raw.equals(prefixBytes),
					JSON.stringify(rest.map((r) => r.raw.toString("utf8"))),
				);
			}
		}

		// Seam 3 — the adapter's public path: the corrupted-decode regression.
		// The pump must deliver the assistant text VERBATIM via readConsole.
		{
			const rig = await startWithFakeChild();
			emitSplit(rig.child, record, splitByte);
			rig.child.simulateExit(0, null);
			const consoleText = await rig.host.readConsole(rig.name);
			check(
				"pump: mid-Cyrillic split reaches readConsole verbatim (no U+FFFD)",
				consoleText.includes("assistant: Привет мир") && !consoleText.includes("\uFFFD"),
				JSON.stringify(consoleText),
			);
		}
	}
	// --- Slice 2 (issue #13): per-record size cap --------------------------
	{
		// Worked example: cap 32 bytes; the fed record is 100 bytes + LF.
		const record = `${"x".repeat(100)}\n`;
		let oversizeSeen = -1;
		const parser = new RpcJsonlParser({ maxRecordBytes: 32, onOversized: (size) => (oversizeSeen = size) });
		const recs = parser.feed(Buffer.from(record, "utf8"));
		check(
			"parser: record over maxRecordBytes is flagged oversize, reported, and not retained",
			recs.length === 1 && recs[0].oversized && oversizeSeen === 100 && recs[0].parsed === null,
			JSON.stringify({ oversized: (recs[0] as { oversized?: boolean }).oversized, oversizeSeen }),
		);
		// A subsequent normal record parses fine — the oversize did not wedge the stream.
		const next = parser.feed(Buffer.from('{"type":"agent_end"}\n', "utf8"));
		check(
			"parser: stream continues after an oversize record",
			next.length === 1 && !next[0].malformed && (next[0].parsed as { type?: string }).type === "agent_end",
		);
		// The default cap is 8 MiB.
		check("parser: DEFAULT_MAX_RECORD_BYTES is 8 MiB", DEFAULT_MAX_RECORD_BYTES === 8 * 1024 * 1024);
	}
} finally {
	for (const repo of repos) rmSync(repo, { recursive: true, force: true });
	rmSync(WORKTREE_ROOT, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\nrpc-jsonl-check: ${failures} failure(s)`);
	process.exit(1);
}
console.log("\nrpc-jsonl-check: all green");
process.exit(0);
