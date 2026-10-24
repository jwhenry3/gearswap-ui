# Plan: SharedWorker use cases beyond cross-tab state

**Status:** deferred (parked 2026-10-03 in favor of devtools work, see
[devtools-dashboard.md](devtools-dashboard.md))
**Context:** `connectSharedWorker`/`sharedWorkerHost` ship today as "one
`SharedWorker` owns one `SharedArrayBuffer`; every tab/iframe binds the same
contract", see [../shared-worker.md](../shared-worker.md). The docs frame
this almost entirely as shared state propagation. This file catalogs the
wider use-case space the same primitives enable, and the gaps blocking each.

## Why this surface is differentiated

A `SharedWorker` is implicitly **leader-elected per origin**: it exists
exactly once no matter how many contexts connect. Combined with
zero-`postMessage` state propagation through the shared buffer, that makes
three capabilities cheap here that are genuinely hard elsewhere:

1. singleton resource ownership across tabs,
2. shared *effects* (not just state) that outlive any single tab,
3. the same contract being runnable across topologies (dedicated worker,
   shared worker, `node:worker_threads`, `InProcessWorker`): a portability
   story we don't currently market.

## Use cases

### A. Singleton resource ownership: "the tab coordinator"

- **One realtime connection per origin.** Worker owns a single
  WebSocket/SSE/WebTransport socket and writes incoming data into shared
  fields; all tabs `observe()` them. Replaces N-connections-per-N-tabs and
  the localStorage-lock leader election every realtime SDK ships (Supabase,
  Firebase-style).
- **Auth/session ownership.** The classic "which tab refreshes the token"
  race disappears: the worker owns the refresh loop; every tab reads token
  state from the buffer.
- **Single IndexedDB writer.** Multi-tab IDB access means transaction
  contention; the shared worker as sole writer + synchronous reads from SAB
  sidesteps it.
- **Offline mutation/upload queue.** One queue owned by the worker keeps
  draining even when the tab that enqueued is closed (worker survives while
  ≥1 client is connected).
- **Sync engine.** One CRDT/OT loop in the worker; tabs are thin views.

### B. Portability: "micro-frontends for logic, not UI"

- **Contract is topology-agnostic already.** `workerClient` runs over any
  `TaskRunner`; the same `defineWorker` entry runs dedicated, shared, Node,
  or in-process for tests. Currently an implementation detail: could be a
  headline feature.
- **Independently deployed shared services.** The `islands-remote.md`
  mechanism (worker bundle from a remote/CDN origin) applied to
  `connectSharedWorker`: a platform team ships a session/analytics/prefs
  worker bundle and every app on the origin binds it via the contract.
  Micro-frontend distribution for business logic instead of rendering.
- **Hub-and-spoke buffers.** Browser analog of Node's
  `withSharedBuffer`/`bindSharedBuffer`: a SharedWorker as canonical state
  hub feeding per-tab compute pools off one buffer.

### C. Shared effects

- **Telemetry/analytics batching**: N tabs' events in, one beacon stream
  out. (Overlap with devtools-dashboard data-plane thinking.)
- **Notification/toast dedup**: all tabs observe the event; exactly one
  displays it. Handshake already assigns `clientIndex`; needs a small
  client-side leader primitive.
- **Fetch & compute dedup / shared cache**, normalized (GraphQL-style)
  cache living in the worker; fetch once per session, every tab reads
  synchronously from SAB, no async cache API, no structured-clone cost.
- **Multi-window apps**: pop-out panels, PiP dashboards, same-origin
  iframe embeds sharing state without `BroadcastChannel` cloning.

## Gaps blocking these (ranked by leverage)

1. **Browser-side shared-memory persistence.** `persistSharedMemory` /
   `redisMemoryAdapter` is `@atolljs/node` only. A SharedWorker dies with
   the last tab, so singleton-owned state evaporates at session end. An
   IndexedDB flush adapter (diff version counters → write dirty fields,
   like the Redis path) is the missing symmetric feature and makes most of
   section A credible.
2. **Message-only shared worker.** `connectSharedWorker` requires
   `sharedMemory`: `src/shared/sharedWorkerClient.ts` binds
   `config.sharedMemory` unconditionally. A memory-free path (singleton
   tasks only, no SAB, no COOP/COEP) widens reach.
3. **Contract version handshake.** The host's "first client's capacity
   wins" rule is safe only when all clients ship together. For
   independently deployed consumers (B's remote services), a mismatched
   client currently binds the same buffer with a different layout: needs
   a version/spec-id in the `SHARED_CONNECT` handshake that fails loudly.
4. **Safari fallback.** No `SharedWorker` on Safari; docs say
   "feature-detect and fall back to `WorkerPool`" but nothing's built in.
   For portability claims: an automatic fallback (per-tab pool +
   `BroadcastChannel` state sync, or graceful degradation) matters.
5. **Presence/lifecycle API.** `clientIndex` exists but there are no
   join/leave notifications or client-leader election: needed by
   notification dedup and several coordinator patterns.

## Honest limits (keep in the pitch)

- Session-scoped, not durable: gap 1 is the fix.
- Same-origin only; not a security boundary.
- `SharedWorker` absent on Safari and historically flaky in Firefox
  private windows: gap 4.
- One worker serializes task execution; fine for coordination, wrong for
  parallel compute (pair with per-tab pools: hub-and-spoke).

## Priority sketch

Highest market leverage × build cost:

1. Realtime-connection singleton (A.1): the demo writes itself, and it
   exercises state propagation, tasks, and lifecycle.
2. Remotely deployed shared services (B.2): extends the MFE story into
   logic; depends on gap 3.
3. Browser persistence (gap 1): the unlock for everything else.
