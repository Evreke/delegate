# How to run the skill-quality harness (L0–L4 + Q)

The harness measures `skills/delegate/` (SKILL.md + REFERENCE.md) against the
real tool-contract fixture `test/skill/tool-contract.json`. All commands run
from the repo root. Thresholds and weights live in ONE constants module:
`test/skill/quality/constants.ts` (L1 bar, L4 budgets, Q weights, bands);
the L2 pass bar (70) lives in the stage-1 rubric `test/skill/runner/rubric.ts`
and is re-exported from the constants module for one-stop discovery.

## Layers

| Layer | What it measures | Command |
|---|---|---|
| L0 | static pins on the skill text (issue #110 minimums) | `timeout 30 bun test/skill-l0-check.ts` |
| L1 | alignment of the skill text to the tool-contract fixture (0–100; blocker = weight ≥ 10 claim at 0) | `timeout 30 bun test/skill/l1/score.ts score --fixture test/skill/tool-contract.json --skill-dir skills/delegate` |
| L2 | scenario set S01–S12 scored against a static text projection of the skill (live replay traces remain the behavioral layer) | part of the report builder below |
| L3 | before/after regression delta over the fixture's blocker claims (`--before` is a git rev; default `629a030^`, the pre-rewrite skill) | part of the report builder below |
| L4 | size budgets per file (bytes + lines) | part of the report builder below |
| Q | `0.25·L1 + 0.35·L2 + 0.20·L3_norm + 0.20·L4_norm`; an L0 fail forces Q = 0. Bands: ≥ 90 ship · 80–89 debt · else reject | part of the report builder below |

## The report artifact (BM-7)

```bash
timeout 60 bun test/skill/quality/build.ts
# writes test/skill/quality-report.json + test/skill/quality-report.md
# (defaults; override with --skill-dir/--fixture/--scenarios/--before/
#  --out-json/--out-md — exit 0 writes the report; verdicts are data)
```

The committed `test/skill/quality-report.*` files are this command's output
for the current skill text — regenerate and commit them together with any
skill edit (same commit).

## CI wiring

`test/skill-l0-check.ts` and `test/skill-quality-check.ts` are FLAT
`test/*.ts` files, so `test/run-checks.sh` (and therefore CI, which invokes
exactly that runner) discovers them automatically — L0 on CI for skill paths
is satisfied without workflow edits. `skill-quality-check` pins the
mechanics and determinism of the pipeline plus one real-text tripwire (see
below); the current verdict band is deliberately NOT a CI gate — it is data
in the report artifact.

## Editing the skill or the harness

- **Skill edit** → re-run the L0 gate and the builder; if an L2 expect-anchor
  or L0 require-pin no longer matches, re-derive that anchor/pin in the same
  commit (`test/skill/quality/l2-text.ts` / `test/skill/l0/pins.ts` — each
  row cites its source). The quality-check tripwire fails CI otherwise.
- **Fixture edit** → weights must keep summing to 100; keyword liveness is
  case-insensitive substring (same rule as the stage-1 L3 delta).
- **Budgets/thresholds** → `test/skill/quality/constants.ts` only.

## Known limitations (by design)

- The L2 number is a STATIC text projection: it proves the skill TEACHES each
  scenario's expected moves, not that a live orchestrator performs them.
  Four forbid tags are contextual (wrong only inside their scenario — e.g.
  S12 forbids `tool:delegate` because the tool is absent there) and are dead
  zones in the projection; the behavioral verdict for them belongs to stage-1
  replay traces (`test/skill/runner/`), not to this harness.
- The L3 layer reuses the stage-1 delta (`test/skill/l3/skill-delta.ts`);
  `--before` needs the git rev present locally (no network fetch).
