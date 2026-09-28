# Skill quality report — skills/delegate

Generated `2026-09-28T08:19:50.188Z` at `55a40280d705721e6ba5666bd232cd9d030fd425` by `bun test/skill/quality/build.ts` (see test/skill/HOW-TO.md).

**Q = 100 — band: SHIP** (ship ≥ 90, debt ≥ 80, else reject)

| Layer | Result | Detail |
|---|---|---|
| L0 pins | pass | 29 pins, 0 violations |
| L1 alignment | 100 / 100 (bar 90) | all keywords present |
| L2 projection | 100 / 100 (bar 70) | all scenarios 100/pass |
| L3 delta | clean → norm 100 | regressions: none; warnings: none; files 2c/0a/0r |
| L4 budgets | norm 100 | SKILL.md bytes 4648/6144; SKILL.md lines 67/90; REFERENCE.md bytes 13695/16384; REFERENCE.md lines 234/280 |

Composite: Q = 0.25*L1 + 0.35*L2 + 0.20*L3_norm + 0.20*L4_norm (L0 fail => 0) with weights {"l1":0.25,"l2":0.35,"l3":0.2,"l4":0.2}.

## L1 per claim

| claim | severity | weight | score | weighted | missing |
|---|---|---|---|---|---|
| completion-report-file | blocker | 31.25 | 1 | 31.25 | — |
| retry-new-name | blocker | 18.75 | 1 | 18.75 | — |
| placement-sub-orchestrator | major | 12.5 | 1 | 12.5 | — |
| probe-no-report | major | 6.25 | 1 | 6.25 | — |
| timeout-end-turn | blocker | 18.75 | 1 | 18.75 | — |
| brief-output-rules | major | 12.5 | 1 | 12.5 | — |

Tool-only claims (documented with source, excluded from L1/L3 scoring per fixture v2): release-default (weight 20).

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

