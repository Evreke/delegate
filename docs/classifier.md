# classifier — display-only triage on validated worker reports

Status: DRAFT

The classifier is an opt-in, flag-gated heuristic that adds a single
display-only triage note to the `delegate` tool result after a worker report
has been collected and accepted by report-schema validation. It never gates,
rejects, wakes or retires anything.

## What it does

- After a report passes report-schema validation in the collect path, one
  `choice` classification runs over the report's `status`, `summary` and
  `artifacts`:
  - Question: *"Is this report a genuine, honest completion of the briefed
    task?"*
  - Labels: `complete` / `suspect`.
- The verdict is appended to the tool result as a note:
  - `classifier: complete 0.93`
  - `classifier: suspect 0.41`
- The note always carries the probability (rounded to two decimals). There is
  no threshold in M1 — a `suspect` label is shown exactly like a `complete`
  one, and neither changes the tool result's outcome.
- The classification is **advisory display, never a gate**: it does not
  affect `status`, does not suppress the report, and does not change what
  collect returns.

## Enabling it

Add a top-level `classifier` section to
`~/.pi/agent/pi-delegate.config.json`:

```json
{
  "classifier": {
    "enabled": true,
    "model": {
      "provider": "<PROVIDER>",
      "id": "<MODEL_ID>"
    }
  }
}
```

- `classifier.enabled` — boolean, **default `false`**. Only an exact `true`
  enables the feature; anything else (missing, `false`, garbage) leaves it
  off.
- `classifier.model` — `{ "provider": "...", "id": "..." }`, **no default**.
  The feature stays disabled unless both `provider` and `id` are non-empty
  strings — even when `enabled` is `true`, an absent or incomplete model
  object is a silent no-op.
- Like every config section, `classifier` is read tolerantly: a missing,
  corrupt or partial section degrades to the disabled fallback and never
  throws. A config profile that carries its own `classifier` section replaces
  the base one wholesale, per the standard top-level section-merge rule.

## When the classifier is unavailable

**Silent skip.** When the feature is disabled, the model is not present in
the model registry, the router is down, auth fails, the call times out, the
answer is not a `choice`, or the provider reports `stopReason: "error"`, the
note simply does not appear. The tool result is byte-identical to the
flag-off case — no warning, no placeholder, no error surfaced to the
orchestrator.

The resolver and the classifier are total: the failure shapes above all
degrade to "off" and never throw or reject.

## Cost and latency

- One inline classifier call, **~30–100 ms**, awaited in the collect path
  only. It runs after validation and never blocks spawn, mailbox or watcher
  work.
- One call per validated report; there is no background or asynchronous
  triage, and no calls are made while the feature is disabled or the model
  cannot be resolved.
- Provider token cost is the cost of a single small `choice` classification
  over the report text, billed through the configured model.

## Non-goals (M1)

M1 is strictly the display note described above. It deliberately does **not**:

- apply any threshold to the probability (thresholds are a later round);
- auto-reject, auto-accept or otherwise alter a report's outcome;
- advise on tier or model selection;
- make wake, retire or teardown decisions;
- run asynchronously or in the background.

Anything beyond the display note is out of scope for this milestone and must
not be inferred from the note's presence.

Status: DRAFT
