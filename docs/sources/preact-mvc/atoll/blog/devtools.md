---
date: 2026-10-04
series: Inside Atoll
---

# Devtools for the Other Thread

## Zero-cost instrumentation, one transport, and a dashboard that draws your worker graph

> **Problem.** The moment real work moves into a worker pool, your app
> becomes a black box. `console.log` across eight threads is a scramble,
> the browser's own devtools barely acknowledge workers exist, and the
> question that matters, *which worker is slow, and doing what?*, has
> no answer.
>
> **Fix.** `@atolljs/devtools`: a sink seam in the SDK, events forwarded
> over the channel the pool already owns, and a dependency-free dashboard
> that renders pools, workers, tasks, fetches, shared-memory writes, and
> islands as one live system.

There's a version of the worker story nobody puts in the pitch deck: the
part where something is slow and you can't see it. The pool is a Proxy:
great ergonomics, terrible visibility. `console.log` from inside a worker
does arrive, interleaved with seven other workers' logs, stripped of any
sense of *which* thread said it or what it was doing when it did.

And the browser's devtools treat workers as second-class: a list of
threads you can switch between, one at a time, with no view of the
system. Nothing answers "which of my eight pool workers is behind, on
which task, holding how much heap, making which fetches."

AtollJS already knew the shape of that system: it built it. So the
devtools didn't need to invent instrumentation; they needed a seam.

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

The `?__atoll_devtools` param *is* the gate: production builds ship the
code and never activate it. Turned on, `initDevtools` installs the event
sink and mounts the overlay: a draggable, resizable flyout holding the
full dashboard, served by the vite plugin on your own origin at
`/__atoll/`: no separate port, no extension, no CORS story. (The flyout
iframe needs the app's COOP/COEP echoed, which the plugin does for the
same reason worker scripts do: see
[cross-origin-isolation.md](../cross-origin-isolation.md).)

## What you see

The dashboard is a static, dependency-free app, `index.html` + `main.js`,
no build step, rendering whichever event stream it hears:

- **The app map**: one world-space canvas drawn like the logo it's
  named for: your app session at the center, pool sockets on the inner
  rim, workers on the mid orbit, islands on the outer orbit rendered as
  their framework's logo (React, Vue, Svelte, Angular…). Wheel to zoom, clustering tiers
  collapse islands into a ring, sessions into labeled discs, click to
  drill into any worker or island's own inspector.
- **Tasks**: a waterfall with one swimlane per worker slot:
  queued→dispatched→settled segments colored by outcome, per-task
  aggregates (failures, wait avg, run p95/max) with click-to-drill.
- **Network**: rolling traffic charts plus a real `fetch()` log from
  main thread *and* workers; click a row for headers, capped body
  previews, sizes, and a Resource-Timing stage breakdown.
- **Memory**, per-field shared-memory write rates (writes/sec, the
  worker that wrote last, sparkline) next to per-context JS heap,
  every worker's heap identified by its script URL.
- **Islands / Workers / Pools**, entity tables: round-trips, op
  batches, replay ms, respawns, errors, live state, cross-linked, since
  `island:mount` carries the client's `poolId`.
- **Log**: the raw event stream when nothing else will do.

Sessions are pages and processes. A disconnected page doesn't vanish:
it's retained (bounded) as an *ended* session so post-mortem history
stays attributed; pin the ones you're comparing, dismiss the noise, let
the TTL sweep the rest.

## The architecture discipline

The part worth stealing for your own observability work is how little
plumbing this took: because the transport decisions all lean on
structure that already exists:

**A sink, not a wire.** Core instrumentation never transports anything.
`emitDevtools(event)` is one branch on a module-level sink;
`connectDevtools()` is the only production code that installs one. That
single seam is why "off" costs literally nothing, and why every
transport produces an identical event stream.

**One transport per app, never per worker.** Workers don't get sockets.
Each event wraps in an `ATOLL_DEVTOOLS` postMessage on the task channel
the pool already owns; the main thread re-emits and stamps it
`worker: {poolId, slot}`. A `poolSize: 32` pool costs exactly one
connection, and the stream arrives single-ordered, which is what makes
the waterfall lanes legible at all.

**The transport *is* the scoping.** In a browser window the default is
`BroadcastChannel`: pure client, no backend, and same-origin isolation
*by spec*: a dashboard can only ever hear apps on its own origin. That's
not a filter; it's a guarantee. Node and cross-origin aggregation opt in
to the WebSocket path instead, pointed at the standalone server
(`npx atoll-devtools`, loopback port 4780): which is also what makes
post-mortem retention possible, since it outlives the page.

**Guard the hot paths, not the log.** `memory:write` fires on every
shared-memory commit: write-rate frequency. The call sites check
`devtoolsEnabled()` *before* building the event object, not just rely on
the sink no-op. Cheap is a design decision made at the call site, not a
hope placed in the transport.

## On Node, same stream

Node takes the WebSocket path by construction, no `window`, no
BroadcastChannel, pointed at the same standalone server, which *is* the
dashboard:

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

Worker-side events still reach the sink automatically: the pool stamps
a `devtools` flag into INIT, `worker_threads` forward over the task
channel, and `process.memoryUsage()` fills the per-worker heap columns.
Express and NestJS sessions land on the aggregate dashboard as
`runtime: 'node'`, right alongside any browser apps pointed at the same
server. One stream shape, both runtimes: same discipline as every other
layer.

---

*Internals and invariants: [docs/devtools.md](../devtools.md). Surface
and options: [`@atolljs/devtools`
README](https://github.com/jwhenry3/atolljs/blob/main/packages/devtools/README.md).
Node wiring: `examples/express`, `examples/nestjs`.*
