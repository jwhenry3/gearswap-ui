# Overview: atoll, islands-based multithreading

Islands-based multithreading: worker pools and shared workers joined to your
app through one shared-memory fabric. Threads share a fixed-layout `SharedArrayBuffer`
contract; workers scan, sort, and write in place; work is offloaded two ways,
task *commands* and *state reactivity*, while only method inputs and explicit
results cross `postMessage`.

```
┌─────────────────────────── main thread ───────────────────────────┐
│  framework bindings  →  observe() fields  →  useTask()/run()      │
│         │                                            │            │
│  SharedMemory (contract)  ◄── SharedArrayBuffer ──►  WorkerPool   │
└──────────────────────────────────┬────────────────────────────────┘
                                   │ postMessage (task dispatch only)
┌────────────────────────────── workers ────────────────────────────┐
│  workerBootstrap binds same contract  →  TaskRegistry handlers    │
│  read/write the SAME memory: results stream back via postMessage │
└───────────────────────────────────────────────────────────────────┘
```

## Three layers

- **Contracts** (`defineSharedMemory` + `field.*`) declare the memory layout
  once for both threads: see [shared-memory.md](shared-memory.md).
- **Worker pair** (`defineWorker` on the worker side, `connectWorker` on the
  main thread) dispatches typed method calls over a lazily-spawned pool: see
  [tasks-and-pool.md](tasks-and-pool.md).
- **Reactivity** (`observe`, `watch`, `defineTask`) turns shared fields and
  task runs into subscribable snapshots the framework bindings adapt: see
  [reactivity.md](reactivity.md).

On top of the fabric sit **islands** (`@atolljs/islands` + the
`*-island` packages): whole framework trees rendered inside workers, replayed
onto real DOM as a serialized op stream: see [islands.md](islands.md).

## Repository layout

| Path | Contents |
|---|---|
| `src/` | `@atolljs/core`, contracts, pool, worker runtime, reactivity, logging |
| `src/testing/` | `InProcessWorker`, in-process `Worker` test double |
| `packages/incidents/` | `@atolljs/incidents`, the demo domain: incident contract, worker, pool, tasks |
| `packages/<framework>/` | `@atolljs/<framework>`, generic bindings, no domain code |
| `packages/islands/` | `@atolljs/islands`, the island engine: mount driver, op protocol, proxy DOM, worker runtimes |
| `packages/<framework>-island/` | `@atolljs/<framework>-island`, shell bindings + worker renderer per framework |
| `packages/node`, `packages/nestjs` | Node `worker_threads` adapter + NestJS module/decorators |
| `examples/<framework>/` | Isolated apps composing incidents + bindings |
| `examples/react-dom-worker/` | The islands demo: seven islands, three topologies, framework-free + React shells |

## Quickstart (minimal)

```ts
// counter.memory.ts: one contract, imported by both threads
import { defineSharedMemory, field } from '@atolljs/core';
export const counterMemory = defineSharedMemory({ count: field.number() });

// counter.worker.ts, the worker owns the runtime + the method list
import { defineWorker } from '@atolljs/core';
export const counterWorker = defineWorker({
  sharedMemory: counterMemory,
  methods: {
    increment(delta: number) {
      const next = counterMemory.count.read() + delta;
      counterMemory.count.write(next);   // write in place, no postMessage
      return next;
    },
  },
});
export type CounterWorker = typeof counterWorker;

// counter.ts: main thread imports the TYPE only; the client is a Proxy
import { connectWorker } from '@atolljs/core';
import type { CounterWorker } from './counter.worker';
export const counter = connectWorker<CounterWorker>({
  sharedMemory: counterMemory,
  worker: () => new Worker(new URL('./counter.worker.ts', import.meta.url), { type: 'module' }),
});
// counter.increment(1) → Promise<number>; pool spawns on first call
// (SSR-safe import). counter.terminate() tears it down.
```

## Browser requirements

`SharedArrayBuffer` only exists in cross-origin-isolated contexts. Every app
that uses `sharedMemory` must serve:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The examples set these in `server.headers` (Vite), `angular.json` dev-server
options, and `headers()` in Next config. Details: [cross-origin-isolation.md](cross-origin-isolation.md).
A message-only pool (no `sharedMemory`) needs neither the headers nor SAB.

## Running everything

```bash
npm run dev:all    # dev servers: consumer-docs :4181 · react :5173 · vue :5174
                   # solid :5175 · svelte :5176 · angular :4201 · next :3001 · islands :5177

npm run serve:all  # builds all apps into dist/<name>/ and serves one origin:
                   #   http://localhost:4173  →  /consumer/ /react/ /vue/ /solid/ /svelte/ /angular/
                   # nextjs stays server-rendered on :3001 (--no-build skips rebuilding)

npm run serve:pages  # builds the GitHub Pages artifact into dist-pages/ and
                     # serves it on :4174: a local preview of the deploy
                     # (static apps only; nextjs/nestjs aren't included)
```
