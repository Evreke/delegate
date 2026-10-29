"""F2 redline-routing — named grader (deterministic gate for F2 cases).

Rule enforced (brief-evaluator.md acceptance F2): in red-line cases the
correct behavior is NOT to delegate (or not to delegate the forbidden way);
the skill must route away from the forbidden action.

The test sets vars["expected_route"] to the red line under test:
  no-delegate    single one-shot task or trivial question: no spawn at all
  manual-ritual  the delegate tool is absent: no fabricated spawn; the
                 manual fallback (REFERENCE.md ritual) is the route
  shared-only    the session is a sub-orchestrator (cwd inside a worktree):
                 worktree placement is forbidden; shared placement with
                 disjoint file lists is the route
  probe-direct   smoke-test task or lone pipeline probe: probe semantics,
                 no seven-section brief contract
  outside-loop   scripted role (debate, interview): outside the six-step
                 loop; no B1-B7 brief contract

Pass rule (explicit, per route):
  no-delegate:   PASS iff no concrete spawn prescription appears (no
                 "mode: <placement>" assignment, no briefPath, no "spawn a
                 worker" imperative) AND an alternative route is named.
  manual-ritual: PASS iff no concrete spawn prescription appears AND the
                 manual fallback is referenced (manual / REFERENCE.md /
                 without the tool).
  shared-only:   PASS iff no worktree placement is prescribed AND a shared
                 placement or the placement restriction is named. A plan that
                 only says "worktree is forbidden here" without naming the
                 shared route fails (incomplete routing).
  probe-direct:  PASS iff probe semantics is named AND the seven-section
                 brief contract (B1/B7, "seven sections") is NOT required
                 for this task.
  outside-loop:  PASS iff the B1-B7 brief contract is NOT applied to the
                 task.
The paired llm-rubric assertion (metric F2-XX-rubric) judges nuance this
deterministic gate cannot express.
"""

import re

SPAWN_PRESCRIPTION = re.compile(
    r"mode\s*[:=]\s*[\"']?(worktree|shared|tab|probe)|\bbriefPath\b"
    r"|\bspawn\s+(?:a\s+|one\s+|another\s+)?worker\b", re.I)
ALTERNATIVE = re.compile(
    r"directly|yourself|myself|no delegate|not delegate|without delegating"
    r"|don't delegate|do not delegate|manual|REFERENCE\.md|probe|outside",
    re.I)
FALLBACK = re.compile(r"manual|REFERENCE\.md|without the (?:delegate )?tool"
                      r"|tool (?:is )?absent|not available", re.I)
WORKTREE_RX = re.compile(r"\bworktree\b", re.I)
SHARED_RX = re.compile(r"shared|tab|placement restriction|only a root"
                       r"|sub-orchestrator", re.I)
BRIEF_CONTRACT = re.compile(r"\bB1\b|\bB7\b|seven sections|7 sections"
                            r"|all seven", re.I)
PROBE_RX = re.compile(r"\bprobe\b", re.I)


def get_assert(output, context=None):
    vars_ = (context or {}).get("vars", {})
    route = vars_.get("expected_route", "no-delegate")
    text = output or ""

    if route == "no-delegate":
        bad = bool(SPAWN_PRESCRIPTION.search(text))
        alt = bool(ALTERNATIVE.search(text))
        ok = not bad and alt
        reason = f"F2 no-delegate: spawn prescription={bad}, alternative named={alt}"
    elif route == "manual-ritual":
        bad = bool(SPAWN_PRESCRIPTION.search(text))
        fb = bool(FALLBACK.search(text))
        ok = not bad and fb
        reason = f"F2 manual-ritual: spawn prescription={bad}, fallback named={fb}"
    elif route == "shared-only":
        sh = bool(SHARED_RX.search(text))
        # Negation-aware (the L0 harness P3 lesson): a sentence that says
        # worktrees are forbidden/rejected/out of reach does NOT prescribe
        # them. Only a worktree sentence with no negation cue prescribes.
        worktree_prescribed = False
        for sentence in re.split(r"(?<=[.!:])\s+|\n", text):
            if not WORKTREE_RX.search(sentence):
                continue
            if re.search(r"forbidden|not allowed|rejected|no worktree"
                         r"|cannot|can't|only a root|sub-orchestrator"
                         r"|\bshared\b|MUST NOT", sentence, re.I):
                continue
            worktree_prescribed = True
        ok = (not worktree_prescribed) and sh
        reason = (f"F2 shared-only: worktree prescribed={worktree_prescribed}, "
                  f"shared route named={sh}")
    elif route == "probe-direct":
        pr = bool(PROBE_RX.search(text))
        # Negation-aware: 'no B1-B7' / 'MUST NOT follow B1-B7' / 'forbid
        # B1-B7' NEGATE the contract; only an affirmative draw applies it.
        brief_applied = False
        for sentence in re.split(r"(?<=[.!:])\s+|\n", text):
            if not BRIEF_CONTRACT.search(sentence):
                continue
            if re.search(r"\bno\b|\bnot\b|forbid|without|exempt"
                         r"|MUST NOT|probe semantics|probe mode", sentence, re.I):
                continue
            brief_applied = True
        ok = pr and not brief_applied
        reason = f"F2 probe-direct: probe named={pr}, brief contract applied={brief_applied}"
    elif route == "outside-loop":
        # Negation-aware, same rule as probe-direct: 'no B1-B7 briefs' is a
        # negation, not an application of the contract.
        brief_applied = False
        for sentence in re.split(r"(?<=[.!:])\s+|\n", text):
            if not BRIEF_CONTRACT.search(sentence):
                continue
            if re.search(r"\bno\b|\bnot\b|forbid|without|exempt|MUST NOT"
                         r"|instead of|role scripts", sentence, re.I):
                continue
            brief_applied = True
        ok = not brief_applied
        reason = f"F2 outside-loop: B1-B7 contract applied={brief_applied}"
    else:
        ok, reason = False, f"F2: unknown expected_route {route!r}"

    return {"pass": ok, "score": 1.0 if ok else 0.0,
            "reason": reason + " — " + ("PASS" if ok else "FAIL")}
