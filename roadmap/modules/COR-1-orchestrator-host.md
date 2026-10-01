# COR-1 · Orchestrator host & RPC

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-2 · **Skills:** ide-orchestration-core

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
**Built (branch `mod/COR-1-orchestrator-host`):**
- **Orchestrator host** (`packages/orchestrator/src/host/`):
  - `host.ts`: `createHost({connection, logger})` returns a `Host` with:
    - `register(method, handler)`. Handlers get `(params, {signal, host})`, with params already zod-parsed (defaults applied). Results are validated against the protocol too, so a broken result becomes `InternalError` instead of reaching the client.
    - `requestSecret(ref, signal?)`, `notify(name, payload)` (validated), `onShutdown(hook)`, `trackProcessGroup(pid)` (returns untrack), `session` (workspace roots after `initialize`), `signal`, `shutdown(reason)`.
    - Router errors: unknown method → `MethodNotFound`; before `initialize` → `NotInitialized`; bad params → `InvalidParams` (-32602) with `z.prettifyError`; unregistered method → `NotImplemented`; handler throws → `InternalError` (a thrown `ResponseError` passes through); version mismatch → `ProtocolMismatch` with `checkProtocolCompatibility`'s message.
  - `stdio.ts`: `claimStdout()` keeps the real stdout for the transport and points `process.stdout.write` and `console.*` at stderr.
  - `logger.ts` / `rotatingFile.ts`: pino logs to stderr and a size-rotated `orchestrator.log` (5 MB × 3) in `--log-dir`. Secret-looking fields (`value`, `apiKey`, `authorization`) are redacted.
  - `start.ts`: `startOrchestrator({argv, configure})` wires everything. It shuts down on stdin end, connection close, SIGTERM or SIGINT, and on an uncaught exception (exit 1).
  - `main.ts` is the entry. **Feature modules register their handlers in its `configure`.**
- **Bundle:** `packages/orchestrator/scripts/build.mjs` builds `dist/orchestrator.js` (one CJS file, ~232 KB, `--entry`/`--outfile` overridable). `extensions/desiide-ai/scripts/build.mjs` now always builds it into the extension's `dist/`, so `package` and the app build (EDT-2) ship it.
- **Extension side** (`extensions/desiide-ai/src/orchestrator/`), with no `vscode` import:
  - `client.ts`: `OrchestratorClient`.
    - `request(method, params, signal?)` validates params before spawning and validates the result.
    - Also provides `onEvent` (uses `parseTaskEvent`, ignores unknown types), `onStatus`, `restart()` and `dispose()` (SIGTERM, then SIGKILL after 2 s).
    - Forks lazily with `forkOrchestrator`, then sends `initialize` (10 s timeout). It answers `secrets.get` and forwards orchestrator stderr and `log` notifications to the Desiide output channel.
  - `restartPolicy.ts`: at most 3 automatic restarts per 60 s, backoff 250 ms → 4 s.
  - `notice.ts`: maps a failed status to the error notification.
- **Extension wiring** (`extension.ts`):
  - The client is constructed at activation but not spawned. It's exposed as `DesiideApi.orchestrator` (additive).
  - A failed status shows an error notification with **Restart Orchestrator** / **Show Log**. A protocol mismatch shows only Show Log, because restarting can't fix it.
  - New command `desiide.restartOrchestrator`. `deactivate()` returns the dispose promise.

**Evidence:**
1. AC1: `packages/orchestrator/src/host/host.test.ts` (in-memory `PassThrough` pipes, 18 tests).
   - Round trip: "round-trips initialize and health.ping".
   - Invalid params: "rejects invalid params with InvalidParams and the zod message".
   - Also covered: NotInitialized, NotImplemented, MethodNotFound, handler errors and invalid results, secrets, notify, cancellation, and shutdown (hooks, process-group kill, idempotent).
2. AC2: two tests.
   - `extensions/desiide-ai/src/orchestrator/process.test.ts` spawns the **real bundle** through `OrchestratorClient`, pings, `SIGKILL`s the pid, and asserts statuses `starting, ready, restarting, starting, ready` with a new pid. It then pings again and checks that dispose kills the process.
   - Also run in **real VS Code 1.140.0**: the `test:integration` suite forks under the Electron runtime with `ELECTRON_RUN_AS_NODE`, kills with -9, and sees `restarting, starting, ready`. The `desiide.restartOrchestrator` command restarts it too.
   - Crash-loop, backoff and init-timeout cases are in `client.test.ts`.
3. AC3: `packages/orchestrator/src/host/stdout.test.ts` bundles a fixture entry whose handler calls `console.log/info/debug` and `process.stdout.write`. It then parses the process's entire stdout as strict `Content-Length` frames, finds exactly the 3 responses and no other bytes, and finds the noise on stderr.
   - Sanity check: with the stdout redirect disabled, the test fails.
4. AC4: `client.test.ts` › "protocol version" covers two cases:
   - The server answers `ProtocolMismatch`.
   - The server answers `2.1.0`.
   
   In both, the status is `failed / protocol_mismatch` with "…Update Desiide so both sides match.", the request rejects with that message, and nothing restarts. `notice.test.ts` checks that the notice shows that message.
   - *Not automated:* the `showErrorMessage` call itself in `extension.ts`. It's a 3-line glue. A real mismatch can't be produced in the integration run without a second bundle.
5. AC5: integration run → `activeAfterStartup: false`, `orchestratorAfterActivation: "idle"`, `activationMs` 0.85, and **86 ms** from opening the container to active (UI-1 measured 90 ms before this change). The extension bundle grew from 93 KB to 184 KB (vscode-jsonrpc + protocol schemas) with no measurable activation cost.
- **Cold start:** first `health.ping`, including the fork, took **87 ms** in VS Code (budget 500 ms).
- `scripts/verify.sh` green (476 tests). The `.vsix` is 248 KB including `orchestrator.js`.

**Deviations:**
- **SecretStorage key convention:** `secret:<name>` is stored under the key `<name>` (`secretStorageKey`). UI-6 must store keys under that name. Documented in `docs/protocol.md`.
- **"Graceful shutdown on `exit`":** the protocol has no `exit`/`shutdown` method, and I didn't add one. The orchestrator shuts down when stdin closes, the connection closes, or it gets SIGTERM/SIGINT. The extension's `dispose()` sends SIGTERM and escalates to SIGKILL after 2 s.
- **Aborting tasks / killing process groups:** this is provided as `host.onShutdown(hook)` and `host.trackProcessGroup(pid)`. COR-2 registers task abort there, and COR-3 tracks its `detached` shell groups. Handler `signal`s are also aborted on shutdown.
- **Router also validates handler results** against the protocol (beyond the brief). It catches contract bugs on the orchestrator side.
- **Client validates params before spawning** and rejects requests without a `file:` workspace folder ("Open a folder to use Desiide."), because `initialize` requires at least one root.
- **The log file is rotated by our own synchronous `RotatingFile`,** not `pino-roll`. pino's worker-thread transports don't survive esbuild bundling, and sync writes keep the last lines before a crash.
- **Orchestrator stderr is forwarded to the Desiide output channel.** Levels are mapped from pino's, and non-JSON lines are shown as-is.
- **Integration run opens a temp workspace folder** (needed for `initialize`). The existing EDT-2 assertions still pass with it.

**Known gaps:**
- If the orchestrator itself is SIGKILLed, the `detached` grandchildren it spawned (COR-3) are orphaned, because no shutdown hook runs. COR-3 could have each child watch its parent, or the extension could kill tracked groups. Noted for COR-3.
- No coverage provider yet (same as FND-2), so the ≥80% target isn't measured. Every new file has direct tests.
- The orchestrator inherits the extension host's environment unchanged. Scrubbing the shell tool's env belongs to COR-3.
- Not run inside the built Desiide app (`test:app`). The fork path was verified in stock VS Code, which uses the same Electron `ELECTRON_RUN_AS_NODE` mechanism.

**Follow-ups:**
- **COR-2 / MOD-1 / JEV-*:** register handlers in `packages/orchestrator/src/host/main.ts` → `configure`. Use `HandlerContext.signal` for cancellation and `host.notify('task.event', …)` for events.
- **UI-2 / UI-3:** use `DesiideApi.orchestrator` (or pass the client) for `request('task.create', …)` and `onEvent`. Surface `status` in the status bar if useful.
- **UI-6:** store API keys in `context.secrets` under the bare name from `secret:<name>`.
- **REL-1:** `test:integration` now also exercises the orchestrator. Run it under xvfb in CI.
