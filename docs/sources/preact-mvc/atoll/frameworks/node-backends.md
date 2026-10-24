# Plain Node backends: `examples/express`, `fastify`, `hono`, `koa`

Read when: working on the non-Nest backend examples or `@atolljs/node` usage
outside a framework.

Four minimal REST APIs (`/api/incidents/*`) over the same
`@atolljs/incidents` contract. Unlike `examples/nestjs` there is no DI or
decorator layer, just `createNodePool` + `workerClient` from
`@atolljs/node`/`@atolljs/core`. Each app is ~3 files:

- `src/incidents.ts`: `createNodePool({ worker, sharedMemory: incidentsMemory,
  poolSize: 'auto' })` + `workerClient<IncidentsWorker>(pool)` + route
  helpers (query-arg parsing, direct shared-memory record reads).
- `src/incidents.worker.ts`: worker entry: `import '@atolljs/node/shim'`
  **first** (binds `self = parentPort` before `workerBootstrap` evaluates),
  then `import '@atolljs/incidents/worker/incidents.worker'` for the task
  registrations.
- `src/main.ts`: the framework's HTTP adapter. Pool-task routes
  (`/seed`, `/stats`, `/query`) dispatch through the client; `/seed-progress`
  and `/:id` read the shared buffer on the API thread directly.

## The worker must be bundled

`node:worker_threads` spawns each worker as a fresh plain-Node process.
Loader hooks and tsconfig `paths` (tsx, `--import tsx`) do **not** propagate
into workers, so an unbundled `.ts` worker entry cannot resolve bare
`@atolljs/*` specifiers: each example bundles the entry with esbuild:

```json
"bundle": "esbuild src/incidents.worker.ts --bundle --platform=node
           --format=esm --packages=external
           --outfile=dist/incidents.worker.js"
```

esbuild applies the example's tsconfig `paths`, so `@atolljs/*` resolves to
the repo sources and gets inlined; real npm deps (zod, msgpackr) stay
external and resolve from `node_modules` at runtime. The pool config then
points at the emitted file:

```ts
worker: () => new Worker(new URL('../dist/incidents.worker.js', import.meta.url))
```

`dev`, `build`, and `start` all run `bundle` first. This differs from the
NestJS example, where webpack detects `new Worker(new URL('./x.worker.ts',
import.meta.url))` and emits the worker chunk itself: esbuild does not
rewrite worker URLs, so the pool references the dist output directly (the
documented `workerFile`/`worker` spec pattern for plain-Node deployments).

The API side runs unbundled under tsx (`dev` = bundle + `tsx watch`), which
does apply `paths` on the main thread. Restarting `npm run dev` rebuilds the
worker bundle.

## Notes

- No COOP/COEP: `SharedArrayBuffer` always works in Node.
- `poolSize: 'auto'` sizes to cores; every route shares one pool.
- `pool.terminate()` runs on SIGINT/SIGTERM before server close.
- Tests (`test/api.e2e.test.ts`) spawn `node --import tsx src/main.ts` on an
  ephemeral port after `npm run bundle`: the e2e asserts the seeded buffer,
  a direct record read, a filtered pool query, and 404 handling.
