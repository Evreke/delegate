# pi-delegate-v2 — Core Architecture

Design document for the first usable release of pi-delegate-v2 (the Core).
Status: **approved by the Stakeholder, 2026-10-06; revised 2026-10-07**
(Stakeholder decisions: completion records, recovery, delivery, session
storage, salvage). Decisions carrying the ADR bar live in `v2/docs/adr/`.
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
Watchdog, TUI Surface (widget).

**Out** (each is a candidate for its own later Brief): web UI · CLI ·
any non-pi harness/backend · compatibility with v1 artifacts ·
Orchestrator-in-Orchestrator (Workers delegating further) · Fleet
surviving session restart (artifacts deliberately survive for manual
continuation — §11 Salvage) · schedules/automation · marketing · a core
merge feature (results integrate through the normal git flow).

## 2. Platform truths (pi)

### Verified 2026-10-06

- A headless pi session processes **one run at a time**; `prompt()`
  resolves when the run finishes.
- `steer()`: a steering message **enters after the current assistant turn
  and its tool calls** — at the step boundary. Mid-step injection does not
  exist. On an idle session, a steer takes effect at once.
- `followUp()`: enters after the whole run finishes.
- `abort()`: stops the active operation; the session survives, goes idle,
  history is preserved; a new prompt starts a new run.

### Verified 2026-10-07 (primary sources: pi docs + dist source + live runs)

- **Spawn introspection**: `createAgentSession()` → `session.sessionId`
  (pi-generated UUIDv7), `session.sessionFile`, `session.sessionManager`
  (`agent-session.d.ts:215,459,461`).
- **Session storage**: default layout
  `~/.pi/agent/sessions/--<encoded-cwd>--/<ISO-ts>_<sessionId>.jsonl`
  (`session-manager.js:288-295,712-713`). The path is **not derivable from
  the id alone** — record the pointer or scan (`findById`). The file is
  created **lazily**: only after the first user/assistant message
  (`session-manager.js:786-800`).
- **Custom entries via pi's API**: parent-side
  `sessionManager.appendCustomEntry(customType, data?)`
  (`session-manager.d.ts:272-273`); extension-side `pi.appendEntry()`
  (`docs/extensions.md:80`). Plain custom entries never enter LLM context.
  No raw file writes into pi-owned logs are ever needed.
- **Resume**: `SessionManager.open(sessionFile)` +
  `createAgentSession({ sessionManager })` continues the same conversation
  at its last leaf; the full active-branch history loads into LLM context
  (`sdk.js:248`); model and thinking level are restored from file entries;
  **system prompt, tools and extensions are recomputed from disk** at
  resume — the resumer must mount the same set the Worker was spawned
  with. A truncated/mid-write JSONL tail line is skipped and repaired on
  load (`session-manager.js:315-321,365-368`); a file with zero parseable
  entries hard-fails. **No locking exists on session files** — a
  double-open silently forks the conversation branch. Usage/cost totals are
  **cumulative per session file across resumes**
  (`agent-session.d.ts:861-864`). Stored-cwd-missing: the SDK path resumes
  silently; `SessionManager.open(path, undefined, fallbackCwd)` re-homes
  cleanly.
- **Custom session dirs** exist (`SessionManager.create(cwd, sessionDir?)`,
  env `PI_CODING_AGENT_SESSION_DIR`, CLI `--session-dir`) but v2 does
  **not** use them —
  [ADR-0001](./docs/adr/0001-session-logs-stay-in-pi-storage.md).

**Consequences (binding for the Core):**
- **Steer** = idle-immediate, otherwise boundary-queued (visible as queued
  until delivered). The force path is **Interrupt then Steer**.
- **Pause** applied mid-run cuts the active run (abort) and holds —
  progress survives in session history.
- No Core mechanism may promise effects *inside* a running step.
- Resume is a platform mechanic of continuation; the Core may resume a
  Worker session **only after the Watchdog has reported the process exit**
  (no locking — a live double-open forks the conversation).

## 3. Topology

- **No daemon.** The v2 extension runs inside the Operator's pi session
  and directly manages Worker child processes.
- A **Fleet** = the Operator's pi session + N Worker pi sessions (headless
  child processes). One Fleet per Operator's pi session.
- Everything lives and dies with the Operator's pi session. Artifacts
  survive on disk — Streams in pi-owned storage, Briefs/Reports/
  Termination Records/manifest in the exchange tree — enabling manual
  continuation (§11 Salvage); nothing else survives restart.

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
- `Ended` is terminal and reached exactly once, always with a **completion
  record**: a Report authored by the Worker, or — only when no Report
  could be obtained from the Worker — a Termination Record authored by the
  Core (§8). The record's `Status` and reason name the variant.
- Budget exhaustion ends the run as `stopped` (reason: budget) through the
  interception flow (§11).
- A Worker with an open Question is `Asking` (suspended).

## 6. Control semantics

| Command   | Worker busy              | Worker idle        | Worker Paused        | Worker Asking        |
|-----------|--------------------------|--------------------|----------------------|----------------------|
| Pause     | cut run (abort), hold    | hold               | no-op                | — (see §8 rule)      |
| Resume    | no-op                    | no-op              | → Working            | —                    |
| Interrupt | abort run → idle         | no-op              | no-op                | —                    |
| Steer     | queued → step boundary   | immediate          | lifts Pause → immediate | —                 |
| Stop      | abort → Ended (`stopped`)| → Ended (`stopped`)| → Ended (`stopped`)  | → Ended (`stopped`)  |

Every ended run produces a completion record (§8) — including
budget-exhausted and operator-stopped runs. A Steer on a Paused Worker
lifts the Pause and takes effect at once — an implicit Resume: the Worker
continues with the new instruction without an explicit Resume.

## 7. Watchdog

A named Core component — the event-driven sense-and-signal layer:

- **Duties**: watch Worker child processes (liveness, exit code/signal),
  detect run completion, emit Events to mounted Surfaces, schedule wakes
  to the Orchestrator (§10). Nothing else.
- **Not its duties**: Budget enforcement, end classification, and recovery
  are Core domain rules (§8, §11) — the Watchdog reports raw process facts
  only.
- **Fail-fast, bounded** (repo command discipline): never blocks the
  Operator session; every wait carries a deadline. On internal error the
  Watchdog degrades to polling-only (`fleet_status` stays authoritative)
  and surfaces the degradation as an Event.
- **Headless by nature**: works with no Surface mounted (§4 boundary test).

## 8. Contracts

### Brief (required at Spawn — the Core hard-refuses without one)

Required content: **Task**, **Role**, **Done criteria**.

Spawn parameters alongside the Brief:
- **Worker name** — unique within the Fleet; the Core hard-refuses a
  duplicate. Grammar `[a-z][a-z0-9_-]{0,31}` (filesystem-safe). Cross-Fleet
  collisions are impossible by construction (per-Fleet exchange directory).
- **Budget** — integer **output tokens** (sum of assistant output; v1
  `budgetTokens` semantics). Mandatory.
- **Checkout mode** — Worktree only inside a git repository; In-place
  anywhere.
- **model** — optional; default from configuration.

**Budget rule**: accrues only from model consumption during executed steps
— no ticks while Paused, Asking, or idle. Cumulative per Worker session
file across resumes (§2) — a resumed Worker inherits its spent Budget.

### Question / Answer

- A Worker asks mid-run → the Orchestrator relays → the Operator answers →
  the Worker resumes with the Answer.
- While Asking: only **Answer** or **Stop** apply (open question — §15).
- Core v1 sets **no timeout** on an open Question (§15).

### Report — worker-authored, never Core-authored

Schema: `status` (`done | stopped | failed`), `summary`, `artifacts[]`,
`evidence[]` — every substantial claim in the summary carries an Evidence
reference (claim + file/artifact path). The Core validates the schema.

**The Core never writes a Report**: work facts belong to the Worker. A
missing or invalid Report is delegated back to the Worker first; a
Termination Record is the last resort.

### Termination Record — Core-authored, last resort

Strict Core-owned schema, **zero work facts**: `reason`, process facts
(exit code/signal, timestamps, Budget spent), and pointers (`sessionFile`,
the invalid Report file if any). It claims nothing about the work done —
so it cannot lose or invent facts, and it can never prove the Done
criteria; it proves the ending.

**Delegation-first classification** (Watchdog reports facts; Core
classifies):

| Facts at run end | Delegation to Worker first | Completion record |
|---|---|---|
| Report present, valid | — | the Report (its Status) |
| Report present, invalid | return validation errors, ≤ 2 retries | Termination Record (`invalid-report`) |
| Run ended, no Report, process alive | steer "write your Report", ≤ 2 nudges | Termination Record (`missing-report`) |
| Budget cut | interception flow (§11) | worker Report, else Termination Record (`budget`) |
| Crash (abnormal exit) | recovery ladder (§11) | worker crash Report, else Termination Record (`crash`) |
| Operator Stop | — | worker Report if producible, else Termination Record (`stopped-by-operator`) |

Reason vocabulary: `crash · missing-report · invalid-report · budget ·
stopped-by-operator`. Reason precedence in mixed cases — Lead.

Reports, Termination Records, and Briefs live in the **Fleet exchange
directory** (§9; exact layout — Lead).

**The contract is two-sided**: the Brief's Done criteria promise, the
Report's Evidence proves. The Orchestrator verifies the Report against the
Done criteria set for that Worker — it trusts evidence, not words — before
completion reaches the Operator.

## 9. Observation

- **A Worker's Stream is its native pi session log** — the JSONL file pi
  writes in **pi-owned default storage** (§2; ADR-0001). The Core writes no
  parallel copy and never moves pi's files; it records pointers and
  appends domain events **through pi's custom-entry API** (§2).
- **Fleet manifest** — one small JSON per Fleet in the exchange tree:
  `name → { sessionId, sessionFile, workerCwd, spawnConfig (model,
  extensions), status, reason, resumeCommand? }`, captured at Spawn from
  §2 introspection. Mandatory: session paths are not derivable from ids
  (§2). It is a pointer table — nothing more (exact schema — Lead).
- Worker-scoped **domain events** (Spawn metadata/Brief, applied Controls,
  Questions/Answers, budget events, completion-record references) are
  recorded as **custom entries in the Worker's session JSONL** via pi's
  API — one self-contained file per Worker: raw activity plus v2's domain
  story.
- **Fleet-level durability** = the Orchestrator's session log (every
  *command* — an Orchestrator-initiated Fleet mutation — is a Core tool
  call recorded there natively) + Worker JSONL custom entries (every
  *transition* — Core/Watchdog-originated) + exchange-tree artifacts
  (Briefs, Reports, Termination Records, manifest). The Fleet's full story
  is reconstructable from these three. **No separate Fleet journal
  exists.**
- **Exchange root**: durable (**never `/tmp`**) and **configurable**;
  default = XDG state location (exact default and layout — Lead); one
  subdirectory per Fleet.
- **Discovery**: the resumed Orchestrator's pi session history holds the
  paths — that is the discovery channel; the manifest is the cheap
  enumeration/inspection affordance, not the discovery mechanism.
- **Full transparency**: pi writes the session logs always, regardless of
  any Surface mounted; on the raw side the Core adds nothing.
- Live Events: the Core emits Events to mounted Surfaces (the TUI widget
  subscribes) from its in-memory state; the native session logs are the
  durable record of the same facts.

## 10. Orchestrator surface

The Orchestrator is a pi agent: it acts on the Core only through tools the
extension exposes (platform fact). The approved set is deliberately small:

- `fleet_spawn` — one or more Briefs (1..N; N = Fan-out). Per-Worker
  params: name, Budget, Checkout mode, model (optional).
- `fleet_control` — `pause | resume | interrupt | steer | stop` (one tool).
- `fleet_answer` — deliver an Answer to a Worker's Question.
- `fleet_status` — Fleet or Worker state query. Per-Worker payload: state,
  queued Steers, Budget usage, completion-record status + reason + summary
  — enough to act without reading files.

Notes:
- Streams are **not** on the Orchestrator's surface: raw activity is
  Surface material (TUI widget, future web UI), never Orchestrator context.
- **Two delivery channels.** Push: on a Worker's end the Core schedules a
  `followUp()` wake into the Operator session with a compact payload.
  Pull: `fleet_status` + the on-disk record. **A wake is a hint; the pull
  side is authoritative.** Delivery is at-least-once: duplicate wakes are
  harmless, wakes are not persisted across restarts (the Fleet dies
  anyway — §3), and the Orchestrator verifies via `fleet_status`/the
  record before acting or reporting to the Operator.
- **Wake classes**:
  - **Class R** — a worker-authored Report exists. Payload
    `{worker, status, summary}`. Duty: verify against the Done criteria
    (§8 two-sided contract), then report to the Operator.
  - **Class T** — a Termination Record. Payload = minimal facts
    `{worker, reason, exit facts, pointers}` + the halt rule: **the
    Orchestrator surfaces the facts to the Operator and HALTS — no
    investigation, no log/stream reading, no re-Spawn, no corrective
    action — until the Operator explicitly approves one.** Enforcement is
    soft (the Orchestrator is an agent): minimal payload (pointers, never
    content), the rule carried in the wake text, and Streams absent from
    the surface. Violation is visible to the Operator in the next message.
- The full Report is read on demand for verification (§8).
- **TUI commands are not part of the Core**: the TUI Surface is the widget
  only; all control flows through chat with the Orchestrator. TUI commands
  are a candidate for a later Brief.

## 11. Failure, budget & recovery

**Budget interception flow** (Budget is a Core run-management rule; the
Watchdog only observes the end):

1. Cap reached → Core **Interrupts** the active run (worker → idle, history
   preserved — §2).
2. Core **steers**: "Budget exhausted — write your final Report on what is
   done, with Evidence."
3. **Bounded grace window**, exempt from Budget (cap — Lead).
4. Report arrives → Ended `stopped` (reason: budget), worker-authored.
5. No Report after grace + one nudge → **Stop** → Termination Record
   (budget).

**Crash-recovery ladder** (Watchdog reported an abnormal exit):

1. **Liveness guard**: process exit confirmed via pid — never resume a
   live process (§2: no locking).
2. **No JSONL** (died before the first message — lazy creation, §2):
   unrecoverable → Termination Record (crash, "no traces").
3. **One bounded recovery attempt**: resume the session (§2 mechanics,
   manifest `spawnConfig` re-mounted) and prompt: "Your process crashed —
   write your final Report on what is done, with Evidence." Budget-exempt
   grace.
4. Report arrives → Ended `failed` (crash) with a **worker-authored**
   Report — facts preserved.
5. Attempt fails (resume error, corrupt file, no Report after grace) →
   Termination Record (crash).

Continuing the *work* on a resumed session is never automatic — an
Operator-approval decision under the Class T halt rule (§10).

- Worker process crash → `Ended`, status `failed`, via the ladder above.
- The Fleet is **idle** exactly when every Worker is `Ended`; the
  Orchestrator then collects the completion records and reports to the
  Operator.

**Salvage** (Stakeholder-approved semantics: the Fleet dies, work
continues with some losses):

- Invariant: at any moment — including after reboot — exchange tree +
  manifest + completion records + pi-owned Streams let a resumed
  Orchestrator reconstruct who was spawned, with which Brief, how each
  ended, and what remains.
- Mechanics verified (§2, 2026-10-07): the manifest triple
  `{sessionId, sessionFile, workerCwd}` is sufficient to resume a Worker
  session from a fresh process.
- Continuation is an **Orchestrator decision under Operator authority**:
  verify artifacts → resume or re-Spawn unfinished Briefs. Never
  automatic resurrection — §1's Out stands.
- Deleted worktrees: resume/fork before cleanup, or accept the
  `fallbackCwd` re-home (§2). Worktree cleanup timing — Operator approval.

## 12. Verification

- **Boundary test** (§4): Core fully exercisable headless, no Surface.
- **Steer scenarios** (scripted fake Worker; bounded check files per repo
  command discipline): queued-visibility (a Steer on a busy Worker shows
  queued in `fleet_status` and appears in the Worker's context only
  at/after the step boundary — never mid-step) · ordering (queued Steers
  arrive in order) · implicit Resume (Steer on Paused lifts Pause at once,
  §6).
- **Artifact-completeness scenario**: after a scripted headless fleet run
  including one crash, the exchange tree + JSONLs contain the Brief, a
  completion record for every Worker (crash path included), domain entries
  for every lifecycle transition, and a complete manifest. Doubles as the
  salvage-material test.
- **Live acceptance item** in each release PR's acceptance list: real pi
  child, real step boundary, queued→delivered observed.
- Platform truths (§2) are verified facts — v2 does not re-test them; it
  pins only Core-owned behaviors.

## 13. Repository layout (monorepo)

```
/                  v1 — unchanged, its laws apply there
/v2                pi-delegate-v2 (working name)
  CONTEXT.md       approved domain glossary (2026-10-06, revised 2026-10-07)
  ARCHITECTURE.md  this document
  docs/adr/        architecture decision records (ADR bar: hard to reverse
                   + surprising without context + a real trade-off)
  src/ …           implementation (Lead, after milestone approval)
```

v2 inherits the documentation discipline: behavior truth lives in code;
these documents are contracts, nothing more. ADRs are created lazily,
never per-decision by default.

## 14. Annex — Borrowed from v1 (ideas only, never code)

Borrowed: brief→spawn→report cycle · Question/Answer (mailbox idea) ·
exchange-directory layout (root: durable and configurable, never /tmp) ·
Budget caps (unit: output tokens) · Evidence in reports ·
report-as-completion-criterion · Stream idea (implemented as pi's native
session JSONL + custom entries — v2 writes no duplicate log) ·
worktree-per-worker · Steer (semantics corrected) · Interrupt · watcher/wake
idea (rebuilt on `followUp` + authoritative `fleet_status`) · worker-name
grammar · the fleet/worker/orchestrator vocabulary.

Explicitly **not** borrowed: herdr placement and its worktree mechanics ·
the v1 dashboard · classifier triage · swarm-server/mount machinery ·
journal/sqlite design · any v1 source code.

## 15. Open questions

1. **Model per Worker** as a Spawn parameter (default from configuration) — confirm.
2. **Question timeout**: none in Core v1 — confirm, or define.
3. **Controls while Asking**: only Answer or Stop — confirm.
4. **Final product name** — working name `pi-delegate-v2`, decide before release.
5. Worker **worktree branch naming** — Lead.
6. **Grace-window caps** (budget interception, crash recovery) — Lead.
7. **Manifest exact schema + exchange-root default path** — Lead.
8. **Reason precedence** in mixed end cases (§8 table) — Lead.
