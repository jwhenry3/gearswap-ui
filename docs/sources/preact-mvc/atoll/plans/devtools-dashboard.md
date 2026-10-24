# Plan: Atoll devtools: dashboard, analytics, watcher

**Status:** active scoping (started 2026-10-03)
**Goal (user-stated):** a tool giving insight into application performance
and traffic for apps built on AtollJS: debugging and diagnosing pool,
task, shared-memory, and island behavior. Framed as a competitive
differentiator vs other worker libraries.

## What exists to build on

- `pool.stats()`, queue depth, in-flight counts, wait/run aggregates
  (`src/pool/`; see [../tasks-and-pool.md](../tasks-and-pool.md))
- Typed error surface, `TaskTimeoutError`, `TaskAbortedError`,
  `WorkerCrashedError`, `PoolQueueFullError`, already the diagnosis
  vocabulary
- Per-field version counters, every shared-memory write bumps an
  `Atomics` counter; a watcher can diff counters to see write traffic
  without intercepting anything ([../shared-memory.md](../shared-memory.md))
- Island op stream, the serialized DOM-op protocol between worker and
  driver is a natural tap point for island render traffic
  ([../islands.md](../islands.md))
- `defineTask`, `{ data, pending, settled, elapsedMs, error }` per run
  ([../reactivity.md](../reactivity.md))
- `src/log.ts` logging: existing diagnostic channel

## Decisions (2026-10-03)

- **Surface:** standalone app served by a local server: works for browser
  and Node pools, no extension-store friction.
- **Scope:** full: pools/tasks, shared-memory field traffic, island
  op-stream introspection, and browser + `worker_threads` parity from
  day one.
- **Data plane:** opt-in typed event stream emitted by the SDK (not
  stats-polling): enqueue/dispatch/settle, queue wait, crash/respawn,
  field writes, island ops; causal ordering preserved.

## Architecture (decided 2026-10-03)

Three pieces:

### 1. Core event bus: `src/devtools.ts` (`@atolljs/core`)

- `DevtoolsEvent` typed union: `pool:init|terminate`,
  `worker:spawn|error|respawn`, `task:enqueue|dispatch|settle`
  (`callId` correlates one call across its lifecycle; outcomes:
  `ok|error|aborted|timeout|queue-full|crashed`), `memory:bind|write`,
  `island:mount|unmount|ops|event|task`.
- `setDevtoolsSink(sink | null)` + `emitDevtools(e)`: one branch when no
  sink is installed, same zero-cost contract as `log.ts` and islands'
  `proxyMetrics`. Stamped events carry `at` (performance.now on the
  emitting thread) + `thread`.
- Pools take `name?: string` in config as a dashboard label (falls back to
  a generated `pool-N` id).

### 2. Instrumentation call sites

- `src/pool/workerPool.ts`, spawn/terminate, per-slot spawn/crash/respawn,
  full task lifecycle (timings already measured for `stats()`, reuse).
- `src/contract/sharedMemory.ts`: `memory:bind` once per bind (field
  index→path table), `memory:write` per version-counter bump (scalar write
  wrapper + list `commit()`); `ConnectorContext` gains `path`.
- `packages/islands/src/island.ts`, `island:mount|unmount`, `island:ops`
  per applied batch (`via` = mount/dispatch/flush/updateProps/setSize,
  `replayMs` = main-thread apply time, the `onOps` hook's twin),
  `island:event` per emit, `island:task` per client round-trip
  (`islandCall` wraps every `client.*` call: method, ms, ops back,
  error).
- Worker→main forwarding: worker-side emitters post
  `{ type: 'ATOLL_DEVTOOLS', event }` on the existing task channel; the
  pool's message listener re-emits into the local sink. One dashboard
  connection per page, works for N workers (and node `worker_threads`
  via the same parentPort path).

### 3. Transport + server + app: `packages/devtools/`

- `connectDevtools({ url })` client: installs a sink that batches events
  over WebSocket to the local server. Same code path in Node (global
  WebSocket, ≥22).
- Server: Node http + ws; binds 127.0.0.1; `/events` ingestion endpoint,
  serves the static dashboard; aggregates multiple connected
  pages/processes as sessions.
- `atoll devtools` subcommand in `packages/cli` boots the server and
  prints the URL.
- Dashboard: Vite app (`packages/devtools/app/`): pool list, task
  timeline (enqueue→dispatch→settle waterfall), per-field write heatmap,
  island op traffic. Main-thread app, deliberately not an island: the
  tool must stay up when the observed app crashes.

## Phases

1. Core event bus + pool instrumentation + `name` config + tests. ✅
2. `memory:bind|write` (sharedMemory.ts) + island events + worker→main
   forwarding (`ATOLL_DEVTOOLS` messages, INIT-handshake `devtools` flag,
   `enableWorkerDevtoolsForwarding`). ✅
3. `packages/devtools`: WS transport client, dependency-free local server
   (static dashboard + `/events` ingest + `/view` fan-out + tail replay),
   `atoll devtools` + `atoll-devtools` bin. ✅: smoke-tested via
   `npm run atoll devtools` (in-repo path resolves `packages/devtools/dist`).
4. Dashboard app: dependency-free static page in
   `packages/devtools/app/`. ✅ baseline shipped; v2 (2026-10-04) rebuilt
   as an analytics site: KPI cards + "attention needed" feed (Overview),
   task waterfall swimlanes + per-task aggregates + click-to-drill
   (Tasks), per-field write rates + sparklines (Memory), islands, raw log.
   Closed sessions are retained (bounded, `closed: true` on `SessionInfo`)
   so post-mortem history stays attributed instead of orphaning rows:
   ended sessions render muted and are excluded from live KPIs.
   Island inspector (2026-10-04): per-instance drilldown: op-traffic
   chart, per-call aggregates, event-channel breakdown, round-trip table.
   Unmount now marks an island `ended` (record kept for post-mortem) rather
   than deleting it.
5. Worker inspector (2026-10-04): Workers view per (pool, slot): tasks,
   failures, respawns, errors; deep-dive has the worker's own waterfall
   lane (waterfall renderer parameterized onto `canvas._segs`), task
   history, error log. `island:mount.poolId` (`client.pool.poolId`, made
   public) cross-links island↔worker inspectors both directions.
6. Real network + memory amounts (2026-10-04): `net:fetch` events via a
   fetch probe: `installFetchProbe` wraps `fetch` on the main thread
   (`connectDevtools`, opt out `network:false`) and inside workers
   (INIT `devtools` flag). `runtime:memory` events via `installMemoryProbe`
   : `performance.measureUserAgentSpecificMemory` on the main thread gives
   a per-context cluster breakdown (worker heaps identified by script
   URL); `performance.memory` fallback. Worker-forwarded events are now
   stamped `worker:{poolId,slot}` at the pool, so worker fetches, writes,
   and heap samples attribute to a slot. Dashboard: fetch log + fetches/s
   card (Network), JS-heap-by-context table (Memory), heap column +
   inspector chart + per-worker fetch table (Workers), session heap in
   the sidebar, host-heap KPI in the island inspector. Caveats: XHR not
   covered; `performance.memory` is main-thread-only in Chrome, so the
   per-slot heap column fills only where workers expose it: Chrome's
   per-worker view lives in the context table.

### Direction (2026-10-04, user-stated)

Grow this into a deployable analytics product: run the devtools server
alongside a production web app for ongoing performance + engagement
review, not just local debugging. Implications: session retention and
history matter (done, ended sessions), the server needs a non-loopback
deployment story (auth/TLS is the operator's concern, document running
behind a reverse proxy), and the event surface should grow toward
engagement signals (page/interaction timing) not just pool internals.

## Follow-ups (not yet done)

- `connectSharedWorker` path emits nothing yet: its task dispatch bypasses
  WorkerPool, and the SHARED_CONNECT handshake needs the same `devtools`
  flag + port-level ATOLL_DEVTOOLS forwarding.
- InProcessWorker ignores the `devtools` INIT flag: same-realm tests use
  the global sink directly.
- Pool `name` is only on `WorkerPoolConfig`/`ConnectWorkerConfig`: NestJS
  `registerPool` and `createNodePool` should pass it through.
- Worker-side task timing breakdown (schema validation vs handler time)
  and task args/result payload sizes (clamped) would sharpen the timeline.
- The dashboard could read the live buffer directly for state inspection,
  the differentiator vs generic tooling (needs a buffer handle transported
  to the viewer, a devtools SharedWorker hub, tying into the deferred
  shared-worker use cases).

## Competitive framing

Competing worker libraries (comlink, workerize, threads.js) offer no
observability. The shared-memory fabric gives us something none of them
have: **synchronous, zero-serialization introspection of live state**:
the watcher can read the same buffer the app uses rather than intercepting
messages. A later option: route browser tabs' telemetry through a
devtools `SharedWorker` hub (ties into
[shared-worker-use-cases.md](shared-worker-use-cases.md) §C telemetry
batching).
