# pi-delegate

**[English](#english)** · **[Русский](#русский)** · **[Examples](EXAMPLES.md)**

> **For the lead:** one operator commands a full AI team — built-in independent quality roles
> (research, review, QA, unbiased verification) plus your own roles in plain language, with
> your own order of work; you are woken only when a decision is yours.
> **For the engineer:** a pi extension that replaces the spawn-and-baby-sit ritual with one
> tool call — briefs, model tiers, strict reports, a file mailbox and an event-driven watcher.
>
> **Для руководителя:** один оператор командует целой командой AI — встроенные независимые
> роли качества (исследование, ревью, QA, непредвзятая верификация) плюс свои роли обычным
> языком, со своим порядком работ; будят вас только когда решение за вами.
> **Для инженера:** расширение для pi, которое заменяет ритуал «заспавнить и нянчить» одним
> вызовом инстру — брифы, тиры моделей, строгие отчёты, почтовый ящик и event-driven вотчер.

> [!WARNING]
> **Windows / PowerShell (не WSL):** в текущем релизе работа может быть нестабильна.
> **Windows / PowerShell (not WSL):** the current release may be unstable there.

---

## English

**pi-delegate** is a multi-agent orchestration harness for [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
It is not another subagent wrapper — it is the missing discipline: strict contracts instead of
hoping the model stays careful, code instead of a 100-line ritual the model must remember
from scratch every time.

### What it is

You stay the orchestrator: you describe the task, review briefs, verify reports, and own the
single merge gate. The extension owns the mechanics — one tool call replaces the entire
spawn-and-baby-sit ritual.

### Prerequisites

- [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — the host harness.
- A worker-host backend, selected by the config's `"host"` key:
  - `"herdr"` (default) — **herdr** on `PATH` is a hard requirement (`herdr --version` to check);
  - `"rpc"` — herdr-free: workers run as headless `pi --mode rpc` child processes of the
    orchestrator session (plain git worktrees for isolation; see the config section below).
- On Windows — herdr for Windows; beyond the exchange/path layer Windows is not certified.
- A configured model tier in `~/.pi/agent/pi-delegate.config.json` — see the
  [installation guide](#installation-guide); unconfigured → `E_TIER`.
- A brief file before each call — the orchestrator writes it; see [EXAMPLES.md](EXAMPLES.md).

Success is defined by the artifact, not by the agent's mood: a `delegate` call succeeds when
a **validated JSON report** is on disk — never when the agent status says done/idle.

### What you get

- **Blocking by default.** A `delegate` call blocks the orchestrator session until the
  worker settles, the settle gate expires (default `watch.settleGateMs` — 15 s, just enough
  to prove the worker started), or you abort. Long blocking is explicit opt-in (`waitMs`).
- **Abort (Esc) cancels the wait, not the worker.** The call detaches; the worker keeps
  running. Recover via `delegate_status`, the mailbox, or the background watcher — the
  report file stays the completion criterion.
- **Optional early release.** With `releaseOn: "started"` (config or per-call) the call
  returns as soon as the worker is proven started and working — control passes to the
  background watcher. That is "the spawn is proven", not "the task is collected": the
  validated report still ends the job.
- **Parallel fan-out = parallel tool calls.** Each call carries its own brief and
  collect discipline; parallelism never removes the per-call preparation.
- **Event-driven watcher.** You are woken only when attention is needed: report ready or
  invalid, mailbox question, worker blocked on an interactive deck, context critical (≥90%),
  worker died without a report, collected-but-still-mounted worker. No `sleep 1500`.
  The watcher is session-keyed: exactly one mount per session, and a second mount for the
  same session file is refused rather than silently replaced.
  Delivered facts are durable via the per-audience journal cursor
  (`cursor-<key>.json` in the task directory, fed by the fleet journal's
  `eventsAfter` read): a session restart does NOT re-wake you on already-delivered
  facts. Emergency rollback: `watch.durableDelivery: false`. One-time note: the first run
  after upgrading on a resumed session may produce a single volley of repeated wake-ups
  (bounded by ownership and the 24 h lookback) — the cursor starts at zero and is never
  seeded. The retired `delivered-*.json` files are inert leftovers, safe to delete.
- **File mailbox.** `q-<name>.json` / `a-<name>.json` — send follow-ups to a running worker
  or answer its questions without respawning it.
- **Strict reports.** The completion criterion is a **validated JSON report** with evidence
  (`file:line`), never a "done" status. Custom schemas via brief frontmatter, with
  `$extends` inheritance and a schema library.
- **Budgets & gauges.** Output-token caps per worker (`E_BUDGET` on breach), live `ctx%`
  and token counters, restart before compaction eats the worker.
- **Isolation.** Git worktree per worker (own checkout + branch) or shared placement
  (`mode: "shared"` — placement in the shared checkout without isolation; the older
  `mode: "tab"` spelling stays valid as a deprecated alias) — sub-orchestrators
  structurally cannot create worktrees.
- **Clean teardown.** Interactive `/delegate-teardown`, auto-cleanup after a collected
  report, full audit in `teardown.log`.
- **Honest errors.** Every refusal is a structured code with a recovery hint:
  `E_BRIEF`, `E_NAME`, `E_TIER`, `E_PLACE`, `E_START`, `E_TIMEOUT`, `E_BUDGET`, `E_CONTEXT`,
  `E_REPORT_MISSING`, `E_REPORT_INVALID`. Two result classes are control flow, not
  failures — `E_TIMEOUT` (the detach handoff: the worker keeps running and the watcher
  wakes you) and the awaiting-answer result (a pending mailbox question) — a deliberate,
  documented deviation from pi's throw convention (ARCHITECTURE.md, Law 8).
- **Capped tool output.** Tool returns that carry worker-written content are bounded by
  pi's truncation helpers: status listings show at most 100 rows (with an "N more omitted"
  note — the full list stays in the result details), and report summaries / mailbox
  bodies are truncated with a pointer to where the full copy lives.

### How it automates the routine

Preparing a fan-out is real orchestration work, and the tool contract reflects it. "One
word — delegate — and it all happens" is the human UX aspiration this project steers
toward, not the machine contract of the tool today. What a call actually requires:

1. the orchestrator decomposes the task and writes briefs per role;
2. workers spawn via parallel tool calls, each with its own brief and collect discipline
   (worktree-isolated, model-tiered: cheap `flash` for execution,
   `frontier` for review and synthesis);
3. you do something else — the watcher queues every signal and wakes you at the right moment;
4. clarifications go through the mailbox; a smoke-test probe can verify the environment
   before a big fan-out;
5. strict reports come back, workers are torn down, the fleet cleans up after itself.

Judgment stays with the model (decomposition, verification, merge); mechanics belong to code.

### One call, two manners: started vs settle

Think of it as delegation to a real team. You (the orchestrator) hand a task to a worker.
The only question is what you do right after handing it over: stand over their shoulder,
or go about your business.

- **`releaseOn: "started"` — the default: hand over the task and walk away.** The call waits
  only long enough to see the worker actually pick the task up (a couple of seconds).
  Then the call ends and the orchestrator is free; the watcher stands guard from there —
  it wakes the orchestrator the moment something needs a decision: the worker finished
  and filed its report, asked a question, got stuck, or died without delivering anything.
- **`releaseOn: "settle"` — opt-out: stand there until it is done.** The call blocks
  the orchestrator: it waits while the worker finishes (or until the wait limit expires —
  15 seconds by default). A short task comes back with its result right in the same turn,
  which is convenient. A long one outlives the limit — the watcher takes over and will
  wake you.
  only long enough to see the worker actually pick the task up (a couple of seconds).
  Then the call ends and the orchestrator is free; the watcher stands guard from there —
  it wakes the orchestrator the moment something needs a decision: the worker finished
  and filed its report, asked a question, got stuck, or died without delivering anything.

In practice: for short tasks, `settle` (the default) gives you the answer immediately,
without an extra wake-up; for big fan-outs of several parallel workers, `started` is what
you want — with `settle`, every call sits blocked for seconds doing nothing useful.

One thing neither mode changes: the success criterion. In both cases the job is done when
a valid report file lands on disk. The modes only decide how long the orchestrator stands
and waits before going back to its own work.

For user-level call examples — from toy to real-world — see [EXAMPLES.md](EXAMPLES.md).

### Operational notes

- **Task passport.** Every delegated run records a passport in the task manifest:
  the extension version that ran it (`version` in the result details and the
  `· pi-delegate vX.Y.Z` completion line), plus — for worktree placements only —
  the checkout's base commit and dirty-file list at spawn (`gitBase`, `gitStatus`)
  and a capped diff-plus-untracked summary stamped at collect (`gitDelta`). Tab
  placements are not stamped (a tab shares its checkout; a snapshot would falsely
  attribute others' edits to this run). The probes are advisory: probe errors never
  affect spawn or collect.
- **Exchange root — not a durable store.** The default location is `/tmp/exchange` on
  Linux/macOS (cleared on reboot) and `%LOCALAPPDATA%\pi\exchange` on Windows (fallback
  `homedir()\AppData\Local\pi\exchange`); the `PI_DELEGATE_EXCHANGE_ROOT` environment
  variable overrides it (absolute path). On a multi-user host it is a shared path (other
  users can read the manifests; task-slug collisions are possible). Brief paths use the
  native form of the running platform: `/tmp/exchange/<task>/brief-<name>.md` on
  Linux/macOS,
  `C:\Users\<you>\AppData\Local\pi\exchange\<task>\brief-<name>.md` on Windows.
- Collected reports are copied to `~/.pi/agent/delegate-archive/<task>/` (best-effort,
  30-day TTL) — that archive is the durable copy.
- Watcher wake-ups are scoped to the owning session via ownership metadata and are
  FAIL-CLOSED by default: a manifest with no owner fields anywhere (legacy) delivers
  nothing — no bystander session is woken for a foreign fleet. The only rollback is the
  explicit config `watch.legacyFailOpen: true`, which is unsafe on a machine with several
  sessions. A session that cannot read its own identity delivers nothing unconditionally
  (no config escape).
- Delivered wake-up facts survive a session restart via the per-audience journal
  cursor: each audience session commits its delivery records to `cursor-<key>.json` in
  the task directory (one file per session per task dir), fed by the fleet journal's
  `eventsAfter` read and written only after a successful send. Repeated wake-ups after a
  restart are therefore gone; the emergency rollback is `watch.durableDelivery: false`
  (back to memory-only dedup, no new version needed). On the first run after upgrading, a
  resumed session may emit a one-time volley of repeated wake-ups (the cursor starts at
  zero and is never seeded; the volley is bounded by the ownership gate and the 24 h
  lookback). The retired `delivered-*.json` files are inert leftovers — safe to delete.
  On a shared machine, updated and not-yet-updated sessions behave differently until all
  are updated.
- **Swarm read server (session-hosted, OFF by default).** Set
  `"swarm": { "server": { "enabled": true } }` in
  `~/.pi/agent/pi-delegate.config.json` (or export `SWARM_SERVER_ENABLED=1`)
  to mount a loopback read endpoint in every session:
  `http://127.0.0.1:7331/api/version` — plus `/api/swarm/snapshot`,
  `/api/swarm/events?after=<seq>` (the `swarm snapshot` / `swarm events`
  envelopes, verbatim, with live worker statuses folded in) and
  `ws://127.0.0.1:7331/api/swarm/stream?after=<seq>` (one snapshot frame,
  then journal events as they happen; reconnect with your last consumed
  `seq`). `swarm.server.port` (default 7331; `0` = OS-assigned) is a hint —
  if the port is taken, the session binds an OS-assigned port and logs the
  substitution. The server binds 127.0.0.1 only. Reads carry no auth (any
  local process can read); WRITES are operator-only and land under **#51**:
  `POST /api/workers/<id>/steer` and `POST /api/asks/<id>/answer` (body
  `{"text":"..."}`) require `Authorization: Bearer <operator token>`. The
  token is generated per mount and printed ONLY on the session's stderr as a
  structured `operator-token` line — copy it from the session UI. Writes only
  reach workers the session itself spawned (foreign/unknown ids refuse) and
  append the same `steer`/`answer` journal rows the tool path writes, with an
  additive `via: "http"`. The server is advisory — a startup failure or a
  failed write never blocks a session, spawn, or collect.
- **Windows: real-host QA gate.** A real-Windows E2E run (delegate spawn →
  report → wake → mailbox, with herdr for Windows) is NOT part of CI — only
  Windows-shaped path tests (`path.win32` fixtures) run on the POSIX CI. An
  operator must run this gate on a real Windows host before claiming Windows
  support beyond the exchange/path layer; until then the honest claim is "the
  exchange/path layer is Windows-portable; the host backend on Windows
  requires herdr for Windows".

### Installation guide

**Step 1 — prerequisites.**

- A working [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) installation.
- `herdr` on `PATH` (required when `"host"` is `"herdr"` — the default; the alternative
  `"host": "rpc"` backend needs no herdr at all). Check with `herdr --version`.

**Step 2 — install the extension.**

Copy or symlink this repository into pi's extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-delegate ~/.pi/agent/extensions/pi-delegate
# ... or: cp -r /path/to/pi-delegate ~/.pi/agent/extensions/pi-delegate
```

The directory name matters: pi loads each subdirectory of `~/.pi/agent/extensions/` as an
extension, and `pi-delegate` is the expected name.

**Step 3 — create the config file.**

Create `~/.pi/agent/pi-delegate.config.json`. There is **no built-in worker tier** — an
unconfigured environment refuses every `delegate` call with `E_TIER`. Replace the
`<PLACEHOLDER>` values with your provider, model and thinking level (the same values you
would pass to pi itself):

```json
{
  "defaults": {
    "tier": "flash",
    "budgetTokens": 150000
  },
  "tiers": {
    "flash": {
      "provider": "<PROVIDER>",
      "model": "<MODEL>",
      "thinking": "<THINKING>"
    },
    "frontier": {
      "provider": "<PROVIDER>",
      "model": "<MODEL>",
      "thinking": "<THINKING>"
    }
  },
  "watch": {
    "intervalMs": 10000,
    "settleGateMs": 15000,
    "releaseOn": "started"
  }
}
```

What each section does:

- `tiers` — named worker tiers (`provider` / `model` / `thinking` per tier). Calls select a
  tier by name (`tier: "flash"`); per-call `provider` / `model` / `thinking` params beat the
  tier, and the tier beats `defaults`.
- `defaults.tier` — the tier used when a call passes none.
- `defaults.budgetTokens` — the default output-token budget per worker (used only for
  accounting displays; hard enforcement requires an explicit `budgetTokens` per call).
- All keys are optional and the file is read tolerantly (missing/corrupt/partial →
  defaults), but with no resolvable tier/provider/model the delegate call fails with
  `E_TIER` — the placeholders above are the minimum you must fill in.
- Instead of (or in addition to) tiers you may pass `provider`, `model` and `thinking`
  explicitly on every `delegate` call.

Optional extras (all have safe defaults; see the operational notes above):

- **Profiles** — named config presets. Put a preset with the SAME shape as the
  base config (host / contextWindow / defaults / tiers / watch) into
  `~/.pi/agent/pi-delegate.d/<name>.json` and select it either by the
  `PI_DELEGATE_PROFILE` environment variable (per-terminal) or by the base
  config's `"profile": "<name>"` key (persistent); the env var wins. A section
  present in the profile replaces the base section WHOLESALE (no partial
  merging inside tiers/defaults/watch); sections absent from the profile fall
  through to the base. No profile selected → the base config as-is. A selected
  profile that is missing or unparseable is an error, never a silent fallback:
  delegate calls fail with a structured `E_START` naming the file (the
  watcher/fleet/status surfaces degrade to defaults instead — they are
  advisory). The host is bound once at session start: mid-session profile
  edits change tiers/defaults/budget/watch on the next delegate call, never
  the running backend.
- `"host": "herdr" | "rpc"` — the worker-host backend. `"herdr"` (default) places workers
  in herdr workspaces/panes and requires the herdr CLI. `"rpc"` runs workers as headless
  `pi --mode rpc` child processes of the orchestrator session — no herdr anywhere:
  worktree placement is a plain `git worktree add` under `~/.pi/agent/worktrees/`, prompts
  go over the worker's stdin, and settle is proven by pi's own `agent_settled` rpc event
  (no status polling). Known limitation: rpc workers live as long as the orchestrator
  process — after it exits they finish their current task and exit (stdin EOF), so a LATER
  session sees their reports/mailbox files but cannot nudge them.
- `watch` — watcher tuning: `intervalMs` (poll period, floor 1 s), `settleGateMs` (the
  default blocking window of a call, floor applies too) and `releaseOn` — `"started"`
  (default) releases the call as soon as the worker is proven started, handing control
  to the background watcher; `"settle"` (opt-out) blocks the full window unless the
  worker settles inline. The values shown are the defaults — the section may be omitted
  entirely.
- `"contextWindow": <number>` — override the worker context window used by the `ctx%`
  gauge when the model is not in the built-in table.
- Environment variable `PI_DELEGATE_EXCHANGE_ROOT` (absolute path) — relocate the exchange
  tree off the default `/tmp/exchange` (Linux/macOS) or
  `%LOCALAPPDATA%\pi\exchange` (Windows), e.g. for a durable or multi-user setup.

**Step 4 — start a session and verify.**

Start a pi session. A quick smoke test is a probe-style delegate call with a tiny brief in
the exchange layout (`/tmp/exchange/<task>/brief-<name>.md` on Linux/macOS). If the config
did not resolve, the call returns a structured error (`E_TIER`) with a recovery hint; if
`herdr` is missing while `"host"` is `"herdr"`, the tools refuse up front.

The `/delegate-teardown` command and the `delegate_status` tool become available
immediately after the session starts.

---

## Русский

**pi-delegate** — харнесс мультагентной оркестрации для [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
Это не очередной враппер над субагентами — это недостающая дисциплина: строгие контракты
вместо надежды на аккуратность модели, код вместо 100-строчного ритуала, который модель
должна каждый раз помнить с нуля.

### Что это

Вы — оркестратор: описываете задачу, проверяете брифы, верифицируете отчёты, держите
единственный мерж-гейт. Расширение владеет механикой — один вызов инструмента заменяет
весь ритуал «заспавнить и нянчить».

### Требования

- [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — харнесс, в котором живёт расширение.
- Бэкенд воркеров, выбирается ключом `"host"` в конфиге:
  - `"herdr"` (по умолчанию) — на `PATH` нужен **herdr** (проверка: `herdr --version`);
  - `"rpc"` — без herdr: воркеры — headless-процессы `pi --mode rpc`, дети сессии
    оркестратора (изоляция — обычные git worktrees; см. раздел про конфиг).
- На Windows — herdr for Windows; за пределами exchange/path-слоя Windows не
  сертифицирован.
- Настроенный тир модели в `~/.pi/agent/pi-delegate.config.json` — см. [инструкцию по
  установке](#инструкция-по-установке); не настроен → `E_TIER`.
- Файл-бриф перед каждым вызовом — его пишет оркестратор; см. [EXAMPLES.md](EXAMPLES.md).

Успех определяется артефактом, а не настроением агента: вызов `delegate` успешен, когда на
диске лежит **валидный JSON-отчёт**, — никогда не тогда, когда статус агента показывает
done/idle.

### Что это даёт

- **Блокирующий вызов по умолчанию.** Вызов `delegate` блокирует сессию оркестратора, пока
  воркер не осядет, не истечёт settle-гейт (по умолчанию `watch.settleGateMs` — 15 с,
  ровно чтобы доказать, что воркер стартовал), или вы не прервёте ожидание. Долгая
  блокировка — явный opt-in через `waitMs`.
- **Abort (Esc) отменяет ожидание, а не воркера.** Вызов отсоединяется (detach); воркер
  продолжает работать. Вернуться к нему можно через `delegate_status`, почтовый ящик или
  фоновый вотчер — критерий завершения по-прежнему файл отчёта.
- **Опциональное раннее отпускание.** С `releaseOn: "started"` (в конфиге или в вызове)
  вызов возвращается, как только доказано, что воркер стартовал и работает, — управление
  переходит фоновому вотчеру. Это «спавн доказан», а не «задача собрана»: валидный отчёт
  всё ещё является завершением работы.
- **Параллельный фан-аут = параллельные tool calls.** Каждый вызов несёт свой бриф и свою
  collect-дисциплину; параллельность не отменяет подготовку каждого вызова.
- **Event-driven вотчер.** Будит, только когда нужен ход: отчёт готов или бит, вопрос через
  почтовый ящик, воркер завис на интерактивном grill-deck, контекст критический (≥90%),
  воркер умер без отчёта, собранный воркер всё ещё висит. Никаких `sleep 1500`.
  Вотчер привязан к сессии: ровно один маунт на сессию, повторный маунт для той же
  сессии отклоняется, а не молча заменяет первый.
- **Почтовый ящик.** `q-<имя>.json` / `a-<имя>.json` — докидывайте уточнения работающему
  воркеру и отвечайте на его вопросы без пересоздания.
- **Строгие отчёты.** Критерий завершения — **валидный JSON-отчёт** с evidence
  (`file:line`), а не «статус done». Свои схемы — во frontmatter брифа, с наследованием
  `$extends` и библиотекой схем.
- **Бюджеты и градусники.** Лимиты output-токенов (`E_BUDGET` при превышении), живые
  `ctx%` и счётчики токенов, рестарт до того, как компакшен съест воркера.
- **Изоляция.** Git worktree на воркера (свой чекаут + ветка) или shared-плейсмент
  (`mode: "shared"` — placement в общем чекауте без изоляции; старый `mode: "tab"`
  остаётся валидным deprecated-алиасом) — суб-оркестратор структурно не может
  создать worktree.
- **Чистая уборка.** Интерактивный `/delegate-teardown`, автоборка после собранного
  отчёта, полный аудит в `teardown.log`.
- **Честные ошибки.** Каждый отказ — структурный код с подсказкой:
  `E_BRIEF`, `E_NAME`, `E_TIER`, `E_PLACE`, `E_START`, `E_TIMEOUT`, `E_BUDGET`, `E_CONTEXT`,
  `E_REPORT_MISSING`, `E_REPORT_INVALID`. Два класса результатов — не сбои, а управление
  потоком: `E_TIMEOUT` (передача управления: воркер продолжает работать, вотчер вас
  разбудит) и результат «ожидает ответа» (висит вопрос в почтовом ящике) — это
  осознанное, документированное отклонение от throw-конвенции pi (ARCHITECTURE.md,
  закон 8).
- **Обрезанный вывод инструментов.** Возвраты инструментов, несущие написанный воркером
  текст, ограничены штатными помощниками pi: в статусных списках не больше 100 строк (с
  пометкой «N more omitted» — полный список лежит в details результата), а саммари
  отчётов и тела писем обрезаются с указанием, где лежит полная копия.

### Как автоматизируется рутина

Подготовка фан-аута — настоящая оркестрационная работа, и контракт инструмента это
отражает. «Одно слово — delegate — и всё случилось» — это человеческое UX-желание, к
которому проект движется, а не machine contract инструмента сегодня. Что вызов требует
на самом деле:

1. оркестратор раскладывает задачу и пишет брифы по ролям;
2. воркеры спавнятся параллельными tool calls, каждый со своим брифом и collect-дисциплиной
   (изоляция worktree, тиры моделей: дешёвый `flash` для исполнения,
   `frontier` для ревью и синтеза);
3. вы занимаетесь своим делом — вотчер копит сигналы и будит в нужный момент;
4. уточнения идут через почтовый ящик; перед большим фан-аутом smoke-проба проверит среду;
5. возвращаются строгие отчёты, воркеры закрываются, флот убирает за собой сам.

Суждение остаётся за моделью (декомпозиция, проверка, мерж), механика — за кодом.

### Один вызов, два нрава: started и settle

Представьте делегирование реальной команде. Вы (оркестратор) передаёте задачу воркеру.
Единственный вопрос — что вы делаете сразу после передачи: стоите над душой или идёте
заниматься своим.

- **`releaseOn: "started"` — по умолчанию: дал задачу — пошёл дальше.** Вызов ждёт ровно
  столько, чтобы увидеть, что воркер реально взялся за работу (пару секунд). Потом вызов
  завершается, и оркестратор свободен; дальше стоит сторож — вотчер: он разбудит
  оркестратора, когда понадобится ход — воркер закончил и сдал отчёт, задал вопрос,
  застрял или умер, не сдав ничего.
- **`releaseOn: "settle"` — opt-out: стоял рядом, пока не закончит.** Вызов блокирует
  оркестратора: он ждёт, пока воркер не закончит (или пока не истечёт лимит ожидания — 15
  секунд по умолчанию). Короткая задача возвращается с результатом прямо в этом же ходе —
  удобно. Длинная задача переживает лимит — дальше эстафету берёт вотчер и разбудит вас.

На практике: для коротких задач удобен `settle` (по умолчанию) — ответ приходит сразу,
без лишнего будильника; для больших фан-аутов из нескольких параллельных воркеров нужен
`started` — с `settle` каждый вызов висит заблокированным по несколько секунд впустую.

Ни один из режимов не меняет критерий успеха: в обоих случаях задача считается
выполненной, когда на диске лежит валидный файл-отчёт. Режимы решают лишь, как долго
оркестратор стоит и ждёт, прежде чем вернуться к своей работе.

Пользовательские примеры вызовов — от игрушечных до боевых — в [EXAMPLES.md](EXAMPLES.md).

### Эксплуатационные заметки

- **Exchange-корень — не durable store.** Путь по умолчанию — `/tmp/exchange` на
  Linux/macOS (очищается при ребуте) и `%LOCALAPPDATA%\pi\exchange` на Windows (fallback
  `homedir()\AppData\Local\pi\exchange`); переменная окружения
  `PI_DELEGATE_EXCHANGE_ROOT` переопределяет его (абсолютный путь). На multi-user хосте
  это общий путь (другие пользователи могут читать манифесты; возможны коллизии имён
  задач). Пути брифов используют нативную форму платформы:
  `/tmp/exchange/<task>/brief-<имя>.md` на Linux/macOS,
  `C:\Users\<вы>\AppData\Local\pi\exchange\<task>\brief-<имя>.md` на Windows.
- Собранные отчёты копируются в `~/.pi/agent/delegate-archive/<task>/` (best-effort,
  TTL 30 дней) — архив и есть долговременная копия.
- Пробуждения вотчера ограничены сессией-владельцем через метки владения и по умолчанию
  fail-closed: манифест без полей владельца (legacy) не доставляет ничего — чужая сессия
  не получает wake по чужому флоту. Единственный откат — явный конфиг-ключ
  `watch.legacyFailOpen: true`; это небезопасно на машине с несколькими сессиями. Сессия,
  которая не может прочитать собственную идентичность, не доставляет ничего безусловно
  (конфигурационного выхода нет).
- Факты доставки пробуждений переживают рестарт сессии через пер-аудиторный курсор
  журнала: каждая сессия-аудитория коммитит свои записи доставки в `cursor-<ключ>.json`
  в каталоге задачи (один файл на сессию на каталог задачи), который питается чтением
  `eventsAfter` журнала флотов и пишется только после успешной отправки. Повторных
  пробуждений после рестарта больше нет; аварийный откат — `watch.durableDelivery: false`
  (возврат к дедупу в памяти, без новой версии). При первом запуске после обновления
  возобновлённая сессия может выдать разовый залп повторных пробуждений (курсор стартует
  с нуля и никогда не засевается; залп ограничен гейтом владения и суточным горизонтом).
  Устаревшие файлы `delivered-*.json` — инертные остатки, их можно безопасно удалить.
  На общей машине обновлённые и ещё не обновлённые сессии ведут себя по-разному, пока
  не обновлены все.
- **Swarm read-сервер (в каждой сессии, по умолчанию ВЫКЛЮЧЕН).** Добавьте
  `"swarm": { "server": { "enabled": true } }` в
  `~/.pi/agent/pi-delegate.config.json` (или экспортируйте `SWARM_SERVER_ENABLED=1`),
  чтобы каждая сессия поднимала loopback read-endpoint:
  `http://127.0.0.1:7331/api/version` — плюс `/api/swarm/snapshot` и
  `/api/swarm/events?after=<seq>` (конверты `swarm snapshot` / `swarm events`
  байт-в-байт, со вживлёнными живыми статусами воркеров) и
  `ws://127.0.0.1:7331/api/swarm/stream?after=<seq>` (один snapshot-кадр,
  затем события журнала по мере появления; переподключайтесь с последним
  потреблённым `seq`). `swarm.server.port` (по умолчанию 7331; `0` = назначается
  ОС) — это подсказка: если порт занят, сессия возьмёт назначенный ОС порт и
  залогирует подмену. Сервер слушает только 127.0.0.1. Чтение — без аутентификации
  (читать может любой локальный процесс); ЗАПИСЬ — только для оператора и
  появилась в **#51**: `POST /api/workers/<id>/steer` и `POST /api/asks/<id>/answer`
  (тело `{"text":"..."}`) требуют `Authorization: Bearer <operator token>`.
  Токен генерируется при монтировании и печатается ТОЛЬКО в stderr сессии
  структурированной строкой `operator-token` — скопируйте его из UI сессии.
  Запись доходит только до воркеров, которых породила эта сессия (чужие/
  неизвестные id отклоняются) и добавляет те же строки журнала `steer`/`answer`,
  что и tool-путь, с аддитивным `via: "http"`. Сервер advisory — сбой старта или
  неудачная запись никогда не блокируют сессию, spawn или collect.
- **Windows: QA-гейт на реальном хосте.** Реальный Windows E2E (delegate spawn →
  отчёт → wake → почтовый ящик, с herdr for Windows) в CI НЕ выполняется — на POSIX CI
  идут только Windows-образные тесты путей (`path.win32` фикстуры). Оператор должен
  прогнать этот гейт на реальном Windows-хосте, прежде чем заявлять поддержку Windows
  за пределами exchange/path-слоя; до тех пор честная формулировка — «exchange/path-слой
  переносим на Windows; host-бэкенд на Windows требует herdr for Windows».

### Инструкция по установке

**Шаг 1 — требования.**

- Рабочая установка [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
- `herdr` на `PATH` (нужен при `"host": "herdr"` — значении по умолчанию; альтернативный
  бэкенд `"host": "rpc"` в herdr не нуждается вообще). Проверка: `herdr --version`.

**Шаг 2 — установка расширения.**

Скопируйте репозиторий или создайте симлинк в каталоге расширений pi:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /путь/к/pi-delegate ~/.pi/agent/extensions/pi-delegate
# ... либо: cp -r /путь/к/pi-delegate ~/.pi/agent/extensions/pi-delegate
```

Имя каталога важно: pi загружает каждый подкаталог `~/.pi/agent/extensions/` как
расширение, ожидаемое имя — `pi-delegate`.

**Шаг 3 — создайте файл конфигурации.**

Создайте `~/.pi/agent/pi-delegate.config.json`. **Встроенного тира воркеров нет** — в
ненастроенном окружении каждый вызов `delegate` отклоняется с `E_TIER`. Подставьте вместо
`<ПЛЕЙСХОЛДЕРОВ>` своего провайдера, свою модель и уровень thinking (те же значения, что вы
передаёте самому pi):

```json
{
  "defaults": {
    "tier": "flash",
    "budgetTokens": 150000
  },
  "tiers": {
    "flash": {
      "provider": "<ПРОВАЙДЕР>",
      "model": "<МОДЕЛЬ>",
      "thinking": "<THINKING>"
    },
    "frontier": {
      "provider": "<ПРОВАЙДЕР>",
      "model": "<МОДЕЛЬ>",
      "thinking": "<THINKING>"
    }
  },
  "watch": {
    "intervalMs": 10000,
    "settleGateMs": 15000,
    "releaseOn": "started"
  }
}
```

Что означает каждая секция:

- `tiers` — именованные тиры воркеров (`provider` / `model` / `thinking` на каждый тир).
  Вызов выбирает тир по имени (`tier: "flash"`); явные параметры `provider` / `model` /
  `thinking` вызова сильнее тира, тир сильнее `defaults`.
- `defaults.tier` — тир по умолчанию, когда вызов не передал свой.
- `defaults.budgetTokens` — бюджет output-токенов воркера по умолчанию (используется
  только для учётных показов; жёсткое ограничение требует явного `budgetTokens` в вызове).
- Все ключи необязательны, файл читается отказоустойчиво (нет файла / битый / частичный →
  значения по умолчанию), но если tier/provider/model не разрешаются, вызов `delegate`
  завершается с `E_TIER` — плейсхолдеры выше — это необходимый минимум.
- Вместо тиров (или вместе с ними) можно передавать `provider`, `model` и `thinking`
  явно в каждом вызове `delegate`.

Необязательные дополнения (у всех безопасные значения по умолчанию; см. эксплуатационные
заметки выше):

- **Профили** — именованные пресеты конфигурации. Положите пресет той же формы,
  что и базовый конфиг (host / contextWindow / defaults / tiers / watch), в
  `~/.pi/agent/pi-delegate.d/<имя>.json` и выберите его либо переменной
  окружения `PI_DELEGATE_PROFILE` (на терминал), либо ключом
  `"profile": "<имя>"` в базовом конфиге (постоянно); переменная окружения
  сильнее. Секция, присутствующая в профиле, заменяет секцию базы ЦЕЛИКОМ
  (частичного слияния внутри tiers/defaults/watch нет); секции, которых в
  профиле нет, берутся из базы. Профиль не выбран → базовый конфиг как есть.
  Выбранный, но отсутствующий/битый профиль — это ошибка, а не тихий откат:
  вызовы delegate падают со структурной `E_START` с именем файла (вотчер/
  флот/статус вместо этого откатываются к значениям по умолчанию — они
  консультативные). Хост привязывается один раз на старте сессии: правки
  профиля в работающей сессии меняют tiers/defaults/budget/watch на следующем
  вызове delegate, но не работающий бэкенд.
- `"host": "herdr" | "rpc"` — бэкенд воркеров. `"herdr"` (по умолчанию) размещает
  воркеров в workspaces/панелях herdr и требует CLI herdr. `"rpc"` запускает воркеров
  как headless-процессы `pi --mode rpc`, дети сессии оркестратора, — herdr не нужен
  вовсе: worktree-плейсмент — обычный `git worktree add` под
  `~/.pi/agent/worktrees/`, промпты уходят в stdin воркера, а оседание доказывается
  собственным rpc-событием pi `agent_settled` (без опроса статусов). Известное
  ограничение: rpc-воркеры живут вместе с процессом оркестратора — после его выхода
  они завершают текущую задачу и выходят (EOF в stdin), поэтому более поздняя сессия
  видит их отчёты/файлы почтового ящика, но не может их подтолкнуть (nudge).
- `watch` — настройка вотчера: `intervalMs` (период опроса, минимум 1 с), `settleGateMs`
  (окно блокировки вызова по умолчанию) и `releaseOn` — `"started"` (по умолчанию)
  отпускает вызов, как только доказано, что воркер взялся за работу, — управление сразу
  переходит фоновому вотчеру; `"settle"` (opt-out) блокирует всё окно, если воркер не
  осел раньше. Показанные значения — значения по умолчанию; секцию можно опустить
  целиком.
- `"contextWindow": <число>` — переопределяет окно контекста воркера для гейджа `ctx%`,
  когда модели нет во встроенной таблице.
- Переменная окружения `PI_DELEGATE_EXCHANGE_ROOT` (абсолютный путь) — переносит
  exchange-дерево с пути по умолчанию `/tmp/exchange` (Linux/macOS) или
  `%LOCALAPPDATA%\pi\exchange` (Windows), например для долговременного или multi-user
  сценария.

**Шаг 4 — стартуйте сессию и проверьте.**

Стартуйте сессию pi. Быстрая проверка — probe-вызов `delegate` с крошечным брифом в
exchange layout (`/tmp/exchange/<task>/brief-<имя>.md` на Linux/macOS). Если конфиг не
разрешился, вызов вернёт структурную ошибку (`E_TIER`) с подсказкой; если `herdr`
отсутствует при `"host": "herdr"`, инструменты откажут сразу.

Команда `/delegate-teardown`, оверлей флота и инструмент `delegate_status` доступны сразу
после старта сессии.

---

Разница между «модель иногда справляется с субагентами» и «мультагентная разработка как
рабочий процесс» — в обвязке. Обвязка здесь.
