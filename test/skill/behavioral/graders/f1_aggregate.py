#!/usr/bin/env python3
"""f1_aggregate.py — F1 pass gate (CI post-step after `promptfoo eval`).

Rule enforced (brief-evaluator.md acceptance 3, the pass gate; brief B3 F1):
the F1 family gates a skill release on the beat-or-match rate against real
history. promptfoo asserts per case; the cross-case rate is not expressible
as a single per-test assertion (nearest-expressible note, eval-spec.md §E2),
so this script aggregates the per-case verdicts.

Usage:
  python3 f1_aggregate.py <promptfoo-output.json>

Input: promptfoo eval --output results.json. Each F1 case carries a
  llm-rubric assertion named by metric "F1-XX-rubric"; its pass/fail IS the
  beat-or-match verdict for case XX (the rubric text defines match-or-beat
  as pass, worse as fail).

Gate (exit 0 = release allowed, exit 1 = blocked):
  G3.1 worse verdicts (failed F1-XX-rubric) > 2 of 20 (>10%)  -> block
  G3.2 any smoke-test case (F1-02, F1-07, F1-20) failed        -> block
       (its rubric embeds: probe routing without the B1-B7 contract)
  G3.3 any minutes-short blocking case (F1-07, F1-13, F1-14) failed
       -> block (its rubric embeds: no end-turn-and-wait routing)
"""
import json, sys

SMOKE = {"F1-02", "F1-07", "F1-20"}
BLOCKING = {"F1-07", "F1-13", "F1-14"}
MAX_WORSE = 2  # 10% of 20


def main():
    data = json.load(open(sys.argv[1]))
    results = data.get("results", {}).get("results", [])
    verdicts = {}
    for r in results:
        test_id = (r.get("testCase") or {}).get("description", "")
        m = __import__("re").match(r"F1-(\d+)", test_id)
        if not m:
            continue
        cid = f"F1-{m.group(1)}"
        for a in r.get("gradingResult", {}).get("componentResults", []):
            a = a.get("assertion") or {}
            if str(a.get("metric", "")).endswith("-rubric") and a.get("metric", "").startswith(cid):
                verdicts[cid] = bool(a.get("pass"))
    missing = [f"F1-{i:02d}" for i in range(1, 21) if f"F1-{i:02d}" not in verdicts]
    worse = sorted(cid for cid, ok in verdicts.items() if not ok)
    blocks = []
    if len(worse) > MAX_WORSE:
        blocks.append(f"G3.1 worse verdicts {len(worse)}/20 > {MAX_WORSE}: {worse}")
    for cid in sorted(SMOKE & set(worse)):
        blocks.append(f"G3.2 smoke-test case {cid} failed (probe routing)")
    for cid in sorted(BLOCKING & set(worse)):
        blocks.append(f"G3.3 blocking case {cid} failed (wait routing)")
    if missing:
        blocks.append(f"incomplete suite: {len(missing)} case(s) without verdict: {missing}")

    print(f"F1 verdicts: {sum(verdicts.values())}/{len(verdicts)} beat-or-match; "
          f"worse: {worse or 'none'}")
    for b in blocks:
        print("BLOCK:", b)
    sys.exit(1 if blocks else 0)


if __name__ == "__main__":
    main()
