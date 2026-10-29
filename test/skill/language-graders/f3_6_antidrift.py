"""F3.6 anti-drift — named rubric grader (deterministic gate).

Rule enforced (brief-evaluator.md acceptance F3.6; V2-DESIGN-CONSTRAINTS
hard constraint 1): no duplication of the tool-owned surface. The skill must
not restate tool schema, flags, result texts, report JSON, or herdr
mechanics; it references them instead of copying them. Grounded in
/root/projects/delegate/src (the owned surface) — see the blacklist below.

Pass rule (explicit):
  PASS iff the skill text (frontmatter included; nothing is exempt — copying
  is copying even inside code spans) contains none of:
    (a) any E_* error code token (E_ + 2+ uppercase letters) — the tool owns
        the code vocabulary; the skill's own codes are E1-E3, which do not
        match this pattern;
    (b) any tool flag or parameter name: briefPath, waitMs, timeoutMs,
        budgetTokens, maxContextPct, releaseOn, extraArgs, repoPath,
        SWARM_TASK, SWARM_WORKER, SWARM_SCHEMA_DIR;
    (c) any swarm CLI verb in its literal hyphen form: write-report,
        poll-answer, read-brief, write-progress, /delegate-teardown;
    (d) any tool result-text n-gram: AWAITING_ANSWER, "Report OK",
        "Report INVALID", "settled but report", "OUTPUT: OK",
        "Treat as a failed spawn", "END YOUR TURN", "released early",
        "recover via delegate_status";
    (e) any report-JSON literal: the report-*.json filename pattern or the
        JSON key literal "status": "pass". The bare phrase "report JSON" is
        NOT a hit: the draft uses it inside its own prohibition ("MUST NOT
        paste report JSON") — naming the artifact to forbid copying it is a
        reference, not a copy;
    (f) any herdr mechanic: herdr, pane, workspace_id, tab_id, terminal_id,
        "worktree create";
    (g) any tool-prompt phrase: "Spawn one worker", "block until it settles",
        "probe OK/FAIL", "Esc detaches".
  Concept references ("the tool's probe semantics", "the tool's prompt owns
  it", "the delegate archive") are the ALLOWED form and contain no blacklisted
  literal. Semantic restatement that no literal list can catch is judged by
  the paired llm-rubric assertion (metric F3.6-rubric).

Input: context.vars["skill_path"] (preferred) or the assertion output text.
"""

import re

BLACKLIST = [
    r"E_[A-Z][A-Z_]+",
    r"\bbriefPath\b", r"\bwaitMs\b", r"\btimeoutMs\b", r"\bbudgetTokens\b",
    r"\bmaxContextPct\b", r"\breleaseOn\b", r"\bextraArgs\b", r"\brepoPath\b",
    r"\bSWARM_TASK\b", r"\bSWARM_WORKER\b", r"\bSWARM_SCHEMA_DIR\b",
    r"\bwrite-report\b", r"\bpoll-answer\b", r"\bread-brief\b",
    r"\bwrite-progress\b", r"/delegate-teardown",
    r"AWAITING_ANSWER", r"Report OK", r"Report INVALID",
    r"settled but report", r"OUTPUT: OK", r"Treat as a failed spawn",
    r"END YOUR TURN", r"released early", r"recover via delegate_status",
    r"report-[\w<>.-]*\.json", r'"status":\s*"pass"',
    r"\bherdr\b", r"\bpanes?\b", r"workspace_id", r"tab_id", r"terminal_id",
    r"worktree create",
    r"Spawn one worker", r"block until it settles", r"probe OK/FAIL",
    r"Esc detaches",
]


def get_assert(output, context=None):
    import os
    path = (context or {}).get("vars", {}).get("skill_path")
    text = open(path).read() if path and os.path.exists(path) else (output or "")

    hits = []
    for pat in BLACKLIST:
        for m in re.finditer(pat, text):
            hits.append(f"{m.group(0)!r} (pattern {pat})")
    ok = not hits
    reason = ("F3.6 anti-drift: " +
              (f"tool-owned literal(s) copied: {hits[:6]}; " if hits else "") +
              ("PASS" if ok else "FAIL"))
    return {"pass": ok, "score": 1.0 if ok else 0.0, "reason": reason}
