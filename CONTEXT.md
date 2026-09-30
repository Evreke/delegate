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
_Avoid_: fleet, group, project

**Worker**:
One run of a named worker inside a task. Identity is (task, name, run) — `run`
distinguishes same-name retries. The central entity: the join of every axis.
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

**Brief / Report**:
A worker's input (markdown instructions) and output (schema-validated JSON),
both stored in the task dir.

### Roles

**Orchestrator**:
A session that spawns workers and owns tasks. Never itself spawned — the root
of its fleet.

**Worker-orchestrator** (lead):
A session that is BOTH a worker (spawned into a parent task) AND an
orchestrator (owns a child task). The tier-1 exception. `AGENTS.md`'s
"sub-orchestrator" is the same entity seen through the authority lens.

**Worker session**:
A session spawned to do a task; spawns nothing.

### Relationships

**contains**:
Task → Worker. Structural: the task's manifest lists its workers.
_Avoid_: has, includes

**spawned_by**:
Worker → Orchestrator session. Causal: which session spawned this worker.
_Avoid_: created_by, started_by

**owned_by**:
Task → fleet-owner session. Authority: which session owns this task's fleet.
_Avoid_: master, belongs_to

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

placed → started → working → (ask/answer) → report → collected → retired.
