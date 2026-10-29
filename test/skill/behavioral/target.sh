#!/usr/bin/env bash
# F1/F2 behavioral target — the skill-primed orchestrator surface.
#
# Contract (EVAL-PLAN-v2.2.md E3, option (a)): reads one situation JSON object
# on stdin: {"situation": "<rendered situation>", "skill_path": "<optional>"};
# runs ONE headless pi session primed with the delegate skill text and prints
# the orchestrator's next action plan on stdout. The target DECIDES, it never
# executes: --no-tools, --no-session.
#
# CI: NOT wired. This runner is local-only by design (see HOW-TO.md,
# "Behavioral evals (local-only)").
set -euo pipefail
SITUATION=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["situation"])')
SKILL_PATH=${SKILL_PATH:-/root/projects/delegate/skills/delegate/SKILL.md}
PROVIDER=${TARGET_PROVIDER:-llm-platform}
MODEL=${TARGET_MODEL:-tensorzero::function_name::frontier}
THINKING=${TARGET_THINKING:-high}

PRIME="You are the orchestrator primed by the delegate skill below. Decide the
next action for the situation at the end. Reply with:
1. ROUTE: one of ticket fan-out / file-slice fan-out / axis fan-out /
   hypothesis fan-out / role chain / two-tier swarm / single worker / probe /
   do it directly / outside the loop / ask.
2. TIER: flash-class, frontier-class, or tool default.
3. If spawning: worker names, mode (worktree/shared/probe), and what each
   brief must contain (reference the B-sections, do not write full briefs).
4. If not spawning: the direct route in 1-3 lines.
Name only the route you take; do not enumerate follow-up options.
Be concrete and short. Skill text:
$(cat "$SKILL_PATH")"

exec pi --print --no-session --no-tools --no-extensions \
  --provider "$PROVIDER" --model "$MODEL" --thinking "$THINKING" \
  --append-system-prompt "$PRIME" \
  "$SITUATION"
