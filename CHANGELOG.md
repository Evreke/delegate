# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version numbers are the semver `X.Y.Z` in `package.json` (runtime source: `src/version.ts`, byte-matched by a static pin); git tags mirror them as `vX.Y.Z`.

## [Unreleased]

### Added

- **Dashboard brief/report tabs serve the real exchange files (#87).** The
  worker-detail panel's brief/report tabs now fetch the worker's `brief-<name>.md`
  and `report-<name>.json` via two additive read-only routes —
  `GET /api/workers/:id/brief` and `GET /api/workers/:id/report`. Resolution
  reuses the console route's fail-closed ownership gate; the served path is
  rebuilt from the graph's task `dir` + canonical worker name (traversal-safe), an
  absent file is an honest `absent:true` (200), and unknown/non-worker/foreign/
  unsafe-name ids refuse with the new `404 E_EXCHANGE_FILE_REFUSED`.

- **Mutation routes accept both id spellings — name-first (#62/#70).**
  `POST /api/workers/:id/steer` and `POST /api/asks/:id/answer` resolve `:id` as a
  canonical worker name when it matches `WORKER_NAME_RE`, otherwise as a SwarmGraph
  session node id through the one shared read-model lookup; ambiguity resolves
  deterministically name-first, and ownership stays fail-closed (a foreign worker's
  node id refuses with the uniform `403 E_SWARM_FORBIDDEN`). No `/by-name/` route is
  added — the v1 routes keep working unchanged.

- **Scheduled wakes, stage A — `delegate_wake` (#10).** An orchestrator can now
  schedule a ONE-SHOT wake for its own session: `delegate_wake` action
  `schedule` takes a free-form `text` plus exactly one of `delayMs` (relative)
  or `at` (absolute ISO-8601), and the background watcher delivers
  `scheduled wake (id w1): <text>` as a followUp turn when due. Actions
  `cancel` (by id) and `list` (pending wakes with due times) complete the
  surface. Due-schedule checking runs INSIDE the existing watcher tick (one
  more event source — no setTimeout swarm): the new deep leaf
  `src/watch-schedule.ts` owns the in-memory store and due computation, with
  time injected through the existing `ClockPort` so timing regressions run on
  the VirtualClock. Delivery rides the same guarded sink as event wakes
  (`sendUserMessage`, `deliverAs: followUp`; a headless build stays inert) and
  the `id#run` delivery key makes a run wake at most once — a failed or
  silent send leaves the schedule pending. Schedules are session-scoped
  (Law 3): they die with the session. Anti-spam limits: `schedule.minDelayMs`
  (default 1000 ms) and `schedule.maxActive` (default 8); bad input refuses
  with the new `E_SCHEDULE` code. Durable persistence (#12) is a later stage —
  stage A is one-shot and in-memory.

- **Scheduled wakes, stage B — periodic wakes (#11).** `delegate_wake` action
  `schedule` gains an `every` parameter (interval ms, next to `at`/`delayMs`
  and mutually exclusive with them, structured `E_SCHEDULE` on conflict) plus
  an optional per-schedule `maxRuns` cap (config default `schedule.maxRuns`,
  100). A periodic wake fires every N until cancelled or the cap is reached,
  carrying its run number: `scheduled wake (id w2, run 3/10): <text>` (the
  free-form `text` may reference `{run}`, `{maxRuns}` and `{elapsed}`). Missed
  intervals COALESCE — at most one pending delivery per schedule, so a sleep
  or a busy session yields ONE wake whose run number advanced past the
  skipped fires, never a back-wake burst; the run count and next-due live
  only in the store (Law 9) and advance on a real send, so a failed periodic
  wake is skipped with its cadence preserved (Law 8). A capped schedule
  removes itself after its last run; `cancel` stops it mid-cycle. In-memory
  and session-scoped (Law 3); durable persistence is #12.

- **Scheduled wakes, stage C — durable schedules (#12).** Pending scheduled wakes
  now SURVIVE a watcher remount (extension reload, watcher recreation while the
  session lives). The store is persisted as ONE versioned JSON document per session
  at the exchange root (`schedules-<watcherKey>.json`, next to the watcher's cursor
  satellites; built by `src/expaths.ts`); on mount the store rebuilds its cache from
  that document (Law 9 — the file is the single source of truth, the in-memory store
  is a cache) and after every mutation it writes the full snapshot back through a new
  injected `SchedulePersistencePort` (`src/watch-schedule-persist.ts`), so the store
  itself stays a filesystem-free leaf. Delivered runs (`id#run`) are part of that
  snapshot — the same delivery-record mechanism/ordering the event-wake cursor uses
  (committed only after a real send; a failed send leaves no record so the next tick
  retries), so a delivered wake is never re-delivered after a restart. Restore is
  advisory by contract: a missing file is a quiet first run, while a corrupt,
  unreadable, wrong-`schemaVersion` (Law 7) or foreign-session document (Law 3 — a
  closed session never resurrects) yields ZERO restored schedules and ONE warning in
  the watcher log, never a dead watcher. A degraded self-id disables persistence
  entirely (fail-closed — no shared "anon" file).

- **Graceful termination handoff on the rpc teardown path (#15).** Tearing
  down a still-live `pi --mode rpc` worker no longer SIGKILLs it with its
  unreported context lost. Before the abort/kill, the rpc adapter writes a
  short bounded termination-notice prompt over the child's stdin ("state
  what is done, what remains, and the last check status — answer without
  tools"), waits at most a configurable window for the answer, and captures
  that answer verbatim as a partial report (`partial-<name>.json`, a
  `PartialReport` — deliberately NOT a schema-valid WorkerReport) at the
  caller-supplied path. The capture is advisory by contract: a closed stdin,
  a silent child or an unwritable path only costs the window and never fails
  the teardown (abort-detaches-never-kills and alreadyGone idempotency
  unchanged). `/delegate-teardown` supplies the path and stamps it onto the
  worker's manifest entry (`partialReportPath`, additive optional field — no
  schemaVersion bump, same convention as the passport fields); adapters
  never write manifests (Law 4). New adapter-level method
  `requestTerminationNotice()` (NOT a Transport seam method); the notice
  window, notice text and kill grace are constructor-bounded.

- **Durable rpc child sessions — persist `sessionPath`, resume via the
  session-file argument (#16).** The rpc adapter's captured worker session
  JSONL path (`StartResult.sessionPath`) is stamped into the worker's manifest
  entry as the additive optional field `sessionPath` (no `schemaVersion`
  bump — the passport/additive-fields convention), and the new adapter-level
  `RpcWorkerHost.resumeAgent()` affordance (NOT a Transport seam method)
  spawns a NEW child for the same worker name that RE-ENTERS that file via the
  documented `--session <path>` extraArgs argument, so accumulated context
  survives an orchestrator exit. The caller supplies the persisted path it
  read from the manifest; an absent/empty path or a vanished session file
  refuses with the structured `E_START` (no silent fresh start). Full reattach
  (same child, new stdin) stays out of scope. Checks:
  `test/rpc-resume-check.ts`.

- **Dashboard access UX — widget link, fragment auth, one server per machine
  (#65, ARCHITECTURE §4.2.8).** The mount now emits ONE canonical `dashboard`
  stderr line carrying the ACTUAL bound port (an `EADDRINUSE` fallback is
  reflected) and the link `http://127.0.0.1:<port>/#t=<operator token>`; the
  token rides in the URL FRAGMENT, so it never reaches the server, a log or
  the journal. The dashboard reads the fragment on load
  (`public/auth-bootstrap.js`), moves the token into the existing
  `sessionStorage` store and strips the address bar before any request; a
  bookmark without a fragment still prompts. **D1 resolved:** one server per
  machine — the first session to bind the configured port is the primary,
  later sessions run as secondaries with NO listener (the primary serves
  their fleets read-only; mutations stay strictly same-session and a foreign
  mutation refuses with the uniform `403 E_SWARM_FORBIDDEN`), a non-delegate
  occupant falls back to an OS-assigned port, and a surviving session takes
  the configured port over when the primary dies (advisory watch, bounded
  backoff — the OS arbitrates; the canonical URL survives and then requires
  the new primary's token). Per-fleet URLs land by addition: `GET
  /api/swarm/fleets`, `GET /fleets/<sessionId>/`, and fleet-scoped
  events/stream routes that carry ONLY that fleet's rows (attention never
  crosses fleets). All v1 routes keep working (Law 7); the swarm-http route
  paths join the frozen surface.

- **Dashboard v1 — the merged one-screen fleet shell (#66, ARCHITECTURE
  §4.2.6/§4.2.7).** The read-only dashboard is one screen: an attention
  strip, a left rail, a center SVG graph canvas (depth-column layout with
  adaptive collapse) and a right detail panel, inside the static frame with
  the connection/token/journal statusbar. The rail/tree/canvas/detail all
  render from the read-model graph; status is the six-token language
  (`running`/`idle`/`ask`/`collected`/`retired`/`dead`), attention aggregates
  cover OWN fleets only, and stream frames patch status/progress IN PLACE
  without relayout. SVG-only rendering, system font stacks, a
  CSS-variable palette/type scale, no build step and zero external network
  calls. New static pins T1.25–T1.28.

- **Dashboard console panel + steering controls (#54, ARCHITECTURE §4.2.7).**
  The fleet dashboard SPA now streams each worker's console and steers it from
  the page. Per worker card: a monospace console panel preloads the backlog via
  `GET /api/workers/:id/console?offset=0` and live-tails it over
  `WS /api/workers/:id/console/stream`, with a DISTINCT honest banner for
  `live` / `ended` / `ended-with-retained-backlog` (backlog shown, marked
  retained) / `unavailable` (no fake terminal) and the fail-closed foreign
  refusal. Steering is optimistic-with-confirmation: a POST to
  `POST /api/workers/:id/steer` (`/api/asks/:id/answer` for a pending ask)
  starts a pending marker that turns `confirmed` ONLY when the matching journal
  `steer`/`answer` event arrives over the read stream (`via:"http"` shown) and
  `failed` on a structured error. Pending questions are folded from `ask`
  events without a matching `answer`. The operator token is prompted once,
  kept in `sessionStorage` ONLY (never localStorage, a URL or a log), sent as
  `Authorization: Bearer`, and a structured 401/403 re-prompts. Controls are
  DISABLED-WITH-REASON (never hidden) for foreign-fleet and ended cards, while
  a console-`unavailable` backend still steers. New client modules
  `src/swarm-server/public/console.js` and `steer.js`; the static pins evolve
  (T1.20/T1.22 asset set + token store) and gain T1.24 (the mutation surface
  lives only in `steer.js`). Check: `test/swarm-dashboard-steer-check.ts`.

- **Read-only fleet dashboard (#53, ARCHITECTURE §4.2.6).** `GET /` on the
  session-hosted read server now serves a static dashboard SPA from
  `src/swarm-server/public/` (vanilla ES modules + CSS — **no build step**, no
  framework, no bundler in the runtime path). It is a pure Law-13 client:
  `GET /api/swarm/snapshot` builds the tree (SessionNode → TaskNode → worker
  embodiments, parented by the graph's `spawned_by` edges, deterministic
  node-for-node), `WS /api/swarm/stream?after=<seq>` applies frames live
  (snapshot replaces; events advance the cursor; reconnect resumes from the
  last consumed `seq` — `sessionStorage` stores only that cursor), and
  `GET /api/swarm/events` feeds the journal-health footer. The four
  degradation flags (`no-session-path`, `no-live-status`, `legacy-orphan`,
  `usage-unavailable`) render as four distinct, honest visual states with the
  flag name verbatim — degraded nodes are shown, never hidden or faked
  healthy. Read-only: GET + WS only, zero mutation requests, zero external
  network calls. Server side: `src/swarm-server/static.ts` (path-safe
  html/js/css serving wired into `routeRequest`). New static pins T1.20–T1.23
  (asset set, no external URL/framework/mutation shape, sessionStorage scope,
  no build artifacts) and the functional check
  `test/swarm-dashboard-check.ts`.

- **Session-hosted swarm read server (#50, swarm-core-v1, ARCHITECTURE
  §4.2).** A loopback HTTP/WS endpoint mounted per session (`src/swarm-server/`):
  `GET /api/version`, `GET /api/swarm/snapshot` and `GET /api/swarm/events?after=<seq>`
  (the `swarm snapshot` / `swarm events` CLI envelopes verbatim — protocol
  identity — with the session's live Transport statuses and usage summaries
  folded in), and `WS /api/swarm/stream?after=<seq>` (one snapshot frame, then
  seq-ordered journal events off a shared cursor poll; cursor-resume on
  reconnect). Config: `swarm.server.enabled` (default **OFF**) and
  `swarm.server.port` (default 7331; `0` = OS-assigned; on `EADDRINUSE` the
  session binds an OS-assigned port and logs the substitution — parallel
  sessions get independent servers). Loopback-only bind (a code constant, not
  a knob), no auth in v1 beyond the loopback. Advisory by contract: a startup
  failure (bad port, bound port, failing journal reader) is logged and never
  blocks session start, spawn, or collect. Zero new runtime dependencies — a
  hand-rolled HTTP/1.1 + RFC 6455 core on `node:net` (the platform has no
  server-side WebSocket; `node:http` upgrade sockets drop writes under bun
  1.3.x). New static pin T1.15: the family is a Law-13 client — no direct
  imports of durable stores, observation surfaces, backend adapters or the
  journal writer half; the journal enters only through the reader surface
  (`journal-read.ts` now re-exports `journalDbPath` for it). Checks:
  `test/swarm-server-{endpoints,ws,lifecycle,fault}-check.ts`.

- **Steering endpoints + operator token (#51, swarm-core-v1, ARCHITECTURE
  §4.2.4).** The session-hosted server gains TWO operator-only write routes:
  `POST /api/workers/<id>/steer` and `POST /api/asks/<id>/answer` (body
  `{"text":"..."}`). Both require `Authorization: Bearer <operator token>`;
  the token is generated fresh per mount (`crypto.randomBytes(32)`) and
  surfaced ONLY on the session's stderr as one structured `operator-token`
  line — never the journal, a response body or a log file (Law 11).
  Missing/malformed/wrong tokens yield the SAME uniform `401 E_SWARM_AUTH`
  refusal (constant-time compare); GET and the WS stream stay open. Ownership
  is fail-closed via the canonical `workerAudienceMatch` (`src/watch-role.ts`)
  over the read-model's manifest rows: a foreign or unknown id refuses with
  the same `403 E_SWARM_FORBIDDEN` body. The write is NOT reimplemented —
  the shared `src/swarm/mailbox-verbs.ts` calls the SAME `postSteerAndNudge` /
  `writeAnswer` / `archiveQuestion` core the `delegate_mailbox` tool uses, so
  an HTTP-issued `a-<name>.json` is byte-identical; every successful mutation
  then appends its `steer`/`answer` journal row (`{text}` + additive
  `via: "http"`; no schema bump) through the verb plumbing. New static pin
  T1.16: the mutation core journals every write and no `src/swarm-server/**`
  file makes a direct mailbox write. The HTTP/1.1 core now accepts small
  bounded JSON bodies on those two routes only. Checks:
  `test/swarm-server-mutation-check.ts` (+ T1.16 in `test/static-check.ts`).

- **Worker console stream endpoint (#52, swarm-core-v1, ARCHITECTURE
  §4.2.5).** The session-hosted read server gains the console half:
  `GET /api/workers/:id/console?offset=<n>` and `WS
  /api/workers/:id/console/stream?offset=<n>` serve one worker's console as
  frames `{ok, schemaVersion, worker, nodeId, task, state, chunk,
  nextOffset, oldestOffset, dropped}`. `:id` is the SwarmGraph session node
  id of a worker session; resolution is fail-closed through the canonical
  `src/watch-role.ts` ownership verdict (unknown/foreign/task ids are
  `E_CONSOLE_WORKER_REFUSED`, 404 — no existence oracle). States are
  transport-derived: `live`, `ended-with-retained-backlog`, `ended`, or
  `unavailable` (a backend without a console stream — herdr — answers HTTP
  200 with `E_CONSOLE_UNAVAILABLE` + recovery hint, never a fabricated
  stream). The rpc backend reuses its `FidelityStore` console stream. The
  server-side retained backlog is bounded by pi's `DEFAULT_MAX_BYTES`
  (drop-oldest, `console-buffer.ts`) and served by character offset with
  `oldestOffset`/`dropped` honesty; console text is ephemeral — never
  journalled, never in the swarm snapshot — and the surface is advisory by
  contract. Zero new dependencies. Checks:
  `test/swarm-console-{rest,ws}-check.ts`.

- **Static pins for the new seams (#31, swarm-core-v1, Law 6).** Three
  shape pins in `test/static-check.ts` make §4.1.2/§4.1.3 fail CI, not
  reviews: **sqlite confinement** (T1.12 — no src/ module outside the
  `src/swarm/journal*.ts` family references a sqlite driver, across the
  static/side-effect/dynamic/require spellings), **watcher-no-direct-FS**
  (T1.13 — the watcher family's import-verified node:fs reads never touch
  an expaths-built exchange path; watcher satellites and store-routed reads
  are the sanctioned shapes, and the journal is consumed only through
  `swarm/journal-read.ts`), **single projection writer** (T1.14 — the
  report/q/a/p projection's writer set is exactly the swarm CLI verbs plus
  the named Phase A legacy rows, exact in both directions, with one LIVE
  waiver for the Phase A q-archive rename). Every pin carries canary
  fixtures, precision fixtures and a seeded-file probe walked by the real
  scanner, so a vacuous pin fails its own check.
- **Read API for external UIs: `swarm snapshot` + `swarm events --after
  <seq>` (#30, swarm-core-v1).** The `swarm` CLI now exposes the two
  orchestrator-side read verbs that make it the UI's backend contract (Law
  13: observation clients read the read-model, never files or the database).
  `snapshot` serializes the SwarmGraph with the real dependencies injected
  (journal reader + the configured mode's ManifestStore) — a PURE READ,
  zero writes: in journal mode the manifest scan goes through the read-only
  journal replay (`scanManifestsViaJournalReader`, extracted from the
  journal-backed store so one spelling serves both), never the store
  constructor whose writer open would create/migrate the database. `events
  --after <seq>` exposes the journal cursor reader verbatim and carries the
  DP7 retention counters (`journal.count` / `journal.dbSizeBytes`). Both
  envelopes are versioned contracts (Law 7: `schemaVersion` 1; the snapshot's
  graph carries its own existing stamp) and byte-pinned by goldens in
  `test/swarm-api-check.ts` — every source degraded (no journal, no exchange
  root, no live transport, no usage) still yields a valid snapshot/events
  result with degraded fields, exit 0 (Law 8). The read verbs require no
  worker identity and join the frozen verb surface by addition (§4.1.1).
- **`swarm` CLI — the five worker verbs, Phase A (#18, swarm-core-v1).**
  `bun <extension>/src/swarm/cli.ts read-brief|write-report|ask|poll-answer|write-progress`
  is the worker contract. Phase A output is byte-identical to the file
  writers it replaces (golden/parity checks); raw-path worker prompts keep
  working unchanged.
- **Fleet event journal — SQLite, single-writer, append-only (#22).** One
  shared database at `<agentDir>/delegate-journal/events.db` (WAL,
  `synchronous = FULL`, `user_version = 1` — the Law 7 version gate); the
  closed fourteen-kind set (including `report` — payload = the validated
  report JSON, appended after the atomic publish); bounded `SQLITE_BUSY`
  backoff for cross-process writers; advisory by contract: a journal
  failure can never fail a spawn or collect.
- **Phase B storage flag — journal = truth, files = projection (#23).**
  `swarm.storage: "files" | "journal"` (default `"files"`) and
  `swarm.projection` (default `true`, journal mode only) gate the
  journal-backed ManifestStore: verb writes append journal events first,
  then write the byte-frozen `manifest.json` projection; with
  `projection: false` reads are served by journal replay alone. Parity
  with the file store is check-pinned; the default flip to `"journal"` is
  a separate operator-approved cutover, not bundled here.
- **Resume reconciliation — the honest fleet picture after a reboot
  (#27).** On session start (journal mode) every owned worker's placement
  liveness is probed through the Transport seam; each dead placement gets
  a terminal `dead-reboot` event and each affected fleet exactly one
  `reconcile-summary` wake ("N workers lost to reboot, briefs preserved,
  M reports collected before loss"). Foreign/owner-less rows in
  mixed-ownership fleets are skipped (auditable `skipped` field), never
  marked lost; the run is advisory and never blocks session start.
- **SwarmGraph read-model — the canonical fleet projection (#29).**
  `buildSwarmGraph` is a pure, deterministic, never-throws projection over
  the journal, the manifest store and optional live status; its serialized
  JSON is a versioned contract (`schemaVersion`, Law 7) pinned by a golden
  check. Law 13's read path now has its projection layer; the read API
  (#30) is the next client surface.

- **HTTP API contract hardening (#55, ARCHITECTURE §4.2, Law 7).** The
  session-hosted HTTP/WS surface gained a golden envelope suite
  (`test/swarm-http-api-check.ts` + `test/swarm-http-goldens.ts`): every
  endpoint's success and structured-error shape is byte-pinned over fixture
  fleets covering the empty journal, a multi-fleet, all four degraded flags,
  the herdr-unavailable console, foreign-fleet refusals and absent/wrong
  operator tokens. An additive-only schema-diff check
  (`test/swarm-http-schema-diff-check.ts`) fails CI when a shipped envelope
  loses or renames a field relative to its golden (additions pass); a
  version-negotiation check (`test/swarm-http-version-check.ts`) pins
  `/api/version` and proves unknown-field tolerance; an end-to-end check
  (`test/swarm-http-e2e-check.ts`) drives snapshot → stream → steer
  (journal-confirmed) → console against a real mounted server. Protocol
  reference: `docs/swarm-http-api.md` (goldens remain normative).
### Changed

- **The noisy advisory stderr lines are gone.** The `swarm-journal` advisory
  note (a journal append failure) and the `swarm-reconcile` note (a reconcile
  failure) no longer print a structured JSON line to stderr — the failure is
  still reflected in the structured result (the journal error envelope / the
  `IDLE` return) and never blocks the verb, but no longer surfaces as JSON
  noise in the session TUI. The operator-facing `dashboard` and
  `operator-token` lines are unchanged.

- **The orphan `public/tree.js` dashboard renderer is removed (#92).** The SPA
  has rendered the tree through `rail.js` (and the panel/controls through
  `detail.js`) since the v1 shell; `tree.js` was a dead renderer no module
  imported, still advertised as a served asset. It is deleted and the asset
  list / static pins / renderer-only check legs are updated to match (the
  live tree, rail and panel coverage is unaffected).

- **Branching model: trunk-based development → simplified git flow.**
  `develop` is the integration branch (all `feature/*` / `fix/*` PRs land
  there via squash-merge); releases are `--no-ff` merge PRs `develop` →
  `main`; hotfixes cut from `main` and merge into both branches. CI gates
  PRs into both branches and a guard job enforces that `main` accepts only
  `develop` and `hotfix/*` heads; branch protection requires PRs + green
  checks on `main` (admin bypass preserved).
- **Watcher consumes the journal cursor; the delivered-facts store is
  retired (#26, swarm-core-v1).** Wake-up dedup moved from the per-task
  `delivered-<key>.json` files to a durable per-audience journal cursor
  (`cursor-<key>.json`, `src/watch-cursor.ts`): each tick reads
  `eventsAfter(cursor)` through `src/swarm/journal-read.ts` (a throwing read
  skips the tick — advisory by contract, spawn/collect never affected), and a
  successful send commits the delivered facts and advances the cursor `seq`
  only over rows of THIS audience's live fleets (the journal's
  `session_id` + `task` key) — a foreign fleet's rows never move it.
  The wake-up text formats and event names are unchanged; the same fixtures
  through old and new detection produce the same event stream
  (`test/watcher-journal-parity-check.ts`). Ownership verdicts gained a
  journal-row predicate (`journalAudienceMatch`) with the unchanged
  fail-closed semantics; the retire engine (§23) is untouched. First-run
  migration: an absent cursor reads as `seq 0` with no records (never
  seeded) — a single bounded repeat volley on the first post-upgrade session,
  documented as with the stage-B migration.

- **Worker prompt now speaks the `swarm` CLI verbs (#25).** `briefPrompt` instructs
  the worker to interact through `bun <extension>/src/swarm/cli.ts` —
  `read-brief`, `ask`, `poll-answer`, `write-progress`, `write-report` — instead
  of hand-writing exchange files by path. Every example carries explicit
  `--brief` / `--task` / `--worker` flags, so the invocation is
  backend-independent; the exported env vars remain the canonical identity
  when present. The pre-#25 raw-file phrasing survives
  one release as a documented fallback behind the config flag
  `swarm.verbsFallback` (default `true`; `false` drops the fallback paragraph).
  The verb invocation is always the primary instruction; the flag controls only
  the fallback's availability.
- **The spawn flow exports the swarm identity into the worker environment**
  (`StartReq.env`): `SWARM_TASK`, `SWARM_WORKER` and the orchestrator-resolved
  project schema dir `SWARM_SCHEMA_DIR`. The rpc backend delivers it to the child
  process; the herdr backend applies it to the `herdr agent start` CLI subprocess
  (documented propagation caveat).

Regression: `test/report-contract-check.ts` (fallback/verb phrasing),
`test/rpc-host-unit-check.ts` (R9 env delivery), `test/profile-check.ts` (P12
resolver) and the opt-in `test/swarm-verbs-e2e-check.ts` (`RPC_E2E=1`: a live rpc
worker writes its report through `swarm write-report`).

- **The dashboard stream client checks `schemaVersion` (#55, Law 7).**
  `src/swarm-server/public/stream.js` now ignores a stream frame whose
  `schemaVersion` this build does not support (`SUPPORTED_STREAM_SCHEMA_VERSION
  = 1`) instead of applying it; a missing `schemaVersion` stays legacy v1, so
  the additive-only tolerance contract is unchanged. Documented in
  `docs/swarm-http-api.md` §3 and proven by `test/swarm-http-version-check.ts`.

### Fixed

- **rpc worktree placement collided with foreign worktrees (#73).** The
  `src/host/rpc.ts` `place()` allocator derived the worktree path from a
  per-host monotonic counter without probing the filesystem, so a directory
  already held by a previous/parallel host session (`delegate-wt-<n>`) made
  `git worktree add` fail with `fatal: '<dir>' already exists` → `E_PLACE`
  (and left a dangling `-b` branch per failed attempt). The allocator now
  probes `existsSync(dir)` and advances the counter PAST occupied paths
  BEFORE running git; the FINAL chosen `n` still feeds `placementRef`
  (`rpc:wt:<n>`), `workspaceId` (`rpc-ws-<n>`) and `paneId` (`rpc:p<n>`), and
  `this.seq` stays the session's monotonic floor. Check:
  `test/rpc-place-probe-check.ts`.

- **Zero-output provider settle was indistinguishable from a generic failed
  spawn (issue #74).** Under a provider burst the model returned empty
  assistant turns; a worker looped on them, settled idle, and wrote no report.
  The orchestrator was told only "settled (idle) with no report", so it had to
  read raw session JSONL to find the real cause. The rpc stdout pump now keeps
  a per-worker latch — `assistantTurnSeen` / `assistantOutputSeen` (a
  whitespace-only turn counts as empty) — and surfaces the additive advisory
  `providerEmpty` fact on `AgentStatus`; the watcher emits a DISTINCT
  `provider-empty` wake (new `E_PROVIDER_EMPTY` taxonomy code) with
  provider-switch retry guidance, and the synchronous settle classification
  returns `E_PROVIDER_EMPTY` instead of `E_REPORT_MISSING` for the same shape.
  Every other settle-without-report cause (non-empty output, never-started, a
  backend that cannot observe assistant output) keeps the generic
  `worker-dead` / `E_REPORT_MISSING` behavior byte-for-byte. Check:
  `test/provider-empty-check.ts`.

- **Files-mode steering never settles (issue #69).** The HTTP mutation path
  forced a journal append regardless of `swarm.storage` (#62's ruled-against
  "preferred variant"), contradicting `src/swarm/storage.ts`'s Phase A
  contract (files mode writes no journal row) and leaving the dashboard's
  optimistic steering marker pending forever. The append now runs under the
  REAL storage mode and the success envelope's additive `confirmation` field
  states the honest outcome: `"confirmed"` when a durable row was appended,
  `"unavailable"` in files mode or on an advisory append failure. The
  dashboard (`public/mutations.js`) settles the marker from that envelope —
  files mode shows the delivered/unconfirmed state, never a spinner — while a
  pre-fix server without the field keeps the old wait-for-journal behavior
  (Law 7). ARCHITECTURE §4.2.4 and `docs/swarm-http-api.md` now state the
  ruled rule; the mutation and HTTP golden checks encode it.

- **Dashboard per-fleet views consumed every fleet (#66 scope §7).** A page
  served at `/fleets/<sessionId>/` fetched the unscoped `GET
  /api/swarm/events` and `WS /api/swarm/stream` and rendered the whole graph —
  a per-fleet view showed foreign fleets' nodes and attention. The client now
  detects its serving base (`public/fleet-scope.js`), reads the scoped
  events/stream under `/fleets/<id>/`, and narrows every graph it folds — the
  HTTP snapshot and the WS snapshot frame alike — to the fleet's own
  `spawned_by` subtree; the root view is unchanged. No per-fleet snapshot
  route is added: the snapshot envelope stays the `swarm snapshot` CLI
  envelope verbatim (protocol identity, §4.2.2). Check:
  `test/fleet-view-scope-check.ts`.

- **Adaptive sqlite driver — the extension must load under node too.** The
  journal driver prefers `bun:sqlite` and falls back to `node:sqlite`
  (node ≥ 22.13); a statically chosen driver crashed the extension import
  chain under the node runtime, so every rpc worker spawn died `E_START`
  before this fix. Driver choice is confined to `src/swarm/journal-driver.ts`
  (the #31 static pin's confinement glob covers it).

## [1.18.0] — 2026-09-21

### Removed

- The `/delegate-fleet` full-screen overlay (`fleet-overlay.ts`) and its checks. The ambient fleet widget — the live indicator of running workers — is KEPT (operator decision after the initial removal round); `fleet-widget.ts` was slimmed: the tool-result transcript rendering (`renderDelegateLines`) moved to `ui-text.ts` (consumed by `delegate`, `delegate_status`, `delegate_mailbox`), and the fleet-idle TUI nudge was retired with the overlay. `delegate_status` and `/delegate-teardown` are unchanged. The `delegate-fleet` journal event name is kept (frozen surface).

### Added — Task passport (per-run provenance)

Every delegated run now leaves a passport in the task manifest:

- **Executing version.** Every `delegate` result carries the extension version that
  actually ran the call — both in the human-readable completion line
  (`· pi-delegate vX.Y.Z`) and in the result details (`version`). Single runtime
  source: `src/version.ts`, byte-matched to `package.json` by a static pin
  (Law 9: one artifact, one source of truth).
- **Pre-run git snapshot** (worktree placements only): the checkout's base commit
  and a capped `git status --porcelain` stamped into the worker's manifest entry
  at spawn. Tab placements are deliberately NOT stamped — a tab shares its checkout
  with other workers and the orchestrator, so a snapshot there would falsely attribute
  others' edits to this run.
- **Post-run git delta** (worktree placements only): a capped `git diff --stat`
  plus the untracked-file list, stamped by the same collect that stamps
  `collectedAt` — one write, one witness.
- **Advisory by contract (Law 8).** Both probes are failure-tolerant: a probe
  error or a non-git checkout yields an empty/absent passport and never affects
  spawn or collect.
- **Additive on-disk format (Law 7).** `gitBase` / `gitStatus` / `gitDelta` are
  optional manifest fields; no `schemaVersion` bump.

Regression: `test/passport-check.ts` (P1–P5).

### Changed


- **Default `releaseOn` flipped to `"started"`.** A blocking `delegate` call no longer
  stands in the settle gate for the full 15 s window: as soon as the worker is proven
  started and working, the call releases and the background watcher owns the wait
  (wakes the orchestrator on report-ready / question / death). The old inline block
  never settled a real worker in practice — it only produced a guaranteed timeout
  before the handover. The old behavior stays available as the explicit opt-out:
  `watch.releaseOn: "settle"` in the config or `releaseOn: "settle"` per call (the
  whitelist normalizer now honors exactly `"settle"`; everything else falls back to
  the default `"started"`). Probes are exempt in both modes — their full window IS
  the smoke verdict. Regression: `test/release-on-started-check.ts` (T-rel.4/T-rel.5).

- **Constitution v2 and machine-verified gates.** ARCHITECTURE.md: a direction statement and the eleventh law (independent reviewer agent with a structured verdict file, one canonical serialized main verdict, red-main freeze); the Law 5 module-size threshold is an exact 400 lines with a machine-verified decomposition ledger (the static check computes the over-threshold list and fails CI in both directions); Law 6 waivers are enumerated data, not prose; unfalsifiable wording rewritten to measurable form; audit history moved out per the closed-set law. AGENTS.md: three blocking QA layers (smoke / critical path / regression — no scheduled nightly), the acceptance list as a mandatory PR artifact, the binding-rule conflict rule.
- **Law 5 slice 1 executed.** The pure execute() phases moved from `src/spawn.ts` (2147 → 1833 lines) to the new `src/spawn-phases.ts` (MODULE_CONTRACT); the Law 6 pins updated in the same commit. The stale herdr ledger plan was corrected to the landed split state.
- **Pre-commit smoke gate.** `hooks/pre-commit` (typecheck + static pins, each bounded at 40s); installed via `git config core.hooksPath hooks/`.
- **Runner verdict telemetry.** Every `test/run-checks.sh` verdict line carries host load, available memory and the concurrent-runner count — ENV-FAILs become attributed evidence instead of folklore.
- **Language unification.** The threat catalog and all agent-facing binding documents are now uniformly English; `rpc-jsonl.ts` carries its MODULE_CONTRACT marker.

## [1.17.1] — 2026-09-16
### Added

- **`streamConsole` explicit unsubscribe.** The seam method's return type now
  carries optional `unsubscribe()` — consumers that stop consuming early (a
  closed stream consumer) must call it: a bare for-await break does not
  unregister the subscriber. Contract documented in src/host.ts; pinned by
  `test/stream-seam-check.ts` (unsubscribe spy over a real `FidelityStore`).
- **Named config profiles (gap 0).** Config presets live at
  `~/.pi/agent/pi-delegate.d/<name>.json` (same shape as the base config) and
  are selected by `PI_DELEGATE_PROFILE` (env) or the base config's `"profile"`
  key (env wins). Sections replace the base wholesale; absent sections fall
  through. A selected-but-missing/corrupt profile is a structured `E_START`
  on delegate calls (advisory surfaces degrade to defaults). All config
  readers now route through the single merged view (`src/profile.ts`); with
  no profile selected behavior is byte-identical to before. Regression:
  `test/profile-check.ts`.

- **`"rpc"` worker-host backend (herdr-free delegation).** New config key `"host": "rpc"`
  binds `src/host/rpc.ts` — workers run as headless `pi --mode rpc` child processes of the
  orchestrator session, no herdr anywhere. Worktree placement is a plain `git worktree add`
  under `~/.pi/agent/worktrees/` (sub-orchestrator authority guard mirrors the herdr
  adapter's); prompts go over the worker's stdin (mid-stream submits re-sent as `steer`);
  settle is proven by pi's own `agent_settled` rpc event — event-driven, zero polling, and
  immune to the herdr-era sensor gaps (§19.1b/§19.1c); worker session JSONL is captured via
  `get_state` for the budget gauges; `readConsole` is assembled from captured rpc output
  (assistant text + tool activity) and bound at construction (spawn.ts's probe flow extracts
  it unbound — herdr's `this`-free readConsole survived, this one initially did not);
  extension-UI dialogs are auto-cancelled so a headless worker cannot deadlock. Known
  limitation: rpc workers live with the orchestrator process — after it exits they finish
  and exit (stdin EOF); a later session reads their reports but cannot nudge them. POSIX-only
  for now (bare `pi` spawn, no Windows shim).
  Regression: `test/rpc-host-check.ts` + `test/rpc-host-unit-check.ts` (deterministic, no pi
  subprocess) + `test/host-parity-check.ts` rpc leg (real pi, never prompted — no LLM
  traffic) + `test/rpc-host-e2e-check.ts` (live, opt-in via `RPC_E2E=1`).

- **Full-fidelity worker console streaming (`streamConsole` seam method, rpc backend).**
  New OPTIONAL `Transport` method `streamConsole?(name, opts?: { afterSeq? }): AsyncIterable<ConsoleEvent>`
  (src/host.ts) — same optionality pattern as `readConsole`: implementations without an event
  store omit it (herdr adapter and the fake host do) and callers probe with
  `typeof transport.streamConsole === "function"` and degrade to `readConsole` polling. The
  envelope is `ConsoleEvent` (workerName, seq, timestamp, kind, payload — raw text, no
  re-encoding). The rpc adapter implements it: its stdout pump (single writer) mirrors every
  parsed rpc record into a new per-host `FidelityStore` (src/stream-seam/) — drop-oldest ring
  capped at 20,000 events per worker (~4.6 MB/worker at realistic payload sizes, ~235 MB at 50
  workers), replay-from-cursor exact and gap-free within the retained window, seq numbers
  monotonic across eviction, a backlog truncated by eviction opens with a `gap` marker naming
  the first retained seq (the `readConsole` last-maxChars snapshot stays the fallback beyond
  the window), and slow subscribers get drop-with-gap-marker backpressure (one merged marker
  naming the recovery cursor; per-subscriber memory O(bufferLimit)). Subscribers attach via
  `afterSeq`; teardown releases the worker's ring. Zero new data sources — fidelity
  preservation of the stream the pump already received. Regression: `test/stream-seam-check.ts`
  + the rpc leg `test/rpc-stream-check.ts`.

- **Dialog-relay policy flag (rpc backend, additive, default OFF).** New rpc adapter option
  `dialogRelay` (default false — behavior byte-identical to the auto-cancel default: blocking
  extension-UI dialogs are answered `cancelled: true` over stdin exactly as before, proven by
  the byte-identical stdin-write assertion in `test/rpc-stream-check.ts`). When enabled, a
  blocking dialog offer is relayed onto the console stream as a `dialog` ConsoleEvent and stays
  pending (status honestly reads `blocked`); the consumer answers via the adapter-level
  `answerDialog()` method, which writes the same raw `extension_ui_response` stdin command the
  auto-cancel path writes (the `rpcCommand` correlation wrapper would clobber the dialog's wire
  id). Fire-and-forget UI records (setWidget/notify/…) mirror as `ui` ConsoleEvents only when
  the flag is on. Regression: `test/rpc-stream-check.ts` (S4–S6).
### Changed
### Removed
## [1.17.0] — 2026-09-12

The healing release: the four-way 2026-09-11 audit of the 1.16.1 line turned into law and executed across waves 0–4 (see STABILIZATION.md and the new ARCHITECTURE.md).

### Added

- **Session-keyed watcher lifecycle (Law 3).** Every `session_start` builds a per-session context; the watcher mount is keyed by session file and a SECOND mount for the same session is refused instead of silently running two watchers with independent dedup. Regression: `test/double-mount-check.ts`.
- **Output truncation caps (Law 1).** Every tool return path that carries worker-written content is bounded by pi's own truncation helpers: `delegate_status` rows capped at 100 with an "N more omitted" note (full list in the result details), report summaries/artifacts and mailbox question bodies truncated with an explicit pointer to the full copy. Regression: `test/status-cap-check.ts`, `test/text-cap-check.ts`.
- **Versioned on-disk formats (Law 7).** `schemaVersion` stamped on the manifest, mailbox/release envelopes and the nudge-failed marker; readers tolerate absent (v1) and reject wrong versions. Regression: `test/schema-version-check.ts`.
- **fsync before rename** in the one atomic file writer (open/write/fsync/close/rename) — crash-consistent durable writes.
- **`prepareArguments` shim** on the delegate tool folding legacy `timeoutMs` calls into `waitMs` (schema stays strict).
- **ARCHITECTURE.md** — the ten-law constitution binding all future developer agents; both AGENTS.md levels point at it.

### Changed

- **Fleet UI is registry-driven (Law 9).** The ambient fleet widget and the `/delegate-fleet` overlay render from the fleet registry read-model (`snapshot()`/`tree()`/`subscribe()`) instead of each running its own `manifestStore` scan + `listStatuses` poll; the widget additionally refreshes on the registry's advisory events. Row assembly is one implementation (`buildWorkerViewsFromSource` → `buildWidgetRows`); liveness comes from the registry's status poll (a `retiredAt` worker reads done — console closed). Advisory invariants unchanged (failed reads keep the last snapshot; spawn/collect untouched); ownership glyphs, fold, mega-fold and width clamps unchanged. The shared text helpers moved to the leaf `src/ui-text.ts` (one implementation for widget, overlay and detail pane). Regression: `test/fleet-source-check.ts` (registry↔legacy parity, event-driven refresh, degradation, dispose teardown).
- **placementRef-only seam (Law 4).** `workspaceId`/`paneId` are now optional compatibility fields on `Placement`; `placementRef` is the only required handle — a second backend (tmux) no longer must fake herdr-shaped ids. Parity pinned by `test/host-parity-check.ts`.
- **Decomposition to layout v3 (Law 5).** The exchange/observe/spawn god-modules split into single-responsibility modules (archive, manifest-store, report-schema, mailbox-store, watch-store; watch-config, watch-detect, watcher, watch-retire, status-tool, commands; tool-result, clock, grace, mailbox-tool) with the duplicate helper clusters deduplicated (fs-probe, text-cap, one mailbox-state reader, one audit sink). Verbatim moves; the user-visible surface (tool names, params, commands, E_* codes) is unchanged.
- **Cheaper watcher tick.** Satellite stamp layers are mtime-cached per mount and the session-JSONL tail parse is fingerprint-gated — no more up-to-1MB re-reads per worker per tick. Regression: `test/watch-tick-cost-check.ts`.
- **Release machinery.** Both CI workflows run the deterministic `test/run-checks.sh` (no silent `|| bun test` fallback), a changelog-section PR gate, a release-run concurrency group, and a pinned bun version.
- **typebox moved to peerDependencies** per pi's packaging contract.
- **Single-sourced skill (Law 9).** The stale repo-root `pi/skills/delegate` copy is deleted; both install layouts load the extension's copy.

### Changed (restored 2026-09-21 — shipped with 1.17.0; misplaced out of this section during the release edit)

### Changed

- **Herdr vocabulary retired in favor of backend-neutral terms.** The worker's
  output/readback surface is now the **worker console**: the transport seam method
  `readPane` is `readConsole`, and prose, guidance strings and comments say
  "console read", "console readback" and "Worker console not at prompt". The
  shared-checkout placement is now **shared placement**: the `delegate` tool's `mode`
  parameter accepts `"shared"` — "placement in the shared checkout without
  isolation" — and the existing `"tab"` value keeps working as a deprecated alias,
  normalized to the same placement (the on-disk manifest `kind` value stays `"tab"`,
  frozen while older sessions read those manifests). The herdr-shaped legacy id
  fields keep their names and are described as "legacy alternate id
  (herdr-shaped)"; consumers keep preferring `placementRef`. The herdr backend itself
  is untouched: herdr CLI strings, the JSON field names parsed from herdr output,
  manifest `kind` values, journal event names, tool names/params, the
  `not_linked_worktree` token and every `E_*` error code stay byte-identical.

- **An orchestrator session running in a directory where a worker once ran
  again receives wake-ups (stage C mount-gate fix).** The mount gate
  (`isWorkerSession`) used to classify any session whose cwd equals a worker
  entry's `placement.checkoutPath` as that worker — so a fresh orchestrator
  started in a worktree where an earlier worker had run silently mounted no
  watcher and lost every child wake-up (reproduced in live acceptance
  testing). Worker identity on the mount side is now proven ONLY by the
  entry's own `sessionPath` (the worker session's JSONL path); the
  checkoutPath === cwd branch is removed as ambiguous by construction (shared-
  placement workers always share the orchestrator's checkout, and a historical entry
  poisoned the gate for every future session in that cwd). Unproven reads as
  "not a worker" and the session mounts — safe because delivery stays
  fail-closed (watcher stage A): a mounted watcher without a proven identity
  never produces a wrong wake. Consequences of the same fix: the in-loop
  self/leaf-worker suppression also matches by sessionPath only, and a
  degraded tier-1 lead (unreadable session id) now mounts a watcher but
  still wakes for nothing (the fail-closed edge lives on the delivery side,
  guideline §3.6).

- **A worker that ends without a report is now reported explicitly (watcher
  stage C — explicit result-plane states).** The `worker-dead` wake now also
  fires for a worker that SETTLED (done/idle, still known to herdr) without
  ever writing a report — previously that state was silent; only the
  gone-from-host shape woke anyone. Both shapes name the missing report and
  the failed-spawn move, carry the same launch-stamp episode fingerprint, and
  are committed to the durable delivery store like every other kind. The
  missing-report branch is deliberately not silenced by the `collectedAt`
  stamp (that stamp suppresses only the report-branch wake-ups). A corrupt
  `q-<name>.json` mailbox file (exists but is not valid JSON or not a question
  envelope) is now audited in the watcher log with its cause instead of being
  silently treated as "no question" — it still produces no wake-up and is
  never masked as a report event. No ownership or delivery behavior changed:
  unreliable result files never widen the wake-up audience.
- **Watcher wake-up delivery now survives a session restart (watcher stage
  B — durable delivery store).** The delivered-facts dedup left the memory of
  one watcher mount: each audience session commits its delivery records to
  `delivered-<key>.json` in the task directory (one file per session per
  task dir, atomic write, tolerant read) and only AFTER a successful
  wake-up send — a failed send never touches the disk, and a failed durable
  write is not a failed delivery (an audit line notes the possible repeat
  after a restart). Repeated wake-ups on the same files after a session
  restart are therefore gone. A report the collect tool already accepted
  (the manifest `collectedAt` stamp) still never produces a delivery record
  — the store holds only really-sent wakes. Emergency rollback to the
  memory-only dedup without a new version: `watch.durableDelivery: false`
  (default true; a non-boolean value warns once and stays true). One-time
  behavior on upgrade: the first run on a RESUMED session may emit a single
  volley of repeated wake-ups — the store starts empty and is never seeded
  (seeding would guess what was delivered; the volley is bounded by the
  ownership gate and the 24 h lookback). On a shared machine, updated and
  not-yet-updated sessions behave differently until all are updated.
- **Watcher wake-up delivery is fail-closed by default (watcher stage A).**
  A manifest with no owner fields anywhere (legacy) no longer delivers
  wake-ups to every mounted watcher; only a proven owner session is woken.
  The single rollback is the explicit config key `watch.legacyFailOpen:
  true`, which restores the old legacy delivery and is unsafe on a machine
  with several sessions (bystander wakes return). A session that cannot read
  its own identity delivers nothing unconditionally — this edge has no
  configuration escape. Skipped deliveries are recorded in the watcher audit
  file (`~/.pi/agent/delegate-watch.log`) with the reason; a spawn that
  could not record an owner path warns the orchestrator explicitly.

### Fixed

- **Google-model-breaking enum parameter shape:** tool enums use `StringEnum` instead of `Type.Union` of literals.
- **Hardcoded `~/.pi/agent` paths** (7 sites) replaced by pi's `getAgentDir()`/`CONFIG_DIR_NAME` exports, with a static pin banning literal joins.
- **Double-delivery bug class closed:** accept-then-log delivery classification ("accepted by pi" counts as delivered; rollback only for genuine pre-delivery failures — `test/watcher-check.ts` W19) and the watcher-vs-collect `collectedAt` race (report wake dropped when the stamp lands between snapshot and send — W20).
- **Lying contracts corrected** (seam module header, fleet stale fail-open paragraph); six production TypeScript errors resolved; `tsc --noEmit` is now a gate; both commands guard dialog/notify calls with `ctx.hasUI`.
- **Silent-catch residue surfaced:** archive failures carry a reason, start-failure manifest-rollback failures are logged, audit-append failures are counted. Regression: `test/silent-catch-check.ts`.
- **False worker-dead for worker-orchestrators:** a worker that ended its turn while its own fleet was still running was classified "settled with no report", causing retries and E_NAME collisions; now the parent watcher sees the in-flight fleet and gets an honest `fleet-in-flight` state instead. Regression: `test/watcher-check.ts` (new block).
- **Schema-violating reports self-heal:** a report rejected at collect (e.g. `status: "done"`) no longer forces a full re-spawn — the watcher automatically posts a fix steer (the exact validator error) to a live worker, which rewrites the report in place; the report-invalid guidance is cheapest-first (steer first, re-spawn only if the worker is gone) and the spawn prompt carries a status anti-example. Regression: `test/watcher-check.ts` (+ auto-nudge block), `test/report-contract-check.ts` (prompt pin).

### Windows path support

- **Windows default exchange root.** On Windows the default exchange root is now
  `%LOCALAPPDATA%\pi\exchange` (fallback `homedir()\AppData\Local\pi\exchange`); the
  `PI_DELEGATE_EXCHANGE_ROOT` environment variable overrides it (absolute path). The
  POSIX default `/tmp/exchange` is unchanged in this release.
- **Single portable path builder.** Every exchange-layer path (manifest, brief, report,
  mailbox, probe dir, teardown log) is assembled through the platform-aware builder
  `src/expaths.ts` (`node:path`, injectable in tests) — no more mixed-separator paths
  from raw `/` template literals. POSIX output stays byte-identical to previous
  releases.
- **No spurious `E_BRIEF` on Windows.** Brief validation (`ensureExchangeDir`) compares
  directories case- and separator-stable on Windows (`c:\…` vs `C:\…`, `/` vs `\`);
  POSIX comparison remains exact.
- **Windows-correct classification and ownership.** Fleet grouping slugs and probe-dir
  classification are separator-agnostic; the session-owner compare
  (`sameSessionPath`, `src/watch-role.ts`) folds case and separators on Windows only —
  a case-differing POSIX path still reads as foreign.
- **herdr adapter on Windows.** Worktree containment uses a segment-aware compare;
  the Windows CLI launch policy is `cmd.exe /d /s /c` with per-argument quoting and
  `windowsHide`; kill escalation on Windows is `taskkill /pid … /T /F`. The POSIX
  SIGTERM→SIGKILL escalation is unchanged.
- **Scope note.** Windows-shaped tests (path.win32 fixtures) run on the POSIX CI; a
  real-Windows E2E run is not part of CI — it stays an explicit manual QA gate. The
  exchange/path layer is Windows-portable in 1.17.0; running the host backend on Windows
  requires herdr for Windows.

### Removed

- **DESIGN.md** — the frozen historical design log (v1 → v1.17.0) — removed from the repo and the npm package; decision history lives in git.


## [1.16.1] — 2026-09-11

### Changed

- Migration stage 1 (architecture-audit steps 1–4, behavior-preserving hardening):
  - Shared conventions extracted to exported constants: staleness threshold
    (duplicate copies in observe.ts and fleet.ts replaced by one import),
    config path, probes directory, teardown journal format, repeat-mandate text.
  - Error codes are now carried on typed error objects instead of being parsed
    from message text; new codes for teardown failure and status-read failure;
    guidance hints produced by a single factory with adapter-supplied detail.
  - Teardown results carry a structured `alreadyGone` field — closing an
    absent worker is no longer an error; regex-based "not found" detection
    removed; adapter parity check extended to cover the new field.

## [1.16.0] — 2026-09-10

### Changed

- **WorkerHost inversion (migration complete)**: the herdr boundary is now a
  backend-neutral seam (`src/host.ts`, type name `Transport` kept) plus a
  herdr adapter (`src/herdr/host.ts`) bound once in `index.ts` from the
  config's `"host"` key (default `herdr`; unknown value → structured error).
  The `src/transport.ts` re-export shim is deleted. Zero behavior change on
  the herdr path; the in-memory fake (`src/host/fake.ts`) ships as the
  second adapter (PoC promoted).
- **Opaque `placementRef` threading**: `StartReq` is keyed by an
  adapter-defined `placementRef` (herdr ids left the seam read model —
  `AgentStatus` is `{name, status, placementRef?}`); spawn manifest
  dedup/rollback matches on name+placementRef with a legacy-paneId fallback;
  the retire closeability gate is ref-aware.
- **Neutralized texts**: all 19 model/user-facing herdr-specific command
  names in tool descriptions, event messages and error guidance replaced
  with backend-neutral phrasing (retry/mailbox/escalation semantics
  unchanged); herdr CLI recipes stay inside adapter error messages.
- **Watcher log UX**: routine watcher bookkeeping (e.g. retire successes) no
  longer surfaces in the pane — every line goes to the audit file
  `~/.pi/agent/delegate-watch.log`; the pane shows only errors and anomalies.

### Fixed

- **Duplicate report-ready wake-ups (true defect, diag D1)**: the watcher's
  dedup state reset treated a no-observation tick (transient report ENOENT)
  as "condition stopped being true" and forgot fingerprinted seen-keys —
  the same report fired twice with an UNCHANGED mtime. Fingerprinted kinds
  keep their key until the worker vanishes or the fingerprint changes
  (regression: W16.16).
- **Foreign-fleet wake broadcast narrowed (diag B1)**: the ownership gate
  consults the manifest-level `masterSessionPath` when a worker entry lacks
  `orchestratorSessionPath` — a known foreign owner stays silent; fail-open
  remains only for manifests with no owner field anywhere (W14.18–W14.23).
- **Archive-at-retire**: a TTL auto-retire of an UNCOLLECTED worker no
  longer orphans its report — retirePass archives the report + manifest
  snapshot before teardown (idempotent; retire-check R7).
- **herdr tab-id drift (implement-osb field report)**: herdr renamed the
  tab-create result key `tab.id` → `tab.tab_id`; the parser missed the new
  spelling and recorded the PANE id as `tabId`, so every autonomous tab close
  failed `tab_not_found` while the agent stayed alive (the paneId fallback
  also masked the failure as an idempotent retire). The parser now reads the
  current spelling (legacy accepted), `AgentStatus` carried `tabId` during
  the transition, and teardown re-resolves the live tab id from the herdr
  registry when the recorded one carries the broken paneId-fallback signature.
- **Worktree teardown idempotency (parity-pin find)**: a SECOND teardown of
  an already-removed worktree failed E_PLACE with herdr
  `workspace_not_found`; the seam contract (and the fake, and the tool
  layer's already-gone handling) requires a no-op success. Not-found-shaped
  removal errors are now idempotent in the herdr adapter.
- **`/delegate-teardown` output**: manifest history entries (retired workers
  are never deleted) are skipped with a count instead of being attempted —
  no more wall of `tab_not_found` errors for long-closed workers; a
  not-found close inside the command is a clean "already closed, no-op".
- **Stale nudge-failed marker**: a same-name retry deletes any leftover
  marker at spawn (a fresh watcher session would re-fire it once).
- **Fixture hygiene / manifest scan backend gate** (field lesson
  2026-09-10): a test manifest written into the live /tmp/exchange root
  woke a bystander orchestrator through the fail-open legacy scan. The scan
  now drops entries whose placement declares a non-empty backend other than
  the active host; the exchange root is overridable via
  `$PI_DELEGATE_EXCHANGE_ROOT` and all test fixtures sandbox under mkdtemp
  dirs.
- Root `package.json` version synced to the extension's (1.15.1 divergence).

### Added

- **F6 — two-tier delegation wake-up**: a session that is a worker of a parent
  manifest AND the orchestrator of its own child manifests (a tier-1 lead)
  now mounts a watcher scoped to ITS OWN children — tier-2 report-ready/
  mailbox-question wakes the lead without meta-orchestrator nudges. The
  pre-existing `createWatcher` leafWorker mute is scoped the same way.
- **Mailbox nudge resilience**: the answer/steer pane nudge retries with
  backoff (3 attempts); on repeated failure a watcher-visible
  `nudge-failed-<name>.json` marker delivers the wake-up on the next tick
  instead of the socket (kind `nudge-failed`, fingerprint = marker ts).
- **Trunk-based development + CI**: PR-gated squash-only flow (AGENTS.md);
  GitHub Actions — `ci.yml` (bun check suite + package.json version sync on
  every PR) and `release.yml` (on main: rerun suite → semver tag → GitHub
  Release with notes from the fresh CHANGELOG section).
- **host-parity pin** (`test/host-parity-check.ts`): one place → manifest →
  teardown flow asserted on BOTH adapters — fake always (CI), real herdr
  behind the existing `herdr --version` skip guard.
- Static pins re-targeted after the split: T1.1d (the seam imports node
  builtins only), T1.1c positive pin (only index.ts imports the adapter).

### Fixed

- **herdr tab-id drift (implement-osb field report)**: herdr renamed the
  tab-create result key `tab.id` → `tab.tab_id`; the parser missed the new
  spelling and recorded the PANE id as `tabId`, so every autonomous tab close
  failed `tab_not_found` while the agent stayed alive (the paneId fallback
  also masked the failure as an idempotent retire). The parser now reads the
  current spelling (legacy accepted), `AgentStatus` carries `tabId`, and
  teardown re-resolves the live tab id from the herdr registry when the
  recorded one carries the broken paneId-fallback signature.
- **Retire pass idempotency**: a herdr "not found" during the autonomous
  close (pane already gone) is treated as a successful retire — no more
  `tab_not_found` error spam every tick; genuine teardown failures keep the
  advisory retry.
- **`/delegate-teardown` output**: manifest history entries (retired workers
  are never deleted) are skipped with a count instead of being attempted —
  the command no longer prints a wall of `tab_not_found` errors for
  long-closed workers; a not-found close inside the command is a clean
  "already closed, no-op" success (parity with the retire pass).
- **Stale nudge-failed marker**: a same-name retry deletes any leftover
  marker at spawn (a fresh watcher session would re-fire it once).
- `nudgeFailedPathFor`/`readNudgeFailedMarker` moved to `exchange.ts`
  (module boundary — exchange-dir conventions live there).
- Root `package.json` version synced to the extension's (1.15.1 divergence).
- Legacy fail-open ownership for worker-orchestrators is pinned by tests
  (W16.14/W16.15) — a deliberate policy, now a conscious one.

### Changed

- README rebuilt bilingual (EN/RU) with header cross-links; the field case
  study and client identifiers removed from the public surface (NDA scrub).
- **Watcher log UX**: routine watcher bookkeeping (e.g. routine retire
  successes) no longer surfaces in the pane — every line goes to the audit
  file `~/.pi/agent/delegate-watch.log`; the pane shows only errors and
  anomalies (close failures, "pane was already gone").

## [1.15.0] — 2026-09-09

### Added

- **Fleet usage accounting (F1)** — persistent per-task accounting for every
  delegate fleet: total output tokens, prompt-cache hits, sent volume (input-
  token proxy), worker count; a fleet description (3–10 words, derived once
  from the first brief of the task) and a link to the master orchestrator's
  session log (`masterSessionPath`) are stored in the task manifest and never
  overwritten. Aggregates are recomputed from worker session files on read
  (cached snapshot in the manifest with `computedAt`); missing or corrupt
  session files yield partial totals with a marker instead of an error.

#### How to use fleet usage accounting

After a fleet has run, call `delegate_status` (or `/delegate-fleet`) — each
task dir now prints one aggregate line after the per-worker rows:

```
fleet rng-sum "delegate random number summation": ↓1.2k out · cache 840 · sent 3.1k · 8 workers
```

`↓out` = total output tokens, `cache` = prompt-cache reads, `sent` = input-
token proxy for data sent. `[partial: …]` names workers whose session files
were missing/corrupt. Totals are read-only — no config needed; the numbers
live in the task's `manifest.json` (`usage` section) and survive restarts.

### Changed

- **Layout v2: 7 flat modules** — the src/{tools,transport,ui} taxonomy is
gone; src/ is now `index.ts` (wiring only) + `spawn.ts` (delegate+mailbox
pipeline), `observe.ts` (status tool, watcher, config), `fleet.ts` (all
UI + ownership + worker views), `exchange.ts` (report/manifest/mailbox
lifecycle + archive), `transport.ts` (herdr boundary, E_* taxonomy),
`usage.ts` (unchanged). Every module opens with a ZCS MODULE_CONTRACT
header naming the invariants it owns (DESIGN.md "layout v2").

### Fixed

- **Report-contract precedence** — the injected report contract now
explicitly overrides a conflicting brief OUTPUT section (rng-sum incident:
a worker wrote `{"number": 6}` and failed schema validation).
- **Retriable E_REPORT_INVALID/E_REPORT_MISSING** — retry guidance now
mandates a NEW suffixed worker name (`<name>-r2`); the original name stays
taken by the settled agent.
- **Phantom manifest entries** — a refused spawn (E_START) no longer leaves a
manifest entry without `sessionPath` (rollback in the startAgent catch,
append-before-start teardown invariant preserved).
- **Mailbox reaches Done workers** — `delegate_mailbox` steer/answer now
wakes a settled worker via a new turn instead of silently dropping the
mail; honest no-op warning for unknown status.
- **`reportSchema` echo** — a brief-declared report JSON Schema is echoed
into the worker prompt, so workers write against the schema they are
validated against.
- **§23 retire (opt-in)** — auto-teardown of drained worker panes, disabled
by default: enable `watch.retire: true` (+ `watch.retireTtlMs`, default
900000); off by default, behavior unchanged when off.
- **Portable worktree paths** — `WORKTREE_DIR` resolved via `os.homedir()`
instead of a hardcoded `/root/...`; new static check bans `/root/` literals
in src/.

### Tests

- Regression pins for all four fixes above (red/green proven), new
`fleet-usage-check.ts` (21 checks), `mailbox-check.ts` (17), retire
R1–R6 matrix; 14 runnable suites + tsc green.

## [1.14.2] — 2026-09-08

### Fixed

- **No more duplicate `report-ready` wake-ups across session restarts** —
  field incident (2026-09-08): an orchestrator
  verified a landed report WITHOUT a formal collect (manual read + commit
  verification), so no `collectedAt` was ever stamped; every session restart
  re-fired report-ready for the same accepted report — the watcher's `seen`
  dedup is session-scoped memory, and the gap is cross-session. Fix in
  `src/watch.ts` + `src/exchange.ts` (DESIGN.md §21):
  - New manifest field `notifiedReportMtime` (stringified report mtimeMs):
    after a SUCCESSFUL batch send the watcher stamps the delivered report
    fingerprint into the manifest worker. The watcher — reader of every other
    manifest field — becomes a writer of exactly this one; `collect` leaves it
    untouched.
  - Detection gates `report-ready`/`report-invalid` on
    `String(reportMtime) !== notifiedReportMtime` alongside the `collectedAt`
    gate: a fresh session no longer re-wakes on an already-announced report.
  - Fingerprint-keyed, so a REWRITTEN report (new mtime) re-arms normally;
    `collectedAt` still outranks (collected reports stay silent regardless).
  - Advisory by contract: stamping is mutation-queue-serialized, idempotent,
    failure-logged and swallowed (can only cost a duplicate wake, never a
    lost one); a FAILED delivery stamps nothing — the batch re-fires while
    still true.
- **Tests**: new `test/watcher-notify-check.ts` (N1–N8, 17 checks): fire →
  stamp → fresh-session silence, rewritten-report re-arm, collectedAt
  precedence, failed-delivery rollback, mixed-batch stamping (question +
  report), report-invalid symmetry. Verified live against the incident
  manifest: tick 1 wakes and stamps, a fresh-session tick stays silent.

## [1.14.1] — 2026-09-07

### Fixed

- **Skill no longer pulls the orchestrator into the manual herdr ritual** —
  field: asking the model to delegate sometimes loaded the skill and followed
  REFERENCE.md's manual herdr CLI spawn ritual instead of calling the
  `delegate` tool. Two causes fixed in `pi/skills/delegate`:
  - REFERENCE.md carried skill frontmatter with the same aggressive trigger
    description — a competing pseudo-skill whose body IS the manual ritual;
    frontmatter removed (it is a sub-doc, not a skill).
  - SKILL.md buried the tool-first rule mid-paragraph; now a non-negotiable
    lead rule: tool in the tool list → the ONLY spawn/collect path; the
    ritual is for sessions where the extension is missing; topologies and
    anti-patterns stay valid reading. E_TIMEOUT row updated to the v1.14
    watcher discipline (end turn, watcher wakes).

### Added

- **Bundle manifest** — the repo root is now an installable pi package
  (`pi.extensions` + `pi.skills`): pi-delegate extension and the delegate
  skill ship together from one source of truth. The loose copies under
  `~/.pi/agent/{extensions,skills}` are retired to
  `delegate-archive/*-prebundle`; `pi install git:github.com/Evreke/ai-sandbox`
  (or the local path) replaces manual syncing.

## [1.14.0] — 2026-09-07

### Added

- **Early release on started worker (`watch.releaseOn: "started"`)** — field
  (delegate tab obpl-fix/calc-fix, 2026-09-07): the delegate call blocked the
  full settle gate even after the worker was already observed working — the
  orchestrator sat parked for 15–20 s per fan-out while the only remaining
  outcome was the §21 handoff. New `watch.releaseOn` config (values `settle`
  default / `started`) plus a per-call `releaseOn` param: once `waitSettle`
  observes the worker working, the call returns a success-shaped
  "orchestrator released" result (`startedConfirmed: true`) and the
  end-your-turn discipline applies immediately. Spawn failures are still
  caught (they precede the first working observation); fast inline settles
  (within one wait slice) still return the report synchronously; probes are
  exempt — their full window IS the verdict. DESIGN.md §20.5/§22.

## [1.13.0] — 2026-09-07

### Added

- **Fleet overlay self-describing fold + stale ordering + legend parity
  (fleet-UX wave 4)** — read-only-display fixes from the verified UX
  investigation (report-lex/report-act/report-pulse); DESIGN.md §15/§22.3:
  - **Self-describing folded lines** (report-lex fix 1): the folded grammar
    `~ owner.slug xN -- L B ! Q v s` (memorization burden 11) is retired for
    `~ <class> <slug> · N workers · counts… · idle <age>` — class token
    space-separated from the slug (the dot-join read as a hostname), no bare
    `xN`, no `--` separator, no letter flags; counts are words (live /
    blocked / hot-ctx (≥CONTEXT_WARN_PCT) / question / rep), non-zero only,
    old flag order. Identity (class + slug + worker count) LEADS the line so
    fitRow's left-to-right degrade keeps it under width pressure. Mega-line
    uses the same vocabulary, stays one line, mixed tag stays truthful
    (`foreign+owner?`).
  - **Stale age tail with ownership-scoped remedy** (report-lex fix 2 ∘
    report-act fix 3): the `s` letter's exact condition (isFleetStale —
    every member collected ≥30 min, semantics unchanged) now renders as
    `idle <age>` carrying the OLDEST member's collectedAt age (`31m`,
    `3h46m`); no stamp → no tail. Remedy is scoped: mine groups read
    `… (/delegate-teardown)`, foreign/`owner?` groups read `… · owner can
    tear down` — the global sweep is never advertised to bystanders.
  - **Foreign-fleet framing line** (report-act fix 1): when any
    foreign/`owner?` group is on screen, one dim legend line states the
    viewer's role: `○ ◌ = another session's fleet — informational; only its
    owner can act` (affirms the §22 canon).
  - **Legend parity** (report-lex fix 3): FLAT legend gains keys for tokens
    its surface renders but never explained — `owner?` untraceable, the `—`
    probe dash, `├└ group`, `↑↓ in/out`. FOLD legend becomes a one-line
    WORKED EXAMPLE of the new grammar plus a minimal key (live=working/
    blocked · rep=report landed · idle=collected ≥30m). Each legend packs
    greedily into at most two physical dim lines (`packLegend`, one when it
    fits).
  - **Stale-aware ordering + window trim** (report-pulse fix 2): ONE new
    `rankGroups` tiebreak layer — fully-stale groups sort below
    otherwise-equal groups (after class rank, before slug); in the height
    window, fresh blocks fill first and fully-stale blocks are admitted
    only after every fresh block is shown, so a live (working/blocked) row
    is never hidden while a stale-group row is visible. Group-atomic
    guarantee kept; NO admission changes — every manifest worker still
    renders (archived tier explicitly out of scope).

### Changed

- Expanded MY flat rows are byte-identical (verified against the regenerated
  goldens); widget (fleet-ui.ts), watch.ts, commands.ts, tools/* untouched.
  Chrome grows by up to 2 lines (second legend line + framing), shrinking
  the height window accordingly; window goldens moved to terminalRows 12.

### Tests

- `test/fleet-tree-check.ts`: folded-grammar expectations updated to the new
  grammar (H3–H5, G3b, S2–S5, W2b) and new cases added — W5 age formatting,
  W6 mine-vs-foreign remedy scoping, W7/W7b stale ordering tiebreak (and
  class-rank precedence), W8/W8b/W8c stale-aware trim priority, W9–W9e
  legend parity + framing line + packLegend two-line cap. All goldens
  deliberately regenerated (the diff is the review artifact).
- All check scripts green except `transport-contract` (known env-broken:
  live herdr spawn — unchanged).

## [1.12.1] — 2026-09-07

### Added

- **Lifecycle hygiene — teardown-after-collect + `worker-stale` + fleet `s`
  flag (fleet-UX wave 3; user decisions locked: default ON, grace 0, only on
  VALID collect, foreign fleets never mutated)** — DESIGN.md §22:
  - **Teardown-after-collect** (`delegate` tool): after a successful strict
    collect (report valid, `collectedAt` stamped) the worker is torn down
    automatically via the transport with its recorded placement. Skips:
    probes (panes stay this wave), `collect.teardownAfterCollect: false`, and
    a pending `q-<name>.json` (the worker is still in a conversation).
    Invalid/failed collects never reach the hook (the pane is needed for
    diagnose). **Advisory by contract**: the hook can only append a note —
    `Auto-teardown: …` or `Warning: … collect unaffected` — to the already-
    decided result; no failure alters a collect outcome or throws past the
    tool boundary. Audit lines mirror the `/delegate-teardown` format into
    the same `<dir>/teardown.log`, suffixed `(auto-after-collect)`.
  - **`resolveCollectConfig`** (`src/watch.ts`, beside `resolveWatchConfig`):
    `collect.teardownAfterCollect`, default **true**, tolerant — missing/
    corrupt/non-boolean → default, never throws.
  - **`worker-stale` watcher event** (§21 union): manifest `collectedAt`
    older than `watch.staleAfterMs` (new key, default 30 min, floor 60 s) and
    the worker still live → "collected N min ago and still mounted — tear it
    down (/delegate-teardown) or keep". Fingerprint = `collectedAt` (a
    re-collect re-arms); silent when not live / herdr unreachable / stamp
    unparseable; the ownership gate already silences foreign fleets and is
    not bypassed. `startWatcher` threads the config threshold.
  - **`s` flag in the fleet overlay** (folded group grammar): appended after
    `L B ! Q v`, non-zero-only, = EVERY member collected ≥30 min ago
    (stale-idle; one fresh member suppresses the group claim). Pure
    `isFleetStale` + injectable render clock; shares the watcher's 30-min
    default; legend gains `s stale`; no new fs reads (rides the manifest the
    overlay already reads). Widget untouched.

### Tests

- New `test/collect-teardown-check.ts` + `collect-teardown-driver.ts`: the
  C1 config matrix, C2 valid → torn down exactly once / invalid / q-pending /
  probe / teardown-throws → collect still succeeds (real `execute()` over a
  mock transport, child-process `$HOME`), C3 config-off, C4 static pins
  (guard order, advisory shape, commands.ts audit mirror).
- `watcher-check.ts`: W15 (fires once, re-arms on re-collect, suppressions,
  foreign-owner silence, key fingerprint, threshold config W2.8–W2.10).
- `fleet-tree-check.ts`: S1–S6 (`s` threshold matrix, every-member rule,
  flag order, mega threading) + folded goldens regenerated for the `s stale`
  legend + V11/V12 `s`-flag goldens (fixed clock).
- All check scripts green except `transport-contract` (known env-broken:
  live herdr spawn — unchanged).

## [1.12.0] — 2026-09-07

### Added

- **Ownership display — fleet-UX stage 1 (glyph + attention-gated fold +
  fitter fix)**: /tmp/exchange manifests are cross-session, so both fleet
  surfaces now say whose workers they are showing. Variant A "Glyph & fold"
  from the fleet-UX design wave (report-ux-own.json), widget policy per user
  decision (attention-gated):
  - **classifyOwnership** (new `src/ownership.ts`, pure): manifest
    `orchestratorSessionPath` === this session's `getSessionFile()` → mine;
    present+different → foreign; absent/empty (legacy manifest) → UNKNOWN.
    Degraded self-id falls back to the worktree `checkoutPath === cwd` match
    (mirrors watch.ts isSelf); tab workers are NEVER matched by cwd. Display
    is FAIL-CLOSED — unknown never renders as mine (deliberate asymmetry vs
    the watcher's fail-open).
  - **Overlay** (`/delegate-fleet`): the row's lead space became an ownership
    glyph column — ● mine (accent), ○ foreign (muted), ◌ legacy (dim) — and
    the legend gained `● mine ○ foreign ◌ legacy`.
  - **Widget** (ambient live rows): MY live rows are byte-identical to
    before; foreign/legacy live workers fold into at most one line per class
    (≤2 total): `○ N foreign live (task1, task2)` / `◌ N legacy live (…)`.
    A class line appears ONLY when that class has a `blocked` worker or one
    at ≥80% context burn (CONTEXT_WARN_PCT) — a quiet foreign fleet renders
    NOTHING above the editor. No new fs reads.
  - **Fitter latent-bug fix**: `layoutFleetRows`' fixed cost ignored the
    double space before the usage column (15 → real 17) and now also carries
    the glyph column (+1 → 18, verified against the rendered row shape);
    floors and shrink priority unchanged. `test/fleet-render-check.ts`
    updated mechanically (rowTotalW helper, L2 expected branch width).
  - New tests: `test/ownership-check.ts` (classifyOwnership case matrix +
    fold-policy cases incl. the fixture-shaped no-line case and an all-mine
    byte-identical golden).
- **Task tree + Tab fold — fleet-UX stage 2 (overlay only)**:
  `/delegate-fleet` rows now group by task + owning session
  (`manifest.dir :: orchestratorSessionPath`, pure `groupWorkerViews`);
  legacy manifests fail open into a per-dir `owner?` bucket that is never
  labeled foreign. Foreign/unknown groups get a one-line dim header
  (`▼ prod-prep · 2/4 live · foreign · ctx↑63%` — ctx is the MAX burn
  across members, dropped when unknown) with `├`/`└` tree glyphs inline in
  the name column (fitter untouched), and fold BY DEFAULT to
  `~ foreign.prod-prep x4 -- L2 v2` (flags: L live, B blocked, ! ctx≥80,
  Q mail, v report; >6 groups collapse into one mega-line). Tab toggles
  fold/unfold (session-scoped memory, folded on first open, no-op when
  nothing is foldable; header hint swaps). Groups sort by their most
  actionable member (mine < owner? < foreign on ties, then slug) and the
  height window is group-atomic — a header never appears without its
  children. MY OWN rows render exactly as stage 1: flat, byte-identical.
  While folded the legend shows the flag key. Per-row ownership glyphs
  stay on every row. Widget untouched. New pure helpers unit-tested in
  `test/fleet-tree-check.ts` (group key, fail-open, two-session split,
  rank ties, flag matrix, fold state machine, pinned goldens at innerW
  58/78/98 folded+expanded, group-atomic window, exact innerW+2 line
  width regression, single-width glyphs).

## [1.11.1] — 2026-09-06

### Fixed

- **Watcher ownership — one orchestrator per wake-up** (two-layer fix, §21.1 F1):
  the watcher mounts into EVERY pi session, but manifests in /tmp/exchange are
  global — so (a) worker sessions received their orchestrator's
  "DELEGATE WATCHER — …" wake-ups and mounted their own redundant watchers, and
  (b) every mounted watcher delivered copies of events from OTHER orchestrators'
  tasks (N sessions = N copies). Now:
  - **Worker gate**: `isWorkerSession(self, manifests)` in `src/watch.ts` — a
    session that is itself a manifest worker (exact worker `sessionPath`, or a
    worktree `checkoutPath` — the `isSelf` strictness, no 24 h lookback) mounts
    NO watcher at `session_start` (`pruneArchive` still runs). Tolerant: garbage
    manifests read as "not a worker", never throw.
  - **Ownership by orchestrator session path**: spawn records
    `orchestratorSessionPath` (the LIVE `sessionManager.getSessionFile()` at
    manifest-write time — never a captured constant: /new and /resume change the
    path, and a new session inheriting no wake-ups is the desired behavior).
    `detectWorkerEvents` emits NOTHING for a worker whose recorded owner differs
    from the watcher's own session (`DetectOptions.selfSessionFile`, threaded
    from `WatcherDeps.self`). Fail-open on both edges: legacy manifests without
    the field and degraded self-ids keep the old behavior — a lost report-ready
    is worse than a duplicate. `collectedAt` logic, report validation, mailbox,
    settle and the `seen` dedup are untouched; the watcher remains a
    manifest-reader (spawn's own record write is unchanged as the only writer).
- **No re-wake on already-collected reports** (field fix): successful collect now
  stamps `collectedAt` (ISO) on the worker's manifest record (best-effort — a
  failure warns, never fails the collect). The watcher treats a `collectedAt`
  worker as delivered and emits no `report-ready`/`report-invalid` for it — the
  watcher's `seen` dedup lives only inside a session, so fresh sessions used to
  re-wake on reports collected in earlier ones (14 stale wake-ups observed in
  the field, v1.11.0 preprod run). Only collect writes the field; other event
  kinds are unaffected.
- **Archive retention**: `pruneArchive(maxAgeMs?)` in `src/archive.ts` deletes
  archived task dirs older than 30 days (folder mtime), best-effort, never
  throws; called once at watcher start (`session_start` in `index.ts`) so the
  archive stops growing without bound.

## [1.11.0] — 2026-09-06

### Added

- **Event-driven background watcher** (`src/watch.ts`, DESIGN.md §21): polls every
  `watch.intervalMs` (default 10 s), aggregates manifests + live herdr statuses +
  worker session JSONL, and wakes the idle orchestrator via
  `pi.sendUserMessage(..., { deliverAs: "followUp" })` when a worker needs attention.
  Five deduped event kinds: report-ready, report-invalid, mailbox-question,
  grill-deck (toolCall detected in the worker session), context-critical (≥ 90 %),
  worker-dead. Lifecycle mounted on `session_start` / stopped on `session_shutdown`;
  headless-safe; advisory-only (a watcher failure never affects spawn/collect).
- **Backlog section** (DESIGN.md §21.1): fleet scoping of wake-ups (F1),
  report-invalid mtime grace + brief schema (F2), teardown stops worker-dead (F3),
  dedup I/O cost (F5), pre-existing test type errors (P1).

### Changed

- **Spawn settle gate default 120 s → 15 s** (`watch.settleGateMs`, explicit
  `waitMs` still overrides; legacy `timeoutMs` keeps its 120 s cap). After
  detach the orchestrator ends its turn — the watcher wakes it; bash/python
  sleep is an acceptable fallback only when the watcher is unavailable
  (SKILL.md + tool texts updated, DESIGN.md §20.1 annotated).
- **Failed delivery re-fires**: event keys of a dropped batch are rolled back
  from the dedup set, so a transient send error can never permanently swallow
  a wake-up.
- **Dedup state reset**: keys of workers no longer present in any manifest are
  forgotten (code now matches the documented behavior).

### Fixed

- `test/static-check.ts`: `src/watch.ts` added to the canonical dependency-rule
  restricted list.
- `test/transport-contract.ts`: `subDir` hoisted above `try` — the `finally`
  cleanup `rmSync` actually runs now (was leaking temp dirs).

### Tests

- New `test/watcher-check.ts` (95 checks): event detection, dedup/fingerprints,
  reset, delivery rollback, config tolerance, self-mute, lifecycle.
- All pre-existing suites pass unchanged.
