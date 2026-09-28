# Skill quality report — skills/delegate

Generated `2026-09-28T07:51:02.887Z` at `851627adca86e1f831d3a7b1d5ad4886c9e588e6` by `bun test/skill/quality/build.ts` (see test/skill/HOW-TO.md).

**Q = 74.69 — band: REJECT** (ship ≥ 90, debt ≥ 80, else reject)

| Layer | Result | Detail |
|---|---|---|
| L0 pins | pass | 29 pins, 0 violations |
| L1 alignment | 78.75 / 100 (bar 90) | release-default missing: started, releaseOn; retry-new-name missing: r2; placement-sub-orchestrator missing: E_PLACE; timeout-end-turn missing: E_TIMEOUT |
| L2 projection | 100 / 100 (bar 70) | all scenarios 100/pass |
| L3 delta | BLOCKER REGRESSION → norm 0 | regressions: release-default, retry-new-name, timeout-end-turn; warnings: placement-sub-orchestrator; files 2c/0a/0r |
| L4 budgets | norm 100 | SKILL.md bytes 4648/6144; SKILL.md lines 67/90; REFERENCE.md bytes 13695/16384; REFERENCE.md lines 234/280 |

Composite: Q = 0.25*L1 + 0.35*L2 + 0.20*L3_norm + 0.20*L4_norm (L0 fail => 0) with weights {"l1":0.25,"l2":0.35,"l3":0.2,"l4":0.2}.

## Blockers / findings

- L3 blocker regression release-default — missing keywords: started, releaseOn
- L3 blocker regression retry-new-name — missing keywords: r2
- L3 blocker regression timeout-end-turn — missing keywords: E_TIMEOUT

## L1 per claim

| claim | severity | weight | score | weighted | missing |
|---|---|---|---|---|---|
| release-default | blocker | 20 | 0.5 | 10 | started, releaseOn |
| completion-report-file | blocker | 25 | 1 | 25 | — |
| retry-new-name | blocker | 15 | 0.67 | 10 | r2 |
| placement-sub-orchestrator | major | 10 | 0.75 | 7.5 | E_PLACE |
| probe-no-report | major | 5 | 1 | 5 | — |
| timeout-end-turn | blocker | 15 | 0.75 | 11.25 | E_TIMEOUT |
| brief-output-rules | major | 10 | 1 | 10 | — |

## L2 per scenario (static text projection)

| scenario | total | verdict | missed | forbidden hits |
|---|---|---|---|---|
| S01 | 100 | pass | — | — |
| S02 | 100 | pass | — | — |
| S03 | 100 | pass | — | — |
| S04 | 100 | pass | — | — |
| S05 | 100 | pass | — | — |
| S06 | 100 | pass | — | — |
| S07 | 100 | pass | — | — |
| S08 | 100 | pass | — | — |
| S09 | 100 | pass | — | — |
| S10 | 100 | pass | — | — |
| S11 | 100 | pass | — | — |
| S12 | 100 | pass | — | — |

