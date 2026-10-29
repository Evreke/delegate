"""F3.4 literalism — named rubric grader (deterministic pre-gate).

Rule enforced (brief-evaluator.md acceptance F3.4; V2-DESIGN-CONSTRAINTS §4):
Literalism guard. No idioms, no metaphors, no culture-bound phrases; every
comparison is stated as a literal condition.

Pass rule (explicit, deterministic part):
  PASS iff, outside fenced code blocks, inline code spans, and the
  frontmatter, none of the blacklisted idiom/metaphor phrases appears
  (case-insensitive, word-boundary where the phrase is a single word):
    superposition, sanity check, ballpark, under the hood, corner case,
    rule of thumb, grey area, gray area, no-brainer, move the needle,
    boil the ocean, hit the ground running, elephant in the room,
    test balloon, in one shot, canary, black box, white box, deep dive,
    dogfood, footgun, silver bullet, ball in your court.
  Skill-owned and tool-owned terms are not idioms and stay allowed: "the
  loop" (the skill's own section name), "smoke-test" / "smoke gate" (the
  tool's own term for probe semantics).
  Metaphor that a fixed list cannot catch is judged by the paired llm-rubric
  assertion (metric F3.4-rubric); this file is the mechanical pre-gate.

Input: context.vars["skill_path"] (preferred) or the assertion output text.
"""

import re


BLACKLIST = [
    "superposition", "sanity check", "ballpark", "under the hood",
    "corner case", "rule of thumb", "grey area", "gray area", "no-brainer",
    "move the needle", "boil the ocean", "hit the ground running",
    "elephant in the room", "test balloon", "in one shot", "canary",
    "black box", "white box", "deep dive", "dogfood", "footgun",
    "silver bullet", "ball in your court",
]


def _strip(text):
    import re
    text = re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", " ", text)
    return text


def get_assert(output, context=None):
    import os, re
    path = (context or {}).get("vars", {}).get("skill_path")
    text = open(path).read() if path and os.path.exists(path) else (output or "")
    low = _strip(text).lower()

    hits = [p for p in BLACKLIST if re.search(r"\b" + re.escape(p) + r"\b", low)]
    ok = not hits
    reason = ("F3.4 literalism: " +
              (f"idiom/metaphor hit(s) {hits}; " if hits else "") +
              ("PASS" if ok else "FAIL"))
    return {"pass": ok, "score": 1.0 if ok else 0.0, "reason": reason}
