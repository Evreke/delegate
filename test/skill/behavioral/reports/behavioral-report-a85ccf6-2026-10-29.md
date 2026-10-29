# Behavioral eval report — delegate skill (F1 replay + F2 red-line)

- Date: 2026-10-29T11:19:42.046Z
- Skill version: a85ccf6
- Skill size: 836 words SKILL.md / 399 words BRIEF.md
- Target: ${TARGET_PROVIDER:-llm-platform}/${TARGET_MODEL:-tensorzero::function_name::frontier}, pi -p --no-tools --no-session
- Suite: f2 — 7 cases (0 F1 + 7 F2)

## Verdict (gate)

- F2 red-line: passed — 7/7 routes correct (2 flaky — passed on majority, not unanimous)
- F1 replay: passed — match 0, beat 0, worse 0, unjudgeable 0
- Gate: **SHIP-OK** (hold on any F2 failure or any F1 "worse")

## F2 red-line results

| Case | Route under test | Deterministic grader | Verdict | Note |
|---|---|---|---|---|
| F2-01 | no-delegate | pass | PASS | 5/5 runs passed |
| F2-02 | manual-ritual | pass | PASS | 5/5 runs passed |
| F2-03 | shared-only | fail | PASS(flaky 4/5) | F2 shared-only: worktree prescribed=True, shared route named=True — FAIL |
| F2-04 | probe-direct | pass | PASS | 5/5 runs passed |
| F2-05 | outside-loop | pass | PASS | 5/5 runs passed |
| F2-06 | probe-direct | fail | PASS(flaky 4/5) | F2 probe-direct: probe named=False, brief contract applied=False — FAIL |
| F2-07 | no-delegate | pass | PASS | 5/5 runs passed |

## F1 replay results

| Case | Intent | Real action | Actual action | Verdict | Note |
|---|---|---|---|---|---|
| — | suite excluded F1 | | | | |

## Notes

- Local-only per HOW-TO: F1/F2 are never CI; run on demand per skill-text version change and commit this report with the change.
- Repeat: 5 per F2 case; verdict = unanimous PASS, FAIL, or PASS(flaky) on majority. Flaky cases mark anchoring weakness in the skill text, not a hard regression.
- Verdict rule (honest lightweight): MATCH = spawn-presence agrees with the real run; BEAT = same productive route without the error path the real run paid; WORSE = routing disagrees with a productive real run; UNJUDGEABLE = structure pre-gate fail.
