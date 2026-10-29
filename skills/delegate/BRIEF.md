# BRIEF — the worker brief template

Read this file before you write each brief. A brief is the worker's whole world:
it has no context beyond this text.

## The template

Copy the skeleton per worker. Keep the B-code headers verbatim.

## B1 — Goal

One or two sentences: the measurable outcome. State the number, path, or format
that defines done.

## B2 — Inputs

Explicit paths and refs; file pointers only. Paste nothing the worker can read.

## B3 — Acceptance

A numbered checklist. Each item is pass/fail-testable without the worker's
summary. This is the done criteria; write it as the worker will be graded.

## B4 — Evidence required

The files and commands the report must cite to prove B3. No proof, no pass.

## B5 — Out of scope

What lies outside the mandate. Name the forbidden surface explicitly.

## B6 — Stop conditions

The worker MUST ask instead of guess when:

- E1: the brief contradicts itself, or two acceptance items cannot both hold.
- E2: the next step needs authority the worker lacks.
- E3: the worker cannot state pass or scope in one sentence.

The mailbox carries questions, never status.

## B7 — Report contract

One line: the tool prompt owns the report format. The brief stays name-agnostic;
never paste report JSON.

MAY add: Role, Budget, Method. B1–B7 is the minimum.

## Language rules

The worker reads literally and cannot ask until a stop condition fires.

1. Write commands in the imperative, one command per sentence.
2. Repeat the noun instead of a pronoun: "the config file", not "it".
3. Mark hard rules with MUST or NEVER. Keep SHOULD for defaults, and name the
   exception path next to it.
4. State the condition before the command: "If the build fails, fix the errors."
5. No idioms, no metaphors; state the literal condition.
6. Name numbers, paths, and formats explicitly. "Short", "properly", and
   "reasonable" anchor nothing.

## Structural anchors

The B-code headers are the worker's attention anchors.

1. Keep the B-code labels verbatim; the worker's report cites them (B3, B4).
2. Put the most critical constraint in B1 or B6; a rule stated only in the
   middle gets lost.
3. One section, one topic.
4. Risky changes carry the verbatim artifact (exact text or exact fix shape)
   in a quoted block.
