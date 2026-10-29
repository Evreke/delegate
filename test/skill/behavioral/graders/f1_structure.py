"""F1-replay-structure — named grader (deterministic pre-gate for F1 cases).

Rule enforced (brief-evaluator.md acceptance F1): a replay submission is the
orchestrator's next action plan for a real historical situation. Before the
per-case llm-rubric (metric F1-XX-rubric) judges match-or-beat, this
pre-gate checks the plan is structurally judgeable.

Pass rule (explicit):
  PASS iff the submission (output text):
    (a) is non-empty (at least 40 characters);
    (b) names a route: one of the six loop topologies (ticket, file-slice,
        axis, hypothesis, role chain, two-tier), or a single-worker spawn,
        or an explicit no-delegate route (probe / do it directly / outside
        the loop);
    (c) states a tier decision: names a tier class (flash / frontier) or
        explicitly relies on the tool default.
Failure of any item means the plan cannot be graded against the real
outcome; the case is scored fail with this reason.
"""


def get_assert(output, context=None):
    import re
    text = output or ""
    ok_a = len(text.strip()) >= 40
    route = re.search(
        r"ticket|file-slice|axis|hypothesis|role chain|two-tier|single worker"
        r"|probe|directly|do it (?:myself|yourself)|no delegate|without delegating"
        r"|outside the loop|one worker|fan-?out",
        text, re.I)
    tier = re.search(r"\bflash\b|\bfrontier\b|\bdefault\b|\btier\b", text, re.I)
    ok = ok_a and bool(route) and bool(tier)
    reason = ("F1 structure: " +
              ("" if ok_a else "plan empty or too short; ") +
              ("" if route else "no route/topology named; ") +
              ("" if tier else "no tier decision or explicit default; ") +
              ("PASS" if ok else "FAIL"))
    return {"pass": ok, "score": 1.0 if ok else 0.0, "reason": reason}
