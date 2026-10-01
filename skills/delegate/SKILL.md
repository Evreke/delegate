---
name: delegate
description: Orchestration playbook for multi-worker fan-outs via the pi-delegate extension (topology and tier choice, brief anatomy, verification and recovery judgment, merge-gate discipline). The delegate tool itself needs NO skill — for any single spawn, collect, or status call, use the tool directly. NOT for single one-shot tasks — the tool alone suffices there. Load only when planning a multi-worker run (per-ticket, per-axis, per-hypothesis, per-repo) or diagnosing failed delegation.
---

# Delegate — the orchestrator's judgment layer

The `delegate` tool owns ALL mechanics: spawn parameters, placement modes, error codes,
probe protocol, settle and release windows, report validation. Its schema and result
texts are the truth — this skill never repeats them. The skill owns the judgment you
exercise around the tool: how to cut the work, how to brief, how to verify, how to
recover, who merges, when to tear down.

You are the orchestrator. Workers execute in their own contexts. Success is a validated
report file, never an agent's status — and `status: "fail"` in a valid report is an
honest completion: read it as a result, not a tool error.

## The loop — judgment at every step

1. **Decompose** into bounded, single-outcome tasks; one ticket = one worker = one
   outcome. Pick the topology to fit the problem: ticket fan-out for independent
   tickets, file-slice for mass mechanical edits (one shared checkout, disjoint file
   lists), axis fan-out for reviews (one reviewer per axis, you synthesize), hypothesis
   fan-out for diagnosis (orthogonal hypotheses; hold the superposition until evidence
   collapses it), role chain for feature delivery, two-tier swarm for multi-repo epics
   (cap depth at 3). Pick the tier: execution → flash-class;
   decisions, review, synthesis → frontier-class.
2. **Brief** — one file per worker under the exchange dir (`/tmp/exchange/{TASK}/` on
   Linux/macOS; `PI_DELEGATE_EXCHANGE_ROOT` overrides). A real-worker brief MUST carry
   all seven Brief-Minimum sections (B1–B7), non-empty — do NOT dispatch without them
   (probe workers are exempt):
   - **B1 Goal** — 1–2 sentences, a measurable outcome.
   - **B2 Inputs** — explicit paths/refs (file pointers only).
   - **B3 Acceptance** — a numbered checklist of acceptance criteria only; each item
     pass/fail-testable without the worker's summary.
   - **B4 Evidence required** — files/commands the report must cite to prove B3 (no proof, no pass).
   - **B5 Out of scope** — what MUST NOT be done.
   - **B6 Stop conditions** — when to `ask` instead of guessing; MUST include E1 (brief
     contradicts itself / two acceptance items can't both hold), E2 (next step needs
     authority you lack), E3 (can't state pass or scope in one sentence). Mailbox: questions
     only, never a status channel.
   - **B7 Report contract** — `status` pass|fail, `artifacts[]`, `evidence[{claim,file}]`
     (the tool's prompt carries the exact contract; briefs stay name-agnostic, never
     paste report JSON).
   MAY add ROLE / BUDGET / Method — B1–B7 is the floor.
3. **Spawn** via parallel `delegate` calls, one per worker. A fan-out of ≥3 deserves a
   cheap smoke check first — the first real worker's structured spawn failure is just
   as cheap a signal; the tool owns how. Respect worktree authority: only a root
   orchestrator (session cwd outside any worktree) gets worktree isolation; a
   sub-orchestrator's workers share its checkout — disjoint file lists per brief.
4. **Verify** every report against the brief's acceptance criteria, demanding file:line
   evidence. Conflicting reports → spawn one tie-breaker verifier with both reports as
   CONTEXT, or resolve from source yourself. A failed worker's output is input for the
   retry, not waste.
5. **Merge** — you are the single merge gate. Workers commit in their own scope; they
   never merge, never push. Verify before merging; you own merge order. Before merging a
   `status=pass`, check the verify triggers: **V1** ephemeral proof (all/critical evidence
   under `/tmp`, build outputs, or live state); **V2** branch-ephemeral proof (feature
   branch merged+deleted, no surviving commit SHA); **V3** unversioned deliverable (in
   neither VCS nor delegate-archive). Any V1–V3 → do NOT merge yet: run a
   `verify-<executorName>` worker (or record the same per-B3 checks + commit SHA yourself);
   merge only on a verify pass. The verify worker MUST NOT implement features — only
   per-B3 verdicts `pass|fail|unverifiable`, re-checked paths, commit SHA. No trigger →
   verify not required, but still check every B3 item against the evidence paths.
6. **Teardown** — close what you opened (`/delegate-teardown`); never leave worktree
   placements behind.

## Recovery policy

- **Diagnosed retry, never verbatim.** When a worker settles without a valid report,
  read its console output, find the root cause, and retry with a new brief naming the
  wrong path, the cause and the fix shape — under a NEW worker name (the settled agent
  keeps the old one). At most 2 repeats per issue, then escalate to the user.
- **End your turn on timeouts.** After a spawn timeout or detach the worker is alive
  and the background watcher owns the wait: end your turn and you are woken when the
  report lands, a question arrives or the worker dies. Never bash-sleep and never
  re-call the tool to wait; status polling is the look-now alternative.
- **Answer blocked workers.** A worker paused on a question is answered through the
  mailbox: read the pending question, reply, let it continue.
- **Two-tier fleets.** If YOU are a worker that spawns its own fleet, end your turn
  right after the fleet is out — your watcher wakes you as each child's report lands,
  exactly as your orchestrator's does. And never end a turn having taken zero actions.

Fallback: if the `delegate` tool is absent from your session, follow the manual ritual
in [REFERENCE.md](REFERENCE.md).
