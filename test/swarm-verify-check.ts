/**
 * swarm-verify-check — acceptance for the `swarm verify` read verb: the
 * aggregation chain check (child reports ↔ parent facts ↔ arithmetic).
 *
 * Run with: bun test/swarm-verify-check.ts   (from repo root)
 *
 * Covers:
 *   V1 happy fleet (parent + two children, consistent facts) → envelope
 *      ok:true, verify.ok:true, every check line pass;
 *   V2 parent partial_sum disagrees with the child-number sum → arithmetic
 *      fail, verify.ok:false;
 *   V3 parent claims a child number the child report does not carry → chain
 *      fail;
 *   V4 missing child report → presence fail for the child + chain fail for
 *      the parent (never a silence);
 *   V5 base-schema-invalid report → schema fail line;
 *   V6 usage guards: stray positional / unknown --task → E_SWARM_USAGE;
 *   V7 --task filters to the named task only.
 *
 * Exit 0 only if all checks pass. Fail-fast: bounded spawns + watchdog.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const watchdog = setTimeout(() => {
	console.error("swarm-verify-check WATCHDOG TIMEOUT");
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

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
const CLI = join(ROOT, "src", "swarm", "cli.ts");
const SANDBOX = mkdtempSync(join(tmpdir(), "swarm-verify-check-"));

function runCli(args: string[]): { status: number | null; json: Record<string, unknown> | null } {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	env.PI_DELEGATE_EXCHANGE_ROOT = SANDBOX;
	env.PI_CODING_AGENT_DIR = join(SANDBOX, "agent"); // hermetic: no live config
	const res = spawnSync("bun", [CLI, ...args], { env, encoding: "utf8", timeout: 15_000 });
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(res.stdout) as Record<string, unknown>;
	} catch {
		/* usage failures still emit the envelope; parse failure stays null */
	}
	return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Fixture: task dir + manifest (legacy backend-less workers are kept by the
// foreign-backend filter) + report writers.
// ---------------------------------------------------------------------------

function taskFixture(task: string, workers: string[]): string {
	const dir = join(SANDBOX, task);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				task,
				dir,
				workers: workers.map((name) => ({
					name,
					placement: { kind: "tab", checkoutPath: dir },
					briefPath: join(dir, `brief-${name}.md`),
					reportPath: join(dir, `report-${name}.json`),
					provider: "p",
					model: "m",
					thinking: "off",
					startedAt: "2026-01-01T00:00:00.000Z",
				})),
			},
			null,
			"\t",
		) + "\n",
		"utf8",
	);
	return dir;
}

function writeReport(dir: string, worker: string, report: Record<string, unknown>): string {
	const path = join(dir, `report-${worker}.json`);
	writeFileSync(path, JSON.stringify({ worker, status: "pass", artifacts: [], evidence: [], ...report }, null, "\t") + "\n", "utf8");
	return path;
}

function childReport(dir: string, worker: string, n: number): void {
	writeReport(dir, worker, { summary: `number=${n} chosen`, facts: [{ k: "number", v: String(n) }] });
}

function parentReport(dir: string, worker: string, claimed: Record<string, string>, sum: number): void {
	writeReport(dir, worker, {
		summary: `partial_sum=${sum} from ${Object.keys(claimed).join(", ")}`,
		facts: [
			...Object.entries(claimed).map(([k, v]) => ({ k, v })),
			{ k: "partial_sum", v: String(sum) },
		],
	});
}

type Line = { task: string; worker: string; check: string; status: string; detail: string };
type VerifyEnvelope = { ok: boolean; verb: string; verify: { ok: boolean; tasks: { task: string; ok: boolean; lines: Line[] }[] } };

function verifyEnvelope(args: string[]): { status: number | null; env: VerifyEnvelope | null } {
	const r = runCli(["verify", ...args]);
	return { status: r.status, env: r.json as unknown as VerifyEnvelope | null };
}

// ---------------------------------------------------------------------------
// V1 — happy fleet
// ---------------------------------------------------------------------------

{
	const dir = taskFixture("vtask1", ["v-child1", "v-child2", "v-parent"]);
	childReport(dir, "v-child1", 3);
	childReport(dir, "v-child2", 4);
	parentReport(dir, "v-parent", { "v-child1_number": "3", "v-child2_number": "4" }, 7);
	const { status, env } = verifyEnvelope([]);
	const task = env?.verify.tasks.find((t) => t.task === "vtask1");
	const line = (w: string, c: string) => task?.lines.find((l) => l.worker === w && l.check === c);
	check(
		"V1.1 happy fleet: exit 0, envelope ok, verify.ok true",
		status === 0 && env?.ok === true && env?.verify.ok === true,
		JSON.stringify(env)?.slice(0, 200),
	);
	check("V1.2 presence+schema pass for every worker", ["v-child1", "v-child2", "v-parent"].every((w) => line(w, "presence")?.status === "pass" && line(w, "schema")?.status === "pass"));
	check("V1.3 chain pass for both child-number facts", line("v-parent", "chain")?.status === "pass" && task?.lines.filter((l) => l.check === "chain").length === 2);
	check("V1.4 arithmetic pass for the consistent partial_sum", line("v-parent", "arithmetic")?.status === "pass");
}

// ---------------------------------------------------------------------------
// V2 — partial_sum disagrees with the child-number sum
// ---------------------------------------------------------------------------

{
	const dir = taskFixture("vtask2", ["v-child1", "v-child2", "v-parent"]);
	childReport(dir, "v-child1", 3);
	childReport(dir, "v-child2", 4);
	parentReport(dir, "v-parent", { "v-child1_number": "3", "v-child2_number": "4" }, 9);
	const { status, env } = verifyEnvelope(["--task", "vtask2"]);
	const task = env?.verify.tasks.find((t) => t.task === "vtask2");
	const arith = task?.lines.filter((l) => l.check === "arithmetic");
	check("V2.1 mismatching partial_sum → verify.ok false (exit stays 0 — a read verb ran)", status === 0 && env?.verify.ok === false);
	check("V2.2 arithmetic fail line names both numbers", arith?.length === 1 && arith[0].status === "fail" && arith[0].detail.includes("9") && arith[0].detail.includes("7"), JSON.stringify(arith));
}

// ---------------------------------------------------------------------------
// V3 — claimed child number ≠ child's own report
// ---------------------------------------------------------------------------

{
	const dir = taskFixture("vtask3", ["v-child1", "v-parent"]);
	childReport(dir, "v-child1", 3);
	parentReport(dir, "v-parent", { "v-child1_number": "8" }, 8);
	const { env } = verifyEnvelope(["--task", "vtask3"]);
	const chain = env?.verify.tasks.find((t) => t.task === "vtask3")?.lines.find((l) => l.check === "chain");
	check("V3.1 inflated child claim → chain fail naming both values", chain?.status === "fail" && chain.detail.includes("8") && chain.detail.includes("3"), JSON.stringify(chain));
}

// ---------------------------------------------------------------------------
// V4 — missing child report: presence fail + parent chain fail
// ---------------------------------------------------------------------------

{
	const dir = taskFixture("vtask4", ["v-child1", "v-parent"]);
	// v-child1 deliberately has NO report file.
	parentReport(dir, "v-parent", { "v-child1_number": "5" }, 5);
	const { env } = verifyEnvelope(["--task", "vtask4"]);
	const task = env?.verify.tasks.find((t) => t.task === "vtask4");
	check("V4.1 missing child report → presence fail for the child", task?.lines.some((l) => l.worker === "v-child1" && l.check === "presence" && l.status === "fail") === true);
	check("V4.2 parent chain fails on the unreadable child (never a silence)", task?.lines.some((l) => l.worker === "v-parent" && l.check === "chain" && l.status === "fail") === true);
	check("V4.3 verify.ok false", env?.verify.ok === false);
}

// ---------------------------------------------------------------------------
// V5 — base-schema-invalid report
// ---------------------------------------------------------------------------

{
	const dir = taskFixture("vtask5", ["v-child1"]);
	writeFileSync(join(dir, "report-v-child1.json"), JSON.stringify({ worker: "v-child1", status: "done", summary: "x", artifacts: [], evidence: [] }, null, "\t") + "\n", "utf8");
	const { env } = verifyEnvelope(["--task", "vtask5"]);
	const schema = env?.verify.tasks.find((t) => t.task === "vtask5")?.lines.find((l) => l.check === "schema");
	check("V5.1 invalid status → schema fail line, presence still pass", schema?.status === "fail" && env?.verify.tasks.find((t) => t.task === "vtask5")?.lines.some((l) => l.check === "presence" && l.status === "pass") === true, JSON.stringify(schema));
}

// ---------------------------------------------------------------------------
// V6 — usage guards
// ---------------------------------------------------------------------------

{
	const stray = runCli(["verify", "oops"]);
	check(
		"V6.1 stray positional → E_SWARM_USAGE",
		stray.status !== 0 && (stray.json?.error as { code?: string } | undefined)?.code === "E_SWARM_USAGE",
		JSON.stringify(stray.json),
	);
	const unknown = verifyEnvelope(["--task", "no-such-task"]);
	check(
		"V6.2 unknown --task → E_SWARM_USAGE",
		unknown.status !== 0 && (unknown.env as unknown as { error?: { code?: string } })?.error?.code === "E_SWARM_USAGE",
		JSON.stringify(unknown.env),
	);
}

// ---------------------------------------------------------------------------
// V7 — --task filters
// ---------------------------------------------------------------------------

{
	const { env } = verifyEnvelope(["--task", "vtask1"]);
	const names = env?.verify.tasks.map((t) => t.task);
	check("V7.1 only the named task is verified", names?.length === 1 && names[0] === "vtask1", JSON.stringify(names));
}

rmSync(SANDBOX, { recursive: true, force: true });
if (failures > 0) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("swarm-verify-check: all checks passed");
