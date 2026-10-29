"""F3.5 verifiability — named rubric grader (deterministic pre-gate).

Rule enforced (brief-evaluator.md acceptance F3.5; V2-DESIGN-CONSTRAINTS §4):
Verifiability, ISO/IEC/IEEE 29148 style. Every acceptance or done criterion
is testable. Vague qualifiers are forbidden outside quoted material:
"properly", "appropriately", "reasonable", "etc." and their close family.

Pass rule (explicit, deterministic part):
  PASS iff, outside fenced code blocks, inline code spans, and the
  frontmatter, none of these vague qualifiers appears (case-insensitive):
    properly, appropriately, reasonable, reasonably, adequate, adequately,
    sufficiently, etc., as needed, if necessary, significantly, robust,
    elegant, seamless, user-friendly, optimally, "in a timely manner".
  Quoted material = inline code spans and double-quoted spans (a criterion
  may quote a vague phrase to forbid it).
  Vagueness that a fixed list cannot catch is judged by the paired
  llm-rubric assertion (metric F3.5-rubric).

Input: context.vars["skill_path"] (preferred) or the assertion output text.
"""

import re


VAGUE = [
    "properly", "appropriately", "reasonable", "reasonably", "adequate",
    "adequately", "sufficiently", "etc.", "as needed", "if necessary",
    "significantly", "robust", "elegant", "seamless", "user-friendly",
    "optimally", "in a timely manner",
]


def _strip_keep_quotes(text):
    import re
    text = re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", " ", text)
    text = re.sub(r'"[^"\n]*"', " ", text)  # quoted material is exempt
    return text


def get_assert(output, context=None):
    import os, re
    path = (context or {}).get("vars", {}).get("skill_path")
    text = open(path).read() if path and os.path.exists(path) else (output or "")
    low = _strip_keep_quotes(text).lower()

    hits = [p for p in VAGUE if re.search(r"\b" + re.escape(p) + r"\b", low)]
    ok = not hits
    reason = ("F3.5 verifiability: " +
              (f"vague qualifier(s) {hits}; " if hits else "") +
              ("PASS" if ok else "FAIL"))
    return {"pass": ok, "score": 1.0 if ok else 0.0, "reason": reason}
