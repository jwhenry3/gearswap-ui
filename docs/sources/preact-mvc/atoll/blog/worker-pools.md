---
date: 2026-09-23
series: Inside Atoll
---

# Worker Pools That Fail Gracefully

## Dispatch, cancellation, timeouts, backpressure, and crash respawn

> **Problem.** A bare `Worker` is a thread and a pipe. Production needs
> queueing, deadlines, cancellation, and a plan for a crashed worker:
> otherwise a dead thread is a promise that never settles.
>
> **Fix.** `WorkerPool`: a typed proxy client with `poolSize: 'auto'`,
> per-call `taskTimeout`/`signal`, bounded queues, and `respawn`: every
> call resolves or rejects with a typed error, never hangs.

Picture the failure mode: your worker throws during module init, or
OOMs mid-task, and the `postMessage` you sent it simply never gets an
answer. The `await` hangs forever. Your loading spinner is now a
permanent fixture.

A bare `Worker` gives you a thread and a pipe. Everything else,
queueing, deadlines, cancellation, crash recovery, is on you, and most
teams learn that the first time a worker dies mid-task in production.

`WorkerPool` exists to enforce one rule: **a pool call must always
settle.**

## The shape

```ts
import type { IncidentsWorker } from './incidents.worker'; // type-only

const pool = connectWorker<IncidentsWorker>({
  worker: () => new Worker(
    new URL('./incidents.worker.ts', import.meta.url),
    { type: 'module' },
  ),
  poolSize: 'auto',        // navigator.hardwareConcurrency ?? 4
  sharedMemory: incidentsMemory,
});

const page = await pool.tasks.queryIncidents({ offset: 0, limit: 50 });
```

Note what the main thread imports: `import type`. The client is a Proxy
typed by `typeof` your worker module: the worker's code never enters
your app bundle. Inside the worker, `defineWorker` installs the message
loop: binds shared memory on `INIT_MEMORY`, dispatches `EXECUTE_TASK`.
Namespaces work (`services: { pricing: {...} }` → `pricing.reprice`),
and `serviceMethod` units carry `argsSchema`/`resultSchema` so argument
validation runs *inside the worker*: the trust boundary is the message,
not your TypeScript config.

## The failure surface

| Knob | Behavior |
|---|---|
| `taskTimeout` | `TaskTimeoutError` covering queue wait *and* run; override per call with `client.with({ timeout })` |
| `client.with({ signal })` | `AbortSignal` → `TaskAbortedError` |
| `respawn` (default `true`) | Crashed workers are replaced; in-flight calls reject with `WorkerCrashedError` instead of hanging |
| Queue bounds | Saturation rejects with `PoolQueueFullError`: backpressure is explicit, not silent memory growth |
| `pool.close()` | Drains, then terminates |

Timeout, abort, crash, saturation: each is a typed rejection you can
`catch`, log, and report. That's the line between a worker library and
worker *infrastructure*, and it's the difference worth paying a
dependency for.

Source: the [worker pool & tasks guide](../tasks-and-pool.md); shared
state feeding those tasks is in [shared memory](../shared-memory.md).
