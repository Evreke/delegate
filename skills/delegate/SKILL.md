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
   Linux/macOS; `PI_DELEGATE_EXCHANGE_ROOT` overrides). Every real-worker brief MUST
   carry all seven Brief-Minimum sections (B1–B7), non-empty — do NOT dispatch without
   them (probe workers are exempt):
   - **B1 Goal** — 1–2 sentences; a measurable outcome.
   - **B2 Inputs** — explicit paths or refs (file pointers only — paste nothing the
     worker can read).
   - **B3 Acceptance** — a numbered checklist; each item is pass/fail-testable without
     reading the worker's summary alone.
   - **B4 Evidence required** — which files/commands must appear in the report to prove
     B3 (no proof, no pass).
   - **B5 Out of scope** — what MUST NOT be done.
   - **B6 Stop conditions** — when to write `q-<name>.json` (ask) instead of guessing;
     MUST include E1 (the brief contradicts itself or two acceptance items cannot both
     be true), E2 (the next step needs authority you do not have), E3 (you cannot state
     in one sentence what pass means or which files are in scope). The mailbox is for
     questions, never a status channel.
   - **B7 Report contract** — at least `status` pass|fail, `artifacts[]`,
     `evidence[{claim,file}]` (the tool's own prompt carries the exact report contract;
     briefs stay name-agnostic, never paste report JSON).
   MAY add ROLE / BUDGET / Method — B1–B7 is the floor, extras are allowed.
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
   never merge, never push. Verify before merging; you own merge order. Before merging
   any executor `status=pass`, evaluate the three verify triggers:
   - **V1 Ephemeral proof** — all or critical evidence/artifacts live only under `/tmp`,
     build output dirs, or live process state.
   - **V2 Branch-ephemeral proof** — proof points at a feature branch that will be
     merged and deleted, with no surviving commit SHA for the final result.
   - **V3 Unversioned deliverable** — the primary deliverable is in neither VCS nor the
     delegate-archive (nor an operator durable store).
   If any V1–V3 holds, do NOT merge yet: run a separate `verify-<executorName>` worker
   (or record the same per-B3 checks + commit SHA in the merge log yourself). Merge only
   on a verify `status=pass` (or a log showing every B3 item pass on a named SHA). The
   verify worker MUST NOT implement features — it only outputs per-B3 verdicts
   `pass|fail|unverifiable`, re-checked paths, and the commit SHA used. If none of V1–V3
   holds, a verify worker is not required — but you still check every B3 item against
   the evidence paths before merging.
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
