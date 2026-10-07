# ADR-0001: Worker session logs stay in pi-owned storage

Date: 2026-10-07 · Status: accepted (Stakeholder) ·
Docs: [ARCHITECTURE.md](../../ARCHITECTURE.md) §2, §9

## Context

pi-delegate-v2 Workers are headless pi child sessions; each produces a
session JSONL (its Stream). A verified platform investigation (2026-10-07,
primary sources: pi docs `sessions.md`/`cli.md`/`settings.md`, dist source,
live runs) proved that pi supports custom session directories as a
first-class pattern (`SessionManager.create(cwd, sessionDir?)`, env
`PI_CODING_AGENT_SESSION_DIR`, CLI `--session-dir`), with no functional
breakage — only loss of visibility in pi's default session world
(`listAll()`, plain `--resume`/`--continue`), which has working
replacements (`pi --session <abs-path>` from anywhere).

Two options were on the table:

- **A** — Worker JSONLs inside the Fleet exchange tree (single durable
  root holding the whole Fleet story; architect-recommended).
- **B** — Worker JSONLs in pi's default storage; the exchange tree holds
  only v2-owned artifacts; a Fleet manifest records pointers.

## Decision

**Option B.** The Stakeholder rejected A ("I am against A", 2026-10-07).
No full rationale was verbalized; the architect's reconstruction — recorded
here as reconstruction, not as the Stakeholder's words — is **ownership
separation**: pi owns and writes its session logs; v2 owns and writes only
its own artifacts (Briefs, Reports, Termination Records, manifest), and
touches pi's files exclusively through pi's API (custom entries). Option A
would blur that line by relocating pi-owned files into v2's tree.

## Consequences

- The **Fleet manifest is mandatory** (session paths are not derivable
  from session ids — verified): `name → { sessionId, sessionFile,
  workerCwd, spawnConfig, status, reason, resumeCommand? }`.
- Salvage is **two-location**: resumed Orchestrator session history →
  exchange root → manifest pointers → Streams in pi storage. All locations
  are durable across reboot (pi storage is home-dir based; the exchange
  root is required durable and configurable, never `/tmp`).
- Resume/salvage mechanics are unaffected by this choice — verified viable
  either way via `SessionManager.open(sessionFile)` +
  `createAgentSession({ sessionManager })`.
- Worktree deletion before resume triggers `MissingSessionCwdError` on
  guarded paths; fallback `open(path, undefined, fallbackCwd)` exists.
  Cleanup timing is an Operator-approval matter.
- **Do not re-propose Option A** without a new Stakeholder decision; the
  technical viability of A is established and is not the open question.
