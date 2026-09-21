# ARCHITECTURE — the pi-delegate constitution

> Binding layer for every agent — human or machine — that touches this
> repository. Behavioral truth lives in the code's own contracts (ZSDoc at
> the point of use); operational truth lives in `AGENTS.md`; history lives in
> git commits and `CHANGELOG.md`. This document carries only current rules
> and current plans. Where this document and `AGENTS.md` conflict, this
> document outranks.

## 0. Direction — what this codebase is for

pi-delegate is a delegation orchestrator extension for the pi coding harness:
one orchestrating session spawns, observes, and collects fleets of worker
coding agents through a single `delegate` tool, a file mailbox, and a
background watcher. Its user is a single operator working on one machine,
possibly with several agent sessions in parallel; the operator's time — not
agent capacity — is the resource every rule here must economize.

Good looks like: the delegation cycle (spawn → settle → report → collect →
mailbox → teardown) stays deterministic and machine-verifiable; every gate
stays green and honest (no pressure skips, no tolerated flakes); the frozen
surface (section 3) never moves; the internal layout stays free to reshape so
the codebase remains changeable rather than petrifying around its past
incidents; and a new backend adapter is an addition, never an excision.

The laws below are fences derived from real incidents; the threat catalog
(section 2) is the direction mechanism that turns new incidents into tests;
the frozen surface is the list of names that may never move. When two rules
cannot both be satisfied, stop and ask the operator — never satisfy one rule
by silently violating another.

## 1. The laws

### Law 1 — The platform is the API. Import, never reimplement.

pi is not a passive host; it is a library with exports. Before writing any
helper, grep pi's exported surface. Concretely binding:

- Directory constants: `getAgentDir()` and `CONFIG_DIR_NAME` from
  `@earendil-works/pi-coding-agent` — never join `os.homedir()` with literal
  `.pi`/`agent` segments (they break `PI_CODING_AGENT_DIR` and rebranded
  distributions).
- Tool parameter enums: `StringEnum` from `@earendil-works/pi-ai` — never
  `Type.Union` of string literals (breaks Google models).
- Output truncation: `truncateHead`/`truncateTail` and the
  `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES` constants — every tool return path
  that can carry worker-written content must be bounded; the LLM must be told
  when and where content was cut.
- File conventions: `parseFrontmatter`, `withFileMutationQueue` (already in
  use — keep it that way), `pi.exec` where its semantics suffice.
- The known, documented exception: the herdr adapter's raw subprocess runner
  (it needs SIGTERM→SIGKILL escalation with stdio destruction that `pi.exec`
  does not provide). The exception is documented in the adapter header, which
  is exactly where future re-litigation should find it.
- Exchange-layer path assembly routes through the single portable builder
  (`src/expaths.ts`, `node:path`, Windows + POSIX); raw separator-shaped
  construction (template-literal `/` joins, separator-shaped `split`/`endsWith`)
  is statically pinned away.

**Enforcement:** `test/static-check.ts` grows banned-pattern pins (hardcoded
`.pi/agent` joins, `Type.Union([...Type.Literal])` on tool parameters, missing
truncation imports on the tool modules). A violation fails CI, not a review.

### Law 2 — Contracts must be true.

`MODULE_CONTRACT` / `FUNCTION_CONTRACT` blocks are how the next agent reads
this codebase without archaeology. A contract that describes a world that no
longer exists is worse than no contract.

Rules: any commit that changes behavior updates the affected contract in the
same commit. Reviewers verify at least one contract per PR against the code.
Where a deviation from a documented invariant is intentional (e.g. the one
I/O site in `host.ts`), the contract says so explicitly at the point of
deviation.

### Law 3 — Session lifetime owns everything mounted in it.

Everything a `session_start` handler mounts — the watcher, timers, file
handles — is owned by a **per-session context object**
created in that handler and torn down in the paired `session_shutdown` of the
same session. Module-global registries are deprecated as a mechanism: one
session's shutdown must never dispose another session's watcher, and a double
module load must never run two watchers with independent dedup.

Rules: mounts return handles; handles are stored on the session context;
teardown of a session touches only its own handles. A second mount for the
same session file refuses rather than silently replaces. Every
double-delivery class gets a regression check that simulates it.

### Law 4 — The seam stays deep and backend-blind.

The `Transport` interface (canonical term: WorkerHost) is the only place a
backend is visible. Rules:

- `placementRef` is the only required handle; herdr-shaped legacy fields
  (`workspaceId`, `paneId`) are optional compatibility, never requirements a
  second backend (tmux is the planned one) must fake.
- Adapters know nothing about the exchange layer: no adapter writes or reads
  manifests (the in-memory fake's manifest-mirroring branch must die before
  it is ever bound for real).
- One mutating operation per backend invocation, serialized inside the
  adapter.
- All backend failure shapes are translated to the E_* taxonomy at the seam;
  no herdr verb, field, or CLI string leaks above `src/herdr/host.ts`.

**Definition of done (checkable):** the layering pins stay green with a new
adapter added — only the composition root's binding line in `index.ts`
changes; the new adapter imports nothing above the seam, writes no manifests,
and translates every failure to the E_* taxonomy. The pins, not a hypothesis
about competence, are the test.

### Law 5 — Modules are responsibilities, not parking lots.

A `src/` file above **400 lines** (exact count, computed by
`test/static-check.ts`) must carry a row in the decomposition ledger — a
typed table in `test/static-check.ts` itself (the Law 6 allowlist pattern:
file, owner, target release, plan) — never in a prose document, where a
ledger rots. The check computes the over-threshold list itself and fails CI
when the ledger does not match it exactly in either direction: a file
without a plan row is a violation, and a ledger row whose file has shrunk
below the threshold is retired by the same audit that retires stale pins.

SECTION banners inside a file are extraction seams designed to be executed,
not admired. A ledger row's plan describes the intended split; the split
itself is a round like any other. At release time, every plan whose target
release has arrived is either executed or re-justified to the operator — a
plan is an obligation with a date, not a parking permit.

The user-visible surface never moves through a split: see the frozen surface
(section 3) — tool names, parameter shapes, `/delegate-*` command names,
manifest `kind` values, journal event names stay byte-identical.

### Law 6 — Layering is enforced by machine, not by prose.

Every dependency rule this document states must have a pin in
`test/static-check.ts` (or an equivalent automated check), because prose
rules rot. Current pins: only `index.ts` imports a backend adapter; the
observe→fleet one-way edge (`T1.8` — no `src/` module imports `observe.ts`
except `compose.ts`; the spawn→observe edge stays dead — config lives in
`watch-config.ts`); exchange-layer paths only through `expaths.ts` (`T1.9`);
the exchange-layer leaves (`expaths.ts`, `host.ts`) stay leaves; the
one-parser law.

A new cross-module edge requires either a new pin or an entry in the check's
enumerated allowed-edges list (edge plus a one-line reason comment) in
`test/static-check.ts`. A prose waiver in a module header satisfies nothing —
this law's first sentence is its own enforcement.

### Law 7 — On-disk formats are versioned contracts.

Every durable file this extension writes — manifest, mailbox question/answer
envelopes, release markers, watcher satellites, the delivered-facts store — is
a protocol with a version. The delivered-facts store is the standard pattern:
an explicit `schemaVersion` the reader checks; absent means version 1; a wrong
version yields an empty-but-valid result, never a misparse. Format schemas
live in code next to their readers; prose may explain, but never carries the
only copy.

### Law 8 — Errors are structured; deviations from pi conventions are documented.

- Every refusal carries its E_* code and a recovery hint the orchestrator can
  act on. No raw `throw new Error` crosses the tool boundary (the single
  parity-wrapper exception in the herdr CLI runner is documented at the site).
- The deliberate deviation from pi's throw-to-signal-error convention
  (structured results instead of throws, because detach/timeouts are
  control flow, not failures) is stated in README, including which
  code classes are control flow and which are genuine failures.
- Anything that can wake or notify a session defaults to fail-closed
  (ownership gates); anything marked advisory (watcher, fleet UI, archive)
  must be structurally incapable of failing a spawn or collect.

### Law 9 — One artifact, one source of truth.

The delegate skill exists in exactly one place. One spelling per fact: the
80% budget threshold is one constant, not three. One implementation per
shared mechanism: worker-row assembly, the audit-log sink, the tolerant
filesystem probes, the error-text helpers. When two copies are discovered,
deletion is the fix; "keep both in sync by hand" is not a state, it is a bug.

### Law 10 — Every fixed bug buys a regression check.

A fix without a check is a rumor. The deterministic runner
(`test/run-checks.sh`: per-file timeout, at most one environment-flake retry,
explicit ENV-FAIL verdict) is the only test gate; CI and the release workflow
must invoke exactly it, not a re-implemented loop. Bugs found by audit get
their checks in the same wave as the fix. Tests stay single-purpose,
mkdtemp-isolated, machine-independent, and self-skipping only with a printed
reason.

A new field incident first adds a row to the threat catalog (section 2),
then the test, then the fix — in that order; otherwise the check suite grows
as a dump without a threat model. A check that self-skips under budget
pressure (its subject fits its layer but not the layer's time budget) is a
bug in the check, not a pass. At the pre-release audit, a pin or scenario
whose subject bug class has had zero relevant hits for two consecutive
releases may be retired with operator sign-off, recorded in CHANGELOG — the
gates may shrink, not only grow.

### Law 11 — Behavior-bearing PRs are reviewed by an independent agent; main's verdict has one canonical producer.

- Every PR whose diff touches code paths receives a review from a fresh
  worker agent (new session, no shared context with the author): the
  code-review skill along both axes (standards, spec), at least one module
  contract spot-checked against the code, verification that the PR carries a
  non-empty acceptance list and the artifacts Law 5 and Law 10 demand. The
  reviewer files `report-<reviewer-name>.json` per the exchange report
  schema. A green verdict is a merge precondition. The PR author cannot
  dismiss a verdict; the operator may merge against a red verdict, recording
  the reason in the PR. PRs whose diff touches only non-code paths (docs,
  CHANGELOG, version sync, golden-fixture regeneration) skip the reviewer;
  the exemption is verified mechanically by path filter.
- Only the operator merges to `main`. The canonical green/red verdict of
  `main` is produced only by the merge gate's serialized run of
  `test/run-checks.sh` plus typecheck (exit code 0 = green). Agent-local runs
  are advisory and never produce or contradict the canonical verdict — the
  runner's documented environment flake reproduces under concurrent agent
  load, so a verdict born under load is not a verdict.
- While `main` is red, merges freeze until green. The author of the change
  that turned main red owns the fix; ownerless reds (environment drift,
  dependency changes) are owned by the operator.

## 2. Threat catalog (mailbox/watcher surface)

The single catalog of bug classes that the regression checks in
`test/*-check.ts` are written against. Binding rule: **a new field incident
first adds a row here, then the test, then the fix** — otherwise the check
suite grows as a dump without a threat model.

Statuses:

- **covered** — the threat is encoded by a named test;
- **partial** — coverage exists at one level, but a known scenario lacks a test;
- **uncovered** — the threat is known, no test exists (honest skeleton; coverage is never invented).

| Threat | Test encoding the threat | Status |
|---|---|---|
| Concurrent fan-out: two place() calls into one task directory (lost manifest update) | `test/manifest-store-check.ts` (M2.1/M2.3 — concurrent appends, all in place); dedup by name+placementRef — `test/host-fake-check.ts` (A12), `test/host-parity-check.ts` | covered at the storage and dedup level; e2e of two parallel `delegate` calls — uncovered |
| herdr hangs on a mutating operation (serialization queue) | `test/transport-guards.ts` (TG.3 — queue deadline, TG.4 — queue proceeds after deadline, TG.5 — serialization; TG.1–TG.2 — listStatuses dedup) | covered |
| Partial teardown: pane dead, worktree alive | no named test | uncovered |
| Corrupt manifest mid-update / competing writers | `test/manifest-store-check.ts` (concurrent update() folds, M2.x) | covered |
| Many sessions with watchers at once / foreign wakes (wake from someone else's fleet) | `test/watcher-check.ts` (W14.x — a foreign owner silences events of every kind; W16.15 — a worker session does not mount a watcher), `test/ownership-check.ts` | covered; since 1.17.0 (watcher stage A) legacy manifests without owner fields fail closed by default — wake only to a proven owner; emergency rollback is the explicit config `watch.legacyFailOpen: true` (unsafe on multi-session; every skipped delivery's reason is written to the audit file) |
| Report rewritten after wake-up delivery (regression `notifiedReportMtime`, found by audit; live incident 1.14.2 — duplicate wakes from a re-read report across a session restart) | `test/watcher-check.ts` (W8.5 — a rewritten report with a fresh mtime re-arms the event; W16.16b–e — fingerprint dedup survives a missed observation, the same mtime is never delivered twice) | covered |
| Answer file without a subsequent report ("letter consumed" semantics) | `test/retire-check.ts` (R2.9 — an answer NEWER than the report → not consumed → not retirable; R2.9b — an answer OLDER than the report → consumed) | covered |
| Settle races: settled versus report write; the grace re-check loop | `test/grace-loop-check.ts` (G1–G5 — sequence table on virtual clocks: report after N re-checks, question/report priority, abort), `test/release-on-started-check.ts` (early release versus the full gate) | covered |
| Duplicate import binding (two `homedir` imports from different modules) | bun's transpiler forgives the duplicate, pi's extension loader (jiti) does not: the extension fails to load with a green check suite | **uncovered** (incident 2026-09-11, fix/exchange-homedir-duplicate; candidate: a load check of index.ts through the real loader) |
| No run provenance: unknown which extension version executed a run and what the code was before/after — incident investigation becomes archaeology | `test/passport-check.ts` (P1–P5: snapshot clean/dirty/not-a-repo/absent, line cap, delta with ??-untracked, manifest roundtrip, version sync with package.json) | covered |

## 3. The frozen surface (never rename)

herdr CLI verb strings · herdr JSON field names (`workspace.worktree.*`,
`is_linked_worktree`) · the `not_linked_worktree` token · manifest
`kind: "worktree"` value · journal event names (`delegate-fleet`,
`spawn`/`collect`) · `/delegate-*` command names · tool names and parameter
shapes · the E_* code names. Extension happens by addition; correction happens
by deprecation with `prepareArguments`-style compatibility, never by silent
reshape.
