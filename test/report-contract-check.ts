/**
 * Report contract sentinel — the canon of the report shape lives in the code
 * (REPORT_EXAMPLE + briefPrompt), never in briefs; the validator (baseValidate)
 * is the enforcement reference.
 *
 * Run with: bun test/report-contract-check.ts   (from repo root)
 *
 * Covers:
 *   1. REPORT_EXAMPLE with the canonical worker name and REAL file paths
 *      substituted passes validateReport (the extension's own validator —
 *      since v1.19 paths must exist at collect time).
 *   2. Regression (the failure class this contract fixes): a report whose
 *      evidence is an array of STRINGS must be rejected with an error naming
 *      the evidence item.
 *   3. briefPrompt carries the report contract: required-field rules, the
 *      verbatim "Extra fields allowed", and the canonical example with the
 *      worker name substituted.
 *   4. briefPrompt echoes a brief-declared reportSchema fragment (§16–§17):
 *      absent/null fragment → prompt identical to base-only; present fragment →
 *      serialized schema + task-specific mandate appended, base intact.
 *   5. W0 pin (rng-sum bug 1): the precedence clause — the report contract
 *      ALWAYS overrides the brief on format/shape — is present verbatim, with
 *      and without a schema fragment, and positioned BEFORE the example and
 *      the schema echo (the worker must read the override first).
 *
 * Exit 0 only if all checks pass.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReport } from "../src/exchange.ts";
import {
	REPORT_EXAMPLE,
	SWARM_CLI_PATH,
	WORKER_NAME_RE,
	briefPrompt,
} from "../src/host.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const NAME = "contract-w1";
check("sanity: test name matches WORKER_NAME_RE", WORKER_NAME_RE.test(NAME));

const root = mkdtempSync(join(tmpdir(), "report-contract-check-"));

// ---------------------------------------------------------------------------
// 1. canonical example (name substituted) passes validateReport
// ---------------------------------------------------------------------------

{
	// Substitute the canonical name AND real paths for the placeholder
	// artifact/evidence pointers: since v1.19 the validator enforces
	// path existence at collect (quality-research fleet P0) — the canon is
	// the report SHAPE; a passing report must reference files that exist.
	const artifactPath = join(root, "artifact.txt");
	writeFileSync(artifactPath, "artifact bytes\n", "utf8");
	const evidencePath = join(root, "evidence-src.ts");
	writeFileSync(evidencePath, "export {}\n", "utf8");
	const report = {
		...REPORT_EXAMPLE,
		worker: NAME,
		artifacts: [artifactPath],
		evidence: [{ claim: "what was verified", file: `${evidencePath}:1` }],
	};
	const path = join(root, `report-${NAME}.json`);
	writeFileSync(path, JSON.stringify(report, null, "\t"), "utf8");
	const r = validateReport(path, NAME);
	check(
		"REPORT_EXAMPLE (worker + real paths substituted) → validateReport ok",
		r.ok && r.report.worker === NAME && r.report.status === "pass",
		JSON.stringify(r),
	);
}

// ---------------------------------------------------------------------------
// 1b. collect-time path-existence semantics (v1.19, quality-research P0)
// ---------------------------------------------------------------------------

{
	const existsPath = join(root, "exists.txt");
	writeFileSync(existsPath, "x\n", "utf8");
	const ghost = join(root, "ghost-does-not-exist.txt");
	const write = (name: string, report: unknown) => {
		const p = join(root, name);
		writeFileSync(p, JSON.stringify(report, null, "\t"), "utf8");
		return p;
	};
	const okReport = (over: object) => ({
		worker: NAME,
		status: "pass",
		summary: "s",
		artifacts: [existsPath],
		evidence: [{ claim: "c", file: existsPath }],
		...over,
	});

	// pass with empty evidence — the hollow-pass class (fleet: measured 0/161
	// on the corpus; now contract-enforced)
	const emptyEv = validateReport(write("empty-evidence.json", okReport({ evidence: [] })), NAME);
	check(
		"pass with empty evidence → rejected (hollow-pass gate)",
		!emptyEv.ok && emptyEv.error.includes("at least one evidence"),
		JSON.stringify(emptyEv),
	);

	// dead artifact path
	const deadArtifact = validateReport(write("dead-artifact.json", okReport({ artifacts: [ghost] })), NAME);
	check(
		"pass with nonexistent artifact path → rejected naming the path",
		!deadArtifact.ok && deadArtifact.error.includes("ghost-does-not-exist.txt"),
		JSON.stringify(deadArtifact),
	);

	// dead evidence path
	const deadEvidence = validateReport(
		write("dead-evidence.json", okReport({ evidence: [{ claim: "c", file: ghost }] })),
		NAME,
	);
	check(
		"pass with nonexistent evidence path → rejected with command-ref guidance",
		!deadEvidence.ok && deadEvidence.error.includes('"command: <cmd>"'),
		JSON.stringify(deadEvidence),
	);

	// command reference instead of a path — accepted verbatim
	const cmdRef = validateReport(
		write("cmd-ref.json", okReport({ evidence: [{ claim: "c", file: "command: ls -la /tmp" }] })),
		NAME,
	);
	check("pass with 'command:' evidence reference → ok", cmdRef.ok, JSON.stringify(cmdRef));

	// relative paths resolve against ctx.baseDir; without a base dir — fail-closed
	const relReport = {
		worker: NAME,
		status: "pass",
		summary: "s",
		artifacts: ["exists.txt"],
		evidence: [{ claim: "c", file: "exists.txt:1" }],
	};
	const relOk = validateReport(write("rel-ok.json", relReport), NAME, { baseDir: root });
	check("relative paths + baseDir → ok", relOk.ok, JSON.stringify(relOk));
	const relNoBase = validateReport(write("rel-nobase.json", relReport), NAME);
	check(
		"relative paths without baseDir → rejected (fail-closed)",
		!relNoBase.ok && relNoBase.error.includes("no base dir"),
		JSON.stringify(relNoBase),
	);

	// :line suffix stripped before stat
	const lineSuffix = validateReport(
		write("line-suffix.json", okReport({ evidence: [{ claim: "c", file: `${existsPath}:42` }] })),
		NAME,
	);
	check("evidence path with :line suffix → stat on the stripped path", lineSuffix.ok, JSON.stringify(lineSuffix));

	// fail reports: existence checks skipped, but blockers required
	const failNoBlockers = validateReport(
		write("fail-noblockers.json", { worker: NAME, status: "fail", summary: "s", artifacts: [], evidence: [] }),
		NAME,
	);
	check(
		"fail without blockers → rejected",
		!failNoBlockers.ok && failNoBlockers.error.includes('"blockers"'),
		JSON.stringify(failNoBlockers),
	);
	const failWithBlockers = validateReport(
		write(
			"fail-blockers.json",
			{
				worker: NAME,
				status: "fail",
				summary: "s",
				artifacts: [],
				evidence: [{ claim: "c", file: ghost }],
				blockers: ["write access to /etc/hosts is required — owned by operator"],
			},
		),
		NAME,
	);
	check(
		"fail with blockers and dead evidence path → ok (existence checks skipped on fail)",
		failWithBlockers.ok,
		JSON.stringify(failWithBlockers),
	);
}

// ---------------------------------------------------------------------------
// 2. regression: evidence as an array of strings must fail on the evidence item
// ---------------------------------------------------------------------------

{
	const bad = { ...REPORT_EXAMPLE, worker: NAME, evidence: ["did the thing"] };
	const path = join(root, "bad-evidence.json");
	writeFileSync(path, JSON.stringify(bad, null, "\t"), "utf8");
	const r = validateReport(path, NAME);
	check(
		"string evidence → rejected with evidence-item error",
		!r.ok && /evidence item/i.test(r.error),
		JSON.stringify(r),
	);
}

// ---------------------------------------------------------------------------
// 3. briefPrompt embeds the report contract
// ---------------------------------------------------------------------------

{
	const prompt = briefPrompt("/tmp/exchange/t/brief-x.md", NAME);
	const example = JSON.stringify({ ...REPORT_EXAMPLE, worker: NAME });

	check("briefPrompt: worker-name rule carries the canonical name", prompt.includes(`"worker" must be exactly "${NAME}"`));
	check("briefPrompt: status enum rule", prompt.includes('"status" strictly "pass" or "fail"'));
	check("briefPrompt: summary rule", prompt.includes('"summary" a non-empty string'));
	check("briefPrompt: artifacts rule", prompt.includes('"artifacts" an array of strings'));
	check("briefPrompt: evidence rule names claim+file", prompt.includes('"evidence" an array of objects, each with non-empty string "claim" and "file"'));
	check("briefPrompt: verbatim 'Extra fields allowed'", prompt.includes("Extra fields allowed"));
	check("briefPrompt: canonical example embedded, worker substituted", prompt.includes(example), `expected ${example}`);
	// fix-report-heal (2026-09-12, the dice-two incident): flash-class models
	// drift to the conversational "done" despite the enum rule — the prompt
	// names the anti-examples explicitly and states the consequence.
	check(
		"briefPrompt: status anti-example pins done/ok/success as rejected at collect",
		prompt.includes(
			'(never "done"/"ok"/"success" — a report with any other status is rejected at collect and wakes your orchestrator)',
		),
		prompt.slice(prompt.indexOf('"status"'), prompt.indexOf('"status"') + 220),
	);
}

// ---------------------------------------------------------------------------
// 4. briefPrompt echoes a brief-declared reportSchema fragment (v1.5)
// ---------------------------------------------------------------------------

{
	const fragment = {
		type: "object",
		properties: { changes: { type: "array", minItems: 1 } },
		required: ["changes"],
	};
	const base = briefPrompt("/tmp/exchange/t/brief-x.md", NAME);
	const withSchema = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, fragment);
	const withNull = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, null);
	const example = JSON.stringify({ ...REPORT_EXAMPLE, worker: NAME });

	check(
		"briefPrompt without fragment: identical to base-only prompt",
		withSchema !== base && withNull === base,
	);
	check(
		"briefPrompt with fragment: serialized schema echoed verbatim",
		withSchema.includes(JSON.stringify(fragment)),
	);
	check(
		"briefPrompt with fragment: task-specific mandate present",
		withSchema.includes("MUST also satisfy this JSON schema") && withSchema.includes("Extra fields still allowed unless the fragment says otherwise"),
	);
	check(
		"briefPrompt with fragment: base contract still intact (worker name + canonical example)",
		withSchema.includes(`"worker" must be exactly "${NAME}"`) && withSchema.includes(example),
	);
}

// ---------------------------------------------------------------------------
// 5. W0 pin (rng-sum bug 1): the precedence clause in briefPrompt —
//    the contract ALWAYS overrides the brief on report format/shape
// ---------------------------------------------------------------------------

{
	const CLAUSE =
		"Report contract — this contract ALWAYS overrides the brief on report format/shape: " +
		"if the brief's OUTPUT section specifies a different report shape, keep ALL required contract fields " +
		"anyway and put the brief-specific data in extra fields.";
	const fragment = { type: "object", properties: { changes: { type: "array" } } };
	const base = briefPrompt("/tmp/exchange/t/brief-x.md", NAME);
	const withSchema = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, fragment);

	check("briefPrompt: precedence clause present verbatim (contract ALWAYS overrides the brief)", base.includes(CLAUSE));
	check("briefPrompt: precedence clause survives a brief-declared schema fragment", withSchema.includes(CLAUSE));
	check(
		"briefPrompt: clause positioned BEFORE the canonical example (override read first)",
		base.indexOf(CLAUSE) !== -1 && base.indexOf(CLAUSE) < base.indexOf("Canonical example"),
	);
	check(
		"briefPrompt: clause positioned BEFORE the task-specific schema echo (base contract always first)",
		withSchema.indexOf(CLAUSE) !== -1 && withSchema.indexOf(CLAUSE) < withSchema.indexOf("Task-specific report schema"),
	);
	check(
		"briefPrompt: clause carries the escape hatch (extra fields) + the override trigger (brief OUTPUT section)",
		/keep ALL required contract fields anyway/.test(base) && /brief-specific data in extra fields/.test(base),
	);
}

// ---------------------------------------------------------------------------
// 6. Issue #25: verb phrasing is PRIMARY; the raw-file fallback lives behind
//    BriefPromptOptions.verbsFallback (config swarm.verbsFallback, default on)
// ---------------------------------------------------------------------------

{
	const base = briefPrompt("/tmp/exchange/t/brief-x.md", NAME);
	const explicitOn = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, null, { verbsFallback: true });
	const explicitOff = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, null, { verbsFallback: false });

	check(
		"#25 the prompt carries the resolvable swarm CLI invocation path",
		base.includes(`bun ${SWARM_CLI_PATH}`) && SWARM_CLI_PATH.endsWith(join("swarm", "cli.ts")),
		SWARM_CLI_PATH,
	);
	check(
		"#25 verb phrasing is primary: all five worker verbs are named in one prompt",
		["read-brief", "ask", "poll-answer", "write-progress", "write-report"].every((v) => base.includes(v)),
	);
	check("#25 the prompt forbids hand-writing report/mailbox/progress files", base.includes("Never hand-write report"));
	check(
		"#25 default verbsFallback is ON — explicit true is byte-identical to the default",
		base === explicitOn,
	);
	check(
		"#25 the PRIMARY write-report instruction carries explicit --brief/--task/--worker flags (backend-independent)",
		base.includes(`write-report --brief /tmp/exchange/t/brief-x.md --task t --worker ${NAME}`),
	);
	check(
		"#25 the env identity is qualified (not claimed unconditionally) and the flags are the always-sufficient spine",
		base.includes("when the backend supports it") &&
			base.includes("works regardless") &&
			!base.includes("already exported into your environment"),
	);
	check(
		"#25 fallback names the exact raw exchange files (q-/a-/p-/report-)",
		base.includes(`q-${NAME}.json`) &&
			base.includes(`a-${NAME}.json`) &&
			base.includes(`p-${NAME}.jsonl`) &&
			base.includes(`report-${NAME}.json`),
	);
	check(
		"#25 the fallback does NOT claim byte-for-byte parity for hand-written raw files (only the verbs are byte-pinned)",
		base.includes("byte-exact reference") && !base.includes("These are exactly the files the verbs write, byte-for-byte"),
	);
	check(
		"#25 verbsFallback:false drops the raw-file paragraph but keeps the verbs primary",
		!explicitOff.includes("Fallback (only if the swarm CLI") &&
			!explicitOff.includes(`report-${NAME}.json`) &&
			explicitOff.includes("write-report") &&
			explicitOff.includes("Never hand-write report"),
	);
	check(
		"#25 fallback survives a brief-declared schema fragment (report contract intact both ways)",
		briefPrompt("/tmp/exchange/t/brief-x.md", NAME, { type: "object" }).includes("Fallback (only if the swarm CLI") &&
			explicitOff.includes(`"worker" must be exactly "${NAME}"`),
	);
}

// ---------------------------------------------------------------------------
// 7. MS-SYM-CONTRACT-1 §4: the worker prompt carries the E1–E3 escalation
//    classes (ask-don't-guess) and the no-status-channel rule.
// ---------------------------------------------------------------------------

{
	const base = briefPrompt("/tmp/exchange/t/brief-x.md", NAME);
	const withSchema = briefPrompt("/tmp/exchange/t/brief-x.md", NAME, { type: "object" });

	check("stop conditions: E1 (brief contradicts itself / acceptance items cannot both hold)", base.includes("the brief contradicts itself or two acceptance items cannot both be true"));
	check("stop conditions: E2 (next step needs authority you do not have)", base.includes("the next step needs authority you do not have"));
	check("stop conditions: E3 (cannot state pass/scope in one sentence)", base.includes("you cannot state in one sentence what pass means or which files are in scope"));
	check("stop conditions: mailbox is for questions, never a status channel", base.includes("the mailbox is for questions, never a status channel"));
	check("stop conditions: ask-don't-guess is present", base.includes("never guess"));
	check(
		"stop conditions survive a brief-declared schema fragment",
		withSchema.includes("the brief contradicts itself or two acceptance items cannot both be true") &&
			withSchema.includes("you cannot state in one sentence what pass means or which files are in scope"),
	);
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
