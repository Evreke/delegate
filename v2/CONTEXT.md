# pi-delegate-v2 — Core Domain

The core domain language of pi-delegate-v2: a pi extension with which an
Operator delegates work to a Fleet of pi-agent Workers from the Operator's
pi session. The Core is UI-blind: Surfaces consume it; it never knows
about them.

Terms tagged **(v1)** are ideas explicitly borrowed from pi-delegate v1 —
ideas only, never code (agreed constraint). Un-tagged terms are new in v2.

## Language

### People

**Operator**:
The human running the pi session that hosts the Fleet. The only
authority: approves plans, answers Questions, issues Controls.
_Avoid_: user, stakeholder.

**Orchestrator**:
The pi agent in the Operator's pi session that plans work, writes
Briefs, Spawns Workers, relays Questions and Answers, and collects
Reports. Exactly one per Fleet.
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
complete.
_Avoid_: DoD, acceptance criteria.

**Budget** (v1):
The mandatory limit on a Worker's consumption. Every Worker has one;
exhausting it ends the run.
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
To act sooner, Interrupt first.
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
The structured account every run ends with: Status, Summary, Artifacts,
Evidence. The Report is the completion criterion — not process state.
_Avoid_: result, output.

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
model messages, reasoning. Written always, regardless of any Surface —
full transparency.
_Avoid_: log, feed, trace.

**Event**:
The single unit the Core emits outward; Streams are made of Events.
_Avoid_: message, notification.

**Surface**:
A consumer of the Core's Events and queries. The TUI (widget +
commands) is one Surface; a web UI is another. The Core is blind to
Surfaces.
_Avoid_: view, dashboard, frontend.

### Lifecycle

**Working**: The live state of a Worker executing its Brief.

**Paused**: Suspended by Pause; alive, not progressing.

**Asking**: Suspended with an open Question.

**Ended**: Terminal. Every Worker reaches Ended exactly once, and always
with a Report; the variant comes from the Report's Status.

The Fleet is idle exactly when every Worker is Ended.

---

Approved by the Stakeholder, 2026-10-06.
