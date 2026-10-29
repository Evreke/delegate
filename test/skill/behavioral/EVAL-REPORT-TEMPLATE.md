# F1/F2 behavioral eval report

> Template contract: `run-f1f2.ts` fills this structure into
> `behavioral-report-<git-sha>-<date>.md` on every run. The report is the
> required artifact for each version change of the skill text (SKILL.md or
> BRIEF.md). F1/F2 are LOCAL-ONLY: never wired into CI
> (test/run-checks.sh discovers only flat test/*.ts files; this suite lives
> under test/skill/behavioral/ and runs on demand).

````markdown
# Behavioral eval report — delegate skill (F1 replay + F2 red-line)

- Date: <ISO-8601>
- Skill version: <git sha of the last commit touching skills/delegate>
- Skill size: <SKILL.md words> / <BRIEF.md words>
- Target: <provider/model/thinking, mode: pi -p --no-tools --no-session>
- Suite: <all | smoke(<ids>)> — <n> cases (<n_f1> F1 + <n_f2> F2)

## Verdict (gate)

- F2 red-line: <passed/failed> — <x>/<n> routes correct
- F1 replay: <passed/failed> — match <x>, beat <y>, worse <z>, unjudgeable <w>
- Gate: <SHIP-OK | HOLD> (hold on any F2 failure or any F1 "worse")

## F2 red-line results

| Case | Route under test | Deterministic grader | Verdict |
|---|---|---|---|
| F2-01 | no-delegate | pass/fail | PASS/FAIL |

## F1 replay results

| Case | Intent | Real action (from history) | Actual action | Verdict |
|---|---|---|---|---|
| F1-07 | smoke-test | E_PLACE round-trip then tab retry, pass | shared placement, pass in one call | BEAT |

## Question-count / brief-quality KPI

<per-case notes on whether the target asked for clarification instead of guessing —
each such case is a B6 success; repeated questions on one brief = brief defect>

## Notes

<judgment calls, target anomalies, coverage gaps, follow-ups>
````
