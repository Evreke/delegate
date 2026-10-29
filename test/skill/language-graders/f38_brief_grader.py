#!/usr/bin/env python3
"""F3.8 — brief-contract grader (deterministic pre-gate).

Two modes:
  template  — target is skills/delegate/BRIEF.md: the template must define the
              B1-B7 skeleton and obey the language rules it preaches.
  brief     — target is a generated worker brief: the skeleton must be present
              verbatim and the language rules must hold.

Rule enforced (EVAL-PLAN-v2.2.md F3.8; skills/delegate/BRIEF.md):
  PASS iff
    (1) B-skeleton: headers B1..B7 present, each exactly once, in order, with
        the canonical labels (B1 - Goal, B2 - Inputs, B3 - Acceptance,
        B4 - Evidence required, B5 - Out of scope, B6 - Stop conditions,
        B7 - Report contract);
    (2) language: banned soft markers absent outside quoted spans (try to,
        make sure, if possible, properly, reasonable, etc., bare should);
        no sentence over 25 words outside frontmatter/quoted spans;
        no concept renames (agent/child/minion for worker; spec/prompt/job/
        instruction/task file for brief; output/result/answer file for report);
    (3) measurability: B1 carries a measurable-outcome marker (a digit, a path,
        or the words number/count/file/verdict/format).

Input: argv[1] = brief file path; argv[2] = mode ("template"|"brief"),
default "brief".
Output: violations, one per line; exit 0 = pass, 1 = fail.
"""

import re
import sys

CANON = [
    ("B1", "Goal"),
    ("B2", "Inputs"),
    ("B3", "Acceptance"),
    ("B4", "Evidence required"),
    ("B5", "Out of scope"),
    ("B6", "Stop conditions"),
    ("B7", "Report contract"),
]

BANNED = [
    r"\btry to\b",
    r"\bmake sure\b",
    r"\bif possible\b",
    r"\bproperly\b",
    r"\breasonable\b",
    r"\betc\.",
    r"\bshould\b",
]

RENAME = [
    (r"\bagents?\b(?!.{0,20}status)", "worker"),
    (r"\bchild\b", "worker"),
    (r"\bminion\b", "worker"),
    (r"\bspec file\b", "brief"),
    (r"\bprompt file\b", "brief"),
    (r"\bjob file\b", "brief"),
    (r"\binstruction file\b", "brief"),
    (r"\btask file\b", "brief"),
    (r"\boutput file\b", "report"),
    (r"\bresult file\b", "report"),
    (r"\banswer file\b", "report"),
]

MEASURE = re.compile(r"\d|/|number|count|file|verdict|format", re.I)


def strip_quoted(text: str) -> str:
    text = re.sub(r"`[^`]*`", "``", text)
    return re.sub(r'"[^"]*"', '""', text)


def prose(text: str) -> str:
    """Body without frontmatter and heading lines; sentences never span headers."""
    body = re.sub(r"^---.*?---", "", text, flags=re.S)
    lines = [ln for ln in body.splitlines() if not re.match(r"^#{1,6}\s", ln)]
    return "\n".join(lines)


def main() -> int:
    path, mode = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "brief")
    raw = open(path, encoding="utf-8").read()
    text = strip_quoted(raw)
    violations: list[str] = []

    # (1) B-skeleton — presence and order (codes are citation keys; repeats in
    # prose are the citation web, not defects)
    headers = re.findall(r"^#{1,3}\s+B([1-7])\b[^\n]*", text, re.M)
    codes = [f"B{h}" for h in headers]
    expected = [c for c, _ in CANON]
    if codes != expected:
        violations.append(
            f"skeleton: found {codes or 'none'}, expected {expected} in order"
        )
    if mode == "template":
        for code, label in CANON:
            if not re.search(rf"{code}[^\n]*{re.escape(label.split()[0])}", text):
                violations.append(f"skeleton: {code} label does not name '{label}'")

    # (2) language
    flat = re.sub(r"\s+", " ", prose(text))
    for pat in BANNED:
        for m in re.finditer(pat, flat, re.I):
            if pat == r"\bshould\b" and mode == "template" and "SHOULD" in raw:
                continue
            violations.append(f"language: banned marker /{pat}/ near '{flat[max(0,m.start()-30):m.end()+30]}'")
    for pat, term in RENAME:
        for m in re.finditer(pat, flat, re.I):
            violations.append(f"language: rename '{m.group(0)}' for fixed term '{term}'")
    for s in re.split(r"(?<=[.!?])\s+", flat):
        words = s.split()
        if len(words) > 25 and not re.match(r"^[-*]\s", s):
            violations.append(f"language: {len(words)}-word sentence: {s[:80]}...")

    # (3) measurability of B1 (brief mode and template both)
    m = re.search(r"B1[^\n]*\n(.*?)(?=\n## |\n### |\Z)", text, re.S)
    b1 = m.group(1) if m else ""
    if not MEASURE.search(b1):
        violations.append("measurability: B1 has no digit, path, or explicit format word")

    for v in violations:
        print(f"F3.8 {mode}: {v}")
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
