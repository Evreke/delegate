# Delegate — MANUAL FALLBACK reference (tool-absent ritual)

> **The gate, first.** This file describes the MANUAL herdr CLI ritual. It applies
> ONLY when the `delegate` tool is absent from your session (extension missing or
> broken).
>
> - **Tool absent** → follow this ritual exactly, in order.
> - **Tool present** → [SKILL.md](SKILL.md) and the `delegate` / `delegate_status` /
>   `delegate_mailbox` tools govern — the tool's schema owns every mechanical detail.
>   Spawning, prompting or collecting through the commands below while the tool
>   exists is a **bug**, not a shortcut.
>
> The last three sections — Supervision, Topologies, Anti-patterns — are UNIVERSAL:
> they hold with or without the tool.
>
> Vocabulary: below, "pane" and "tab" name herdr's own objects (its CLI strings and
> JSON fields are frozen). With the tool, the same concepts are the worker console
> and shared placement.

Execution lives in worker sessions — separate pi processes in herdr panes, each with
a fresh context. Prompt the execution tier tight and structured — it is a small model.

## 1. Pre-flight gate

1. Gate: `test "${HERDR_ENV:-}" = 1`. If it fails, report that delegation over herdr
   is unavailable and stop.
2. Clock check: `journalctl --no-pager --since '-5 min' | grep -c 'Clock change'`.
   Recurring steps mean the host clock is being reset (competing NTP/hypervisor sync)
   — herdr waits and input handling become unreliable (raw escape flushes into panes,
   broken pipes). Report it to the user before long `--wait` orchestration.
3. Choose the transport per worker:
   - **Interactive worker** (herdr pane, session kept) — the default. It supports
     follow-up prompts, questions, and mid-run re-briefs.
   - **Headless one-shot** (`pi -p`) — a single artifact from a throwaway probe. Add
     `--approve` (headless modes skip the trust prompt) and narrow tools
     (`--tools read,bash`).
4. Assign budget per worker: execution work ≤ ~150k tokens, at most 5 iterations for
   write/review loops.
5. Create the exchange dir: `mkdir -p /tmp/exchange/{TASK}`. The exchange root is
   platform-dependent: `/tmp/exchange` on Linux/macOS, `%LOCALAPPDATA%\pi\exchange`
   on Windows. `PI_DELEGATE_EXCHANGE_ROOT` overrides it. Use the native path form of
   the running platform in every command below.
6. For a fan-out of ≥3 workers, run the first worker alone and check it before the
   rest. The check: console alive, brief read, first actions sane. The observed state
   is the final verdict on the transport. A dead console or a wrong flag surfaces on
   worker 1, not on the fleet.

Completion: every planned worker has a name, tier, budget, and brief path. Names match
`[a-z][a-z0-9_-]{0,31}`, unique among live agents.

## 2. Brief

One brief file per worker in the exchange dir (`brief-<name>.md`). The prompt sent to
the worker console is one line pointing at it — long prompts wrap and mangle in a
narrow console. (Tool-absent only: here the BRIEF itself must state the report path
and format, because no tool prompt supplies them.)

- **ROLE** — one line: tier, read/write scope ("You are facts-worker F1, read-only").
- **TASK** — bounded, single outcome. Verbatim artifacts (exact fix shape, exact text)
  for risky changes — an equivalence argument for rewrites.
- **CONTEXT** — file pointers only: spec path, prior reports, worktree path, branch,
  base commit. Paste nothing the worker can read.
- **CONSTRAINTS** — the owned surface first ("You edit exactly these files"), then the
  danger surface as explicit negatives (no git-write commands, no builds, no docker).
- **OUTPUT** — exact report path + format, ending: "Before replying, verify the report
  file is written. Reply with only the file path."
- **BUDGET** — tokens / time slots / iterations.

Completion: the brief exists on disk. The planned prompt is a single `Read <path> …`
line.

## 3. Spawn

Default shape: **one worker = one worktree workspace**. `herdr worktree create`
returns an isolated workspace in one call — the worker's own tab, its own git branch,
and a root shell pane already inside the checkout at
`~/.herdr/worktrees/<repo>/<branch>`. It needs a git repo: target your workspace
(`$HERDR_WORKSPACE_ID`) or pass `--cwd <repo-path>`. The `--base <REF>` flag picks a
non-HEAD base.

```bash
# one worktree workspace per worker
WT=$(herdr worktree create --workspace "$HERDR_WORKSPACE_ID" \
       --branch "task-research-1" --label "research-1" --no-focus)
WS=$(echo "$WT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["workspace"]["workspace_id"])')
P=$(echo "$WT"  | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')

# start the worker in the worktree's root pane (flags after --)
herdr agent start research-1 --kind pi --pane "$P" --timeout 90000 -- \
  --provider llm-platform --model "tensorzero::function_name::flash" --thinking high

# send the brief and wait for the run to settle
herdr agent prompt research-1 "Read /tmp/exchange/{TASK}/brief-research-1.md and follow its instructions exactly. Reply with only the file path." --wait --timeout 1800000
```

**Worktree authority:** a sub-orchestrator (pwd under `~/.herdr/worktrees/`, or the
brief says so) never calls `worktree create`/`worktree remove`. It spawns its workers
as new tabs in its own workspace: one tab per worker, all sharing the same checkout
and branch. Only the root orchestrator creates and removes worktrees.

```bash
# sub-orchestrator spawn: tab in my worktree workspace, not a new worktree
T=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label "worker-a" --no-focus)
P=$(echo "$T" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')

herdr agent start worker-a --kind pi --pane "$P" --timeout 120000 -- \
  --provider llm-platform --model "tensorzero::function_name::flash"
```

The tab's root pane inherits the worktree cwd.

Names auto-uniquify on collision (`facts-1` → `facts-2`): read the name back from the
`agent start` response and prompt that name, not the one you requested.

Fall back to sibling pane splits only when a worker needs no git isolation (read-only
fact workers, non-repo tasks). Split from your own pane, `--no-focus`, same cwd.
Alternate right/down so no pane gets sliver geometry.

Startup `--timeout` 60–180 s. The prompt `--wait` timeout equals the expected task
length (10–30 min for execution work).

Completion: `herdr agent get <name>` shows the worker working (or blocked) for every
spawn, and every worktree worker's workspace id + branch is recorded for teardown.

## 4. Collect

The report file is the result. `herdr agent read` is for status and short answers only
— rows that leave the alternate screen never reach scrollback, so long worker output
read from the terminal is silently truncated.

1. For each worker, read the agreed report file with the `read` tool. `ENOENT` = the
   worker produced nothing: treat as a failed spawn, not an empty result.
2. Poll instead of blocking when running other work: `herdr agent list`, or
   `herdr agent get <name>` per worker. Status vocabulary:
   `idle | working | blocked | done | unknown`. `done` means the turn ended — the
   report file is the completion criterion, not the status.
3. `blocked` = an approval or question UI. Read the worker console, answer the
   question (or `send-keys <name> esc` to decline and re-brief).

Completion: every worker has a report file on disk, read by you.

## 5. Verify and re-delegate

- The diff of a root-spawned worktree worker: `git diff <base>` inside its worktree.
- Sub-orchestrator workers share the sub-orchestrator's checkout and branch: disjoint
  file lists per brief, one build runner at a time.
- Re-delegate a failed prompt as the diagnosed retry — SKILL.md recovery applies: new
  brief, NEW worker name, at most 2 repeats.
- Repair prompts get tighter, never looser.

Completion: DoD verified (tests/acceptance criteria), all changes accounted for, merge
order decided by you.

## 6. Teardown and audit

1. Teardown authority follows spawn authority. A sub-orchestrator inside a worktree
   closes its own tabs (`herdr tab close <tab_id>` per worker tab) and never removes
   the worktree. The root removes worktree workers:
   `herdr worktree remove --workspace <ws_id> --force` per worker — one call deletes
   the checkout and closes its workspace, tab, and agent. No separate
   `pane close`/`workspace close` calls. Pane-split workers:
   `herdr pane close <pane_id>` per pane. Names release implicitly.
2. One mutating herdr command per tool call, and log the planned sequence to
   `/tmp/exchange/{TASK}/teardown.log` first. A mutating op can hang up your pane's
   process group and kill every step queued after it in the same call.
3. No output from a tool call during herdr state changes is not evidence of failure —
   the op can complete server-side. Reconcile from `herdr workspace list` /
   `agent list` and `~/.config/herdr/herdr-server.log` (every API request is logged
   with its outcome), then close leftovers idempotently.
4. If `worktree remove` answers `not_linked_worktree`, the workspace is an orphan from
   a server crash mid-removal (observed on 0.8.2): recover with
   `workspace close <ws_id>`.
5. For a run of ≥3 workers, close with an audit from the session store: workers
   spawned, wall time per worker, tokens per tier, repeats — parse `usage` blocks in
   `~/.pi/agent/sessions/…/<session>.jsonl`, not estimates.

## Reference — supervision (universal)

- Stuck interactive worker: `herdr agent send-keys <name> ctrl+c`, then re-brief.
  Headless liveness: `nohup … &` + `ps -p $!` check, `pgrep -af "pi .*-p"`.
- Mid-run correction to a working worker: a short steering prompt (state +
  instruction), for example "STEP 0 resolved upstream — do not cherry-pick, continue
  with STEP 1".
- A resumed session can sit inside a worker's herdr pane:
  `herdr agent start … -- --session <path-to.jsonl>`.
- Tier overload: re-delegate to a different tier (for example flash → chat/beta)
  rather than queuing behind an overloaded one.

## Reference — topologies (universal)

The topology map — ticket, file-slice, axis, hypothesis, role chain, two-tier swarm —
is universal judgment: SKILL.md step 1 owns it. The manual ritual realizes two shapes:
the §3 default (one worktree workspace per worker) for ticket fan-outs, and shared
tabs (disjoint file lists per brief) for file-slice fan-outs and sub-orchestrators.

## Reference — anti-patterns (universal)

- Manual `rm` of herdr-managed state (`~/.herdr/`, a repo with open worktree
  workspaces): herdr commands are the only lifecycle API. Close a repo's worktree
  workspaces before you delete the repo.
- Interactive tools with rich TUI inside worker consoles: workers answer questions in
  files — you poll and answer.
- Unbounded fan-out: cap concurrency and budget per tier — smoke on worker 1 first
  (§1).
