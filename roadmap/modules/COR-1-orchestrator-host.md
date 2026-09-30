# COR-1 · Orchestrator host & RPC

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-2 · **Skills:** ide-orchestration-core

## Purpose
The process boundary: the orchestrator's RPC server, and the extension-side client that spawns and supervises it.

## Scope
**Orchestrator side (`packages/orchestrator/src/host/`)**
- Entry `main.ts`: JSON-RPC over stdio (`vscode-jsonrpc/node`), `initialize` handshake, method router that zod-validates params and dispatches to typed handlers (stubs returning `NotImplemented` until other modules plug in).
- Handler registration API so other modules plug in without editing the router: `host.register('task.create', handler)`.
- Reverse request helper `requestSecret(ref)` → `secrets.get`.
- Logging with pino → stderr + rotating file in the extension's log dir. **stdout carries only RPC frames.**
- Graceful shutdown on `exit` / stdin close: abort all tasks and kill child process groups.
- esbuild bundle → single `dist/orchestrator.js`.

**Extension side (`extensions/desiide-ai/src/orchestrator/`)**
- `OrchestratorClient`: lazy spawn on first use via `child_process.fork` with `ELECTRON_RUN_AS_NODE` using `process.execPath` (so no system Node is required).
- Supervisor: restart with backoff, at most 3 restarts in 60 s, then surface an error with "Restart orchestrator" in the UI.
- Answers `secrets.get` from `context.secrets`.
- Typed `request()` / `onEvent()` wrappers built from protocol types.

## Out of scope
Task logic (COR-2) and UI rendering (UI-3).

## Acceptance criteria
1. In-memory pipe test: `initialize` + `health.ping` round-trip, and invalid params → JSON-RPC error with the zod message.
2. Real child-process test: spawn the bundled orchestrator, ping, kill -9 → the supervisor restarts it and emits a status event.
3. A test asserts nothing but valid frames is written to stdout, even when a handler `console.log`s (console is redirected to stderr).
4. Protocol major mismatch → clear error shown to the user.
5. The orchestrator is not spawned during extension activation (verify activation time stays within budget).

## Handoff notes
_(filled by the build session)_
