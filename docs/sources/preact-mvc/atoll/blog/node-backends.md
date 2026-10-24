---
date: 2026-09-28
series: Server-side Atoll
---

# Atoll on the Server

## `node:worker_threads`, HTTP offload, and gateway routing

> **Problem.** A CPU-bound route on Node parks the event loop: every
> concurrent request queues behind the current serialization, hashing, or
> aggregation.
>
> **Fix.** `@atolljs/node` ports the same model onto `worker_threads`:
> pools compute off the main loop, `proxyToWorker`/`routeHttpGateway`
> forward matching requests into workers, and thin adapters plug the pool
> into Express, Fastify, Hono, or Koa.

Everything so far assumed a browser. The backend has the same story with
higher stakes: an endpoint that aggregates a million records parks the
event loop for tens of milliseconds per request, and while it runs,
*every other request on that process waits*. One slow route is a denial
of service on your own server.

`@atolljs/node` is the same framework, shared memory, typed pools, task
dispatch, running on `worker_threads`. Same API, different host.

## Three topologies, pick your depth

**Offload.** The simplest: the handler calls `pool.tasks.x()` and
awaits. The request stays on the main thread; the compute doesn't.
Works on every Node version, zero HTTP plumbing.

**Gateway.** `routeHttpGateway` (or the narrower `proxyToWorker`) keeps
the HTTP server on the main thread but forwards matching requests into
the pool: the worker's handler owns the response end-to-end:

```ts
import { proxyToWorker, workerHttpPorts } from '@atolljs/node';

// workers announce their listener ports via workerHttpPorts(...);
// the gateway forwards matching prefixes to them
app.use('/api/heavy', proxyToWorker({ pool, tracker, to, worker }));
```

The edge cases are handled rather than documented away: a
`HTTP_PORT_QUERY` handshake covers workers that announce before the
gateway's tracker sees them, and respawned workers reclaim their
prefixes on re-announce.

**Framework adapters.** Express, Fastify, Hono, Koa: thin plugins that
attach the pool and contract to the app you already have. You don't
port your server to Atoll; the pool joins your server.

## What's deliberately not here

No DOM, no islands: `worker_threads` has no rendering surface and
doesn't need one. The server story is *compute placement*: which event
loop pays for a request, and how shared state stays live in memory
instead of being re-fetched per request.

If the single-threaded event loop is the reason your p99 won't go down,
this is the shortest path past it that doesn't involve learning a new
request lifecycle.

Next in the series: what happens when workers take the sockets
themselves.

Source: the [Node.js runtime guide](../frameworks/node.md) and the
[framework adapters](../frameworks/node-backends.md).
