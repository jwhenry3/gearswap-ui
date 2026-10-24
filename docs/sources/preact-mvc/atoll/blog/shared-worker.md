---
date: 2026-09-25
series: Inside Atoll
---

# One Pool Per Browser

## `SharedWorker` makes shared memory actually shared

> **Problem.** A `WorkerPool` belongs to one page: three tabs means three
> pools, three copies of the same data, three workers recomputing the same
> results.
>
> **Fix.** `connectSharedWorker` + `sharedWorkerHost`: one `SharedWorker`
> owns one `SharedArrayBuffer`; each tab attaches a port and reads the
> same memory and version counter.

Open your app in three tabs and count what you just paid for: three
pools, three copies of the same dataset, three workers running the same
queries. Every tab pays full price because `Worker` is per-page: that's
the API, not your design.

For dashboards and multi-window tools that's waste squared.
`SharedWorker` exists for exactly this, but famously ships with
`onconnect`, a `MessagePort`, and nothing else. No shared state model,
no protocol.

Atoll's version:

```ts
// worker entry: installs onconnect → attachSharedPort(port)
import { sharedWorkerHost } from '@atolljs/core';
import './task.handlers';   // TaskRegistry.register(...) calls
sharedWorkerHost();

// page side
const worker = await connectSharedWorker({
  createWorker: () => new SharedWorker(
    new URL('./incidents.sharedWorker.ts', import.meta.url),
    { type: 'module' },
  ),
  sharedMemory: incidentsMemory,
  tasks: { initIncidents: InitIncidents, queryIncidents: QueryIncidents },
});

await worker.queryIncidents({ offset: 0, limit: 50 }); // typed task
worker.sharedMemory.metrics.read();                    // same buffer as every tab
worker.disconnect();                                   // this client only: worker stays up
```

One `SharedWorker` owns **one** `SharedArrayBuffer`. Each tab attaches a
port, binds the same contract, and gets views over the *same* memory.
The host allocates the buffer lazily on first attach: tabs that join
later bind to what's already there, sized by the contract's
`memoryBytes`.

The detail that makes this more than port plumbing: a write in one tab
bumps the shared version counter and resolves every *other* tab's
`Atomics` waiters. Cross-tab reactivity with zero messages and zero
broadcast channels: same mechanism as single-page reactivity, wider
scope.

And `disconnect()` closes one client's port while the worker, and the
memory, stay up for the rest. That's lifecycle semantics a per-tab
`Worker` simply can't express, and it's the difference between a
multi-tab feature and a multi-tab bug farm.

Source: the [shared-worker guide](../shared-worker.md); the cross-tab
waiters lean on [reactivity](../reactivity.md).
