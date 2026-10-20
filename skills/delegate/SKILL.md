---
name: delegate
description: Orchestration playbook for multi-worker fan-outs via the pi-delegate extension — topology and tier choice, brief anatomy, verify and recovery judgment, merge-gate discipline. NOT for single one-shot tasks — the tool alone suffices. Load when planning a multi-worker run (per-ticket, per-axis, per-hypothesis, per-repo) or diagnosing failed delegation.
---

# Delegate — the orchestrator's judgment layer

The `delegate` tool owns all mechanics — its schema and result texts are the truth, and
this skill never repeats them. The skill owns the judgment around the tool: cutting the
work, briefing, verifying, recovering, merging, teardown.

You are the orchestrator. Success is a validated report file, never an agent's status. A
valid report with `status: "fail"` is an honest completion: read it as a result, not a
tool error.

## The loop — judgment at every step

1. **Decompose** into bounded, single-outcome tasks — one ticket = one worker = one
   outcome. Pick the topology to fit the problem:
   - **Ticket fan-out** — independent implementation tickets.
   - **File-slice fan-out** — mass mechanical edits: one shared checkout, disjoint file
     lists per brief.
   - **Axis fan-out** — reviews: one reviewer per axis, you synthesize.
   - **Hypothesis fan-out** — diagnosis over orthogonal hypotheses (hold the
     superposition until evidence collapses it).
   - **Role chain** — feature delivery: investigator → planner → developer → verifier →
     narrator over one artifact.
   - **Two-tier swarm** — multi-repo epics (cap depth at 3).
   Pick the tier: execution work → flash-class. Decision, review, synthesis work →
   frontier-class.
2. **Brief** — one file per worker under the exchange dir. A real-worker brief MUST
   carry all seven Brief-Minimum sections (B1–B7), non-empty — do NOT dispatch without
   them (probe workers are exempt):
   - **B1 Goal** — 1–2 sentences, a measurable outcome.
   - **B2 Inputs** — explicit paths/refs (file pointers only).
   - **B3 Acceptance** — a numbered checklist of acceptance criteria only. Each item is
     pass/fail-testable without the worker's summary.
   - **B4 Evidence required** — files/commands the report must cite to prove B3 (no
     proof, no pass).
   - **B5 Out of scope** — what lies outside the worker's mandate.
   - **B6 Stop conditions** — when to `ask` instead of guessing. MUST include E1 (the
     brief contradicts itself / two acceptance items cannot both hold), E2 (the next
     step needs authority you lack), E3 (cannot state pass or scope in one sentence).
     Mailbox: questions only, never a status channel.
   - **B7 Report contract** — the tool's prompt owns the exact report contract. Briefs
     stay name-agnostic — never paste report JSON.
   MAY add ROLE / BUDGET / Method — B1–B7 is the floor.
3. **Spawn** via parallel `delegate` calls, one per worker. A fan-out of ≥3 workers:
   run the first worker alone. Its structured spawn failure is the cheap smoke check
   that gates the rest — the tool owns how. Respect worktree authority: only a root
   orchestrator (session cwd outside any worktree) gets worktree isolation. A
   sub-orchestrator's workers share its checkout — disjoint file lists per brief. A
   minutes-short task with nothing else to do: blocking until the worker settles is
   fine. The release windows are the tool's business.
4. **Verify** every report against the brief's acceptance criteria, demanding file:line
   evidence. Conflicting reports → spawn one tie-breaker verifier with both reports as
   CONTEXT, or resolve from source yourself. A failed worker's output is input for the
   retry, not waste.
5. **Merge** — you are the single merge gate. Workers commit in their own scope. They
   never merge, never push. You own merge order. Before merging a `status=pass`, check
   the verify triggers. **V1** — ephemeral proof: all/critical evidence under `/tmp`,
   build outputs, or live state. **V2** — branch-ephemeral proof: feature branch
   merged+deleted, no surviving commit SHA. **V3** — unversioned deliverable: in
   neither VCS nor delegate-archive. Any V1–V3 → hold the merge. Run a
   `verify-<executorName>` worker — or record the same per-B3 checks + commit SHA
   yourself — and merge only on a verify pass. The verify worker MUST NOT implement
   features — only per-B3 verdicts `pass|fail|unverifiable`, re-checked paths, commit
   SHA. No trigger → merge.
6. **Teardown** — close what you opened (`/delegate-teardown`). Leave no worktree
   placement behind.

## Recovery policy

- **Diagnosed retry, never verbatim.** When a worker settles without a valid report,
  read its console output and find the root cause. Retry under a NEW worker name with a
  new brief naming the wrong path, the cause and the fix shape. The settled agent keeps
  the old name. At most 2 repeats per issue, then escalate to the user.
- **End your turn on timeouts.** After a spawn timeout or a detach, the worker is alive
  and the background watcher owns the wait. End your turn: you are woken when the
  report lands, a question arrives or the worker dies. Never bash-sleep and never
  re-call the tool to wait — status polling is the look-now alternative.
- **Answer blocked workers.** A worker paused on a question asks through the mailbox.
  Read the pending question, reply, let it continue.
- **Two-tier fleets.** If YOU are a worker that spawns its own fleet, end your turn
  right after the fleet is out. Your watcher wakes you as each child's report lands,
  exactly as your orchestrator's does. And never end a turn having taken zero actions.

Fallback: if the `delegate` tool is absent from your session, follow the manual ritual
in [REFERENCE.md](REFERENCE.md).
