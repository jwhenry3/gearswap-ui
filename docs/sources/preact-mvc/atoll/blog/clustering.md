---
date: 2026-09-29
series: Server-side Atoll
---

# Clustering and Persistence

## Socket-transfer, sticky sessions, and Redis-backed shared memory

> **Problem.** Offloading *compute* still leaves connections accepted on
> one main thread, and a process restart wipes shared state entirely,
> cold-starting the read model on the first request.
>
> **Fix.** `createHttpCluster` transfers raw sockets straight to workers
> (Node ≥ 26) with `stickyByAddress` pinning, `proxyUpgradeToWorker` does
> the same for WebSockets, and `persistSharedMemory` mirrors fields into
> Redis and replays them on boot.

Gateway routing moves compute off the main thread, but every connection
still lands there first. For most apps that's fine. For workloads where
the per-request cost *is* the product, hashing, compression,
aggregation over shared state, Node 26 added the missing primitive:
transferring the accepted socket itself to a worker.

## Socket-transfer clustering

```ts
import { createHttpCluster, stickyByAddress } from '@atolljs/node';

const cluster = createHttpCluster({
  workers: () => new Worker(new URL('./server.worker.ts', import.meta.url)),
  route: stickyByAddress(),     // same client → same worker
});
```

The main thread accepts and hands off; request handling never touches
its event loop. `stickyByAddress` pins clients to workers: essential
the moment a worker holds per-connection or in-memory session state.
`proxyUpgradeToWorker` does the equivalent for WebSockets: upgrades
tunnel through the gateway, or transfer with the socket on Node ≥ 26.
And `SOCKET_TRANSFER_SUPPORTED` is exported and checked: older Node is
told the truth, not crashed.

## Making shared state durable

The honest limit of shared memory: it's process-local. Restart the
process and a million-record read model is gone: cold start on the
first request, right when your load balancer is watching.

`persistSharedMemory` mirrors each versioned field into Redis hashes and
replays ops across processes:

```ts
import { persistSharedMemory, ioRedisSubscriber } from '@atolljs/node';

const handle = persistSharedMemory(incidentsMemory, {
  transport: ioRedisSubscriber(redis),  // any ioredis-shaped client
});
// on boot, workers rehydrate the buffer from Redis
// handle.stop() flushes and detaches cleanly
```

Stop is clean: a failing final flush warns instead of rejecting, and
the flush timer never leaks. On boot, workers rehydrate from Redis: the
read model survives a deploy.

That's the full arc this series builds toward: compute in workers,
connections on workers, state in shared memory, memory in Redis. Each
piece removes one reason production traffic has to care that
multithreading happened.

Source: the [Node.js runtime guide](../frameworks/node.md): clustering,
WebSocket tunneling, and persistence; implementation in
`packages/node/src/{http,redis}.ts`.
