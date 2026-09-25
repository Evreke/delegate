# swarm-http-api — the session-hosted HTTP/WS read API

This is the single prose reference for the session-hosted HTTP/WS surface of
pi-delegate (ARCHITECTURE §4.2). **Goldens are normative**: the frozen bytes
live in `test/swarm-http-goldens.ts` and are enforced by
`test/swarm-http-api-check.ts` (byte-exact) and
`test/swarm-http-schema-diff-check.ts` (additive-only). If this document and
a golden disagree, the golden wins.

## 1. Scope and trust model

- The server is hosted by a pi session (`src/swarm-server/mount.ts`, called at
  `session_start`), **OFF by default** (`swarm.server.enabled: false`;
  port `swarm.server.port`, default 7331, `0` = OS-assigned). Two sessions
  are two independent servers.
- It binds **`127.0.0.1` only** — a code constant, not a config knob.
- The **read** surface (GET + WS) has **no auth** beyond the loopback bind:
  every process on the machine may read it. That is the documented boundary.
- The **write** surface (POST) is operator-token gated (§7).
- The server is **advisory by contract** (Law 8): a failing read degrades to a
  structured envelope, never a crash and never a pipeline dependency.

## 2. Envelope invariants (Law 7, Law 8)

- Every JSON **error** envelope carries top-level `"schemaVersion": 1` — and
  so does every success envelope, with ONE exception: the snapshot success
  envelope is the `swarm snapshot` CLI envelope **verbatim** (protocol
  identity, §4.2.2), so it has no top-level `schemaVersion`; its version lives
  inside the body (`snapshot.schemaVersion`, currently 1). `/api/version`, the
  `events` envelope, the console frames, the mutation envelopes and every WS
  frame carry the top-level field.
- Errors are structured: `{"ok":false,"schemaVersion":1,"error":{"code","message","hint"}}`.
  `code` is an `E_*` token; `hint` is always a non-empty recovery string.
- Envelopes are **additive-only**: a new field may be added; a field may
  never be removed or renamed. Clients must ignore unknown fields.

`GET /api/version` (fully frozen):

```json
{"ok":true,"schemaVersion":1,"serverVersion":"<extension version>","protocol":"swarm-http/1"}
```

## 3. Version negotiation (client rule)

1. A client MUST tolerate unknown fields anywhere in an envelope.
2. A client MUST check `schemaVersion` and ignore an envelope whose version it
   does not support — never half-read it. A **missing** `schemaVersion` is
   treated as legacy v1 and accepted (the repo's tolerance convention). For the
   snapshot success envelope, read `snapshot.schemaVersion` (§2).
3. The shipped dashboard client implements this in
   `src/swarm-server/public/stream.js` (`SUPPORTED_STREAM_SCHEMA_VERSION`,
   `reduceFrame`); `test/swarm-http-version-check.ts` proves both the
   unknown-field tolerance and the unsupported-version ignore.

## 4. REST endpoints

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| GET | `/api/version` | frozen identity envelope (§2) | 405 |
| GET | `/api/swarm/snapshot` | `{ok,verb:"snapshot",snapshot}` ‡ | 405 |
| GET | `/api/swarm/events?after=<seq>` | `{ok,verb:"events",schemaVersion,after,events,journal}` | 400, 405 |
| GET | `/api/workers/:id/console?offset=<n>` | one console frame (§6) | 400, 404 |
| POST | `/api/workers/:id/steer` | mutation envelope (§7) | 400, 401, 403, 404, 500 |
| POST | `/api/asks/:id/answer` | mutation envelope (§7) | 400, 401, 403, 404, 500 |
| GET | `/` and `/<asset>` | dashboard SPA assets (`src/swarm-server/public/`) | 404 |

Anything else: `404 E_SWARM_NOT_FOUND`; a served path with the wrong method:
`405 E_SWARM_USAGE`. Requests are one-per-connection (`Connection: close`).

‡ No top-level `schemaVersion` on this one success envelope — the snapshot
body's own `schemaVersion` is the version (§2). Every other success
envelope/frame carries it top-level.

### 4.1 `/api/swarm/snapshot`

Returns the `swarm snapshot` CLI envelope **verbatim** (protocol identity,
§4.2.2) built from the session's live in-process sources — the transport's
statuses and usage summaries fold in, so the `no-live-status` /
`usage-unavailable` flags appear only when genuinely unavailable. Degradation
is data on the graph's nodes (`degraded: [{flag}]`): `no-session-path`,
`no-live-status`, `legacy-orphan`, `usage-unavailable`; `available` stays
`true` (a failed source degrades the graph, never the response).

### 4.2 `/api/swarm/events?after=<seq>`

Returns the `swarm events` CLI envelope verbatim. `after` is **required** and
must be an integer cursor; rows are strictly `seq > after`; a negative value
clamps to 0. An absent/corrupt journal yields the empty-but-valid envelope
(`events: []`, `journal:{count:0,dbSizeBytes:0}`), never an error.

## 5. WebSocket `/api/swarm/stream?after=<seq>`

Frames are JSON text frames, each carrying `schemaVersion`:

```json
{"ok":true,"schemaVersion":1,"type":"snapshot","snapshot":{...}}
{"ok":true,"schemaVersion":1,"type":"events","after":<cursor-before-batch>,"events":[...rows]}
```

- The FIRST frame on every connection is the snapshot frame.
- Event frames follow as the journal cursor advances (poll interval default
  500 ms); ordering by `seq` is preserved per connection and the cursor never
  rewinds.
- **Cursor-resume**: a client reconnects with `?after=<last consumed seq>` and
  receives exactly the rows after it — no duplication, no loss. The client
  frame surface is PING→PONG and CLOSE→CLOSE; TEXT/BINARY are ignored (v1).
- An absent/failing journal degrades to "no event frames" (the snapshot still
  flows); a bad `after` or missing `Sec-WebSocket-Key` refuses the upgrade
  with a plain HTTP error envelope.

## 6. Worker console `/api/workers/:id/console`

`:id` is the **SwarmGraph SESSION node id** of a worker session (never a raw
path). Resolution walks the read-model and proves ownership through the
canonical `workerAudienceMatch` verdict; only `mine` passes. An unknown id, a
task node, a foreign owner, a missing owner edge and a degraded self-id are
refused **identically** (`404 E_CONSOLE_WORKER_REFUSED`, no existence
oracle). A non-integer/negative `offset` is `400 E_CONSOLE_USAGE`.

Frame (fixed key order; `task` and `error` are conditional):

```json
{"ok":true,"schemaVersion":1,"worker":"w1","nodeId":"<id>","task":"alpha",
 "state":"live","chunk":"...","nextOffset":11,"oldestOffset":0,"dropped":false}
```

`state` is transport-derived, never fabricated: `live` | `ended` |
`ended-with-retained-backlog` | `unavailable`. A backend that exposes no
console stream (e.g. herdr) answers **HTTP 200** with `state:"unavailable"`
and an additive `error:{code:"E_CONSOLE_UNAVAILABLE",...}` — a valid degraded
answer, not an HTTP error. Offsets are character positions in the server's
bounded transcript; `oldestOffset` is the frontier and `dropped` flags a read
below it; feeding `nextOffset` back yields exactly the later bytes. Console
text is ephemeral — never journaled, never in the snapshot. The WS form
(`/api/workers/:id/console/stream?offset=<n>`) pushes the same frames.

## 7. Mutation surface (operator token, Law 11)

`POST /api/workers/<id>/steer` and `POST /api/asks/<id>/answer` take a JSON
body `{"text":"<non-empty>"}`.

- **Token**: `Authorization: Bearer <operator token>`. The token is generated
  fresh per mount (`crypto.randomBytes(32)`) and surfaced ONLY on the
  session's stderr as one `operator-token` line — never the journal, a
  response body or a log file. Missing, malformed and wrong tokens yield the
  SAME `401 E_SWARM_AUTH` refusal, compared in constant time.
- **Id spellings** (both accepted, additive since #62): `<id>` is EITHER the
  canonical **worker name** (v1) OR the **SwarmGraph SESSION node id** of the
  worker's session (the same spelling the console endpoint, §6, uses).
  **Resolution order is name-first**: an id that spells a canonical worker
  name always resolves as a name — even if a session node happens to carry
  the same string (node ids are hex and CAN look like names, e.g. `ef2f5792`).
  A non-name id that is not a worker session node in the read-model is
  `400 E_SWARM_USAGE`. Ownership is proven by the mutation core either way, so
  a foreign worker's node id refuses with the same `403` as its name.
- **Ownership**: only workers this session provably spawned; a foreign or
  unknown id refuses with the SAME `403 E_SWARM_FORBIDDEN` body.
- A non-canonical/undecodable id or an invalid body is `400 E_SWARM_USAGE`.
- The write goes through the SAME mailbox core the `delegate_mailbox` tool
  uses (`src/swarm/mailbox-verbs.ts`); in journal storage a `steer`/`answer`
  row with the additive `via:"http"` is appended AFTER the envelope is
  published (files storage writes no row — §4.1.3 Phase A is untouched).
- **Confirmation** (additive field since #62): `confirmation` states how the
  mutation confirms. `"confirmed"` — the journal row is durably appended
  (journal storage). `"unavailable"` — files storage (no journal row will
  ever arrive) or an advisory append failure; the envelope reached the worker
  but a client must not wait for a journal event. Clients connecting to a
  pre-#62 server (no `confirmation` field) keep waiting for the journal
  event — the field is additive and old servers stay fully supported.

Success envelope:

```json
{"ok":true,"schemaVersion":1,"verb":"steer","worker":"w1","via":"http",
 "answerPath":"<a-w1.json>","journal":{"seq":N},"confirmation":"confirmed",
 "nudged":false}
```

(`journal` is `null` and `confirmation` is `"unavailable"` in files storage.)

## 8. Error taxonomy

| Code | HTTP | Meaning |
| --- | --- | --- |
| `E_SWARM_NOT_FOUND` | 404 | Unknown path. |
| `E_SWARM_USAGE` | 400 / 405 | Bad query flag, body, id, or method. |
| `E_SWARM_IO` | 500 | Internal read/mutation failure (advisory). |
| `E_SWARM_AUTH` | 401 | Missing/invalid operator token. |
| `E_SWARM_FORBIDDEN` | 403 | Worker not owned by this session. |
| `E_CONSOLE_USAGE` | 400 | Invalid console `offset`. |
| `E_CONSOLE_WORKER_REFUSED` | 404 | Unknown/non-worker/foreign console id. |
| `E_CONSOLE_UNAVAILABLE` | 200 (in-frame) | Backend exposes no console stream. |

## 9. Checks

- `test/swarm-http-api-check.ts` — golden envelope suite: every endpoint's
  success and error shapes, fixture fleets (empty journal, multi-fleet, all
  four degraded flags, herdr-unavailable console, foreign-fleet refusal,
  wrong/absent token), the WS `/api/swarm/stream` snapshot + events frames,
  the WS console frames, the WS upgrade-refusal envelope and the static-asset
  404.
- `test/swarm-http-schema-diff-check.ts` — additive-only discipline: field
  removal/rename fails, addition passes.
- `test/swarm-http-version-check.ts` — `/api/version` pin, unknown-field
  tolerance, unsupported-version ignore.
- `test/swarm-http-e2e-check.ts` — the full loop: snapshot → stream →
  steer (journal-confirmed) → console.
