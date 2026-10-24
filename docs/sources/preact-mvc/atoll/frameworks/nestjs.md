# NestJS: `@atolljs/nestjs` (+ `@atolljs/node`)

Read when: working on `packages/nestjs/`, `packages/node/`, or
`examples/nestjs/`.

`@atolljs/nestjs`: worker pools on the server. Decorated service
methods become RPC endpoints into `node:worker_threads` workers that each boot
their own Nest application context: same module, real DI, both sides.
`@atolljs/node` underneath adapts Node's `Worker` (an EventEmitter) to
the DOM surface the pool expects: see [../tasks-and-pool.md](../tasks-and-pool.md#node-workers).

## Binding API

| Export | Signature | What it does |
|---|---|---|
| `AtollModule.forRoot` | `forRoot({ pools? })` / `forRootAsync(...)` | Global atoll infrastructure once: validator, discovery, lifecycle. Optional pools for simple apps; feature modules prefer `registerPool`. |
| `AtollModule.registerPool` | `registerPool(config)` / `registerPoolAsync(...)` | Bull-style module-level pool registration inside the feature module that owns the worker: name, worker, sharedMemory, poolSize. Injectable provider, terminated on module destroy. |
| `@AtollTask` | `@AtollTask(taskId \| contract \| { pool })` | Per-method RPC offload: main-thread calls dispatch to the named pool; the body executes inside the worker's Nest context on the DI-resolved instance. |
| `@AtollService` | `@AtollService({ pool })` / `@AtollService(service, opts?)` | Class-level offload: marks every method for dispatch to the pool under `ClassName.method` ids (the contract form binds only methods declared in a `ServiceContract`). |
| `@InjectAtollPool` | `@InjectAtollPool(name)` | Parameter decorator injecting a configured pool for first-class task methods / `runTask`. |
| `runAtollWorker` | `runAtollWorker(module): Promise<INestApplicationContext>` | Worker-side bootstrap: self-contained (shim + bootstrap inside). Creates a Nest application context, discovers `@AtollTask` providers via DiscoveryService, binds them into `TaskRegistry`. |
| `registerAtollHandlers` | `registerAtollHandlers(...instances)` | Explicit registration for instances created outside a worker Nest context. |
| worker spec | `worker: path \| URL \| (() => Worker \| NodeWorker)` | Pool worker declaration: a factory may return `node:worker_threads.Worker` directly; it is adapted internally, so `new Worker(new URL(...))` stays in the bundler-detectable inline form without adapter ceremony. |

## Shape

One module call wires every pool: each becomes an injectable provider,
registers in the pool registry `@AtollTask` dispatches through, and terminates
on module destroy. Source: `packages/nestjs/src/module.ts`.

`@AtollTask`/`@AtollService`: the decorator decides the thread. Main thread:
the call serializes args and dispatches `EXECUTE_TASK` to the pool. Worker
side: the decorator only records metadata: `runAtollWorker` binds the real
body to the DI-created instance. `@AtollService({ pool })` applies that
dispatch to every method on the class; `@AtollTask` remains for per-method
control. Source: `packages/nestjs/src/decorators.ts`.

**The service-level facade.** `@AtollService` at class level is the backend
analog of the frontend `islandComponent` facade: the service class IS the
interop surface: inject it anywhere (controllers *or other services*) and
every call dispatches, with zero atoll imports at the consumer. See
`examples/nestjs/src/facade/`: `report.service.ts` (the facade),
`dashboard.service.ts` (a plain service composing worker calls), and
`facade.worker.ts`: the `reports` pool is message-only and shares the
incidents buffer via `withSharedBuffer`, like `housed`.

`runAtollWorker`: the worker boots its own application context and discovers
decorated providers, so injected dependencies resolve inside worker-run
bodies. Source: `packages/nestjs/src/worker.ts`.

Usage references: `examples/nestjs/src/shared/incidents-analytics.service.ts`
(one service, two runtimes, the same class file is the contract),
`examples/nestjs/src/incidents.controller.ts` (injected pool wrapped once with
`workerClient<IncidentsWorker>`, calls read like the worker's own method
names), `examples/nestjs/src/digest/digest.worker.ts` (worker entry: two imports:
`runAtollWorker` plus the feature module).

## Housing partial APIs inside workers

Beyond task dispatch, a route subtree can live *only* in workers: the
gateway/proxy model from [node.md](node.md), but the worker side runs a
full Nest app, so housed controllers keep decorators, DI, and guards. The
example gives housed traffic its **own pool and its own worker entry**:
each entry file stays single-purpose:

- **`src/housed/housed.worker.ts`**, the dedicated entry: `await bindSharedBuffer()`
  receives the incidents buffer and binds all contracts, then
  `NestFactory.create(HousedApiModule)` + `app.init()` +
  `serveHttp(app.getHttpServer(), { listen: 0 })` binds an internal
  `127.0.0.1` port and announces it via the `HTTP_PORT` handshake, and the
  same `serveHttp` call also accepts `HTTP_CONNECTION` sockets, so the
  worker serves both topologies with no extra wiring.
  No `runAtollWorker`/bootstrap: housed workers serve HTTP, not tasks.
- **`src/housed/housed-atoll.module.ts`**, registers the `'housed'` pool,
  *message-only*: a pool's `sharedMemory` creates a NEW buffer, so the worker
  factory is `withSharedBuffer` (`@atolljs/node`) fed by
  `getAtollPool('incidents')?.sharedBuffer`, evaluated lazily per spawn so
  respawns get it too, import order puts IncidentsAtollModule first. Two
  pools' workers, one shared buffer.
- **Main thread** (`src/main.ts`): `getAtollPool('housed')` →
  `workerHttpPorts(pool)` → `app.use('/api/housed', proxyToWorker({ pool,
  tracker, to: '/api/housed', worker }))`. Express strips the mount prefix;
  `to:` restores it for the worker's routes.
- `worker:` is a slot index or a selector over the live `pool.workers`
  snapshot: round-robin, or pin to one slot; respawned workers re-announce
  and take their routes back automatically (the `HTTP_PORT_QUERY` handshake
  covers announcements that raced the tracker).
- **Housed controllers** (`src/housed/`): plain `@Controller`s under
  `api/housed/*`. Injecting `IncidentsAnalytics` shows the two-runtime
  story: its `@AtollService` methods see an empty pool registry in-worker
  and run their real bodies on this worker's DI'd instance: per-worker
  state like `workerTelemetry()` is genuinely per-worker.
- `HousedApiModule` (the worker-side module) imports **no** `registerPool`:
  pools only exist on the main thread.
- **Clustering (Node ≥ 26)**, `main.ts` additionally calls
  `createHttpCluster({ pool, port: PORT + 1 })` (env `TRANSFER_PORT`),
  self-gating: it logs a notice and returns `null` below Node 26, so the
  call site needs no capability check. A dedicated listener where the main
  thread hands each accepted socket to a housed worker unparsed. Clustering
  is per-CONNECTION: it can't share the app's port by URL path (the acceptor
  never reads bytes), so the gateway proxy stays the single-port story and
  the cluster listener is a second, zero-parse entry to the same housed
  routes.
- **WebSockets**, upgrades bypass `app.use`, so a housed ws endpoint mounts
  on the server itself:
  `app.getHttpServer().on('upgrade', proxyUpgradeToWorker({ pool, tracker, worker }))`
  , the handshake replays to the worker's listener, then frames tunnel
  socket↔socket. On the cluster listener nothing is needed: a ws server
  attached to the worker's `serveHttp` server handles upgrades in-worker.

## Shared-memory persistence: Redis adapter

`@atolljs/node/redis` is the shared-memory analog of NestJS's Redis
WebSocket adapter: field regions mirror to a Redis hash, restore into the
buffer at boot, and optionally replicate across processes over pub/sub. The
buffer stays the synchronous source of truth: Redis sits behind it.

```ts
// static client: works in registerPool too if the client is in scope
AtollModule.registerPool({
  name: 'incidents',
  worker: () => new Worker(new URL('./incidents.worker.js', import.meta.url)),
  sharedMemory: incidentsMemory,
  persistence: redisMemoryAdapter(redis, { name: 'incidents' }),
});

// injected client: registerPoolAsync
AtollModule.registerPoolAsync({
  name: 'incidents',
  useFactory: (redis: Redis) => ({
    worker: () => new Worker(new URL('./incidents.worker.js', import.meta.url)),
    sharedMemory: incidentsMemory,
    persistence: redisMemoryAdapter(redis, {
      name: 'incidents',
      subscriber: ioRedisSubscriber(redis.duplicate()), // cross-instance replication
    }),
  }),
  inject: ['REDIS'],
});
```

Details (key layout, `ready`/`flush`/`stop` lifecycle, version-counter diff,
list `commit()` caveat): `docs/shared-memory.md` → Persistence adapters.

## Build: Vite SSR build

The Nest CLI has no Vite builder, so the example builds with `vite build`
directly (`vite.config.ts`), targeting Node via `build.ssr`. To convert an
existing NestJS project, `atoll convert vite` performs the whole migration:
writes `vite.config.ts` + `dev.mjs`, repoints
`new URL('./x.worker.ts', …)` literals at the emitted `.worker.js` bundles,
and patches `package.json`/`tsconfig.json`. The config:

- `main.ts` plus every `src/**/*.worker.ts` are rollup inputs; each worker
  entry emits as `dist/<name>.worker.js`.
- Output is flattened into `dist/` (`entryFileNames`/`chunkFileNames`), so a
  `new URL('./x.worker.js', import.meta.url)` literal resolves to the emitted
  worker file whether it ends up in `main.js` or a shared chunk.
- The pool config's `worker:` factory references the emitted `.worker.js`
  name — rolldown does not rewrite worker URLs the way webpack does, so
  worker entries are declared as explicit inputs instead.
- `resolve.alias` maps `@atolljs/*` to the repo's `src/` trees; a consumer
  installing the published packages needs only the inputs and flat output.
- Dev loop (`dev.mjs`): `vite build --watch` rebuilds while `node --watch
  dist/main.js` restarts the app — a worker reload is a respawn anyway.
- The `node:worker_threads` shim and bootstrap are self-contained in
  `atoll-nestjs/worker`: no bundler banner needed.

The webpack path still works (`builder: { "type": "webpack" }` on Nest 12+)
if you prefer `nest build`, with two caveats:

- Pin webpack <5.108: that release miscompiles `new Worker(new URL(...))`
  when `Worker` is a member-expression callee (`import { Worker } from
  'node:worker_threads'`), producing `ns.Worker__webpack_require__.wc` and
  crashing at pool spawn.
- The published `@atolljs/*` dist is ESM-only, and webpack emits `commonjs2`
  with `nodeExternals()` leaving `@atolljs/*` as runtime `require()` calls —
  boot crashes with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Bundle them instead:
  `config.externals = [nodeExternals({ allowlist: [/^@atolljs\//] })]`. The
  webpack build also assumes CJS output, so a `type: "module"` Nest 12
  scaffold needs `"type"` removed (the Vite path runs ESM natively).

## Notes

- No COOP/COEP needed: Node always allows `SharedArrayBuffer`.
- The example is `"type": "module"` with a Vite ESM build — it drops
  straight into Nest 12's default ESM scaffold (`module: nodenext`, `.js`
  import extensions); no CJS downgrade needed.
- `poolSize: 'auto'` spawns `os.cpus().length` workers eagerly at module
  init — on a 24-core dev box that is 24 Nest application contexts per boot.
  Set an explicit number in dev if startup time matters.
- The example uses explicit `@Inject` tokens so decorator metadata isn't
  load-bearing under esbuild; `emitDecoratorMetadata` stays optional.
- Keep worker entry imports free of main-thread side effects; only the pool's
  own contracts should be defined in its module graph (each pool hands its
  workers one buffer).
- Args/results cross postMessage: keep them small; big data lives in the
  shared buffer.
