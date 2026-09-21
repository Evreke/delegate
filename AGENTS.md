# pi-delegate — agent glossary

> **Binding constitution.** `ARCHITECTURE.md` (in this directory) binds every
> agent that touches this extension; its laws are the binding layer for
> all work on the codebase. Where ARCHITECTURE.md and the prose conventions in
> this file conflict, ARCHITECTURE.md outranks them.

## Documentation — closed set (operator law)

Documents are read by agents: they cost tokens and rot. The extension's documentation is a CLOSED set — behavior truth lives in code:

- **ZSDoc in code** (MODULE_CONTRACT / FUNCTION_CONTRACT / BUG_FIX_CONTEXT at the point of use) — the primary truth about behavior.
- **ARCHITECTURE.md** — the strict guideline: binding rules and their enforcement, no behavioral narrative.
- **README.md** — what the extension is, how to install and configure it, operational notes. Nothing else.
- **CHANGELOG.md** — release history (Keep a Changelog; released sections immutable).
  Documentation-only changes to REPO docs (README, EXAMPLES.md, AGENTS.md) get NO
  CHANGELOG entries — only behavior changes are recorded. The delegate skill
  (`skills/delegate/`) is different: it ships inside the versioned pi package
  (`pi.skills` in package.json), so changes to it are recorded like any other
  shipped-artifact change.

Everything else is garbage — do NOT create it in this repo: no plans, TL;DRs, acceptance records, session instructions, stage guides, notes, design logs/chronicles or decision archaeology. Agent-to-agent artifacts (briefs, reports, plans) go to the exchange dir, never the repo. Documents carry ONLY current truth and plans: no rejected approaches, no interim states, no who-decided-what — history lives in git commits and CHANGELOG. Do not write rottable status prose into living docs; prefer the code's own state. A new `.md` file requires the operator's explicit decision.

One rule: **"worktree" names the isolation mechanism, "checkout" names the path.** They are complementary, never synonyms — code pairs them deliberately (`Placement.kind: "worktree"` carries a `checkoutPath`).

## Terms

- **git worktree** — git's native extra-checkout of one repo (registered in `.git/worktrees/`, has a branch). No herdr involvement. Do not confuse with a herdr workspace.
- **wt-workspace** — a herdr workspace whose cwd is backed by a git worktree: what `herdr worktree create`/`open` makes and what `Placement.kind === "worktree"` means. Has a tab + root pane; a bare git worktree has no herdr UI presence at all.
- **master checkout** — the repo's main checkout (herdr's `repo_root`, the source-of-truth for `--cwd`). herdr refuses a *linked* worktree as a `--cwd` source (`not_linked_worktree` guard) — master only.
- **checkout / `checkoutPath`** — the directory an agent runs in. A wt-workspace has its own; a `tab` shares the orchestrator's. Never use "checkout" as a name for the placement kind.
- **repo group** — herdr's UI grouping of workspaces by `repo_key`: one git repo → one tree in the sidebar (master = tree node, wt-workspaces = its leaves). Not parent/child — herdr has no workspace hierarchy; the tree is render-time derivation from `repo_key` + `is_linked_worktree`, and `repo_key` is the ONLY grouping mechanism (operator-verified 2026-09-07).
- **leaf** — a wt-workspace nested under an orchestrator's worktree (planned; not yet implemented). Nested leaves need `--cwd <master-root> --path <orchestrator-wt>/<name>`. UI-wise every wt-workspace of the repo is already a leaf of the repo tree.
- **WorkerHost** — the backend-neutral seam every tool talks to; the seam type is `Transport` in `src/host.ts`. **host** — the configured backend implementation, chosen ONCE in `index.ts` from the config's `"host"` key (default `"herdr"`). **backend** — the `placement.backend` tag persisted in manifest records (`"herdr"` / `"fake"`), alongside the legacy id fields. **placementRef** — the opaque, adapter-defined placement handle (`herdr:pane:<id>` / `fake:<n>`): only the owning adapter decodes it; no raw backend id crosses the seam. Behavioral truth lives in the `src/host.ts` and `src/herdr/host.ts` module contracts.

## Authority model

- Session cwd outside `~/.herdr/worktrees/` → **root orchestrator**: may place/teardown wt-workspaces.
- Session cwd inside a wt-workspace → **sub-orchestrator**: worktree placement/teardown rejected (transport guards); tabs only.
- Guard lives in the herdr adapter `src/herdr/host.ts` (`capabilities()`, `isSubOrchestratorCwd()`, `placeInner()`, `teardownInner()`).

## Command & check discipline — mandatory, fail-fast is basic

Every agent in this repo (workers and orchestrators alike) follows these rules. They exist because a check script that can block forever once hung an agent for 35 minutes (2026-09-15).

1. **Fail-fast is a basic property of every test/check.** A check script must never await anything unbounded: every wait has a deadline, and the script carries a top-level watchdog that exits non-zero (e.g. after 20s) no matter what. A hanging check is a bug IN the check — fix the check, never raise the timeout to tolerate it.
2. **Run the suite only through the runner** (`test/run-checks.sh`): it auto-discovers `test/*.ts` and bounds every check with a per-check timeout (`CHECK_TIMEOUT`, default 30s) plus structured FAIL/ENV-FAIL reporting. NEVER invoke a check script directly without an explicit `timeout` wrapper.
3. **Bound every long-running command.** Test runs, builds, installs — anything that can exceed a few seconds — go through an explicit `timeout <s> <command>`.
4. **When a command hangs, kill the child, not the session.** The hung process is killed; the agent continues from the tool failure and fixes the cause (usually a missing deadline in the check or the code under test).

## Round discipline — merge opens the field trial, never the next round

1. A round ends in three stages, in order: worker report verified against the brief → merge → **field trial** by the operator against an explicit acceptance list (the behaviors the round promised, exercised in the real environment — browser, live sessions, ports — not in the check suite).
2. The next round on the same surface starts only after the field trial passes, or its findings become that round's brief. A passing check suite is the start of acceptance, not its end.
3. Field findings accumulate and batch into rounds; each round's brief may cover several findings at once.
4. Priorities live outside the repo — GitHub issues on `origin`, grouped under the fleet-dashboard milestone. Re-deriving priorities per session from the freshest complaint is the failure mode this section exists to prevent.
5. **Acceptance list is a PR artifact.** The PR itself carries the explicit acceptance list — the behaviors it promises, each exercisable in the real environment. The operator's field trial executes the list; deriving it at trial time is a PR defect the reviewer must catch (Law 11).
6. **Binding-rule conflicts stop for the operator.** When two binding rules cannot both be satisfied (for example: the incident pin and the regression scenario do not fit the fail-fast bounds of one commit), stop and ask the operator via the mailbox. Never satisfy one binding rule by silently violating another.

## Trunk, releases, and QA gates

- **Trunk discipline.** `main` is always releasable. Work happens in
  `feature/<topic>` / `fix/<topic>` branches, lands via squash-merge PRs. No
  direct commits to `main`. The canonical green/red verdict of `main` is
  produced only by the merge gate's serialized run (Law 11) — agent-local
  runs are advisory.
- **Release authority is human.** The operator is the sole release authority:
  the tag and GitHub Release are created only after the operator has
  personally tested the release candidate. Agents may prepare everything up to
  the merge-ready PR, and must stop there.
- **QA gates — three blocking layers** (scenarios live as check files in
  `test/`; the files, not this list, are the scenario truth):
  - **Smoke** — 4 scenarios: typecheck, static pins, seam contract, report
    contract. Budget: under 1 minute. Runs pre-commit (git hook; setup step:
    `git config core.hooksPath hooks/`, verified in CI) and as stage one of
    every PR pipeline.
  - **Critical path** — 10 scenarios over the fake backend: the full
    delegation cycle, release-on-started handoff, watcher wake, mailbox round
    trip, retire, and the refusal paths (budget, invalid report, double
    mount, shared-placement guard) plus output capping. Budget: under 10
    minutes. Runs on every PR push in CI.
  - **Regression** — 6 scenarios: the named regression set, herdr adapter
    conformance and process lifecycle against the scripted herdr stub, rpc
    transport framing, check-suite typecheck, release-gate rehearsal. Budget:
    under 20 minutes. Runs at the merge gate and on demand.
  All three layers block. There is no scheduled nightly layer; real-
  environment verification is the operator's field trial. Watcher long-run
  token cost and Windows-specific path behavior are intentionally not
  verified by any automated or manual gate — accepted loss.
- **Metrics are watched, not blocking.** Reviewed at the pre-release audit:
  p95 wall-clock per layer against its budget; environment-fail rate per 100
  check executions (target below 1; a sustained rate above 5 triggers a fix
  round); self-skip rate per layer (same shape — target below 1, sustained
  above 5 triggers a fix round).
- **Retirement.** At the pre-release audit, a pin or scenario whose subject
  bug class has had zero relevant hits for two consecutive releases may be
  retired with operator sign-off, recorded in CHANGELOG. Gates may shrink,
  not only grow.
- **Dogfooding.** This repository builds the tool that builds this
  repository: all multi-agent work runs through pi-delegate itself (briefs in
  the exchange tree, strict JSON reports, budget caps, evidence in every
  finding). Release-checklist item: every major release includes at least
  one task that was implemented by a fleet of its own workers.
- **Audit cadence.** Before every minor release, re-run the four-way audit
  (pi compliance, architecture, reliability, release ops) on the release
  branch. Findings are triaged into the roadmap; none are carried silently.
- **Documentation is part of the definition of done.** README, CHANGELOG, and
  law-consistent ZSDoc claims are contracts (Law 2). A behavior change that makes a doc
  claim false is an incomplete change.

## Frozen surface — never rename

True INSIDE the herdr adapter (`src/herdr/host.ts`); the seam above it is backend-neutral. `herdr worktree <verb>` CLI strings · herdr JSON fields (`workspace.worktree.*`, `is_linked_worktree`) · `not_linked_worktree` token · manifest `kind: "worktree"` value · journal events (`delegate-fleet`, `spawn`/`collect`) · `/delegate-*` command names · tool names/params. Binding home of this list: ARCHITECTURE.md section 3 — this section is a restatement for agents working from AGENTS.md alone; ARCHITECTURE.md outranks on any divergence.

The word "worktree" appears in several syntactic positions (placement kind value, physical dir, herdr CLI verb, herdr JSON fields) — one concept, four vantage points, each unambiguous by position (census 2026-09-07: zero genuine overloads). Keep the word; disambiguate with the terms above when writing prose.
