# Worker pool & tasks

Read when: working on `src/pool/`, `src/worker/`, `src/service.ts`,
task dispatch, timeouts/cancellation, or `packages/node`.

Tasks are the only message-passing boundary, split the way tRPC splits a
router: the *worker script* owns the runtime and the method list via
`defineWorker`; the main thread imports only its `typeof` and drives it
through a `connectWorker` Proxy client. Method names are listed exactly once.

## One file per method

Each task owns one file under `service/` containing its wire schemas and its
worker implementation as a `serviceMethod` unit: reference:
`packages/incidents/src/service/queryIncidents.ts`. The schemas type `run`'s
parameters: nothing to annotate.

`argsSchema`/`resultSchema` validate at the thread boundary inside the worker:
the trust boundary is the message. Plain functions work too
(`methods: { ping: () => 'pong' }`) when no validation is needed; their
signature types the client directly.

## Worker side

Reference: `packages/incidents/src/worker/incidents.worker.ts`.
`defineWorker` installs the message loop (binds shared memory on
`INIT_MEMORY`, dispatches `EXECUTE_TASK`) and registers every method under its
own name. `services: { pricing: { … } }` namespaces methods as
`pricing.reprice` when one worker hosts several domains. The exported
`IncidentsWorker` type is all the main thread ever imports from this file.

## Main thread: the client

Reference: `packages/incidents/src/incidents.ts`. `import type` keeps worker
code out of the main bundle. The client is a Proxy:
`incidents.queryIncidents(q)` dispatches taskId `"queryIncidents"` to the
pool: typed by the worker's method signatures. The pool spawns lazily on the
first call, so importing the client is SSR-safe; `start()` spawns eagerly,
`terminate()` drops the pool and the next call re-spawns.

### `connectWorker` config

| Option | Notes |
|---|---|
| `worker` | Factory `() => new Worker(new URL(..., import.meta.url), { type: 'module' })`: bundlers only emit worker chunks for the inline form. A `URL` also works. |
| `sharedMemory` | *Optional.* The contract to bind on the main thread and ship to workers, type-checked against the worker's declared `sharedMemory`. Omit for a message-only pool: no `SharedArrayBuffer` or COOP/COEP requirement; the handshake becomes a bare `INIT`. |
| `workers` | How many workers you need: a number (default `1`), or `'auto'` for `navigator.hardwareConcurrency ?? 4`. `1` builds a `DedicatedWorker` (no pool); anything above builds a `WorkerPool`. See [How many workers](#how-many-workers). |
| `poolSize` | *Deprecated* alias for `workers`; `workers` wins when both are set. |
| `concurrency` | *Pool only.* In-flight cap per worker (default 1); least-busy dispatch, FIFO queue beyond the cap. |
| `maxQueue` | *Pool only.* Queue bound; a full queue rejects with `PoolQueueFullError`. |
| `taskTimeout` | Default timeout from enqueue (queue wait + run) → `TaskTimeoutError`. Override per call via `client.with({ timeout })`. |
| `respawn` | Default `true`: crashed workers are replaced; in-flight calls reject with `WorkerCrashedError`. |
| `lazy` | Default `true`. `false` spawns at construction. |
| `name` | Devtools label. It also derives the runner's devtools id: the name slugged plus `-p` for a pool or `-w` for a dedicated worker (`name: 'sla', workers: 3` → `sla-p`; `name: 'Model Lane'` → `model-lane-w`). A repeated name in the same thread gets a counter (`sla-p2`). Unnamed runners keep `pool-N` / `worker-N`. Island clients built by a mount's `worker` shorthand default it to the app name. |

`client.with({ signal, timeout })` returns the same typed surface with
per-call controls; `pool.stats()` exposes queue/in-flight counts and wait/run
aggregates; `pool.workers` exposes a live snapshot of the slot workers for
auxiliary messaging outside task dispatch (respawns appear on the next read:
see [frameworks/node.md](frameworks/node.md) for the socket-routing use);
`pool.sharedBuffer` exposes the buffer handed to workers via INIT_MEMORY
(e.g. to share one contract buffer across two pools: `withSharedBuffer` in
`@atolljs/node` feeds it to each spawned worker);
`pool.close()` drains then terminates. A `signal` abort rejects
the call with `TaskAbortedError` (all four errors are exported from
`@atolljs/core`): a queued call is dropped, an in-flight one rejects
the caller but holds the worker's slot until its reply arrives: JS can't
interrupt a running task, so the pool never double-books a busy worker.

### How many workers

`workers` states intent; the client picks the machinery. Reference:
`src/pool/workerClient.ts` (`resolveWorkerCount`), `src/pool/dedicatedWorker.ts`.

- **`workers: 1` (the default): a dedicated worker, no pool.** Calls are
  posted to the worker immediately: no queue, no least-busy scheduler, no
  in-flight cap. The worker's own message loop runs them in arrival order
  (a task that awaits lets the next message start). Kept from the pool:
  per-call timeout and abort, crash respawn (`respawn`), `stats()` (with
  `queued` and `waitMs` always zero), `workers`, `sharedBuffer`,
  `close()`, and the same devtools events, with `pool:init` flagged
  `dedicated: true` and a `<name>-w` (or, unnamed, `worker-N`) id.
- **`workers: N > 1` or `'auto'`: a `WorkerPool`.** Separate calls are
  distributed across the N workers (least-busy, `concurrency` cap, FIFO
  queue, `maxQueue`). One call still runs on one worker: a pool never
  splits a single call; fan out by issuing several calls
  (`Promise.all(chunks.map((c) => client.crunch(c)))`).

When you need more than one:

- **Independent heavy calls that should overlap**: N jobs on N workers
  finish in roughly the time of one. One worker runs them back to back.
- **Throughput under load** (an HTTP handler offloading requests,
  `@atolljs/node`): the pool is the backpressure point.

When one is right:

- **State that lives in the worker** (a cache, an open model, a rendered
  island tree): every call must land on the same worker, which a pool
  can't promise. Island clients are always `workers: 1`
  (`connectIslandWorker` pins it).
- **Latency isolation**: what you want is *off the main thread*, not
  parallelism. A second `workers: 1` client is a second isolated lane.

The client's `pool` property is typed `WorkerRunner<S>`
(`WorkerPool<S> | DedicatedWorker<S>`): both satisfy `TaskRunner` and
share `stats()`, `workers`, `sharedBuffer`, `close()`, and `terminate()`.

## Sub-workers: a worker that spawns workers

`connectSubWorker` is the worker-shell counterpart of `connectWorker`: the
same typed client over the same runner (`DedicatedWorker` or `WorkerPool`, by `workers`), called from *inside* a
`defineWorker` entry so a worker can fan out into its own dedicated workers.
The protocol doesn't care which side of the boundary spawned the pool:
INIT/INIT_MEMORY/EXECUTE_TASK is identical; only the spawn site differs.

```ts
// shell.worker.ts: runs inside a dedicated worker
const sub = connectSubWorker<CruncherWorker>({
  worker: () => new Worker(new URL('./cruncher.worker.ts', import.meta.url), { type: 'module' }),
  sharedMemory: cruncherMemory,
  workers: 2,
});

export const shellWorker = defineWorker({
  sharedMemory: shellMemory,
  methods: {
    fanOut: (chunks: number[][]) => Promise.all(chunks.map((c) => sub.crunch(c))),
  },
});
```

Two memory modes, chosen per pool:

- **Own buffer** (`sharedMemory` alone): the sub-pool allocates a fresh
  `WebAssembly.Memory` inside the shell and binds the contract to it: a
  private buffer for that tier, pushed to sub-workers via INIT_MEMORY.
- **Inherited buffer** (`sharedBuffer`): no allocation, the pool ships an
  existing SAB to every sub-worker. `sharedBuffer: contract.buffer` binds
  sub-workers to the buffer the shell itself holds, so main → shell → sub
  all read and write the same fields (hub-and-spoke). `sharedBuffer` is
  resolved once at pool construction; pass `pool.sharedBuffer` or
  `contract.buffer` (a bound `SharedMemory`'s `.buffer` getter). The option
  lives on `WorkerPoolConfig`, so `connectWorker`, `new WorkerPool`, and
  `createNodePool` accept it too: a second main-thread pool can share the
  first pool's buffer without `withSharedBuffer` plumbing.

Rules and limits:

- **Same bundler-detectability contract as the main thread**: the nested
  entry must be an inline `new Worker(new URL('./x.worker.ts', import.meta.url))`
  literal, never hoisted or computed. `vite build` emits nested worker
  chunks; in dev, `@atolljs/vite` rewrites nested entry URLs back onto its
  `?worker_file` bundling path (see [vite-plugin.md](vite-plugin.md)).
- **No Safari**: nested dedicated workers aren't supported there (no
  `Worker` global inside a worker). URL-style `connectSubWorker` configs
  throw a clear error at spawn; feature-detect and fall back to dispatching
  on the main-thread pool.
- **Node**: `worker_threads` nests natively. Inside a worker, use a factory
  (`worker: () => createNodeWorker(new Worker('./sub.js'))`) or
  `createNodePool`; both accept `sharedBuffer`; the sub-worker entry still
  needs `@atolljs/node/shim` first, and `bindSharedBuffer` works unchanged
  (its `parentPort` is the shell worker).
- One contract, one binding per context: if the shell's module graph
  defines a contract it also hands to a sub-pool, the pool's
  `sharedMemory.bind()` rebinds that contract to the sub-pool's buffer:
  a contract is a window onto whichever buffer it was bound to last.

## Devtools controls and timing

With devtools enabled, every main-thread runner (`DedicatedWorker` or
`WorkerPool`) registers with the `pool.*` dashboard commands
(`src/pool/devtoolsCommands.ts`); see
[devtools.md](devtools.md#control-channel-dashboard--app).

- **`worker.kill { poolId, slot }`** goes through the runner's real crash
  handler: in-flight calls on that slot reject with `WorkerCrashedError`
  (`'killed from devtools'`) and the slot respawns per `respawn`.
- **`pool.chaos { poolId, delayMs?, failRate?, timeoutRate? }`** applies to
  every subsequent call until cleared with `{ poolId }` alone. Rates are
  0-1 and sum to at most 1. An injected failure rejects with
  `chaos: injected failure` before anything is posted; an injected timeout
  still posts the call and then fails it through the normal timeout path.
- **User Timing**: each call records an `atoll task <taskId>` measure on
  the main thread (one track per runner id, group `atoll`) and an
  `atoll run <taskId>` measure inside the worker, so Chrome's Performance
  panel shows queue-plus-run next to the worker's own run time.

Runners created inside a worker (sub-workers) still emit events but
aren't commandable.

## Under the hood

`connectWorker` builds a `DedicatedWorker` (`workers: 1`) or a `WorkerPool`
(`workers > 1`); `workerClient(runner)` is the bare
Proxy over any `TaskRunner`: a pool you already hold (Nest's
`@InjectAtollPool`), a SharedWorker client, or a test stub. The
explicit-contract path (`TaskContract`, `TaskRegistry.register`,
`defineService`) remains for cases where both threads need the contract object
at runtime.

## Explicit service contracts (advanced)

`defineWorker`/`connectWorker` build on a lower, framework-neutral layer
(`src/service.ts`): the same one the NestJS binding dispatches through.
Reach for it when both threads need the contract object at runtime: feeding a
hand-built `WorkerPool`, a DI provider, or a test stub:

| Export | What it does |
|---|---|
| `defineService(name, methods)` | Declares the contract bundle once: `{ method: { argsSchema?, resultSchema? } }`. Wire ids derive as `service.method`; signatures infer from the schemas (`argsSchema: z.tuple(...)` → args, `resultSchema` → return type). |
| `implementService(service, handlers)` | Worker-side registration into `TaskRegistry`; throws at bind time on a missing method instead of surfacing "handler not found" on the far thread. |
| `createClient(service, runner)` | The main-thread half: a typed proxy over any `TaskRunner`: a pool, a SharedWorker client, or a test stub. |
| `service.tasks` | A `TaskMap`: feed it straight to `new WorkerPool({ tasks })` or a SharedWorker config. |
| `rpc<A, R>({ taskId? })` | Escape hatch for method declarations schemas can't carry: typed args with no validation, or an explicit wire id for interop. |

```ts
import { defineService, implementService, createClient, rpc } from '@atolljs/core';

// Both threads import the same object, ids can never drift:
export const pricing = defineService('pricing', {
  reprice: { argsSchema: z.tuple([z.string()]), resultSchema: z.number() },
  ping: rpc<[], string>(),                  // no schemas, types declared
});
// pricing.tasks.reprice.taskId === 'pricing.reprice'

// worker side: a missing method throws here, at bind time:
implementService(pricing, { reprice: (sku) => …, ping: () => 'pong' });

// main thread: over any TaskRunner:
const client = createClient(pricing, pool);
await client.reprice('SKU-1');
```

## Node workers

`WorkerPool`/`connectWorker` run on `node:worker_threads` unchanged:
`@atolljs/node` adapts Node's `Worker` (an EventEmitter) to the DOM
surface the pool expects. The worker entry's first import is
`@atolljs/node/shim`, which binds `self = parentPort` before
`defineWorker`'s bootstrap evaluates.

```ts
import { createNodePool, createNodeWorker } from '@atolljs/node';
import { Worker } from 'node:worker_threads';

// createNodePool = new WorkerPool + the adapter baked in. Its worker:
// factory may return a node:worker_threads.Worker directly, adapted
// internally, keeping the bundler-detectable new URL(...) literal:
const pool = createNodePool({
  sharedMemory: memory,
  tasks: pricing.tasks,
  worker: () => new Worker(new URL('./incidents.worker.ts', import.meta.url)),
});

// connectWorker / new WorkerPool need the DOM surface: wrap explicitly:
connectWorker<IncidentsWorker>({
  worker: () => createNodeWorker(new Worker('./dist/incidents.worker.js')),
});
```

`SharedArrayBuffer` works in Node with no headers: cross-origin isolation is
a browser-only requirement.
