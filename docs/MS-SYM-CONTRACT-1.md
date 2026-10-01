# MILESTONE: Symmetric Orchestrator Contract

**ID:** `MS-SYM-CONTRACT-1`  
**Date of evidence base:** 2026-09-30  
**Audience:** any agent executing or reviewing this milestone without prior chat context  
**Authority:** this document only; do not invent requirements not written here

---

## 0. Binding interpretation rules

1. Words **MUST / MUST NOT / REQUIRED / ONLY** are mandatory.  
2. Words **MAY** are optional.  
3. If a case is not listed, **stop and ask the operator**; do not guess.  
4. Do not expand scope to spawn, watcher, retry redesign, peer-swarm, or removing the report artifact gate unless this document explicitly says so (it does not).  
5. Numeric claims below are fixed findings from the research fleet; do not "update" them from memory.

---

## 1. Problem (definition)

**As-is behavior (forbidden target state to leave in place):**

- Orchestrator dispatches real workers using briefs that often lack machine-checkable acceptance criteria.  
- Orchestrator accepts worker success when a JSON report validates and `status` is `pass`.  
- Orchestrator does **not** systematically re-check the **same** acceptance items against **existing** files/commits at merge time.

**Name of this failure mode:** acceptance on worker self-report (honest-word acceptance).

**Root cause (single sentence):**  
The contract is one-sided: the worker must produce a report; the orchestrator is not required to produce a verifiable brief or to verify outputs against that brief.

**Out of scope as root cause:** spawn placement bugs, settle/collect criterion design, watcher redesign, retry mechanism redesign.

---

## 2. Evidence base (facts only)

Source artifacts (paths as of research host):  
`REPORT-QUALITY-RESEARCH.md`, `MERGE-LOG.md`, `FLEET-CONFIG.md`, and accepted phase artifacts under the research `artifacts/` directory.

| Fact ID | Fact | Number |
|---------|------|--------|
| F1 | Indexed real worker-runs | N=198 |
| F2 | Outcome-labeled sample | N=83 |
| F3 | Infra union (never_started ∪ timeout ∪ awaiting_answer) | 31/198 = 15.7% |
| F4 | Fail reports on index | 6/198 = 3.0% |
| F5 | Incomplete on labeled sample | 4/83 = 4.8% |
| F6 | Infra vs semantic order of magnitude | comparable (not infra-dominant) |
| F7 | dead-reboot pairs self-healed | 55/63 = 87% |
| F8 | `pass` with `evidence_count=0` | 0/161 (index) |
| F9 | Hollow `pass` in reviewed pass set | 3/20 = 15% |
| F10 | Evidence paths still existing post-hoc | 168/203 = 82.8% |
| F11 | Briefs missing Stop / Evidence required / Out of scope | 196/198 each |
| F12 | Briefs missing Acceptance checklist | 87/198 |
| F13 | Runs with mailbox ask | 10/198 = 5.1% |
| F14 | Ask runs that received answer and finished | 8/8 pass+good |
| F15 | Same-brief retries pass | 10/10 |
| F16 | Hypothesis verdicts | H1 inconclusive; H2 supported; H3 rejected; H4 supported; H5 supported; H6 rejected |

**Definitions used in facts:**

- **Hollow pass:** `status=pass` but critical claimed work is not re-checkable later (missing paths, ephemeral only, or deliverable never stored).  
- **Real worker:** non-probe run that is expected to write `report-<name>.json`.  
- **Infra union:** lifecycle classes never_started, timeout, awaiting_answer as defined in the infra research artifact (never_started = no signal events after spawn, not "process failed to start").

---

## 3. Goal of this milestone

Replace honest-word acceptance with a **symmetric contract**:

| Side | Obligation |
|------|------------|
| Orchestrator (input) | MUST only dispatch real workers with a brief that meets **Brief Minimum** (§4) |
| System (collect) | MUST reject `status=pass` reports whose listed proof paths fail existence checks at collect time (§5) |
| Orchestrator (merge) | MUST NOT merge executor work that hits a **Verify Trigger** (§6) unless a verify pass (or operator-recorded equivalent check) exists |

No other goals are in this milestone.

---

## 4. Brief Minimum (input contract)

A brief for a **real worker** is valid **only if** all sections below exist and are non-empty:

| Section ID | Section name | REQUIRED content |
|------------|--------------|------------------|
| B1 | Goal | 1–2 sentences; measurable outcome |
| B2 | Inputs | Explicit paths or refs |
| B3 | Acceptance | Numbered checklist; each item is pass/fail testable without reading the worker’s summary alone |
| B4 | Evidence required | What files/commands must appear in the report to prove B3 |
| B5 | Out of scope | What MUST NOT be done |
| B6 | Stop conditions | When the worker MUST write `q-<name>.json` instead of guessing |
| B7 | Report contract | At least: `status` pass\|fail; `artifacts[]`; `evidence[{claim,file}]` |

**MUST NOT** dispatch a real worker if any of B1–B7 is missing or empty.

**Probe workers** are exempt from B1–B7 **only** if mode is explicitly probe and no report is expected.

**Stop conditions MUST include these three escalation classes (wording MAY vary; meaning MUST NOT):**

- **E1** Brief contradiction or two acceptance items cannot both be true → ask.  
- **E2** Next step needs authority the worker does not have → ask.  
- **E3** Cannot state in one sentence what pass means or which files are in scope → ask.  

**MUST NOT** use mailbox ask as a status channel (“still working”).

---

## 5. Collect path rule (system contract)

**When:** after existing JSON/schema validation of the report, before stamping `collectedAt` / accepting success.

**For `status=pass` ONLY:**

1. `evidence` MUST have length ≥ 1.  
2. Every `artifacts[]` entry MUST be a path that exists at collect time (file or directory).  
3. Every `evidence[].file` that is a filesystem path (optional trailing `:line` or `:start-end`) MUST exist at collect time.  
4. `evidence[].file` values that are pseudo-paths (examples: `docker logs…`, `TODO`, `N/A`) MUST cause reject.  
5. Empty `artifacts` is allowed only if evidence paths all exist.

**For `status=fail`:** missing paths MUST NOT block collect (MAY warn).

**Path resolution rule (REQUIRED to be fixed in implementation docs when coding):**  
Relative paths resolve against orchestrator project cwd unless absolute. Do not invent a second silent rule.

**Default policy for pass:** paths only under ephemeral exchange `/tmp` (or equivalent) without a durable copy **MUST fail** collect under this milestone’s intended end state. Soft-warn-only is allowed only as an explicit intermediate rollout flag, not as the completed milestone state.

---

## 6. Verify triggers (merge contract)

After executor collect with `status=pass`, orchestrator MUST evaluate:

| ID | Trigger | Exact condition |
|----|---------|-----------------|
| V1 | Ephemeral proof | All or critical evidence/artifacts are only under `/tmp`, build output dirs, or live process state |
| V2 | Branch-ephemeral proof | Proof points at a feature branch that will be merged and deleted, and no surviving commit SHA is listed for the final result |
| V3 | Unversioned deliverable | Primary deliverable is not in VCS and not in delegate-archive (or operator durable store) |

**If any V1–V3 is true:**

- MUST NOT merge executor work yet.  
- MUST run a separate worker `verify-<executorName>` (or operator performs the same checks and records them in the merge log with the same acceptance table).  
- Merge of executor work is allowed ONLY if verify `status=pass` (or operator log shows every B3 item pass on a named commit SHA).

**If no V1–V3:** verify worker is NOT required by this milestone; human merge still MUST check B3 against evidence paths.

**Verify worker MUST NOT** implement new features for the executor.  
**Verify worker MUST** produce: per-B3 verdict pass|fail|unverifiable; list of re-checked paths; commit SHA used.

---

## 7. Explicit non-goals (MUST NOT do)

1. Redesign spawn / placement / worktree.  
2. Redesign watcher / lifecycle for residual abandoned runs.  
3. Redesign retry mechanics.  
4. Remove or weaken “report file is completion criterion”.  
5. Remove artifact/schema gate that already yields F8.  
6. Add peer-to-peer agent swarm patterns.  
7. Treat F3 infra rate as a primary optimization target of this milestone.

---

## 8. Done criteria (all REQUIRED)

Milestone is **complete** only when all are true:

| ID | Criterion | How to prove |
|----|-----------|--------------|
| D1 | Every new real-worker brief in a defined sample window satisfies B1–B7 | Audit ≥20 consecutive real briefs; 20/20 pass |
| D2 | Collect rejects pass reports with missing proof paths | Automated tests + ≥3 canary rejects observed |
| D3 | No merge of executor pass under V1–V3 without verify pass or operator equivalent log | Merge log review; 0 violations in window |
| D4 | Infra union rate not materially regressed | Compare to F3 ~15.7% on ≥30 runs; investigate if >20% |
| D5 | No commits whose purpose is a §7 non-goal | PR/commit message audit |

**Not done criteria:** “prompts feel better”, “workers seem smarter”, “more agents”.

---

## 9. Implementation order (REQUIRED sequence)

1. Enforce §6 merge/verify process (no code required).  
2. Enforce §4 Brief Minimum + E1–E3 in orchestrator and worker prompt surfaces.  
3. Implement §5 collect path validation to hard-fail on pass.  

Do not reorder to “code first” unless operator explicitly overrides this document in writing.

---

## 10. Kickoff text for an executing agent

```text
Execute milestone MS-SYM-CONTRACT-1 only as written in the milestone document.
Do not use prior chat memory. Do not add goals.
Problem: orchestrator accepts worker pass without symmetric verifiable brief + re-check.
Facts F1–F16 are fixed.
Deliver: Brief Minimum enforcement, collect path hard-fail for pass, verify-on-V1-V2-V3 merge rule.
Do not touch spawn, watcher, retry, artifact gate removal, or peer-swarm.
Stop and ask operator on any ambiguity.
Done only when D1–D5 are evidenced.
```

---

## 11. Ambiguity protocol

If paths, host layout, or tool names differ from the research host:

1. Ask operator for roots and tool names.  
2. Map them explicitly in one table (old → local).  
3. Continue only after operator confirms the table.  

Do not invent corpus paths or change F1–F16.

---

**End of milestone document.**
