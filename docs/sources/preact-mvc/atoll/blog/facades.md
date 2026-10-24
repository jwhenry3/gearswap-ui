---
date: 2026-09-30
series: Facades
---

# Facades Over Threads

## How AtollJS makes real JavaScript multithreading feel like ordinary code

> **Problem.** Workers exist, but `postMessage` ergonomics make them not
> worth it: you abandon your framework's idioms, hand-roll a protocol, and
> serialize every interaction through a stringly-typed pipe.
>
> **Fix.** Make the boundary invisible. The function, component, or
> injectable you were going to write anyway *is* the contract: typed
> pools, shared memory, and DOM streaming live underneath the call site.

JavaScript has had real threads for fifteen years, and the honest answer
to "why isn't everything multithreaded" is that the API makes you earn
it. `postMessage` gives you a pipe and a serialization boundary; the
protocol on top, request ids, response matching, error plumbing,
progress events, is work nobody assigned you but everybody pays for.

AtollJS is built around one thesis:

> **The code you were going to write anyway, a function, a component
> class, an injectable service, IS the contract.** The boundary lives
> underneath it, invisible at the call site.

Here's what that looks like at each level.

## The problem, concretely

Two scenarios the framework was built against:

**The frozen UI.** A telecom incident explorer: a live table of a
million alarm records. Type in the search box and the input lags; scroll
and frames drop. The correct fix is "do it in a worker," which means
abandoning your framework's renderer and hand-rolling a DOM sync
protocol. So nobody does it.

**The stalled API.** A NestJS endpoint aggregates a million records.
Every request parks the event loop for tens of milliseconds, so *every
other request waits*. Node has `worker_threads`, but a useful worker
needs bootstrap, task routing, failure handling, and DI on both sides.

The capability is in the platform. The ergonomics are what kill it.

## The foundation the facades sit on

One shared primitive: `defineSharedMemory`.

```ts
export const incidentsMemory = defineSharedMemory({
  lists: {
    incidents: field.list({
      schema: reef.object({
        id: reef.u32(), severity: reef.int(0, 3), status: reef.int(0, 2),
        site: reef.string(10), /* … */
      }),
      count: 1_000_000,
    }),
  },
  signals: { seedProgress: field.number() },
});
```

The schema compiles to a deterministic byte layout over a
`SharedArrayBuffer`: identical on the main thread and in every worker.
Both sides import the same object; reads are zero-copy; writes bump a
version counter that `Atomics` watchers sleep on. No message touches the
hot path.

## The facade ladder

**A function call.** `defineWorker` on the worker side,
`connectWorker`/`workerClient` on the main thread. The client is a Proxy
typed by `typeof` your worker: `import type` means the worker module
never enters your bundle. Cancellation, timeouts, backpressure, crash
respawn: included.

**Framework DI.** Angular apps get `provideAtoll` / `injectAtollPool`:
the pool is a provider like any other. Nothing about your component tree
changes.

**A component class.** `islandComponent` turns a worker-side component
class into a local-looking shell component. React, Vue, Solid, Svelte,
Angular: the same million-record table renders *inside the worker* in
all five, streaming DOM ops to the main thread. Re-renders land around
2-3 ms in the worker; the main thread touches ~22 live DOM rows.

| Framework | Worker re-render on scroll jump | DOM rows |
|---|---:|---:|
| Vue | ~3 ms | 22 |
| Solid | ~2 ms | 22 |
| Svelte | ~3 ms | 22 |
| Angular | ~3 ms | 22 |
| React | ~3 ms | 22 |

**A service.** NestJS gets `@AtollService({ pool })` at class level:
inject normally, every method dispatches to the pool, and the consumer
literally cannot import Atoll to call it. That last part is the test of
a real facade: `DashboardService` composes `ReportService` with zero
framework imports.

## Why this shape matters

Facades fail in two familiar ways. They leak, and you're back to
managing the boundary by hand, or they hide failure, and you find out
in production. AtollJS picks neither: call sites stay idiomatic, but the
failure modes are typed and loud: `TaskTimeoutError`,
`WorkerCrashedError`, `PoolQueueFullError`, a validator warning and a
local-execution fallback when a pool can't spawn.

## Try it

```bash
npm install @atolljs/core
```

The repo has per-framework examples, a NestJS app, and the million-row
benchmark: all wired to run. The docs site walks each binding end to
end.

The next time a feature makes your tab stutter or your p99 sag, before
reaching for memoization or pagination, ask whether the work belongs in
a worker. If the answer used to be "not worth the plumbing": that's
the assumption this project exists to retire.

Sources: [shared-memory contract](../shared-memory.md) ·
[reef schemas](../reef.md) ·
[worker pools & tasks](../tasks-and-pool.md) ·
[islands engine](../islands.md) ·
[NestJS bindings](../frameworks/nestjs.md):
repository: [github.com/jwhenry3/atolljs](https://github.com/jwhenry3/atolljs),
examples in `examples/`.
