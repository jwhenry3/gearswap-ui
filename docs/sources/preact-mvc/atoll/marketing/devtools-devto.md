# Dev.to: Devtools for Multithreaded Applications

Dev.to article adapted from [`../blog/devtools.md`](../blog/devtools.md), weighted toward pitching AtollJS: the site post assumes the reader knows the project, this one introduces it up front and closes with a CTA. Copy everything below the rule into the dev.to editor verbatim, frontmatter included: `published: false` lands it as a draft. No Problem/Fix blockquote; those are a site-blog convention only.

---

---
title: 'Devtools for Multithreaded Applications: Zero-Cost Observability for Web Workers'
published: false
description: AtollJS devtools put a live observability surface on worker pools - app map, task waterfall, fetch log, shared-memory writes, per-worker heaps - browser and Node on one dashboard.
tags: javascript, typescript, webdev, webworkers
cover_image:
canonical_url:
---

# Devtools for Multithreaded Applications: Zero-Cost Observability for Web Workers

[AtollJS](https://github.com/jwhenry3/atolljs) is an open-source SDK for moving real work off the main thread: typed worker pools you call like local objects, shared-memory state that stays in sync across threads without serialization on the hot path, and UI islands that render React, Vue, Solid, Svelte, or Angular entirely inside web workers. The core is ~12 KB gzipped on the main thread with no runtime dependencies.

A pool is a method list on the worker side and a typed Proxy client on the main side:

```ts
// counter.worker.ts: the worker entry; methods live here
import { defineWorker } from '@atolljs/core';
import { counterMemory } from './counter.memory';

export const counterWorker = defineWorker({
  sharedMemory: counterMemory,
  methods: {
    increment(delta: number) {
      const next = counterMemory.count.read() + delta;
      counterMemory.count.write(next);   // in-place shared-memory write
      return next;
    },
  },
});
export type CounterWorker = typeof counterWorker;
```

```ts
// counter.ts: the main thread imports the type only, no worker code
import { connectWorker } from '@atolljs/core';
import { counterMemory } from './counter.memory';
import type { CounterWorker } from './counter.worker';

export const counter = connectWorker<CounterWorker>({
  sharedMemory: counterMemory,
  worker: () => new Worker(
    new URL('./counter.worker.ts', import.meta.url),
    { type: 'module' },
  ),
  poolSize: 'auto',   // navigator.hardwareConcurrency
});

await counter.increment(1);   // typed RPC; the pool spawns on first call
```

That ergonomics story has a catch, and it's the subject of this post: the moment real work moves into a pool, your app becomes a black box. `console.log` across eight threads is a scramble, the browser's own devtools treat workers as second-class (a list of threads you can switch between, one at a time), and the question that matters, *which worker is slow, and doing what?*, has no answer.

[`@atolljs/devtools`](https://github.com/jwhenry3/atolljs/tree/main/packages/devtools) is our answer: a live observability surface for the whole worker system, and it was almost free to build, because AtollJS's architecture already knew the shape of the system it was observing.

## One line, gated by the URL

```ts
import { initDevtools } from '@atolljs/devtools';

initDevtools({ session: { name: 'my-app' } });
// Call before pools spawn: workers forward events only if the sink
// existed at INIT time.
```

Then:

```
my-app/?__atoll_devtools   → devtools on, dashboard flyout mounts
my-app/                    → zero cost; no sink installed
```

The `?__atoll_devtools` param *is* the gate: production builds ship the code and never activate it. Turned on, `initDevtools` installs the event sink and mounts the overlay: a draggable, resizable flyout holding the full dashboard, served by the AtollJS vite plugin on your own origin at `/__atoll/`: no separate port, no extension, no CORS story.

## What you see

The dashboard is a static, dependency-free app, `index.html` + `main.js`, no build step, rendering whichever event stream it hears:

- **The app map**: one world-space canvas drawn like the logo it's named for: your app session at the center, pool sockets on the inner rim, workers on the mid orbit, islands on the outer orbit rendered as their framework's logo (React, Vue, Svelte, Angular…). Wheel to zoom, clustering tiers collapse islands into a ring, sessions into labeled discs, click to drill into any worker or island's own inspector.
- **Tasks**: a waterfall with one swimlane per worker slot: queued→dispatched→settled segments colored by outcome, per-task aggregates (failures, wait avg, run p95/max) with click-to-drill.
- **Network**: rolling traffic charts plus a real `fetch()` log from main thread *and* workers; click a row for headers, capped body previews, sizes, and a Resource-Timing stage breakdown.
- **Memory**: per-field shared-memory write rates (writes/sec, the worker that wrote last, sparkline) next to per-context JS heap, every worker's heap identified by its script URL.
- **Islands / Workers / Pools**: entity tables: round-trips, op batches, replay ms, respawns, errors, live state, cross-linked, since `island:mount` carries the client's `poolId`.
- **Log**: the raw event stream when nothing else will do.

Sessions are pages and processes. A disconnected page doesn't vanish: it's retained (bounded) as an *ended* session so post-mortem history stays attributed; pin the ones you're comparing, dismiss the noise, let the TTL sweep the rest.

## Why it was cheap

The part worth stealing for your own observability work is how little plumbing this took, and it doubles as the best argument for the platform underneath: every transport decision leans on structure AtollJS already had.

**A sink, not a wire.** Core instrumentation never transports anything. `emitDevtools(event)` is one branch on a module-level sink; `connectDevtools()` is the only production code that installs one. That single seam is why "off" costs literally nothing, and why every transport produces an identical event stream.

**One transport per app, never per worker.** This is where the pool design pays for itself. Workers don't get sockets; each event wraps in an `ATOLL_DEVTOOLS` postMessage on the task channel the pool already owns, and the main thread re-emits it stamped `worker: {poolId, slot}`. A `poolSize: 32` pool costs exactly one connection, and the stream arrives single-ordered, which is what makes the waterfall lanes legible at all.

**The transport *is* the scoping.** In a browser window the default is `BroadcastChannel`: pure client, no backend, and same-origin isolation *by spec*: a dashboard can only ever hear apps on its own origin. That's not a filter; it's a guarantee. Node and cross-origin aggregation opt in to the WebSocket path instead, pointed at the standalone server (`npx atoll-devtools`, loopback port 4780): which is also what makes post-mortem retention possible, since it outlives the page.

**Guard the hot paths, not the log.** `memory:write` fires on every shared-memory commit: write-rate frequency, and AtollJS shared memory is designed for exactly that kind of write rate. The call sites check `devtoolsEnabled()` *before* building the event object, not just rely on the sink no-op. Cheap is a design decision made at the call site, not a hope placed in the transport.

## On Node, same stream

AtollJS pools also run on `node:worker_threads` (Express, Fastify, Hono, Koa, NestJS adapters), and the devtools follow: Node takes the WebSocket path by construction, pointed at the same standalone server, which *is* the dashboard:

```ts
// src/devtools.ts: a dedicated module, imported FIRST from the entry.
// No-op unless ATOLL_DEVTOOLS is set in the environment.
import { initDevtools } from '@atolljs/devtools/node';
initDevtools({ session: { name: 'my-api' } });
```

```ts
// main.ts: ESM evaluates imports before the body runs; pools spawn
// inside sibling modules (or NestFactory), so the sink must be first.
import './devtools';
```

```bash
ATOLL_DEVTOOLS=1 npm run start &
npx atoll-devtools          # http://127.0.0.1:4780
```

Worker-side events still reach the sink automatically: the pool stamps a `devtools` flag into INIT, `worker_threads` forward over the task channel, and `process.memoryUsage()` fills the per-worker heap columns. Express and NestJS sessions land on the aggregate dashboard as `runtime: 'node'`, right alongside any browser apps pointed at the same server. One stream shape, both runtimes.

## Try it

```bash
npx @atolljs/cli new            # scaffolds a runnable project
npx @atolljs/cli add devtools   # init module + @atolljs/devtools install
```

Spawn a pool, open your app with `?__atoll_devtools`, and watch the map draw itself. Everything above ships in the repo today:

- **GitHub**: [github.com/jwhenry3/atolljs](https://github.com/jwhenry3/atolljs)
- **Docs and live demos**: [jwhenry3.github.io/atolljs](https://jwhenry3.github.io/atolljs/)
- **Devtools internals and invariants**: [docs/devtools.md](https://github.com/jwhenry3/atolljs/blob/main/docs/devtools.md)
- **Node wiring examples**: `examples/express`, `examples/nestjs`

If you've got a worker pool in production and no way to see inside it, we'd love to hear what the dashboard is missing. Issues and PRs welcome.
