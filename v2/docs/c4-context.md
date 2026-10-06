# pi-delegate-v2 — C4 Context

Level 1 of the C4 model: the system in scope, the people, and the
external dependencies. Domain language: `v2/CONTEXT.md`. Everything here
traces to the approved `v2/ARCHITECTURE.md` — this document adds no new
decisions.

Approved by the Stakeholder, 2026-10-06.

## Elements

- **Person — Operator**: the human in the pi session; describes tasks,
  answers Questions, issues Controls, verifies acceptance.
- **Software system (in scope) — pi-delegate-v2 Core**: the domain +
  orchestration engine (a pi extension); UI-blind; enforces the Brief /
  Budget / Report contracts; emits Events.
- **Software actor — Orchestrator**: the pi agent in the Operator's pi
  session; plans work, writes Briefs, drives the Core through its four
  tools, verifies Reports. Named role of an agent, not a separate product.
- **External system — pi harness**: agent runtime, TUI, session JSONL
  storage; hosts the Core, the Orchestrator and the headless Worker
  sessions; writes the session logs.
- **External system — git**: repositories; source of Worktrees (Worktree
  checkout mode).
- **External system — AI model providers**: serve model calls for the
  Orchestrator and Workers (via pi).

## Diagram

```mermaid
C4Context
  title pi-delegate-v2 — System Context

  Person(operator, "Operator")

  System_Boundary(session, "Operator's pi session") {
    System(orchestrator, "Orchestrator", "pi agent")
    System(core, "pi-delegate-v2 Core", "system in scope")
    System(widget, "TUI widget", "Surface")
  }

  System_Ext(workers, "Workers x N", "pi agents")
  System_Ext(pi_storage, "pi session storage", "JSONL")
  System_Ext(git, "git")
  System_Ext(llm, "AI providers")

  Rel(operator, orchestrator, "chat", "", "solid")
  Rel(operator, widget, "watches", "", "dashed")
  Rel(orchestrator, core, "tools", "", "solid")
  Rel(core, widget, "Events", "", "dashed")
  Rel(core, workers, "spawns, controls", "", "bold")
  Rel(core, pi_storage, "domain entries", "", "dashed")
  Rel(workers, pi_storage, "raw logs", "", "dashed")
  Rel(core, git, "worktrees", "", "solid")
  Rel(workers, llm, "models", "", "dotted")
  Rel(orchestrator, llm, "models", "", "dotted")

  UpdateRelStyle(operator, orchestrator, $offsetX="-20", $offsetY="-30")
  UpdateRelStyle(operator, widget, $offsetX="20", $offsetY="-20")
  UpdateRelStyle(orchestrator, core, $offsetX="-10", $offsetY="-10")
  UpdateRelStyle(core, widget, $offsetX="-10", $offsetY="-10")
  UpdateRelStyle(core, workers, $offsetX="-30", $offsetY="20")
  UpdateRelStyle(core, pi_storage, $offsetX="30", $offsetY="10")
  UpdateRelStyle(workers, pi_storage, $offsetX="0", $offsetY="-10")
  UpdateRelStyle(core, git, $offsetX="-30", $offsetY="20")
  UpdateRelStyle(workers, llm, $offsetX="-30", $offsetY="20")
  UpdateRelStyle(orchestrator, llm, $offsetX="-40", $offsetY="30")
```

**Line semantics:** solid = control and commands · dashed = data and
observation · dotted = model calls · bold = the main orchestration axis
(Core → Workers).

## Relations (precise labels — kept out of the diagram on purpose)

| From → To | Meaning |
|---|---|
| Operator → Orchestrator | chat: tasks, Questions, Controls |
| Operator → TUI widget | watches the Fleet |
| Orchestrator → Core | `fleet_spawn` · `fleet_control` · `fleet_answer` · `fleet_status` |
| Core → TUI widget | live Events |
| Core → Workers | spawns, controls (headless child processes) |
| Core → pi session storage | custom entries (v2 domain events) |
| Workers → pi session storage | raw activity, logged by pi (JSONL) |
| Core → git | creates and owns Worker worktrees |
| Workers → AI providers | model calls via pi |
| Orchestrator → AI providers | model calls via pi |

## Notes

- C4 mapping choices: the Orchestrator and the TUI widget are shown as
  systems inside the `Operator's pi session` boundary — the Core is the
  system in scope; the Orchestrator is a named role of a pi agent, the
  widget is the Core's only Surface in this release.
- The TUI widget is the only Surface in the Core release; a web UI would
  be an equal consumer of the same Events (later Brief).
- Workers live in their own pi sessions; a Fleet spans N+1 sessions.
- The Core never writes a parallel log: Streams are pi's session JSONL,
  enriched with v2 custom entries.
