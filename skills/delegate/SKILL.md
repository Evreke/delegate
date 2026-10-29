---
name: delegate
description: Orchestration judgment for multi-worker runs on the pi-delegate delegate tool — topology, tiers, briefs, verification, recovery, merging. NOT for single one-shot tasks (the tool alone suffices) or lone pipeline probes. Load when planning a fan-out, acting as a sub-orchestrator, or recovering a failed delegation.
---

# Delegate — orchestrator judgment

The `delegate` tool owns all mechanics; its schema and result texts are the truth.
This skill owns judgment.

Success is a validated report file, never an agent status; a fail
status is honest data.

## Route first

- Implementation, review, research, diagnosis, docs: the loop below.
- A smoke-test task: probe semantics. It MUST NOT carry the brief contract.
- A scripted role (debate, interview): outside this loop.

## The loop

### 1. Decompose

Cut the work into bounded tasks: one worker, one outcome. Choose the smallest
topology that fits.

- **Ticket fan-out** — independent tickets or questions.
- **File-slice fan-out** — mass mechanical edits; one shared checkout, disjoint
  file lists per brief.
- **Axis fan-out** — reviews; one reviewer per axis, you synthesize.
- **Hypothesis fan-out** — diagnosis; one worker per candidate cause, open until
  a report confirms or eliminates it.
- **Role chain** — one artifact passes through
  investigator→planner→developer→verifier→narrator.
- **Two-tier swarm** — multi-repo epics; a sub-orchestrator plans, spawns a named
  3–4 team, verifies, integrates. Cap nesting depth at three.

Pick the tier class: execution→flash-class; judgment→frontier-class. Name a tier
only to correct a wrong default.

Done when: every worker has one outcome, a topology, and a tier decision.

### 2. Brief

Write one brief per worker under the exchange dir. Read [BRIEF.md](BRIEF.md)
first; it owns the template, the language rules, and the anchors. A real-worker
brief MUST carry all seven template sections non-empty: B1 — Goal; B2 — Inputs;
B3 — Acceptance; B4 — Evidence required; B5 — Out of scope; B6 — Stop
conditions; B7 — Report contract. You MUST NOT dispatch without them.

Done when: every brief follows BRIEF.md with all seven sections non-empty.

### 3. Spawn

Issue one delegate call per worker, in parallel. For a fan-out of three or more,
run one probe worker first; its structured failure gates the rest. A probe worker
uses the tool's probe semantics; it MUST NOT follow B1–B7 and MUST NOT receive a
brief file.

Placement authority: a root orchestrator (cwd outside any worktrees directory)
grants worktree isolation. If the cwd sits under a worktrees directory, you are
a sub-orchestrator: you MUST place workers shared. Sub-orchestrator workers
share the checkout with disjoint file lists per brief. Read-only workers need
no isolation; place them shared.

Done when: every planned worker is started or its failure triaged.

### 4. Verify

Check every report against its brief's B3 items; demand file:line evidence. On
conflicting reports, spawn one tie-breaker verifier with both as context, or
resolve from source. Log the question count per worker beside the verdicts.
Two or more questions flag the brief, not the worker.

Done when: every report has a per-item, evidence-backed verdict.

### 5. Merge

You are the single merge gate. A read-only run has no merge; the report is the
deliverable.

Authority: workers commit in their own scope; they never merge or push. You own
merge order.

Triggers: before you merge a pass report, check for proof that will not survive.
V1: proof lives only in /tmp, build outputs, or live state. V2: proof lived only on
a branch now merged and deleted. V3: the deliverable is in neither version control
nor the delegate archive.

Verify worker: on any trigger, run a verify-<executor> worker. It returns
per-criterion verdicts (pass, fail, unverifiable), re-checked paths, and the commit
SHA; or run the same checks yourself. It MUST NOT implement features.

Decision: no trigger, merge; any trigger, merge only on a verify pass.

Done when: every accepted change is merged or rejected, and the decision is recorded.

### 6. Teardown

Close what you opened. Done when: no worktree placement you created remains.

## Supervise

From first spawn to last report, the tool wakes you when a worker needs
attention; act on the mailbox:

- Steer a working worker: one short correction, state plus next instruction.
- Answer a blocked worker: read, reply, let it continue.
- Release a finished worker: report valid, mailbox drained.

Discovery comes from wakes, not from tool results.

## Recovery

- Diagnosed retry, never verbatim: when a worker settles without a valid report,
  read its console output for the root cause. Retry under a new worker name; the
  new brief MUST name the wrong path, the cause, and the fix shape. Cap two repeats
  per issue, then escalate to the user.
- Timeout or detach: end your turn; the watcher owns the wait. Never bash-sleep;
  never re-call the tool to wait.
- Your own fleet: end your turn after your fleet is out. Never end a turn having
  taken zero actions.

Fallback: if the delegate tool is absent, follow the manual ritual in
[REFERENCE.md](REFERENCE.md).
