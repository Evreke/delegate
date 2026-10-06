# pi-delegate-v2 — Core Architecture

Design document for the first usable release of pi-delegate-v2 (the Core).
Status: **approved by the Stakeholder, 2026-10-06**.
Domain language: [CONTEXT.md](./CONTEXT.md) — domain terms are
capitalized. Every claim traces to a Stakeholder-approved decision or a
verified platform fact.

Audience: the Stakeholder (approval authority) and the Lead developer
(implementation authority).

## 1. Purpose & boundaries

**Purpose**: rebuild delegation on an explicit domain model — closing v1's
three pains: a domain model smeared across layers, steering that never
lands, and an architecture that cannot carry a real UI.

**In**: the Core (domain + orchestration engine), Worker lifecycle, the
full control set, observation Streams, Brief/Report/Question contracts,
TUI Surface (widget).

**Out** (each is a candidate for its own later Brief): web UI · CLI ·
any non-pi harness/backend · compatibility with v1 artifacts ·
Orchestrator-in-Orchestrator (Workers delegating further) · Fleet
surviving session restart · schedules/automation · marketing · a core
merge feature (results integrate through the normal git flow).

## 2. Platform truths (pi, verified 2026-10-06)

- A headless pi session processes **one run at a time**; `prompt()`
  resolves when the run finishes.
- `steer()`: a steering message **enters after the current assistant turn
  and its tool calls** — at the step boundary. Mid-step injection does not
  exist. On an idle session, a steer takes effect at once.
- `followUp()`: enters after the whole run finishes.
- `abort()`: stops the active operation; the session survives, goes idle,
  history is preserved; a new prompt starts a new run.

**Consequences (binding for the Core):**
- **Steer** = idle-immediate, otherwise boundary-queued (visible as queued
  until delivered). The force path is **Interrupt then Steer**.
- **Pause** applied mid-run cuts the active run (abort) and holds —
  progress survives in session history.
- No Core mechanism may promise effects *inside* a running step.

## 3. Topology

- **No daemon.** The v2 extension runs inside the Operator's pi session
  and directly manages Worker child processes.
- A **Fleet** = the Operator's pi session + N Worker pi sessions (headless
  child processes). One Fleet per Operator's pi session.
- Everything lives and dies with the Operator's pi session. Streams and
  Reports remain on disk as artifacts; nothing else survives restart.

## 4. The Core and Surfaces

- The Core owns all domain state and rules. It never imports TUI or web
  code; its only outward channel is **Events + queries**.
- Surfaces are equal consumers: the TUI (widget) is the first; a web UI
  is a later one.
- **Boundary test**: the Core must be fully exercisable with no Surface
  mounted (headless fleet run).

## 5. Worker lifecycle

States: `Spawning → Working ⇄ Paused → Asking → Ended`.

- `Working` has two phases: **busy** (a step is running) and **idle**
  (alive, between steps). `Interrupt` moves busy → idle.
- `Ended` is terminal and reached exactly once, always with a Report; the
  Report's `Status` (`done | stopped | failed`) names the variant.
- Budget exhaustion ends the run as `stopped` (reason: budget).
- A Worker with an open Question is `Asking` (suspended).

## 6. Control semantics

| Command   | Worker busy              | Worker idle        | Worker Paused        | Worker Asking        |
|-----------|--------------------------|--------------------|----------------------|----------------------|
| Pause     | cut run (abort), hold    | hold               | no-op                | — (see §7 rule)      |
| Resume    | no-op                    | no-op              | → Working            | —                    |
| Interrupt | abort run → idle         | no-op              | no-op                | —                    |
| Steer     | queued → step boundary   | immediate          | lifts Pause → immediate | —                 |
| Stop      | abort → Ended (`stopped`)| → Ended (`stopped`)| → Ended (`stopped`)  | → Ended (`stopped`)  |

Every ended run produces a Report — including budget-exhausted and
operator-stopped runs. A Steer on a Paused Worker lifts the Pause and
takes effect at once — an implicit Resume: the Worker continues with
the new instruction without an explicit Resume.

## 7. Contracts

### Brief (required at Spawn — the Core hard-refuses without one)

Required content: **Task**, **Role**, **Done criteria**.
Spawn parameters alongside the Brief: **worker name**, **Budget**,
**Checkout mode** (Worktree only inside a git repository; In-place
anywhere), **model** (optional; default from configuration — see open
questions).

### Question / Answer

- A Worker asks mid-run → the Orchestrator relays → the Operator answers →
  the Worker resumes with the Answer.
- While Asking: only **Answer** or **Stop** apply (open question — see §13).
- Core v1 sets **no timeout** on an open Question (see §13).

### Report (the completion criterion — never process state)

Schema: `status` (`done | stopped | failed`), `summary`, `artifacts[]`,
`evidence[]` — every substantial claim in the summary carries an Evidence
reference (claim + file/artifact path). The Core validates the schema; an
invalid Report marks the run `failed` (reason: invalid report).

Reports and Briefs live in the **Fleet exchange directory** (layout idea
borrowed from v1; exact path shape — Lead).

**The contract is two-sided**: the Brief's Done criteria
promise, the Report's Evidence proves. The Orchestrator verifies the
Report against the Done criteria that were set for that Worker — it
trusts evidence, not words — before completion reaches the Operator.

## 8. Observation

**A Worker's Stream is its native pi session log** — the JSONL session
file pi itself writes: full messages, tool calls, reasoning, usage. The
Core writes no parallel copy. Each Worker runs with a deterministic
custom session-id (= its worker name) and a session directory set
inside the Fleet exchange tree: the worker → session-file mapping needs
no registry, and a Fleet's artifacts live in one place (exact layout —
Lead).

- Worker-scoped **domain events** (Spawn metadata/Brief, applied
  Controls, Questions/Answers, budget events, the Report) are recorded
  as **custom entries in the same session JSONL** (pi v3 `custom`
  entries) — one self-contained file per Worker: raw activity plus v2's
  domain story.
- **Fleet-level durability comes from the Orchestrator's own session
  log**: every Fleet mutation is a Core tool call made there
  (`fleet_spawn`, `fleet_control`, `fleet_answer`), recorded natively
  by pi with timestamps and results. No separate Fleet journal exists.
- **Full transparency**: pi writes the session logs always, regardless
  of any Surface mounted; on the raw side the Core adds nothing.
- Live Events: the Core emits Events to mounted Surfaces (the TUI
  widget subscribes) from its in-memory state; the native session logs
  are the durable record of the same facts.

## 9. Orchestrator surface

The Orchestrator is a pi agent: it acts on the Core only through tools
the extension exposes (platform fact). The approved set is deliberately
small — exactly what the approved duties require:

- `fleet_spawn` — one or more Briefs (1..N; N = Fan-out). Per-Worker
  params: name, Budget, Checkout mode, model (optional).
- `fleet_control` — `pause | resume | interrupt | steer | stop` (one
  tool).
- `fleet_answer` — deliver an Answer to a Worker's Question.
- `fleet_status` — Fleet or Worker state query (polling).

Notes:
- Streams are **not** on the Orchestrator's surface: raw activity is
  Surface material (TUI widget, future web UI), never Orchestrator
  context.
- On a Worker's completion the Core delivers Status + summary to the
  Orchestrator; the full Report is read on demand for verification
  (see §7 — two-sided contract).
- **TUI commands are not part of the Core**: the TUI Surface is the
  widget only; all control flows through chat with the Orchestrator.
  TUI commands are a candidate for a later Brief.

## 10. Failure & budget

- Budget exhausted → run ends `stopped` (reason: budget), Report required.
- Worker process crash → `Ended`, status `failed`; no Report possible →
  the Core records `failed` (reason: crash) in the Fleet state.
- The Fleet is **idle** exactly when every Worker is `Ended`; the
  Orchestrator then collects the Reports and reports to the Operator.

## 11. Repository layout (monorepo)

```
/                  v1 — unchanged, its laws apply there
/v2                pi-delegate-v2 (working name)
  CONTEXT.md       approved domain glossary (2026-10-06)
  ARCHITECTURE.md  this document after approval
  src/ …           implementation (Lead, after milestone approval)
```

v2 inherits the documentation discipline: behavior truth lives in code;
these two documents are contracts, nothing more.

**Architecture decision records**: decisions carrying the ADR bar (hard
to reverse + surprising without context + a real trade-off) are recorded
in `v2/docs/adr/NNNN-*.md` (convention approved 2026-10-06). ADRs are
created lazily, never per-decision by default.

## 12. Annex — Borrowed from v1 (ideas only, never code)

Borrowed: brief→spawn→report cycle · Question/Answer (mailbox idea) ·
exchange-directory layout · Budget caps · Evidence in reports ·
report-as-completion-criterion · Stream idea (implemented as pi's native
session JSONL + custom entries — v2 writes no duplicate log) ·
worktree-per-worker · Steer (semantics corrected) · Interrupt · the
fleet/worker/orchestrator vocabulary.

Explicitly **not** borrowed: herdr placement and its worktree mechanics ·
the v1 dashboard · classifier triage · swarm-server/mount machinery ·
journal/sqlite design · any v1 source code.

## 13. Open questions

1. **Model per Worker** as a Spawn parameter (default from configuration) — confirm.
2. **Question timeout**: none in Core v1 — confirm, or define.
3. **Controls while Asking**: only Answer or Stop — confirm.
4. **Final product name** — working name `pi-delegate-v2`, decide before release.
5. Worker **worktree branch naming** — Lead.
