---
date: 2026-09-30
pinned: true
---

# Introducing AtollJS

## Islands-based multithreading: pools, shared memory, and worker-rendered UI under one contract

> **Problem.** Web workers are the only real threads the browser gives
> you, and the platform hands you the pieces, `Worker`, `postMessage`,
> `SharedArrayBuffer`, but no structure. Calls are untyped messages,
> state is either cloned or hand-offset bytes, and the moment a second
> file needs to agree on a layout, drift becomes a production bug.
>
> **Fix.** AtollJS makes the boundary a *contract*: one typed spec both
> threads import, a worker pool behind a typed proxy client, reactivity
> over shared fields, and, at the far end, whole framework trees
> rendered inside workers.

JavaScript has had workers for fifteen years, and the way most apps use
them hasn't changed: pick the expensive function, post it some data,
await the result. That works: until the work isn't a function call.
It's a million-row scan. It's a UI tree re-rendering every frame. It's
state that both threads need *live*, not cloned-and-stale.

AtollJS is built around four goals, each one a layer:

## 1. Share state, don't serialize it

`postMessage` clones everything: fine for results, wrong for state a
worker updates continuously. The raw alternative, `SharedArrayBuffer`,
is fast and gives you *nothing* to keep both sides honest.

So the layout is a type. `defineSharedMemory` takes a spec of
fixed-width fields and compiles it to a deterministic byte layout:
one declaration, imported by main and worker alike:

```ts
// incidents.memory.ts: the contract both threads import
import { defineSharedMemory, field, reef } from '@atolljs/core';

export const incidentsMemory = defineSharedMemory({
  lists: {
    incidents: field.list({
      schema: reef.object({
        id:       reef.u32(),
        severity: reef.int(0, 3),    // domain bound → narrowest width (u8)
        site:     reef.string(10),   // 10 inline UTF-8 bytes, schema-enforced
        open:     reef.boolean(),    // flag byte
      }),
      count: 1_000_000,
    }),
  },
  signals: { seedProgress: field.number() },
});
```

The schema *is* the layout: `reef` mints validators the compiler reads a
byte width from, so the two sides can't disagree: there's only one
source of offsets. And it costs nothing you didn't ask for: the schema
engine is vendored into `reef`, so no zod dependency ships with the SDK.

Deep dive: [Shared Memory Is a Contract, Not a Buffer](shared-memory.md).

## 2. Make worker calls feel like method calls

A worker is an RPC surface: it should look like one. `defineWorker`
declares the method list inside the worker; `connectWorker` gives the
main thread a typed proxy over a lazily-spawned pool:

```ts
// incidents.worker.ts: worker side owns the runtime
import { defineWorker } from '@atolljs/core';

export const incidentsWorker = defineWorker({
  sharedMemory: incidentsMemory,
  methods: {
    async seedIncidents(n: number) {
      /* writes straight into shared memory: results don't cross postMessage */
    },
    queryIncidents(q: QueryArgs) { /* scan in place, return the page */ },
  },
});

// main.ts: the client is a Proxy typed by typeof worker
import { connectWorker } from '@atolljs/core';
import type { IncidentsWorker } from './incidents.worker'; // type-only

const incidents = connectWorker<IncidentsWorker>({
  sharedMemory: incidentsMemory,
  worker: () => new Worker(
    new URL('./incidents.worker.ts', import.meta.url), { type: 'module' },
  ),
  poolSize: 'auto',
});

await incidents.queryIncidents({ offset: 0, limit: 50 });
```

`import type` matters: worker code never enters the app bundle. Under
the hood the pool handles what bare workers don't: queueing,
`taskTimeout`, cancellation, crash respawn. A pool call always settles.

Deep dive: [Worker Pools That Fail Gracefully](worker-pools.md).

## 3. Let results flow back as reactivity

The payoff of shared memory is *live* reads: main doesn't await a
return value, it watches the field the worker is writing:

```ts
import { observe, defineTask } from '@atolljs/core';

const progress = observe(incidentsMemory, 'signals.seedProgress');
// snapshot-stable, refcounted: activates on first subscriber

const queryTask = defineTask((q: QueryArgs) => incidents.queryIncidents(q));
// { data, pending, settled, elapsedMs, error }: latest-wins by default
```

`observe` and `defineTask` are the primitives; framework bindings adapt
them: `useSharedValue`/`useTask` in React, equivalents in Vue, Solid,
Svelte, Angular, Next.js. Your component subscribes; the worker writes;
the diff flows through the version counter, not a message.

Deep dive: [Reactivity Without Messages](reactivity.md).

## 4. Render UI itself off-thread

Push the idea to its limit and the *framework tree* can live in the
worker too. `@atolljs/islands` mounts a registered app inside a worker;
it renders against a proxy document and streams serialized DOM ops back
to a driver that replays them. A React island, end to end:

```tsx
// counter.app.tsx: a plain React component; it runs INSIDE the worker.
// islandApp() stamps it with its registry key (minification-proof).
import { useState } from 'react';
import { islandApp, type EventPayload } from '@atolljs/islands/worker';
import { emit } from '@atolljs/react-island/worker';

// Worker-side handlers get the wire payload, { type, value, key },
// not a SyntheticEvent; handler() adapts it to JSX's event prop types.
const handler = <E,>(fn: (e: EventPayload) => void): ((e: E) => void) =>
  fn as unknown as (e: E) => void;

export const CounterApp = islandApp('counter', function CounterApp({
  label = 'count',
}: {
  label?: string;
}) {
  const [count, setCount] = useState(0);    // state never leaves the worker
  return (
    <button
      onClick={handler(() => {
        const n = count + 1;
        setCount(n);
        emit('incremented', { count: n });  // island → shell channel
      })}
    >
      {label}: {count}
    </button>
  );
});

// counter.worker.tsx: the whole worker entry
import { defineReactPolyWorker } from '@atolljs/react-island/worker';

export const counterWorker = defineReactPolyWorker({
  apps: { counter: CounterApp },            // one worker, many islands
});

// counter.island.ts: a shell-safe contract module: registry key + worker
// factory, no worker code imported. The dynamic import is the bundler's
// split point: it (and the worker entry) only loads when the island mounts.
export const app = 'counter';
export const worker = () =>
  new Worker(new URL('./counter.worker.tsx', import.meta.url), { type: 'module' });

// app.tsx: the shell is ordinary React; the facade is the boundary.
// lazyIsland mints a proxy component off the contract: attrs ARE the props.
import { Suspense } from 'react';
import { lazyIsland } from '@atolljs/react-island';

const CounterIsland = lazyIsland(() => import('./counter.island'));

export function App() {
  return (
    <Suspense fallback={<p>mounting worker…</p>}>
      <CounterIsland
        label="clicks"                      // serialized across postMessage
        onEvent={(name) => name === 'incremented' && console.log('worker-side click')}
      />
    </Suspense>
  );
}

// main.tsx: an ordinary bootstrap; React on both sides, DOM on one
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(<App />);
```

Render, diff, and state all run off the main thread: what's left behind
is a thin shell replaying ops. The facade wraps the same `mountIsland`
driver call, the contract's dynamic import is the split point, so a
heavy island's chunk only loads when it mounts, and the driver takes a
bare element on framework-free shells.
Per-framework packages (`react-island`, `vue-island`, …) keep each
worker's renderer to the framework it actually uses.

Deep dive: [Islands That Render in Workers](islands.md).

## On the server: NestJS

Everything above is the browser story; the pool doesn't change when the
runtime does. On `node:worker_threads`, `@atolljs/nestjs` puts the pool
behind dependency injection: `AtollModule.registerPool` makes it an
injectable provider, and `@AtollService` makes a service class the
interop surface: inject it anywhere and every method dispatches:

```ts
// digest.service.ts: the decorator picks the thread
import { Injectable } from '@nestjs/common';
import { AtollService } from '@atolljs/nestjs/decorators';
import { defineSharedMemory, field } from '@atolljs/core';

export const digestMemory = defineSharedMemory({ jobsDone: field.number() });

@Injectable()
@AtollService({ pool: 'digest' })   // every method dispatches to the pool
export class DigestService {
  async hash(input: string) {
    // executes inside the worker's own Nest context:
    // injected dependencies resolve there too
  }
}

// digest.module.ts: the API-thread side: the feature module owns the
// pool and the shared memory it was built on
import { Module } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { AtollModule } from '@atolljs/nestjs';
import { digestMemory, DigestService } from './digest.service';

@Module({
  imports: [
    AtollModule.registerPool({
      name: 'digest',
      // webpack emits the worker entry as its own chunk
      worker: () => new Worker(new URL('./digest.worker.ts', import.meta.url)),
      sharedMemory: digestMemory,
      poolSize: 2,
    }),
  ],
  providers: [DigestService],
})
export class DigestAtollModule {}

// digest.worker.ts: the whole worker entry
import { runAtollWorker } from '@atolljs/nestjs/worker';
void runAtollWorker(DigestAtollModule);

// digest.controller.ts: injecting the service is the whole consumer story
import { Body, Controller, Post } from '@nestjs/common';

@Controller('api/digest')
export class DigestController {
  constructor(private readonly digest: DigestService) {}

  @Post('hash')
  hash(@Body() body: { input: string }) {
    return this.digest.hash(body.input);   // dispatches to the pool
  }
}

// app.module.ts: forRoot once; feature modules own their pools
@Module({
  imports: [AtollModule.forRoot(), DigestAtollModule],
  controllers: [DigestController],
})
export class AppModule {}

// main.ts: an ordinary bootstrap; nothing about it is worker-aware
import { NestFactory } from '@nestjs/core';

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();               // pools terminate on module destroy
await app.listen(3100);
```

Each worker boots its own Nest application context, so the method body
runs with real DI on both sides: the class file is the contract, the
same discipline as every browser layer. Node needs no COOP/COEP for
`SharedArrayBuffer`, so shared memory comes along free; and a route
subtree can even be *housed* inside workers outright, proxied at the
framework boundary.

Deep dive: [Dependency Injection Across the Boundary](nestjs-di.md).

## What ties it together

Every layer leans on the same discipline: **declare once, in types both
threads share.** The memory contract is a schema; the worker surface is
`typeof` your worker module; islands scope every mount to an `app@N`
instance. Nothing is duplicated across the boundary, so nothing drifts.

And the footprint follows the same rule. Dependencies stay external and
opt-in: no shared-memory fields means no schema code in your bundle at
all; islands need no `SharedArrayBuffer` and no special headers, so the
graceful-degradation story is real. The whole stack is what you use of
it, byte for byte.

---

*The [overview](../overview.md) walks the three-layer architecture end to
end. For a first build, `atoll new` scaffolds a working island app in one
command.*
