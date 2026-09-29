# JEV-3 · Jev HTTP client (TypeSafe API)

**Status:** blocked (waiting for TypeSafe API docs in `docs/jev-api/`) · **Milestone:** Alpha* · **Size:** S · **Depends on:** JEV-1, API docs · **Skills:** ide-jev-decisions

## Purpose
`HttpJevEngine`: the real Jev behind the `JevEngine` interface.

## Scope
- Implement choice/score/noul against the documented API. Map packs/questions to the API's request shape.
- Auth via `secret:jev` → header. Endpoint from `mutt.jev.endpoint`.
- Timeout 1.5 s per call → fall back to rules for that call (reason `jev_timeout`).
- Circuit breaker: 3 consecutive failures → rules for 60 s.
- zod-validate every response. On an invalid response → rules + `jev_invalid_response` logged with the request ID.
- `jev.test` RPC: health + a sample decision, returning latency.
- **Update the `ide-jev-decisions` skill** with the real wire format and remove the "assumed" warning. Confirm Noul semantics.

## Acceptance criteria
1. Fixture tests for each question type from the documented examples.
2. Timeout, 5xx, 401, and malformed-body cases each fall back correctly with the right reason label.
3. The circuit breaker opens and closes as specified (fake timers).
4. No file contents or secrets in the request (asserted against JEV-1 builder output).
5. Live smoke under `MUTT_LIVE=1`.

## Handoff notes
_(filled by the build session)_
