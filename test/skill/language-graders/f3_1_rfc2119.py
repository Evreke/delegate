"""F3.1 rfc2119-keywords — named rubric grader (deterministic pre-gate).

Rule enforced (brief-evaluator.md acceptance F3.1; V2-DESIGN-CONSTRAINTS §4):
RFC 2119/8174 keyword discipline. MUST / MUST NOT / SHOULD / MAY are the only
obligation markers. Imperatives outside the keywords are commands, not soft
suggestions. The phrases "try to", "make sure", "if possible" are forbidden.

Pass rule (explicit):
  PASS iff, outside the frontmatter, fenced code blocks, and inline code
  spans, all of the following hold:
    (a) none of these soft-imperative phrases appears (case-insensitive):
        "try to", "make sure", "if possible", "attempt to",
        "as much as possible", "be sure to", "don't forget to",
        "it is recommended";
    (b) no lowercase "must" or "shall" appears (RFC 8174: a lowercase modal
        carries no force, so an obligation written in lowercase is a broken
        keyword).
  Lowercase "should" and "may" are counted and reported in the reason but do
  not fail this gate: epistemic and normative uses are not separable without
  a model. The paired llm-rubric assertion (metric F3.1-rubric) judges the
  remainder.

Input: context.vars["skill_path"] (preferred) or the assertion output text.
"""

import re



def _strip(text):
    text = re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)  # frontmatter
    text = re.sub(r"```.*?```", " ", text, flags=re.S)                  # fenced blocks
    text = re.sub(r"`[^`\n]*`", " ", text)                              # inline code
    return text


def get_assert(output, context=None):
    import os, re
    path = (context or {}).get("vars", {}).get("skill_path")
    text = _strip(open(path).read() if path and os.path.exists(path) else (output or ""))
    low = text.lower()

    forbidden = ["try to", "make sure", "if possible", "attempt to",
                 "as much as possible", "be sure to", "don't forget to",
                 "it is recommended"]
    hits_a = [p for p in forbidden if p in low]
    hits_b = re.findall(r"\b(?:must|shall)\b", text)  # regex is case-sensitive here
    soft = re.findall(r"\b(?:should|may)\b", text)    # reported, not failing

    ok = not hits_a and not hits_b
    reason = ("F3.1 RFC 2119/8174: " +
              (f"soft-imperative phrases {hits_a}; " if hits_a else "") +
              (f"lowercase obligation modals {sorted(set(hits_b))}; " if hits_b else "") +
              (f"lowercase should/may count (advisory): {len(soft)}. " if soft else "") +
              ("PASS" if ok else "FAIL"))
    return {"pass": ok, "score": 1.0 if ok else 0.0, "reason": reason}
