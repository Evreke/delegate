"""F3.3 vocabulary — named rubric grader (deterministic pre-gate).

Rule enforced (brief-evaluator.md acceptance F3.3; V2-DESIGN-CONSTRAINTS §4):
Vocabulary discipline, ISO 24495-1 style. One term per concept; a concept is
never renamed mid-text (worker / report / brief stay fixed); every internal
code (B1-B7, E1-E3, V1-V3) is defined at its point of use.

Pass rule (explicit, deterministic part):
  PASS iff, outside fenced code blocks, inline code spans, and the
  frontmatter, all of the following hold:
    (a) no forbidden synonym of a fixed concept appears (case-insensitive,
        word-boundary). Fixed concepts and forbidden synonyms:
          worker  <- agent (except the exact tool-owned collocation
                     "agent status"), child, minion, resource, actor, unit
          brief   <- "spec file", "prompt file", "instruction file",
                     "task file", "job file"
          report  <- "output file", "result file", "answer file"
          orchestrator <- supervisor, driver, controller, boss
          probe   <- canary, "test balloon", "dry run"
    (b) every internal code token (B1..B7, E1..E3, V1..V3, word-bounded,
        uppercase) carries a definition marker at its first occurrence: one
        of ":", "—", " - ", " means", " is " within 80 characters after the
        token.
  Renaming that only a model can catch (a paraphrase outside the synonym
  list) is judged by the paired llm-rubric assertion (metric F3.3-rubric).

Input: context.vars["skill_path"] (preferred) or the assertion output text.
"""

import re


CONCEPT_SYNONYMS = [
    (r"\bagents?\b", "worker", ("agent status",)),
    (r"\bchildren\b|\bchild\b", "worker", ()),
    (r"\bminions?\b|\bresources?\b|\bactors?\b|\bunits?\b", "worker", ()),
    (r"\bspec files?\b|\bprompt files?\b|\binstruction files?\b|\btask files?\b|\bjob files?\b", "brief", ()),
    (r"\boutput files?\b|\bresult files?\b|\banswer files?\b", "report", ()),
    (r"\bsupervisors?\b|\bdrivers?\b|\bcontrollers?\b|\bboss(?:es)?\b", "orchestrator", ()),
    (r"\bcanar(?:y|ies)\b|\btest balloons?\b|\bdry runs?\b", "probe", ()),
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
    body = _strip(text)

    renames = []
    for pat, concept, allow in CONCEPT_SYNONYMS:
        for m in re.finditer(pat, body, re.I):
            window = body[max(0, m.start() - 20):m.end() + 20].lower()
            if any(a in window for a in allow):
                continue
            renames.append((m.group(0), concept))

    undefined = []
    for m in re.finditer(r"\b(B[1-7]|E[1-3]|V[1-3])\b", body):
        tail = body[m.end():m.end() + 80]
        if not re.search(r"[:—]| - | means | is ", tail):
            undefined.append(m.group(1))

    ok = not renames and not undefined
    reason = ("F3.3 vocabulary: " +
              (f"concept renamed mid-text {renames[:5]}; " if renames else "") +
              (f"code(s) without point-of-use definition {sorted(set(undefined))}; " if undefined else "") +
              ("PASS" if ok else "FAIL"))
    return {"pass": ok, "score": 1.0 if ok else 0.0, "reason": reason}
