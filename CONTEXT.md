# pi-delegate — domain language

The vocabulary for pi-delegate's delegation fleet: what a task, worker,
session and placement ARE, and how they relate. This is the territory the
read-model (SwarmGraph) and the dashboard both project — a glossary, not a
spec. Behavioral truth stays in the code's own contracts (ZSDoc); operational
truth in `AGENTS.md`; binding rules in `ARCHITECTURE.md`.

## Language

### Entities

**Task**:
A container of work — one exchange dir (`/tmp/exchange/<task>/`) holding the
manifest, briefs, mailbox files and reports. A task is a holder, not a runtime.
_Avoid_: group, project

**Worker**:
One run of a named worker inside a task. Identity is (task, name, run) — `run`
distinguishes same-name retries; the read-model's manifestRef also keys on
`placementRef` (the WHERE). The central entity: the join of every axis.
_Avoid_: agent, node

**Session**:
A pi session (a JSONL file and its identity). The runtime an orchestrator or a
worker lives in.
_Avoid_: process, terminal, pane

**Placement**:
Where a worker runs — an isolated worktree or a shared placement — carrying a
backend and an opaque placementRef. The record of WHERE, distinct from the
path an agent runs in.
_Avoid_: workspace, checkout, cwd

**Fleet**:
The collection of tasks owned by one session (one `/api/swarm/fleets` row).
Distinct from Task.

**Brief / Report**:
A worker's input (markdown instructions) and output (schema-validated JSON),
both stored in the task dir.

### Roles (a session's role; the read-model's `roleLabel` emits these four)

**Orchestrator**:
A session that spawns workers and owns tasks. Never itself spawned — the root
of its fleet.

**Worker-orchestrator** (lead):
A session that is BOTH a worker (spawned into a parent task) AND an
orchestrator (owns a child task). The tier-1 exception. Distinct from
`AGENTS.md`'s "sub-orchestrator", which is the AUTHORITY tier (cwd inside a
worktree), not this role — correlated, but not identical.

**Worker session**:
A session spawned to do a task; spawns nothing. (Role label `worker`.)

**Unknown**:
A session whose role cannot be resolved (degraded self-id / no session path).

### Relationships

**contains**:
Task → Worker. Structural: the task's manifest lists its workers. (Target —
not yet an edge; see "Known divergence".)
_Avoid_: has, includes

**spawned_by**:
Worker → Orchestrator session. Causal: which session spawned this worker.
_Avoid_: created_by, started_by

**owned_by**:
Task → owner session. Authority: which session owns this task's fleet.
(Target — today the read-model mislabels it `spawned_by`.)
_Avoid_: master, belongs_to

**collected** / **retired**:
Worker → owning Task. Lifecycle edges carrying the `collectedAt` / `retiredAt`
stamp.

**runs_in**:
Worker → its own session. The worker's runtime embodiment.

### Structure

**Containment axis**:
The static task⊃worker nesting (exchange dir + manifest).

**Lineage axis**:
The causal spawn chain: session → worker → (lead) → child task → worker.

**Two-level authority**:
depth 0 = the root orchestrator's workers; depth 1 = a lead's workers.

**Worker is the join**:
A worker is simultaneously contained in a task, spawned by a session, and
running in a session — the point where the two axes meet.

### Lifecycle

placed → started → working → (ask/answer) → report → collected → closed.
(The manifest field `retiredAt` maps to the terminal `closed` phase.)

### Known divergence (target vs today)

The read-model's edge vocabulary today is `spawned_by` / `collected` /
`retired`. `contains` and `owned_by` are the TARGET: today `graph-build.ts`
emits `spawned_by` for BOTH worker→orchestrator (lineage) and task→owner (the
conflation `owned_by` is meant to fix). This glossary is the target language;
the code is mid-migration (#136, #141).
