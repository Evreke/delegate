# Delegate — MANUAL FALLBACK reference (tool-absent ritual)

> **The gate, first.** This file describes the MANUAL herdr CLI ritual. It applies
> ONLY when the `delegate` tool is absent from your session (extension missing or
> broken).
>
> - **Tool absent** → follow this ritual exactly, in order.
> - **Tool present** → [SKILL.md](SKILL.md) and the `delegate` / `delegate_status` /
>   `delegate_mailbox` tools govern; the tool's schema owns every mechanical detail.
>   Spawning, prompting or collecting through the commands below while the tool
>   exists is a **bug**, not a shortcut.
>
> The last three sections — Supervision, Topologies, Anti-patterns — are UNIVERSAL:
> they hold with or without the tool.
>
> Vocabulary: below, "pane" and "tab" name herdr's own objects (its CLI strings and
> JSON fields are frozen). With the tool, the same concepts are the worker console
> and shared placement.

The contract: you are the orchestrator. You decompose, brief, spawn, collect, verify,
merge. Execution lives in worker sessions — separate pi processes in herdr panes, each
with a fresh context. Tier routing: the decision tier (frontier-class) briefs, reviews,
and synthesizes; the execution tier (flash-class) implements, fixes, enumerates,
verifies. Prompt the execution tier tight and structured — it is a small model.

## 1. Pre-flight gate

1. Gate: `test "${HERDR_ENV:-}" = 1`. If it fails, report that delegation over herdr
   is unavailable and stop.
2. Clock check: `journalctl --no-pager --since '-5 min' | grep -c 'Clock change'`.
   Recurring steps mean the host clock is being reset (competing NTP/hypervisor sync)
   — herdr waits and input handling become unreliable (raw escape flushes into panes,
   broken pipes). Report it to the user before launching long `--wait` orchestration.
3. Choose the transport per worker:
   - **Interactive worker** (herdr pane, session kept) — the default; supports
     follow-up prompts, questions, and mid-run re-briefs.
   - **Headless one-shot** (`pi -p`) — a single artifact from a throwaway probe. Add
     `--approve` (headless modes skip the trust prompt) and narrow tools
     (`--tools read,bash`).
4. Assign tier and budget per worker: execution work ≤ ~150k tokens; repeats ≤ 2 per
   issue; iterations ≤ 5 for write/review loops.
5. Create the exchange dir: `mkdir -p /tmp/exchange/{TASK}`. The exchange root is
   platform-dependent: `/tmp/exchange` on Linux/macOS, `%LOCALAPPDATA%\pi\exchange`
   on Windows; `PI_DELEGATE_EXCHANGE_ROOT` overrides it. Use the native path form of
   the running platform in every command below.
6. For a fan-out of ≥3 workers, smoke test first: one probe worker prompted to reply
   exactly `OUTPUT: OK` (catches dead consoles, wrong flags, overloaded tiers). The
   probe's reply is the final verdict.

Completion: every planned worker has a name, tier, budget, and brief path. Names match
`[a-z][a-z0-9_-]{0,31}`, unique among live agents.

## 2. Brief

One brief file per worker in the exchange dir (`brief-<name>.md`). The prompt sent to
the worker console is one line pointing at it — long prompts wrap and mangle in a
narrow console. (Tool-absent only: here the BRIEF itself must state the report path
and format, because no tool prompt supplies them.)

- **ROLE** — one line: tier, read/write scope ("You are facts-worker F1, read-only").
- **TASK** — bounded, single outcome. Verbatim artifacts (exact fix shape, exact text)
  for risky changes; equivalence argument for rewrites.
- **CONTEXT** — file pointers only: spec path, prior reports, worktree path, branch,
  base commit. Paste nothing the worker can read.
- **CONSTRAINTS** — the owned surface first ("You edit exactly these files"), then the
  danger surface as explicit negatives (no git-write commands, no builds, no docker).
- **OUTPUT** — exact report path + format, ending: "Before replying, verify the report
  file is written. Reply with only the file path."
- **BUDGET** — tokens / time slots / iterations.

Completion: brief exists on disk; the planned prompt is a single `Read <path> …` line.

## 3. Spawn

Default topology: **one worker = one worktree workspace**. `herdr worktree create`
returns a full isolated workspace in one call — the worker's own tab, its own git
branch, and a root shell pane already cd'd into the checkout at
`~/.herdr/worktrees/<repo>/<branch>`. It needs a git repo: target your workspace
(`$HERDR_WORKSPACE_ID`) or pass `--cwd <repo-path>`; `--base <REF>` picks a non-HEAD
base.

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

**Worktree authority (universal):** only the root orchestrator creates and removes
worktrees. A sub-orchestrator — an orchestrator itself running inside a worktree
workspace (your brief says so, or `pwd` is under `~/.herdr/worktrees/`) — must never
call `worktree create`/`worktree remove`. It spawns its workers as new tabs in its own
workspace: one tab per worker, all sharing the same checkout and branch.

```bash
# sub-orchestrator spawn: tab in my worktree workspace, not a new worktree
T=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label "worker-a" --no-focus)
P=$(echo "$T" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')

herdr agent start worker-a --kind pi --pane "$P" --timeout 120000 -- \
  --provider llm-platform --model "tensorzero::function_name::flash"
```

The tab's root pane inherits the worktree cwd. Workers sharing one checkout are a
file-slice fan-out: give each a disjoint file list in its brief.

Names auto-uniquify on collision (`facts-1` → `facts-2`): read the name back from the
`agent start` response and prompt that name, not the one you requested.

Fall back to sibling pane splits only when a worker needs no git isolation (read-only
fact workers, non-repo tasks). Split from your own pane, `--no-focus`, same cwd;
alternate right/down so no pane gets sliver geometry.

Startup `--timeout` 60–180 s; prompt `--wait` timeout = expected task length (10–30
min for execution work).

Completion: `herdr agent get <name>` shows the worker working (or blocked) for every
spawn, and every worktree worker's workspace id + branch is recorded for teardown.

## 4. Collect

The report file is the result. `herdr agent read` is for status and short answers only
— rows that leave the alternate screen never reach scrollback, so long worker output
read from the terminal is silently truncated.

1. For each worker, read the agreed report file with the `read` tool. `ENOENT` = the
   worker produced nothing: treat as a failed spawn, not an empty result.
2. Poll instead of blocking when running other work: `herdr agent list`, or
   `herdr agent get <name>` per worker; status vocabulary
   `idle | working | blocked | done | unknown`. `done` means the turn ended — the
   report file is the completion criterion, not the status; a report whose `status` is
   `"fail"` is still an honest completion.
3. `blocked` = an approval or question UI. Read the worker console, answer the
   question (or `send-keys <name> esc` to decline and re-brief).
4. Cross-check conflicting worker reports by spawning one tie-breaker verifier with
   both reports as CONTEXT, or resolve it yourself from source.

Completion: every worker has a report file on disk, read by you.

## 5. Verify and re-delegate

You are the single merge gate: workers commit in their own worktree/scope; they never
merge, never push, never open PRs.

- Verify against the brief's OUTPUT: acceptance criteria as PASS/FAIL with file:line
  evidence.
- Worktree workers spawned by the root commit on their own branch in their own
  checkout — their diff is `git diff <base>` inside the worktree.
- Sub-orchestrator workers share the sub-orchestrator's checkout and branch: disjoint
  file lists per brief, one build runner at a time.
- A failed worker's result is input, not waste: **replace the failed prompt with a
  diagnosed retry** — a new brief that names the wrong path taken, the root cause, and
  the required fix shape, run under a NEW worker name (the settled worker keeps the
  old one). A verbatim retry is a banned move; the diagnosed retry is the move. ≤2
  repeats per issue, then escalate to the user.
- Repair prompts get tighter, never looser.

Completion: DoD verified (tests/acceptance criteria), all changes accounted for, merge
order decided by you.

## 6. Teardown and audit

1. Worktree authority is root-only here too: a sub-orchestrator inside a worktree
   closes its own tabs — `herdr tab close <tab_id>` per worker tab — and never removes
   the worktree. The root removes worktree workers: `herdr worktree remove --workspace
   <ws_id> --force` per worker — deletes the checkout and closes its workspace, tab,
   and agent in one call; no separate `pane close`/`workspace close` needed.
   Pane-split workers: `herdr pane close <pane_id>` per pane. Names release
   implicitly.
2. One mutating herdr command per tool call, and log the planned sequence to
   `/tmp/exchange/{TASK}/teardown.log` first — a mutating op can hang up your pane's
   process group, killing every step queued after it in the same call.
3. A tool call that returns no output during herdr state changes is not evidence of
   failure — the op may have completed server-side. Reconcile from
   `herdr workspace list` / `agent list` and `~/.config/herdr/herdr-server.log` (every
   API request is logged with its outcome), then close leftovers idempotently.
4. If `worktree remove` answers `not_linked_worktree`, the workspace is an orphan from
   a server crash mid-removal (observed on 0.8.2): recover with
   `workspace close <ws_id>`.
5. For a run of ≥3 workers, close with an audit from the session store: workers
   spawned, wall time per worker, tokens per tier, repeats — parse `usage` blocks in
   `~/.pi/agent/sessions/…/<session>.jsonl`, not estimates.

## Reference — supervision (universal)

- Stuck interactive worker: `herdr agent send-keys <name> ctrl+c`, then re-brief.
  Headless liveness: `nohup … &` + `ps -p $!` check, `pgrep -af "pi .*-p"`.
- Mid-run correction to a working worker: send a short steering prompt (state +
  instruction), e.g. "STEP 0 resolved upstream — do not cherry-pick, continue with
  STEP 1".
- A resumed session can sit inside a worker's herdr pane:
  `herdr agent start … -- --session <path-to.jsonl>`.
- Tier overload: re-delegate to a different tier (e.g. flash → chat/beta) rather than
  queuing behind an overloaded one.

## Reference — topologies (universal)

| Topology | Shape | Use |
|---|---|---|
| Ticket fan-out | one ticket = one worktree = one branch = one agent | independent implementation tickets — realized by the default spawn in §3 |
| File-slice fan-out | N agents, one worktree, disjoint file lists per agent | mass mechanical edits (javadoc, renames) |
| Axis fan-out | one reviewer per review axis → synthesize under your recommendation | code review, audits |
| Hypothesis fan-out | ≥3 independent workers on orthogonal hypotheses; hold the superposition until evidence collapses it | diagnosis, ToT investigations |
| Role chain | investigator → planner → developer → verifier → narrator over one artifact | feature delivery with human-facing report |
| Two-tier swarm | root → per-repo/tech-lead orchestrators → workers | multi-repo epics (cap depth at 3; workers that delegate are the exception, not the rule). Root owns all worktree create/remove; sub-orchestrators place workers inside their own worktree as tabs |

## Reference — anti-patterns (universal)

- Brief pasted into the prompt → put it in a file; the prompt points at it.
- Long result read from the worker console → read the report file.
- `done` trusted as completion → the report file exists is the criterion.
- Failed prompt retried verbatim → diagnosed retry with root cause + fix shape.
- Workers merging or pushing → orchestrator is the merge gate; workers commit in scope
  only.
- Manual `rm` of herdr-managed state (`~/.herdr/`, a repo with open worktree
  workspaces) → herdr commands are the only lifecycle API; delete a repo only after
  its worktree workspaces are closed.
- Parallel builds in one worktree → one build runner at a time; file-disjoint scopes.
- Interactive tools with rich TUI inside worker consoles → workers answer questions in
  files; you poll and answer.
- Unbounded fan-out → smoke test first, cap concurrency, budget per tier.
- Briefs that omit the exchange dir or report path → the loop has no collection point;
  always OUTPUT first.
- Running this ritual while the `delegate` tool exists → the tool is the only spawn
  path; see the gate at the top of this file.
