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
background watcher. Authority stays with a single operator working on one
machine, possibly with several agent sessions in parallel; multi-host
operation is out of scope, and only that operator releases or merges. "Single
operator" is a statement about authority, not about audience: the fleet's
lifecycle and its current state are durable, machine-readable products with
consumers beyond the operator's own screen (§0.1). The operator's time — not
agent capacity — is the resource every rule here must economize.

Good looks like: the delegation cycle (spawn → settle → report → collect →
mailbox → teardown) stays deterministic and machine-verifiable; every gate
stays green and honest (no pressure skips, no tolerated flakes); the frozen
surface (section 3) never moves; the internal layout stays free to reshape so
the codebase remains changeable rather than petrifying around its past
incidents; a new backend adapter is an addition, never an excision; and the
fleet's history and current state are auditable and observable through one
durable read path (§0.1, Law 13).

The laws below are fences derived from real incidents; the threat catalog
(section 2) is the direction mechanism that turns new incidents into tests;
the frozen surface is the list of names that may never move. When two rules
cannot both be satisfied, stop and ask the operator — never satisfy one rule
by silently violating another.

### 0.1 The swarm-core directions (binding)

Three directions carry the force of the laws in section 1 for the
`swarm-core-v1` horizon; Law 13 is their enforceable home.

1. **Durable audit of the fleet lifecycle.** Every fleet lifecycle
   transition — spawn, progress, question, answer, report, collect, retire,
   teardown — appends to a durable, versioned, append-only event journal that
   is the system of record for fleet history. A lifecycle fact that exists
   only as an ad-hoc file scan is not audited. The host session journal
   events (`delegate-fleet`, `spawn`/`collect` — frozen names, section 3) are
   the seed of this journal, never a parallel copy of it (Law 9).
2. **A machine-readable swarm read-model is a first-class product surface.**
   The read-model is the single projection of current fleet state over the
   durable stores (manifest, event journal) plus live transport status. Its
   serialized JSON output is a versioned contract (Law 7) pinned by a golden
   test (Law 10); it grows by addition, never by silent reshape.
3. **Observation UIs are clients of the read-model, not of ad-hoc file
   scans.** Every observation surface — the ambient fleet widget, the
   `delegate_status` tool, `/delegate-teardown`, and any future dashboard —
   consumes the read-model and must not read manifests, watcher satellites,
   progress files, or raw transport statuses to derive fleet state. This is a
   read-path rule, not a presentation rule: a surface may render however it
   likes, but it derives fleet state in exactly one place.

Explicitly out of scope for this horizon: the web UI itself. The milestone
delivers the journal, the read-model and its read API; it builds no browser
client. Multi-host federation stays out of scope, and mailbox traffic is not a
read-model edge.

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

Everything a `session_start` handler mounts — the watcher, the ambient fleet
widget (the live indicator of running workers, read through the swarm
read-model — Law 13), timers, file handles — is
owned by a **per-session context object**
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

Law 13's observation boundary is the same mechanism: an observation module
that imports `manifest-store.ts` or `watch-store.ts`, reads a progress file,
or calls `transport.listStatuses()` to derive fleet state is a new
cross-module read edge and fails CI once the read-model read API lands. That
pin is owed by the `swarm-core-v1` read-model issue and is added in the same
commit that exposes the API; until then the rule is a planned direction
(§0.1), not a live pin, and no new observation module may introduce a direct
durable read.

### Law 7 — On-disk formats are versioned contracts.

Every durable file this extension writes — manifest, mailbox question/answer
envelopes, release markers, watcher satellites, the watcher's per-audience
cursor file (`cursor-<key>.json`), the fleet event journal, and the swarm
read-model snapshot (Law 13) — is a protocol
with a version. The watcher cursor is the standard pattern:
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
  must be structurally incapable of failing a spawn or collect. A product
  surface (the event journal, the swarm read-model — Law 13) is advisory in
  exactly this sense: its *output contract* is binding and tested, but the
  pipeline never depends on it, so a journal, read-model, or client failure
  cannot fail a spawn or collect.

### Law 9 — One artifact, one source of truth.

The delegate skill exists in exactly one place. One spelling per fact: the
80% budget threshold is one constant, not three. One implementation per
shared mechanism: worker-row assembly, the audit-log sink, the tolerant
filesystem probes, the error-text helpers. When two copies are discovered,
deletion is the fix; "keep both in sync by hand" is not a state, it is a bug.
Fleet state has one read path: the read-model (Law 13). Two observation
modules deriving fleet state from different stores, or one module re-scanning
a store the read-model already projects, is that same bug.

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

### Law 11 — No secrets in the repository.

No credentials — provider API keys, tokens, `auth.json` contents, private
keys — may exist in tracked files or in git history. The operator's keys live
ONLY in the environment and in the agent dir outside the repository
(`~/.pi/agent/`); the repository reads credentials from the environment at
runtime and never stores them. Real-environment (opt-in) checks take
credentials from the environment of the machine they run on, never from the
repository. Enforcement: a static pin scans all tracked files for
secret-shaped literals (JWT-like `eyJ…`, `sk-…` provider keys,
`*_API_KEY`/`*_SECRET`/`*_TOKEN` assignments with literal values) and fails
CI on a hit; `.gitignore` excludes `.env*` and key files so they cannot be
committed by accident. A key that reaches history is treated as compromised:
rotate it immediately, then purge the history.

### Law 12 — Behavior-bearing PRs are reviewed by an independent agent; main's verdict has one canonical producer.

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
- Only the operator merges to `main` — via the release PR (`develop` →
  `main`) or a hotfix PR; work lands in `develop` first (simplified git
  flow, AGENTS.md). The canonical green/red verdict of
  `main` is produced only by the merge gate's serialized run of
  `test/run-checks.sh` plus typecheck (exit code 0 = green). Agent-local runs
  are advisory and never produce or contradict the canonical verdict — the
  runner's documented environment flake reproduces under concurrent agent
  load, so a verdict born under load is not a verdict.
- While `main` is red, merges into `main` freeze until green. The author of
  the change that turned main red owns the fix; ownerless reds (environment drift,
  dependency changes) are owned by the operator.

### Law 13 — Fleet state has one durable read path: journal → read-model → clients.

Binding for the `swarm-core-v1` horizon; definitions in §0.1.

- **Durable audit.** Every fleet lifecycle transition (spawn, progress,
  question, answer, report, collect, retire, teardown) appends to the durable,
  append-only event journal. The journal is the system of record for fleet
  history and is versioned under Law 7. Fleet history is never reconstructed
  by scanning the exchange directory.
- **Read-model.** The swarm read-model is the single projection of current
  fleet state over the durable stores plus live transport status. Its
  serialized JSON is a versioned contract (Law 7) pinned by a golden test
  (Law 10); it grows by addition, never by silent reshape. The read API is a
  first-class product surface.
- **Clients.** Every observation surface (ambient fleet widget,
  `delegate_status`, `/delegate-teardown`, future dashboards) reads fleet
  state only through the read-model. An observation module importing
  `manifest-store.ts` or `watch-store.ts`, reading a progress file, or calling
  `transport.listStatuses()` to derive fleet state is a violation.
- **Advisory to the pipeline (Law 8).** "First-class product surface" makes
  the read-model's *output contract* binding and tested; it never makes the
  pipeline depend on it. A journal, read-model, or client failure is
  structurally incapable of failing a spawn or collect.

**Enforcement (Law 6).** The client boundary is a dependency rule and gets a
static pin: an observation module that imports a durable store or reads a
progress file fails CI. The pin lands in the same commit as the read-model
read API. Until then the read-model is `worker-view.ts`; the observation
modules that predate the API (`status-tool.ts`, `fleet-widget.ts`) are the
named migration debt of `swarm-core-v1`, and no new observation module may
introduce a direct durable read. This clause states its enforcement date
rather than claiming a live pin — it is a planned rule under §0.1 until that
commit lands.

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
| Zero-output provider settle: the provider returns only empty/whitespace assistant turns, the worker settles idle with no report, and the failure is misclassified as a generic failed spawn (issue #74, 2026-09-25) | `test/provider-empty-check.ts` (P1–P9: the rpc ANY-output latch, the watcher's distinct `provider-empty` event, the synchronous `E_PROVIDER_EMPTY` code, and the non-empty / never-started / unobservable negatives) | covered |
| Duplicate import binding (two `homedir` imports from different modules) | bun's transpiler forgives the duplicate, pi's extension loader (jiti) does not: the extension fails to load with a green check suite | **uncovered** (incident 2026-09-11, fix/exchange-homedir-duplicate; candidate: a load check of index.ts through the real loader) |
| No run provenance: unknown which extension version executed a run and what the code was before/after — incident investigation becomes archaeology | `test/passport-check.ts` (P1–P5: snapshot clean/dirty/not-a-repo/absent, line cap, delta with ??-untracked, manifest roundtrip, version sync with package.json) | covered |

## 3. The frozen surface (never rename)

herdr CLI verb strings · herdr JSON field names (`workspace.worktree.*`,
`is_linked_worktree`) · the `not_linked_worktree` token · manifest
`kind: "worktree"` value · journal event names (`delegate-fleet`,
`spawn`/`collect`) · `/delegate-*` command names · tool names and parameter
shapes · the E_* code names · the swarm-http route paths (`/api/version`,
`/api/swarm/snapshot`, `/api/swarm/events`, `/api/swarm/stream`,
`/api/swarm/fleets`, `/fleets/<sessionId>/`,
`/fleets/<sessionId>/api/swarm/events`,
`/fleets/<sessionId>/api/swarm/stream`, `/api/workers/:id/console`,
`/api/workers/:id/steer`, `/api/asks/:id/answer`). Extension happens by
addition; correction happens
by deprecation with `prepareArguments`-style compatibility, never by silent
reshape. The Law 13 lifecycle event names are additions to this list, never
renames of the entries already here.

## 4. Design records

A design record is the binding design text behind a milestone: it resolves
its issue's numbered requirements in measurable wording, states every
decision falsifiably or marks it `[operator-decision-pending]`, and carries
the force of section 1 once the operator approves it (the milestone's
acceptance gate). A record plugs into the laws; it never restates them.
Rejected alternatives appear only as the one-paragraph binding rejections
the originating issue demands — never as decision archaeology.

### 4.1 swarm-core exchange: verb interface, journal, resume reconciliation (issue #21)

Status: DRAFT — gate: operator approval (the issue's acceptance gate). On
approval this record binds the swarm-core-v1 implementation issues (#18,
#22, #23, #25, #26, #27, #28, #29, #30, #31); on rejection it is rewritten,
never patched piecemeal. This record is the design home Law 13 points at:
it specifies the journal (§4.1.2), the two-phase storage cutover (§4.1.3),
the watcher cursor (§4.1.2) and resume reconciliation (§4.1.4); the
read-model projection (#29) and its read API (#30) are specified by their
own issues under this record's constraints.

#### 4.1.1 Verb interface — the `swarm` CLI

Worker-side verbs — the ONLY worker contract: `read-brief`, `write-report`,
`ask`, `poll-answer`, `write-progress`. (Operator decision DV1: the progress
verb is `write-`, not `report-` — "report" is the strict terminal-artifact
noun of `write-report`; one word, one concept; the name also aligns the verb
with its journal kind `progress`.) Orchestrator-side verbs — `spawn`,
`collect`, `status`, `answer`, `steer`, `release`, `teardown` — are
specified symmetrically but stay wrapped by the pi tools in this milestone
(the frozen surface does not move: tool names and parameter shapes are
byte-identical). `collect` is in the set (operator decision DV2): it is the
frozen journal event and the settle→collect act — strict report validation,
archive, the `collectedAt` stamp — which the read-only `status` cannot
cover. The mailbox inbox scan (`delegate_mailbox` action `read`) gets NO
verb in v1 (operator decision DV3): watcher-wake is the discovery path; the
tool action-set symmetry is intentionally not projected onto the verb set.
Verb→journal-kind mapping is name-identical (`write-progress` → kind
`progress`, and so on) with one indirection: `release` (the verb — the §23
retire ACK posted by the orchestrator) drives the watcher retire engine,
which appends journal kind `retire`; no verb named `retire` exists.

Rules:

- A worker interacts through verbs, never raw paths. After the `briefPrompt`
  switch (#25) the worker prompt names only verb invocations; the raw-file
  phrasing survives one release behind the config flag `swarm.verbsFallback`
  (default on in #25's release, removed after).
- Identity travels with the invocation by ONE canonical mechanism: the spawn
  flow exports `SWARM_TASK` and `SWARM_WORKER` into the worker's
  environment; the `--task` / `--worker` flags exist as explicit override
  only (never the primary path). The CLI builds every path through
  `src/expaths.ts` exclusively (static pin per #18's acceptance, Law 6).
- Result contract (Law 8): success = exit 0 plus a JSON result on stdout;
  failure = non-zero exit plus a structured stdout error carrying an E_* code
  and a recovery hint. New codes join the E_* taxonomy by addition, never by
  redefinition.
- `write-report` validates the report against the resolved schema (the v1
  base plus the brief-declared fragment, via `src/report-schema.ts`) BEFORE
  writing and exits with the structured error on failure — the worker learns
  immediately instead of through a watcher wake-up one tick later. Validation
  moves from collect time to write time; collect keeps its own validation
  (fail-closed), and a verb-written report failing collect-time validation is
  a bug class with a regression check (Law 10).
- Phase A output is byte-identical to the current file writers (golden test,
  #18) — Law 7 wire formats frozen.
- The five worker verb names and seven orchestrator verb names join the
  frozen surface (section 3) in the commit that ships them; extension by
  addition only.

#### 4.1.2 The journal — append-only, single-writer, durable

Location: ONE SQLite database at `join(getAgentDir(), "delegate-journal",
"events.db")` (Law 1 — resolved through pi's `getAgentDir()`, never the
exchange root, which dies on reboot; never the repository). Schema DDL
(version 1, `PRAGMA user_version = 1` — the Law 7 version gate for the
database itself):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;  -- cross-process write rule, see below
PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,   -- ISO-8601 UTC, injected clock (ClockPort)
  kind       TEXT NOT NULL,   -- one of the closed kind set below
  session_id TEXT NOT NULL,   -- owning orchestrator session (the SwarmGraph SessionId: stable hash of the session file path)
  task       TEXT NOT NULL,   -- exchange task name
  worker     TEXT,            -- canonical worker name; NULL on fleet-scoped events
  payload    TEXT NOT NULL    -- kind-shaped JSON (contract below)
);
CREATE INDEX IF NOT EXISTS events_by_fleet ON events(session_id, task, seq);
```

Kinds — the closed v1 set, fourteen kinds (new kinds only by addition,
never rename): `spawn`, `stamp`, `collect`, `ask`, `answer`, `steer`,
`progress`, `report`, `retire`, `dead-reboot`, `reconcile-summary`,
`compaction-marker`, `termination-notice`, `partial-report`.
`report` is the #23 operator-approved addition: journal-as-truth covers the
terminal artifact itself — the validated report JSON is the payload — and
the watcher's report-readiness wake rides the journal cursor (#26, below),
so the kind opens no watcher surface of its own. The last two
(`termination-notice`, `partial-report`) are forward-compat with #15: they
may exist in the schema before their producers land. `reconcile-summary`
is this record's addition
over the issue's enumeration — it makes "exactly one summary wake per fleet"
(§4.1.4) dedup-able through the journal itself; `compaction-marker` is the
audit-continuity anchor of the operator-invoked compaction path (retention,
below). Each kind name joins
section 3's frozen list in the commit that lands its first producer.

Payload shapes (JSON; the listed fields are the v1 contract, additive-only
after that):

- `spawn` `{backend, placementRef, briefPath, briefText, depth?, entry}` —
  `briefText` is the full brief inline: the journal is where briefs survive
  a reboot (§4.1.4 step 5). `depth` rides along (additive, no schema-version
  bump — the passport precedent). `entry` is the full `ManifestWorker`
  (additive): journal replay rebuilds the manifest from it, so reads never
  depend on the projection file.
- `stamp` `{field, value, entryIndex?}` — the mirror of every manifest stamp
  the pipeline writes (`collectedAt`, `sessionPath` once #16 lands, …). On
  worker-scoped rows `entryIndex` names the `workers[]` position the stamp
  mutates, making replay sequence-scoped: a same-name respawn is never
  retro-stamped by an earlier row. Legacy rows without `entryIndex` keep
  the name-match fallback.
- `collect` `{status, reportPath, archivePath}`.
- `ask` / `answer` / `steer` `{text}` — the mailbox envelope fields, verbatim.
- `progress` — the `ProgressEvent` shape (`src/host.ts`), verbatim.
- `report` — the validated report JSON, verbatim; appended by `write-report`
  after the atomic publish, so the journal never announces an unpublished
  report.
- `retire` `{reason}`.
- `dead-reboot` `{detectedAt, lastSeq}` — `lastSeq` is the worker's last
  journal seq before the loss was detected.
- `reconcile-summary` `{lost: string[], collectedBeforeLoss: number,
  skipped?}` — fleet-scoped (worker NULL); the wake text the watcher renders
  from it is the frozen per-fleet summary of §4.1.4 step 4. `skipped`
  (additive) names the fleet's foreign/owner-less workers that a
  mixed-ownership reconciliation left untouched — auditable in the journal,
  never counted as `lost`.
- `termination-notice` `{graceMs}` — producer: #15.
- `partial-report` `{captured: boolean, text?}` — producer: #15.
- `compaction-marker` `{exportedTo, deletedCount, lastDeletedSeq}` —
  fleet-scoped; appended by the compaction path AFTER the deletion it
  records, so audit continuity survives it (retention rule, below).

Single-writer code, multi-process database: the journal module family
(`src/swarm/journal*.ts` — writer and reader sides) is the ONLY writer CODE;
"single-writer" never means one process. `events.db` is ONE database written
by every concurrent pi session process, so cross-process writes are
serialized by SQLite itself: every writer sets `busy_timeout = 5000` ms,
retries `SQLITE_BUSY` with bounded backoff-plus-jitter, and keeps every
append a short single-statement transaction — a torn write leaves the last
record intact or absent, never corrupt (#22's acceptance check). No UPDATE
or DELETE operation exists in the module family — append-only is enforced
by absence, not convention; the ONE exception is the operator-invoked
compaction path (retention, below), guarded by the all-terminal rule.
Static pin (#31, Law 6): no `src/` module outside the journal module family
(`src/swarm/journal*.ts`) imports a sqlite driver.

Advisory by contract (Law 8, Law 13): a journal append failure is recorded
and skipped — structurally incapable of failing a spawn or collect; a
fault-injection check proves it before the Phase B default flip (§4.1.3).

Append sites: the journal rows are written at the lifecycle points that
today emit the host session journal events (`delegate-fleet`,
`spawn`/`collect` — section 3). Those facts are the seed of this journal,
never a parallel copy (§0.1.1, Law 9): one site, one fact, one spelling —
fleet history is never re-derived by scanning the exchange directory.

Cursor: the reader API is `eventsAfter(cursor)` — all rows with
`seq > cursor`, ordered by `seq`. The watcher's durable dedup is the
per-audience cursor file `cursor-<key>.json` (one per audience session per
task dir), fed by `eventsAfter`: it carries the last consumed `seq` — read
each tick, advanced only over rows of this audience's live fleets — plus
the delivery records committed after each successful wake send. The dedup
state is the cursor file, never journal rows (no delivered-event kind
exists); the in-session seen-map stays memory-only. The delivered-facts
store (`delivered-<key>.json`) is retired — nothing writes it again.
First-run migration is conservative re-derivation: an absent cursor is
never seeded (`seq 0`, no records), so the first post-upgrade session sees
one bounded repeat volley (bounded by the ownership gate and the lookback)
— durable and exactly-once from the first commit on (#26). Interim
detection design: detection remains the filesystem snapshot ladder this
release (`src/watch-detect.ts`); the journal is the durable exactly-once
dedup; full journal-driven detection lands with #10–#12 per §4.1.5's
landing-order rule. `swarm events --after <seq>` (#30) exposes this reader
verbatim.

Retention (operator decision DP7): events are never auto-deleted in v1.
Growth is bounded by fleet volume: a typical non-`spawn` event row is about
0.5 KB (ISO timestamp, kind, session/task/worker ids, sub-KB payload);
`spawn` rows carry `briefText` inline and run to a few KB each — a heavy
session of several thousand events stays in low single-digit MB.
Visibility is mandatory, not aspirational: `swarm status` (the read API,
#30) surfaces the journal's row count and database size. Manual compaction
is an operator-invoked maintenance path — export a fleet's events to JSONL,
then delete them — with one binding rule: deletion is allowed ONLY for
fleets whose workers are ALL terminal (`collect` / `retire` /
`dead-reboot`), and every compaction appends a `compaction-marker` event
recording the export target and the deleted range, so audit continuity
survives the deletion. This compaction path is the sole, documented
exception to the module family's no-DELETE rule above.

#### 4.1.3 Two storage phases

Phase A — files are truth (#18): the CLI writes today's files
byte-identically (golden tests; the watcher is untouched; rollback is
trivial — stop shipping the CLI). The journal module (#22) may land in the
same release but receives no production writes in Phase A. Falsifiable
interim state: Law 13's durable-audit clause is interim-UNMET during
Phase A — fleet lifecycle facts exist only as ad-hoc files until the first
Phase B write, and this interim ends exactly when `swarm.storage` can be
set to `"journal"`.

Phase B — journal is truth (#23): every verb write and every tool-side
lifecycle transition appends to the journal transactionally; the exchange
files become a generated projection with the byte format frozen (Law 7);
the swarm CLI verbs are the projection's only writers (#31 pin). The
manifest gains a third `ManifestStore` port implementation backed by the
journal, parity-pinned against the file-backed implementation (the existing
two-impl parity precedent). Gate: config flag `swarm.storage: "files" |
"journal"`, default `"files"` in #23's release.

A→B cutover criteria (flipping the DEFAULT to `"journal"` — always a
separate operator-approved PR, never bundled with #23):

1. `test/swarm-parity-check.ts` green on main: identical flows over both
   storage modes produce byte-identical projections.
2. The full delegate cycle works on the journal alone (projection disabled
   by flag; rpc backend leg behind `RPC_E2E=1` green).
3. The journal lifecycle-replay check (#22 acceptance 1) green.
4. The advisory fault-injection check green: a failing journal cannot fail
   a spawn or collect.
5. At least one full release shipped with the flag present and parity green.
6. Operator sign-off recorded in the cutover PR.

#### 4.1.4 Resume reconciliation (binds #27)

Trigger: `session_start`, after watcher mount. Advisory by contract: a
reconciliation failure never blocks session start — it is skipped
(silently; the result is the `IDLE` return, no stderr noise).

Procedure:

1. Journal scan: fleets (`session_id`, `task`) owned by this session.
   Ownership uses the canonical `watch-role.ts` verdict — fail-closed;
   foreign fleets are untouched.
2. For every worker with no terminal event (`collect`, `retire`,
   `dead-reboot`), placement liveness is checked through the Transport seam
   ONLY — backend-blind (rpc child alive? herdr pane exists? — the adapter
   answers; the reconciler never branches on a backend).
3. Each dead placement gets a `dead-reboot` event. The event is terminal:
   step 2's terminal-event check sees it, so a worker is never double-marked.
4. Per affected fleet, ONE `reconcile-summary` event; the watcher delivers
   it through its cursor as exactly one per-fleet summary wake: "fleet
   <task>: N workers lost to reboot, briefs preserved, M reports collected
   before loss". Measurable: per reconciliation run, per fleet, at most one
   summary wake; a later reconciliation over the same fleet finds no
   un-terminated workers and wakes nothing.
5. The operator decides: reap via `/delegate-teardown`, or respawn from the
   journal — the `spawn` payload's `briefText` is the preserved brief, so
   respawn needs nothing from the dead exchange root. With #16 landed, the
   respawn additionally re-enters the worker's persisted `sessionPath`
   (§4.1.5).

Phase note: reconciliation exists only once the journal carries production
writes (#23). In Phase A the post-reboot picture stays today's — an
accepted loss, recorded here rather than discovered in the field.

#### 4.1.5 Interaction with #10/#11/#12, #15, #16, #28–#31

- #10/#11/#12 (scheduled wakes): this record fixes the rule, not the landing
  order. When a scheduled-wake stage lands on top of the journal, its
  lifecycle events (scheduled, fired, cancelled, restored) are journal kinds
  from day one — added to the §4.1.2 kind set by addition — and its durable
  store (#12) migrates to journal + cursor per #26's migration rule (the
  first run re-derives the cursor conservatively; a bounded repeat volley is
  documented, as with the stage-B migration precedent). A stage that lands
  before the journal ships with its file store and migrates when #26 lands.
  Each affected PR states the chosen order explicitly (#26's constraint).
- #16 (durable rpc `sessionPath`): #16 makes the WORKER's own session
  resumable; §4.1.4 makes the ORCHESTRATOR's picture honest. Interaction:
  with Phase B the `sessionPath` manifest stamp rides a `stamp` event
  (`field: "sessionPath"`), and §4.1.4 step 5 respawn re-enters the
  persisted session when one exists. Either landing order works: #27-first
  respawns from `briefText` with fresh context; #16-first respawns re-enter
  accumulated context. This record does not resolve #16's design.
- #15 (termination handoff): the `termination-notice` and `partial-report`
  kinds and their payload shapes are reserved in §4.1.2; the handoff
  mechanics themselves stay #15's to design.
- #28 (manifest `depth`): the `spawn` payload carries `depth` — additive,
  no schema-version bump (the passport precedent).
- #29/#30 (SwarmGraph, read API): the read-model is a pure projection over
  this journal plus the manifest store plus optional live transport status;
  `swarm snapshot` and `swarm events --after` are its client surface. Their
  JSON contracts are versioned (Law 7) and golden-tested (Law 10).
- #31 (static pins): the sqlite-confinement, watcher-no-direct-FS and
  single-projection-writer pins enforce §4.1.2 and §4.1.3 mechanically
  (Law 6).

#### 4.1.6 Rejected alternatives (binding rejections)

1. Write-through registry (files stay truth, the journal mirrors every
   write): rejected — two sources of truth that can drift (Law 9); every
   write path gains a second failure mode; reconciliation would have to
   arbitrate between stores. This record instead has exactly one truth per
   phase, a flag-gated cutover, and a parity check proving equivalence
   during the transition.
2. Raw SQL as the worker contract: rejected — the schema leaks into every
   worker prompt (prompt fragility); append-only cannot be enforced (SQL
   can UPDATE/DELETE); one mis-scoped statement has whole-fleet blast
   radius against the single shared database. Verbs are the worker
   contract; SQL stays below the journal module family
   (`src/swarm/journal*.ts`), confined by the #31 pin.
3. Files-forever (exchange files stay the system of record): rejected — no
   audit queries (history becomes filesystem archaeology); the exchange
   root dies on reboot while pi sessions resume (the manifest-loss incident
   class: the orchestrator cannot even state that its fleet died); every
   observation UI would reimplement format knowledge, which Law 13's client
   rule forbids.

### 4.2 swarm-server: the session-hosted read endpoint (issue #50)

Status: this record lands with #50's implementation. It binds the
session-hosted HTTP/WS read endpoint under the swarm-core-v1 constraints
(§4.1, Law 13).

#### 4.2.1 Session-hosted ruling

The read API's first network surface is **session-hosted**: each pi session
that enables it mounts ONE server in its `session_start` and tears it down in
the paired `session_shutdown` (Law 3 — a globalThis mount registry keyed by
session file refuses a second mount for the same session; two parallel
sessions are two independent servers, necessarily on different ports). The
port (`swarm.server.port`, default 7331; `0` = OS-assigned) is a REQUEST, not
a requirement: on `EADDRINUSE` the mount retries once on an OS-assigned port
and logs the substitution. The server is **OFF by default**
(`swarm.server.enabled: false`) and **advisory by contract** (Law 8): every
startup failure — bad port, bound port, failing journal reader — is logged
(one structured JSON stderr line) and never blocks session start, spawn, or
collect; pinned by `test/swarm-server-fault-check.ts`.

The session holds ONE long-lived read-only journal reader
(`src/swarm-server/journal-session.ts` over `src/swarm/journal-read.ts` — the
openReadOnly precedent), never the CLI verbs' per-request temp-copy
workaround (a one-shot-process affordance). A reader opened before the
journal exists reopens exactly once on the absence→presence transition (a
session mounts before the first journal write creates events.db).

#### 4.2.2 Protocol identity with a future daemon

The HTTP surface is the read API's SAME contracts, not a new one
("protocol identity"): `GET /api/swarm/snapshot` and
`GET /api/swarm/events?after=<seq>` return the `swarm snapshot` /
`swarm events` CLI envelopes verbatim (byte-equality pinned against real CLI
runs in `test/swarm-server-endpoints-check.ts`); the server's addition is
LIVE in-process sources the separate-process CLI structurally lacks — the
session's Transport statuses and usage summaries fold into the snapshot, so
`no-live-status` / `usage-unavailable` appear only when genuinely
unavailable. Every error envelope carries top-level `schemaVersion: 1` and so
does every success envelope, EXCEPT the verbatim CLI snapshot envelope, whose
version lives inside its body (`snapshot.schemaVersion`) — protocol identity
wins over the uniform top-level field (Law 7); structured E_* errors (Law 8),
and `E_SWARM_NOT_FOUND` joins the taxonomy by addition. A future standalone
daemon must speak these same
envelopes over the same paths — the identity constraint is what keeps the
session-hosted server and a daemon swappable for clients.

`WS /api/swarm/stream?after=<seq>` pushes: ONE snapshot frame on connect,
then event frames as the journal cursor advances (poll interval default
500 ms), ordering by `seq` preserved; a client reconnects with its last
consumed `seq` (cursor-resume). The HTTP stack is a hand-rolled zero-dep
HTTP/1.1 + RFC 6455 core on `node:net` (`src/swarm-server/http1.ts`,
`ws.ts`): the platform has no server-side WebSocket, and `node:http`'s
upgrade path silently drops writes under bun 1.3.x (the repo's check
runtime) — one spelling that runs identically under node (the extension
runtime) and bun (the check runtime).

#### 4.2.3 Loopback trust model

The server binds `127.0.0.1` ONLY — a constant in code, not an operator
knob (fail-closed: there is no config spelling that widens the bind). The
read API carries NO auth beyond the loopback bind: every process on the
machine can READ it. That is the documented boundary: single-operator
authority (§0) covers the operator's own processes; multi-user hosts and
off-machine access are OUT OF SCOPE for this surface. Non-goals (issue #50):
no multi-session aggregation, no daemon mode, no TLS — each
joins by addition under its own issue. The mutation endpoints and their
operator token joined in §4.2.4 (#51); worker console streaming, once a #50
non-goal, joins by addition in §4.2.5 (#52); the read-only dashboard
frontend joins by addition in §4.2.6 (#53).

#### 4.2.4 Mutation surface + operator token (issue #51)

The server's TWO write routes are operator-only and additive to the read
surface:

- `POST /api/workers/<id>/steer` `{text}` — post a steering envelope to a
  worker this session owns.
- `POST /api/asks/<id>/answer` `{text}` — answer a pending question of an
  owned worker (the pending q-file is archived).

Both require `Authorization: Bearer <operator token>`; GET and the WS stream
stay open. The token is generated fresh per mount (`crypto.randomBytes(32)`)
and surfaced ONLY on the session's stderr as one structured `operator-token`
line — never the journal, a response body or a log file (Law 11). Missing,
malformed and wrong tokens yield the SAME uniform `401 E_SWARM_AUTH` refusal,
compared in constant time.

Ownership is fail-closed (Law 8): the `<id>` resolves through the canonical
`workerAudienceMatch` (src/watch-role.ts) over the read-model's manifest
rows; only a proven `"mine"` verdict mutates. A foreign or unknown id refuses
with the SAME `403 E_SWARM_FORBIDDEN` body — the gate never leaks whether an
id exists in another fleet.

The `<id>` accepts BOTH spellings additively (#70): an id matching the
canonical worker-name grammar (`WORKER_NAME_RE`) resolves NAME-FIRST as a
worker name — even when a session node carries the same string (node ids are
hex and CAN look like names) — and any other id is resolved to a worker name
through the read-model graph (`findWorkerEmbodiment` in ./console.ts, the ONE
shared lookup the console surface also uses); an id matching neither is `400
E_SWARM_USAGE`. Ownership is proven by the mutation core for BOTH spellings,
so a foreign worker's session node id refuses with the same uniform `403
E_SWARM_FORBIDDEN` as its name. No `/by-name/` route is added; the v1 name
routes keep working unchanged (Law 7).

The write itself is NOT reimplemented: `src/swarm/mailbox-verbs.ts` (the
shared orchestrator verb core) calls the SAME `postSteerAndNudge` /
`writeAnswer` / `archiveQuestion` path the `delegate_mailbox` tool uses, so
an HTTP-issued `a-<name>.json` is byte-identical to a tool-issued one. The
additive difference is journaling: a successful mutation appends its
`steer` / `answer` journal row (`{text}` plus the additive `via: "http"`;
no schema-version bump) AFTER the envelope is published — the `report` kind
precedent — through the verb plumbing (`appendSwarmEvent`), under the REAL
`swarm.storage` mode (#69 operator ruling, 2026-09-25T09:40Z). In `journal`
mode the row is durable and the success envelope answers `confirmation:
"confirmed"`; in `files` mode the append is Phase A (§4.1.3) and writes
NO journal row — the envelope answers `confirmation: "unavailable"`, and
the dashboard settles its optimistic marker from that envelope state
(`steer.js`'s honest delivered/unconfirmed view), never a forever-pending
spinner. An advisory append failure degrades to the same `"unavailable"`
(Law 8). The field is additive (Law 7): a pre-fix server without
`confirmation` keeps the old wait-for-journal client behavior. The static
pin `T1.16` proves no `src/swarm-server/**` file makes a direct
mailbox write, so the mutation path cannot bypass the journal once the
journal is the truth store (#51 acceptance 6).

Every mutation envelope — success and error — carries `schemaVersion: 1` and
the structured `E_*` codes (`E_SWARM_AUTH`, `E_SWARM_FORBIDDEN` join by
addition; `E_SWARM_USAGE` on a malformed body/id). The mutation routes are
advisory by contract (Law 8): a failed write or nudge degrades to a
structured error and never destabilizes the session, watcher, or collect.

#### 4.2.5 Worker console surface (issue #52)

Status: this record section lands with #52's implementation. It binds the
console half of the session-hosted read endpoint under §4.2 and the laws.

Two routes, ONE envelope (v1, additive-only, Law 7):

```
GET /api/workers/:id/console?offset=<n>        → one console frame
WS  /api/workers/:id/console/stream?offset=<n> → live-tail console frames
{ok, schemaVersion, worker, nodeId, task?, state, chunk, nextOffset,
 oldestOffset, dropped, error?}
```

**Identity and ownership (fail-closed, Law 8).** `:id` is the SwarmGraph
SESSION node id of a worker session — never a raw path. Resolution walks the
read-model graph (Law 13: fleet state enters only through the read-model),
and the gate is the canonical `src/watch-role.ts` ownership verdict
(`workerAudienceMatch` over the worker's `spawned_by` parent path, with the
task-level fleet owner as the fallback). ONLY the `mine` verdict passes; an
unknown id, a task node id, a foreign owner, a missing owner edge and a
degraded self-id are refused IDENTICALLY with `E_CONSOLE_WORKER_REFUSED`
(404) — no existence oracle, no fail-open edge. A non-integer or negative
`offset` is `E_CONSOLE_USAGE` (400).

**States are transport-derived, never fabricated.** `live` while the
transport still reports the worker alive; on end, the endpoint probes the
backend for retention — `ended-with-retained-backlog` when the backend still
answers a console read, `ended` when it does not. A backend that exposes no
console stream (no `streamConsole` seam method — e.g. the herdr adapter)
answers HTTP 200 with `state: "unavailable"` and an additive
`error: {code: "E_CONSOLE_UNAVAILABLE", …, hint}`: a valid degraded answer,
not an HTTP error, and never a fabricated stream.

**Bounded backlog and offsets.** Each server holds a per-worker transcript
bounded by pi's `DEFAULT_MAX_BYTES` (Law 1 constant), evicted oldest-first by
whole retained event and served by character offset (`src/swarm-server/
console-buffer.ts` owns the cap and the offset model). `oldestOffset` is the
frontier; `dropped` flags a read below it. Feeding `nextOffset` back yields
exactly the later bytes — no duplication, no loss, inside the retained
window. Console text is EPHEMERAL display data: it is never written to the
journal and never enters the swarm snapshot, and the whole surface is
advisory by contract (a capture or frame failure degrades to a structured
frame, structurally incapable of failing spawn/collect).

Checks: `test/swarm-console-rest-check.ts`, `test/swarm-console-ws-check.ts`.
The `T1.15` family pin covers the new modules unchanged (no durable store,
journal writer or backend adapter import).

#### 4.2.6 The fleet dashboard (issue #53)

`GET /` serves a read-only dashboard SPA from `src/swarm-server/public/`
(`./static.ts`): vanilla ES modules + CSS, **no build step** and no
framework/bundler in the runtime path — the assets are the shipped bytes.
It is a pure Law-13 client of the read API: `GET /api/swarm/snapshot` builds
the tree (SessionNode → TaskNode → worker embodiments, parented by the
graph's `spawned_by` edges), `WS /api/swarm/stream?after=<seq>` applies
frames live (snapshot replaces, events advance the cursor; reconnect resumes
from the last consumed `seq`), and `GET /api/swarm/events` feeds the
journal-health footer (`journal.count` / `journal.dbSizeBytes`). The client
issues ZERO mutation requests (GET + WS only) and makes ZERO external network
calls (pinned statically, T1.20–T1.23). Each of the four degradation flags
(`no-session-path`, `no-live-status`, `legacy-orphan`, `usage-unavailable`)
renders a distinct honest visual state with the flag name verbatim; degraded
nodes are shown, never hidden or faked healthy. `sessionStorage` holds ONLY
the reconnect cursor. The dashboard is the first frontend of the milestone;
steering UI (#54) joins by addition.

#### 4.2.7 Dashboard console panel + steering controls (issue #54)

Issue #54 completes the dashboard's browser scope: worker-console streaming
and operator steering, both additive to the read-only SPA.

**Console panel.** Each worker card carries a console panel fed by the #52
console surface: the backlog preload is `GET /api/workers/:id/console?offset=0`
and the live tail is `WS /api/workers/:id/console/stream` (`:id` is the graph
SESSION node id). The panel renders the console envelope's transport-derived
state as a DISTINCT honest banner — `live`, `ended`,
`ended-with-retained-backlog` (the backlog is shown and marked retained), and
`unavailable` (an honest message, never a fake terminal) — plus the
fail-closed refusal (`E_CONSOLE_WORKER_REFUSED`) as the foreign/unowned state.
The tail is a plain monospace text node; ANSI is not interpreted. Console text
remains ephemeral (never journaled, never in the snapshot).

**Steering.** The page POSTs the #51 routes with `Authorization: Bearer
<operator token>`: `POST /api/workers/:id/steer {text}` and
`POST /api/asks/:id/answer {text}` (`:id` is the WORKER NAME the dashboard
sends; the route accepts the worker name OR the graph session node id
additively, name-first, #70). Steering is
OPTIMISTIC-WITH-CONFIRMATION: a successful POST creates a pending marker that
becomes `confirmed` ONLY when the matching journal `steer`/`answer` event
arrives over `WS /api/swarm/stream` (the journal is the truth —
`via:"http"` is shown), and `failed` on a structured error. Pending questions
are folded from `ask` events without a matching `answer`; the answer form
POSTs and clears on the `answer` event. Mutation controls are
DISABLED-WITH-REASON, never hidden: a foreign-fleet (console-refused) or ended
card states why; a merely `unavailable` console keeps steering enabled (the
mutation surface is independent of console capture).

**Token.** The operator token is prompted once, kept in `sessionStorage` ONLY
(key `swarm.dashboard.operatorToken`), sent only in the `Authorization`
header, and never placed in localStorage, a URL or a log; a structured
401/403 clears it and re-prompts. Client modules: `public/console.js`
(console reducer + WS tail) and `public/steer.js` (token + mutation +
confirmation + pending-ask fold); `public/detail.js` renders the panel and
controls from the per-worker view `app.js` supplies, and `public/rail.js`
renders the tree (sessions → tasks → workers). No build step. Static
pins T1.20/T1.22 evolve (asset set, token store) and T1.24 constrains the
mutation surface to `steer.js`'s two routes with a Bearer header. Check:
`test/swarm-dashboard-steer-check.ts`.

#### 4.2.8 Dashboard access: widget link, fragment token, one server per machine (issue #65)

Issue #65 resolves the three access frictions the operator named — the URL
was undiscoverable, copying a 64-hex token from stderr was friction, and
parallel sessions fragmented the picture — by fixing the ACCESS SHAPE, not
the dashboard. The dashboard shell from #66 is unchanged; every contract
below is additive to it (Law 7).

**Widget-link surface (item 1).** The mount is the ONE spelling of the
canonical link (Law 9): on a successful bind it emits exactly ONE structured
stderr line `{event:"dashboard", url, link}` carrying the ACTUAL bound port —
the EADDRINUSE fallback is reflected, never the configured port
(`src/swarm-server/mount.ts` `dashboardUrlFor` / `dashboardLinkFor`; the
bound port is never re-derived by a consumer). The session handle exposes
`dashboardUrl` (tokenless) and `role` for programmatic consumers; the widget
surface is the stderr line (the brief's "widget and/or mount line").

**Fragment-token rule (item 2).** The link carries the session's operator
token in the URL FRAGMENT: `http://127.0.0.1:<port>/#t=<token>`. A fragment
is never sent to the server, so the token cannot appear in a request line, a
server log, the journal or a response body; it reaches the page only through
`public/auth-bootstrap.js`, which moves it into the EXISTING `sessionStorage`
token store (`steer.js` `TOKEN_KEY` — the one token store) and strips the
address bar with `history.replaceState` before any request. A bookmark
without a fragment bootstraps nothing and the existing manual prompt (with
its bounded 401 re-prompt) stays the fallback. Automatic token entry into a
PATH or QUERY, dropping auth on loopback, a one-time token exchange and
cookie auth are REJECTED (see the issue's record); the graph shows only the
one accepted mechanism. The token still travels to the mutation routes ONLY
as `Authorization: Bearer`.

**D1 RESOLVED: one server per machine (item 3, operator-pre-approved).** The
first session to bind the configured port is the PRIMARY; a later session
that sees a delegate primary on that port mounts NO listener and becomes a
SECONDARY — its fleets are served READ-ONLY through the primary, because the
shared journal already makes every fleet visible and no new store is
introduced. Mutations stay strictly same-session: a server steers only the
fleets its hosting session owns (the Transport handle exists only there), so
a foreign fleet served by the primary refuses a mutation with the uniform
`403 E_SWARM_FORBIDDEN`. A port occupied by something that is not a delegate
server (or nothing at all) falls back to an OS-assigned port
(`EADDRINUSE → 0`), fail-open for a single session — no cross-session
dependency sits in the critical path (Law 8). Rationale: parallel sessions
fragmented the picture precisely because each held its own server; one
canonical URL per machine is the shape the operator asked for, and the OS
arbitrates liveness so no election protocol is needed.

**Takeover rule (item 3b).** Every non-primary mounted session runs an
ADVISORY primary watch (`src/swarm-server/primary-watch.ts`): a bounded
liveness probe of the configured port plus a bind attempt, with
multiplicative backoff, at most one in-flight attempt, an unref'd timer and
total failure handling. When the primary dies, the first survivor's bind
succeeds — the OS is the arbiter, no election, no new store — and the
canonical URL keeps serving. Takeover changes WHO SERVES reads, never WHO MAY
MUTATE: each session keeps its OWN operator token (a token authenticates the
operator to a session, not to a port), so after takeover the canonical URL
requires the NEW primary's token and the promoted session re-announces its
dashboard link only when the effective port actually changed. A second kill
with no survivors leaves the port free — graceful degradation, never a
phantom listener.

**Per-fleet URL contract (item 3).** `GET /` redirects to the single fleet
view when exactly one fleet exists, else serves the fleet index (the v1 SPA).
`GET /fleets/<sessionId>/` serves that fleet's view; `<sessionId>` is a
SwarmGraph SESSION node id and an unknown id is a structured 404.
`GET /api/swarm/fleets` is the fleet index envelope (`self` + one row per
fleet with its `own` flag). `GET /fleets/<sessionId>/api/swarm/events` and
`WS /fleets/<sessionId>/api/swarm/stream` emit ONLY that fleet's journal rows
(the per-audience cursor precedent: attention never crosses fleets); the WS
scope is resolved from the read-model before the 101 handshake, so an unknown
fleet is a plain 404, never a fabricated stream. The dashboard client detects
its serving base (`public/fleet-scope.js`) and consumes ONLY its own fleet:
under `/fleets/<id>/` it reads the scoped events/stream and narrows every
graph it folds — the HTTP snapshot and the WS snapshot frame alike — to the
session node's own `spawned_by` subtree; the root view stays unscoped. The
snapshot read keeps the ONE protocol-identity route (no per-fleet snapshot
contract is added, §4.2.2). Routing decisions read fleet
state ONLY through the read-model (Law 13). The swarm-http route paths are
frozen surface (§3); the v1 `/api/*` routes keep working unchanged (Law 7). Check:
`test/swarm-server-lifecycle-check.ts` (L3–L7),
`test/swarm-http-api-check.ts` (F1–F10) with the additive goldens in
`test/swarm-http-goldens.ts`, and `test/fleet-view-scope-check.ts` (R0–R4 — the
client-side per-fleet view scope).
