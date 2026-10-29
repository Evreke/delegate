# Skill quality report — skills/delegate

Generated `2026-10-29T11:48:24.733Z` at `d5275a42eb3140dafb6982106d9ea3e8994ce42b` by `bun test/skill/quality/build.ts` (see test/skill/HOW-TO.md).

**Q = 93.44 — band: SHIP** (ship ≥ 90, debt ≥ 80, else reject)

| Layer | Result | Detail |
|---|---|---|
| L0 pins | pass | 29 pins, 0 violations |
| L1 alignment | 96.88 / 100 (bar 90) | placement-sub-orchestrator missing: share its checkout |
| L2 projection | 90.63 / 100 (bar 70) | all scenarios 100/pass |
| L3 delta | clean → norm 87.5 | regressions: none; warnings: placement-sub-orchestrator; files 1c/0a/0r |
| L4 budgets | norm 100 | SKILL.md bytes 5323/6400; SKILL.md lines 128/160; REFERENCE.md bytes 11041/16384; REFERENCE.md lines 204/280; BRIEF.md bytes 2341/3072; BRIEF.md lines 72/96 |

Composite: Q = 0.25*L1 + 0.35*L2 + 0.20*L3_norm + 0.20*L4_norm (L0 fail => 0) with weights {"l1":0.25,"l2":0.35,"l3":0.2,"l4":0.2}.

## L1 per claim

| claim | severity | weight | score | weighted | missing |
|---|---|---|---|---|---|
| completion-report-file | blocker | 31.25 | 1 | 31.25 | — |
| retry-new-name | blocker | 18.75 | 1 | 18.75 | — |
| placement-sub-orchestrator | major | 12.5 | 0.75 | 9.38 | share its checkout |
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
| S04 | 90 | pass | release:on-settle | — |
| S05 | 100 | pass | — | — |
| S06 | 85 | pass | brief:diagnosed-retry | — |
| S07 | 100 | pass | — | — |
| S08 | 85 | pass | report:status-fail-honored | — |
| S09 | 77.5 | pass | turn:end-after-fleet, brief:file-first | — |
| S10 | 85 | pass | brief:diagnosed-retry | — |
| S11 | 80 | pass | wait:wake-tool | — |
| S12 | 85 | pass | brief:file-first | — |

