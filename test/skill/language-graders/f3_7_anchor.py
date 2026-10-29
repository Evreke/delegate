"""F3.7 anchor-discipline — named rubric grader (deterministic gate).

Rule enforced (brief-evaluator.md acceptance F3.7; V2-DESIGN-CONSTRAINTS §4):
Anchor discipline. Criticals are not buried mid-paragraph; each step has a
checkable completion line where a done-state exists; task-critical rules
appear at the start or the end, never only in the middle.

Pass rule (explicit, deterministic part):
  PASS iff all of the following hold:
    (a) every "###" step section of "## The loop" contains at least one
        "Done when:" line (the checkable completion line);
    (b) no prose line longer than 180 characters carries a MUST/MUST NOT
        further than 60 characters into the line (a critical buried in a
        wall-of-text line);
    (c) the body's first 12 non-empty prose lines or its last 12 non-empty
        prose lines contain at least one MUST / MUST NOT / "Success is"
        (task-critical rules anchored at start or end).
  "Criticals buried mid-paragraph" across a multi-line paragraph is only
  partly decurable deterministically; the paired llm-rubric assertion
  (metric F3.7-rubric) judges the remainder.

Input: context.vars["skill_path"] (preferred) or the assertion output text.
"""

import re



def get_assert(output, context=None):
    import os, re
    path = (context or {}).get("vars", {}).get("skill_path")
    text = open(path).read() if path and os.path.exists(path) else (output or "")
    body = re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)
    body = re.sub(r"```.*?```", " ", body, flags=re.S)

    # (a) per-step completion line
    steps = re.split(r"(?m)^### ", body)[1:]
    no_done = [s.splitlines()[0].strip() for s in steps
               if "Done when:" not in s]

    # (b) buried criticals in long lines
    buried = []
    for line in body.splitlines():
        for m in re.finditer(r"\bMUST( NOT)?\b", line):
            if len(line) > 180 and m.start() > 60:
                buried.append(line.strip()[:80])

    # (c) criticals anchored at start or end
    prose = [l.strip() for l in body.splitlines() if l.strip()]
    head, tail = prose[:12], prose[-12:]
    anchored = any(re.search(r"MUST|Success is", l) for l in head + tail)

    ok = not no_done and not buried and anchored
    reason = ("F3.7 anchor discipline: " +
              (f"step(s) without 'Done when:' {no_done}; " if no_done else "") +
              (f"buried critical line(s) {buried[:3]}; " if buried else "") +
              ("" if anchored else "no MUST/'Success is' in the first or last 12 prose lines; ") +
              ("PASS" if ok else "FAIL"))
    return {"pass": ok, "score": 1.0 if ok else 0.0, "reason": reason}
