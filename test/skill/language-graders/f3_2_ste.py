"""F3.2 ste-sentences — named rubric grader (deterministic pre-gate).

Rule enforced (brief-evaluator.md acceptance F3.2; V2-DESIGN-CONSTRAINTS §4):
STE sentence rules, ASD-STE100 style. At most 25 words per sentence. Active
voice. One instruction per sentence. No noun chains longer than 3 words.

Pass rule (explicit, deterministic part):
  PASS iff, in prose (frontmatter, fenced code blocks, inline code spans,
  table markup, and list/heading markers removed), all of the following hold:
    (a) every sentence has at most 25 words (a sentence ends at . ! ? or the
        line end; a bullet item is one sentence);
    (b) no passive-voice construction (be + past participle) outside sentences
        that start with "Done when" — a done-state names a resulting state,
        the active-voice rule governs instructions;
    (c) no run of 4 or more consecutive capitalized words (proper-noun noun
        chain proxy).
  One-instruction-per-sentence and general noun chains are not decidable
  without a model; the paired llm-rubric assertion (metric F3.2-rubric)
  judges them. This file is the mechanical pre-gate.

Input: context.vars["skill_path"] (preferred) or the assertion output text.
"""

import re



def _prose_sentences(text):
    import re
    text = re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.S)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", " CODE ", text)
    out = []
    for line in text.splitlines():
        line = re.sub(r"^\s*[-*]\s+", "", line)
        line = re.sub(r"^\s*\d+\.\s+", "", line)
        line = re.sub(r"^#+\s*", "", line)
        line = line.replace("**", "")
        if not line.strip() or line.strip().startswith(("|", ">")):
            continue
        for s in re.split(r"(?<=[.!?])\s+", line.strip()):
            if s.strip():
                out.append(s.strip())
    return out


def get_assert(output, context=None):
    import os, re
    path = (context or {}).get("vars", {}).get("skill_path")
    text = open(path).read() if path and os.path.exists(path) else (output or "")
    sents = _prose_sentences(text)

    long_sents = [(len(s.split()), s[:80]) for s in sents if len(s.split()) > 25]
    passive = [s[:80] for s in sents
               if not s.lower().startswith("done when")
               and re.search(r"\b(?:is|are|was|were|be|been|being)\s+\w+(?:ed|en)\b", s, re.I)]
    chains = [m.group(0)[:80] for m in
              re.finditer(r"\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*){3,}\b",
                          " ".join(sents))]

    ok = not long_sents and not passive and not chains
    reason = ("F3.2 STE sentences: " +
              (f"{len(long_sents)} sentence(s) over 25 words {long_sents[:3]}; " if long_sents else "") +
              (f"{len(passive)} passive construction(s) {passive[:3]}; " if passive else "") +
              (f"{len(chains)} noun-chain proxy hit(s) {chains[:3]}; " if chains else "") +
              ("PASS" if ok else "FAIL"))
    return {"pass": ok, "score": 1.0 if ok else 0.0, "reason": reason}
