# pi-delegate-v2 — Core Domain

Revised 2026-10-07 (Stakeholder decisions: Budget unit, completion records,
Watchdog, manifest).

The core domain language of pi-delegate-v2: a pi extension with which an
Operator delegates work to a Fleet of pi-agent Workers from the Operator's
pi session. The Core is UI-blind: Surfaces consume it; it never knows about them.

Terms tagged **(v1)** are ideas explicitly borrowed from pi-delegate v1 —
ideas only, never code (agreed constraint). Un-tagged terms are new in v2.

Harness vocabulary is used descriptively, never defined or owned here:
«agent» means a pi agent — an independent concept outside delegation. In
delegate's language, the agent managing the Fleet is the **Orchestrator**;
agents executing Briefs are **Workers**.

Built from the approved v2 decision tree (rounds 5–12). v1's own CONTEXT.md
was deliberately not consulted: the vocabulary is rebuilt, coincidences are
marked, not inherited.

## Language

### People

**Operator**:
The human running the pi session that hosts the Fleet. The only
authority: approves plans, answers Questions, issues Controls.
_Avoid_: user, stakeholder.

**Orchestrator**:
The pi agent in the Operator's pi session that plans work, writes
Briefs, Spawns Workers, relays Questions and Answers, collects Reports,
and verifies them against the Brief's Done criteria before completion
reaches the Operator. Exactly one per Fleet.
_Avoid_: coordinator, lead, PM.

### Fleet & Workers

**Fleet** (v1):
The Operator's pi session together with its Workers. Each Worker runs
in its own pi session, so a Fleet spans more than one pi session
(N+1). Each Operator's pi session holds at most one Fleet.
_Avoid_: swarm, team.

**Worker**:
A pi agent running headless in its own pi session — a child process of
the Operator's pi session — executing exactly one Brief. Has a name, a
Role, a Checkout mode, a Budget.
_Avoid_: agent, subagent, process.

**Role**:
The function a Worker serves, declared in its Brief (implementer,
reviewer, researcher, …). Shapes the Worker's prompts and permissions.
_Avoid_: persona, profile, tier.

**Spawn** (v1):
Create one Worker from a Brief.
_Avoid_: launch, start, instantiate.

**Fan-out** (v1):
Spawn several Workers in parallel in one planning act.
_Avoid_: batch, scale-out.

**Checkout mode** (v1 idea, renamed from "isolation mode" / "placement"):
Where a Worker's file changes land, chosen at Spawn: In-place or
Worktree. Worktree is possible only in a git repository; In-place
anywhere.
_Avoid_: isolation mode, placement, sandbox.

**In-place**:
Checkout mode in which the Worker edits the checkout of the
Operator's pi session directly.

**Worktree** (v1 idea):
Checkout mode in which the Worker works in its own git worktree: one
per Worker, created and owned by v2 itself — no external multiplexer.
A Worker never edits outside its own Worktree.
_Avoid_: branch, isolation mode, placement, sandbox.

### Work packages

**Brief** (v1):
The mandatory package a Worker is spawned with: Task, Role, Done
criteria. The Core refuses a Spawn without one.
_Avoid_: assignment, spec, ticket.

**Task**:
The concrete work assignment inside a Brief.
_Avoid_: job, story.

**Done criteria**:
The verifiable conditions in a Brief that decide when the Task is
complete — the side of the two-sided contract that the Report's
Evidence must prove.
_Avoid_: DoD, acceptance criteria.

**Budget** (v1):
The mandatory limit on a Worker's consumption, in **output tokens** (sum of
assistant output). Every Worker has one; exhausting it ends the run.
Accrues only during executed steps — no ticks while Paused, Asking, or
idle; cumulative per Worker session across resumes.
_Avoid_: cap, quota, limit.

### Control

**Control**:
One of the five commands over a Worker: Pause, Resume, Interrupt,
Steer, Stop.
_Avoid_: remote, command.

**Pause**:
Suspend a Worker's progress while keeping it alive and resumable.
_Avoid_: freeze, hold.

**Resume**:
Continue a Paused Worker.
_Avoid_: unpause, play.

**Interrupt** (v1):
Abort a Worker's current step at once; the Worker stays alive and idle.
_Avoid_: cancel, kill.

**Steer** (v1, semantics corrected):
Deliver a new instruction to a Worker. On an idle Worker it takes
effect at once; on a working Worker it enters at the next step
boundary — platform-guaranteed, visible as queued until delivered.
On a Paused Worker it lifts the Pause and takes effect at once — a
Steer is an implicit Resume. To act sooner on a busy Worker,
Interrupt first.
_Avoid_: nudge, message.

**Stop**:
End a Worker for good. The run still ends with a Report.
_Avoid_: kill, terminate.

### Questions

**Question** (v1 "mailbox" idea):
A Worker's mid-run request to the Operator, relayed by the Orchestrator.
While a Question is open, the Worker is suspended.
_Avoid_: clarification request, mailbox.

**Answer**:
The Operator's reply to a Question; it resumes the asking Worker.
_Avoid_: response, reply.

### Completion

**Report** (v1):
The structured account of a run: Status, Summary, Artifacts, Evidence.
Always **worker-authored** — the Core never writes one. The Report is the
completion criterion — not process state.
_Avoid_: result, output.

**Termination Record**:
The Core-authored completion record of last resort, written only when no
Report could be obtained from the Worker (crash, missing-report,
invalid-report, budget, stopped-by-operator). Strict Core-owned schema,
zero work facts: reason, process facts, and pointers (session log, invalid
Report file). Proves the ending, never the Done criteria.
_Avoid_: crash report, tombstone, failure report.

**Status**:
A Report's verdict: `done`, `stopped`, or `failed`.
_Avoid_: state.

**Evidence** (v1):
A Report reference backing a substantial claim, pointing at a file or
Artifact.
_Avoid_: proof, support.

**Artifact**:
A file a run produced that is meant to outlive the Worker.
_Avoid_: deliverable, output.

### Observation

**Stream** (v1 read-model idea):
The append-only record of one Worker's raw activity: steps, tool calls,
model messages, reasoning — the Worker's native pi session JSONL, living
in pi-owned storage. Written always, regardless of any Surface — full
transparency. The Core appends domain events through pi's API and records
pointers; it never writes a parallel copy.
_Avoid_: log, feed, trace.

**Watchdog**:
The Core component that senses Worker process facts (liveness, exit,
completion) and signals them asynchronously — Events to Surfaces, wakes to
the Orchestrator — so no agent burns tokens polling. Reports raw facts
only: classification, Budget enforcement, and recovery are Core domain
rules. Fail-fast and bounded; degrades to polling-only on internal error.
_Avoid_: watcher, monitor, supervisor.

**Fleet Manifest**:
The per-Fleet pointer table in the exchange directory: Worker name →
session id, session file path, worker cwd, spawn config, end status and
reason. The anchor of salvage — sufficient to resume any Worker session
from a fresh process. Nothing more than a pointer table.
_Avoid_: registry, index, journal.

**Event**:
The single unit the Core emits outward; Streams are made of Events.
_Avoid_: message, notification.

**Surface**:
A consumer of the Core's Events and queries. The TUI (widget) is one
Surface; a web UI is another. The Core is blind to Surfaces.
_Avoid_: view, dashboard, frontend.

### Lifecycle

**Working**: The live state of a Worker executing its Brief.

**Paused**: Suspended by Pause — alive, but no new step starts until
Resume, a Steer, or Stop. A Steer on a Paused Worker lifts the Pause
(implicit Resume).

**Asking**: Suspended with an open Question.

**Ended**: Terminal. Every Worker reaches Ended exactly once, and always
with a completion record — a worker-authored Report or, as last resort, a
Core-authored Termination Record; the variant comes from the record's
Status and reason.

The Fleet is idle exactly when every Worker is Ended.

---

Approved by the Stakeholder, 2026-10-06; revised 2026-10-07.
