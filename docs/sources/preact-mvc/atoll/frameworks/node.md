# @atolljs/node: node:worker_threads adapter + HTTP clustering/offload

`@atolljs/node` adapts the SDK's DOM-shaped `Worker` expectations to Node's
`worker_threads` (an EventEmitter), so `WorkerPool`/`connectWorker` run in
any Node program without a framework. `packages/node` ships three surfaces:

| Import | Purpose |
|---|---|
| `@atolljs/node` | `createNodePool`, `createNodeWorker`, `NodeWorkerAdapter` |
| `@atolljs/node/shim` | worker-entry prelude, binds `self = parentPort` before Atoll's bootstrap evaluates |
| `@atolljs/node/http` | `createHttpCluster` (main) + `serveHttp` (worker), connections clustered into pool workers; `routeHttpGateway`: path-level routing: some routes in worker A, some in B, some on main |

## Task dispatch (any Node program)

```ts
const pool = createNodePool({
  worker: () => new Worker(new URL('./incidents.worker.ts', import.meta.url)),
  sharedMemory: incidentsMemory,
  poolSize: 'auto',
});
const incidents = workerClient<IncidentsWorker>(pool);
await incidents.computeMetrics();
```

The `worker:` factory may return a `node:worker_threads.Worker` directly:
`createNodePool` auto-wraps it. The DOM `new Worker(new URL(...))` literal
stays bundler-detectable where a bundler is involved.

**Two non-obvious runtime facts:**

- `worker_threads` spawn **plain Node** processes. tsx hooks and tsconfig
  `paths` do NOT propagate into workers: bundle the worker entry (e.g.
  esbuild → `dist/x.worker.js`) and point `workerFile`/`worker:` at the
  bundle, or keep worker-side imports resolvable by plain Node.
- Node needs no COOP/COEP headers: `SharedArrayBuffer` is always available.

## Shared-memory persistence (`@atolljs/node/redis`)

`persistSharedMemory` mirrors a bound contract's field regions to a Redis
hash: the shared-memory analog of NestJS's Redis WebSocket adapter. The
buffer stays the synchronous source of truth; Redis sits behind it for
restart durability and, optionally, cross-process replication:

```ts
const pool = createNodePool({
  worker: () => new Worker(new URL('./incidents.worker.ts', import.meta.url)),
  sharedMemory: incidentsMemory,
  persistence: redisMemoryAdapter(redis, { name: 'incidents' }),
});
await pool.persistence?.ready; // restored: workers see persisted state
```

A `syncIntervalMs` poll diffs the per-field version counters and `hset`s
dirty fields as base64; `stop()` (called by `pool.terminate()`) does a final
flush. Pass `subscriber` (`ioRedisSubscriber(redis.duplicate())`, or
node-redis's `subscribe(ch, cb)` shape directly) to also publish each dirty
field to `{key}:{name}:ops`: other processes apply the bytes into their own
buffer and bump the local version counter, so `observe()` fires the same as
a local write. Last-write-wins per field. `fields: [...]` restricts the
persisted subset. See `docs/shared-memory.md` → Persistence adapters and
`packages/node/test/redisMemory.test.ts` for the fake-client test pattern.

## HTTP clustering (`@atolljs/node/http`, Node ≥ 26)

The pool can own the whole HTTP lifecycle, not just dispatched tasks: the
`cluster` module's accept-and-handoff, rebuilt on `worker_threads`. The
main thread accepts TCP connections with `pauseOnConnect` (never reads
request bytes) and transfers each `net.Socket` to a worker via
`postMessage(msg, [socket])`. Inside the worker, an `http.Server` feeds the
socket to Express/Fastify/Koa: parsing, routing, handler execution, and
response serialization all run off the API thread:

```ts
// main thread: accepts + routes, never parses HTTP
const pool = createNodePool({ worker, sharedMemory, poolSize: 'auto' });
const cluster = createHttpCluster({ pool, port: 3204 });
await cluster?.close();     // stop accepting; transferred sockets stay with workers
```

```ts
// worker entry: after '@atolljs/node/shim'
import { serveHttp } from '@atolljs/node/http';
serveHttp(expressApp);            // or koa.callback(), fastify().server,
                                  // an http.Server, or { handler }/{ server }
```

- **`pool.workers`**: the pool exposes a live snapshot of slot workers
  (respawns included) for auxiliary messaging; `createHttpCluster` reads
  it fresh per connection. Task dispatch still owns `runTask`/`dispatch`:
  HTTP connections and `EXECUTE_TASK` messages coexist on the same workers.
- **Routing**: default round-robin; `route(socket, workers)` in options
  overrides (e.g. hash on remote address). Returning `undefined` destroys
  the socket.
- **Stickiness**: a transferred socket pins its whole life to one worker,
  so a bare WebSocket connection needs nothing. Multi-connection session
  flows do (socket.io's polling→upgrade, HTTP↔WS pairs): the acceptor can't
  read cookies/headers, so `route: stickyByAddress()` does rendezvous
  hashing on the client address (nginx `ip_hash` style): every connection
  from a client lands on one worker, and a removed worker only remaps its
  own clients.
- **Protocol**: sockets carry `{ type: 'HTTP_CONNECTION', socket }`, a wire
  id distinct from the task protocol; `serveHttp` filters for it, so it
  coexists with `defineWorker` in one entry.
- **Limits**: TCP only. `net.Server` transfer also works (a `server` option
  accepts a custom `net.createServer({ pauseOnConnect: true })` listener).
  TLS termination is NOT supported: a handshake would consume bytes on the
  accepting thread; serve plain HTTP behind a proxy/terminator. The socket
  must not have buffered data: `pauseOnConnect` is what makes this true.
- **Capability gate**: socket transfer (the mechanism clustering rides on)
  landed in Node.js 26. `createHttpCluster` bakes the check in: below 26 it
  logs a notice and returns `null`: callers never guard the call
  (`SOCKET_TRANSFER_SUPPORTED` stays exported for tests/feature detection).
  `serveHttp` *without* `listen` still throws there, since sockets are its
  only transport.

## Gateway: per-route ownership (any Node)

Clustering routes per *connection*: it can't split a listener by URL
path, because the accepting thread never reads request bytes. When routes
need explicit owners, `/api/a/*` on worker A, `/api/b/*` on worker B, the
rest on the main thread, `routeHttpGateway` takes the other approach: the
main thread parses HTTP once and proxies matched prefixes to worker-owned
listeners. No socket transfer, so it works on every Node version:

```ts
// worker entry: listen on an internal port and announce it
serveHttp(app, { listen: 0 });          // → parent gets {type:'HTTP_PORT',port}
```

```ts
// main thread
const gateway = routeHttpGateway({
  pool,
  port: 3204,
  routes: [
    { prefix: '/api/a/', to: '/api/', worker: 0 },  // pool slot 0 owns /api/a/*
    { prefix: '/api/b/', to: '/api/', worker: 1 },  // pool slot 1 owns /api/b/*
  ],
  handler: (req, res) => { /* everything else: main thread */ },
});
```

- `worker:` is a slot index into the live `pool.workers` snapshot (or a
  selector fn): a respawned worker re-announces its port and takes over its
  routes automatically.
- `to:` rewrites the prefix: `/api/a/incidents/query` reaches the worker as
  `/api/incidents/query`; the prefix only names the owner.
- Workers bind `127.0.0.1`: the gateway owns the only public port.
- A route whose worker hasn't announced yet gets a 503.
- Main-thread handler work (cheap shared-memory reads, fan-out dispatch)
  stays in-process: that's the "some routes on main" leg.
- **WebSockets**: upgrade handshakes match the same prefix table and are
  *tunneled*: the gateway replays the handshake to the owning worker's
  listener and splices the sockets, so frames never touch main-thread code.
  Unmatched upgrades go to `onUpgrade` (e.g. your own ws server on main),
  or the socket is destroyed.

### Embedding in a host framework: `workerHttpPorts` + `proxyToWorker`

When the main thread's HTTP stack belongs to Nest/Express/etc., mount just
the proxy piece instead of running the standalone gateway:

```ts
const tracker = workerHttpPorts(pool);          // HTTP_PORT handshake tracker
app.use('/api/housed', proxyToWorker({
  pool, tracker, to: '/api/housed',             // restore the stripped mount
  worker: (w) => w[i++ % w.length],             // or a slot index to pin
}));
```

`workerHttpPorts` tracks worker announcements (respawns re-announce on the
next `refresh()`; `HTTP_PORT_QUERY` covers announcements that raced the
attach). `proxyToWorker` resolves the target worker per request and forwards
`req`/`res` to its internal port. See `examples/nestjs` for a housed Nest
module.

WebSocket upgrades bypass middleware, so they get their own mount point:
`proxyUpgradeToWorker` returns an `'upgrade'` listener for the host server:

```ts
app.getHttpServer().on('upgrade', proxyUpgradeToWorker({ pool, tracker, worker }));
```

It replays the handshake to the worker's listener and tunnels frames
socket↔socket. Note the URL is *not* mount-stripped here (upgrade events
skip Express), so `to` is a rewrite prefix: usually omitted.

For clustering, nothing is needed at all: the WS handshake rides the
transferred socket, so `new WebSocketServer({ server })` on the server
`serveHttp` returns works inside the worker unchanged.

**Sharing one buffer across pools**: a pool's `sharedMemory` creates its own
`WebAssembly.Memory`, so a second pool can't take the same contract, give it
none (message-only) and hand each worker `pool.sharedBuffer` with
`withSharedBuffer`/`bindSharedBuffer` (`@atolljs/node`): the main-side wrapper
feeds a buffer (or thunk, evaluated per spawn) into every spawned worker's
message channel, and the worker entry `await`s `bindSharedBuffer()`, which
binds all defined contracts: before booting. `bindSharedBuffer` also accepts
a manual `workerData.buffer`. When the second consumer is itself a pool, the
`sharedBuffer` pool config does it directly (`sharedBuffer: pool.sharedBuffer`
or a thunk) — and inside a worker shell it's how sub-workers inherit the
shell's buffer (see [../tasks-and-pool.md](../tasks-and-pool.md)).

Reference implementation: `examples/http-offload`: gateway on :3204 (any
Node) plus the clustered listener on :3205 (Node ≥ 26); e2e asserts
one route shape answered by three different threads.
