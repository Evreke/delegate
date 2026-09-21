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
envelopes, release markers, watcher satellites, the delivered-facts store, the
fleet event journal, and the swarm read-model snapshot (Law 13) — is a protocol
with a version. The delivered-facts store is the standard pattern:
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
- Only the operator merges to `main`. The canonical green/red verdict of
  `main` is produced only by the merge gate's serialized run of
  `test/run-checks.sh` plus typecheck (exit code 0 = green). Agent-local runs
  are advisory and never produce or contradict the canonical verdict — the
  runner's documented environment flake reproduces under concurrent agent
  load, so a verdict born under load is not a verdict.
- While `main` is red, merges freeze until green. The author of the change
  that turned main red owns the fix; ownerless reds (environment drift,
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
| Duplicate import binding (two `homedir` imports from different modules) | bun's transpiler forgives the duplicate, pi's extension loader (jiti) does not: the extension fails to load with a green check suite | **uncovered** (incident 2026-09-11, fix/exchange-homedir-duplicate; candidate: a load check of index.ts through the real loader) |
| No run provenance: unknown which extension version executed a run and what the code was before/after — incident investigation becomes archaeology | `test/passport-check.ts` (P1–P5: snapshot clean/dirty/not-a-repo/absent, line cap, delta with ??-untracked, manifest roundtrip, version sync with package.json) | covered |

## 3. The frozen surface (never rename)

herdr CLI verb strings · herdr JSON field names (`workspace.worktree.*`,
`is_linked_worktree`) · the `not_linked_worktree` token · manifest
`kind: "worktree"` value · journal event names (`delegate-fleet`,
`spawn`/`collect`) · `/delegate-*` command names · tool names and parameter
shapes · the E_* code names. Extension happens by addition; correction happens
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
`ask`, `poll-answer`, `report-progress`. Orchestrator-side verbs — `spawn`,
`status`, `answer`, `steer`, `release`, `teardown` — are specified
symmetrically but stay wrapped by the pi tools in this milestone (the
frozen surface does not move: tool names and parameter shapes are
byte-identical).

Rules:

- A worker interacts through verbs, never raw paths. After the `briefPrompt`
  switch (#25) the worker prompt names only verb invocations; the raw-file
  phrasing survives one release behind the config flag `swarm.verbsFallback`
  (default on in #25's release, removed after).
- Identity travels with the invocation: every worker verb carries task and
  worker identity (`--task` / `--worker` flags, or the environment the spawn
  flow sets); the CLI builds every path through `src/expaths.ts` exclusively
  (static pin per #18's acceptance, Law 6).
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
- The five worker verb names and six orchestrator verb names join the frozen
  surface (section 3) in the commit that ships them; extension by addition
  only.

#### 4.1.2 The journal — append-only, single-writer, durable

Location: ONE SQLite database at `join(getAgentDir(), "delegate-journal",
"events.db")` (Law 1 — resolved through pi's `getAgentDir()`, never the
exchange root, which dies on reboot; never the repository). Schema DDL
(version 1, `PRAGMA user_version = 1` — the Law 7 version gate for the
database itself):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
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

Kinds — the closed v1 set (new kinds only by addition, never rename):
`spawn`, `stamp`, `collect`, `ask`, `answer`, `steer`, `progress`, `retire`,
`dead-reboot`, `reconcile-summary`, `termination-notice`, `partial-report`.
The last two are forward-compat with #15: they may exist in the schema
before their producers land. `reconcile-summary` is this record's addition
over the issue's enumeration — it makes "exactly one summary wake per fleet"
(§4.1.4) dedup-able through the journal itself. Each kind name joins
section 3's frozen list in the commit that lands its first producer.

Payload shapes (JSON; the listed fields are the v1 contract, additive-only
after that):

- `spawn` `{backend, placementRef, briefPath, briefText, depth?}` —
  `briefText` is the full brief inline: the journal is where briefs survive
  a reboot (§4.1.4 step 5). `depth` rides along once #28 lands (additive,
  the passport precedent).
- `stamp` `{field, value}` — the mirror of every manifest stamp the pipeline
  writes (`collectedAt`, `sessionPath` once #16 lands, …).
- `collect` `{status, reportPath, archivePath}`.
- `ask` / `answer` / `steer` `{text}` — the mailbox envelope fields, verbatim.
- `progress` — the `ProgressEvent` shape (`src/host.ts`), verbatim.
- `retire` `{reason}`.
- `dead-reboot` `{detectedAt, lastSeq}` — `lastSeq` is the worker's last
  journal seq before the loss was detected.
- `reconcile-summary` `{lost: string[], collectedBeforeLoss: number}` —
  fleet-scoped (worker NULL); the wake text the watcher renders from it is
  the frozen per-fleet summary of §4.1.4 step 4.
- `termination-notice` `{graceMs}` — producer: #15.
- `partial-report` `{captured: boolean, text?}` — producer: #15.

Single-writer: `src/swarm/journal.ts` is the ONLY writer module. No UPDATE
or DELETE operation exists in the module — append-only is enforced by
absence, not convention. Every append is one transaction, so a torn write
leaves the last record intact or absent, never corrupt (#22's acceptance
check). Static pin (#31, Law 6): no other `src/` module imports a sqlite
driver.

Advisory by contract (Law 8, Law 13): a journal append failure is recorded
and skipped — structurally incapable of failing a spawn or collect; a
fault-injection check proves it before the Phase B default flip (§4.1.3).

Append sites: the journal rows are written at the lifecycle points that
today emit the host session journal events (`delegate-fleet`,
`spawn`/`collect` — section 3). Those facts are the seed of this journal,
never a parallel copy (§0.1.1, Law 9): one site, one fact, one spelling —
fleet history is never re-derived by scanning the exchange directory.

Cursor: the reader API is `eventsAfter(cursor)` — all rows with
`seq > cursor`, ordered by `seq`. The cursor is the last consumed `seq`,
persisted per audience session; it replaces the watcher's seen-map plus
delivered-facts store as the dedup mechanism — durable and exactly-once by
construction (#26). `swarm events --after <seq>` (#30) exposes this reader
verbatim.

Retention: none in v1 — the journal grows unboundedly with fleet activity;
rotation or compaction is `[operator-decision-pending]` and lands, if ever,
as an additive decision that never rewrites existing rows.

#### 4.1.3 Two storage phases

Phase A — files are truth (#18): the CLI writes today's files
byte-identically (golden tests; the watcher is untouched; rollback is
trivial — stop shipping the CLI). The journal module (#22) may land in the
same release but receives no production writes in Phase A.

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
reconciliation failure never blocks session start — it is logged and
skipped.

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
- #28 (manifest `depth`): the `spawn` payload carries `depth` once #28
  lands — additive, no schema-version bump (the passport precedent).
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
   contract; SQL stays below `src/swarm/journal.ts`, confined by the #31
   pin.
3. Files-forever (exchange files stay the system of record): rejected — no
   audit queries (history becomes filesystem archaeology); the exchange
   root dies on reboot while pi sessions resume (the manifest-loss incident
   class: the orchestrator cannot even state that its fleet died); every
   observation UI would reimplement format knowledge, which Law 13's client
   rule forbids.
