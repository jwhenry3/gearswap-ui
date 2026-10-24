# Shared worker

Read when: working on `src/shared/`: `sharedWorkerClient.ts` /
`sharedWorkerHost.ts`, or the cross-context handshake.

`connectSharedWorker` + `sharedWorkerHost` extend the shared-memory pattern
beyond a single page: one `SharedWorker` owns one `SharedArrayBuffer`, and
every page, tab, and iframe that connects binds its contract to that same
buffer. The point isn't messaging between contexts: it's shared state.

## Pool vs shared worker

| | `WorkerPool` | `connectSharedWorker` |
|---|---|---|
| Worker kind | N dedicated `Worker`s, owned by one page | One `SharedWorker`, shared across contexts |
| Buffer owner | Page allocates, pushes to workers | Worker allocates once, shares with every client |
| Memory scope | Per page | **Cross-tab / cross-iframe**: one buffer, every client binds it |
| State propagation | Field writes → `observe` within the page | Field writes → `observe` in *every connected context* |
| Task dispatch | Round-robin across workers | Per-client port; single worker serializes execution |
| Lifecycle | `terminate()` kills workers | `disconnect()` closes this port; browser owns the worker |

## State propagates through memory, not messages

Every field write bumps a shared version counter via `Atomics.add` +
`Atomics.notify`, and each client's `observe`/`watch` subscribers park on
`Atomics.waitAsync` over that same counter. Because the buffer is literally
shared, a write in one tab resolves every other tab's waiter: **zero
`postMessage`, zero serialization, the worker isn't even involved**.

```ts
// tab A
memory.metrics.write((m) => ({ ...m, critical: m.critical + 1 }));

// tab B: fires on tab A's write. No message ever crossed the port.
observe(memory, 'metrics').subscribe((m) => render(m));
```

Port messages are only the *control plane*: the connect handshake and task
dispatch (request → compute → reply). State itself never crosses a port; it
lives in the buffer everyone shares.

## Protocol (control plane only)

Each connection is an independent `MessagePort` from `onconnect`. The
handshake inverts the pool's `INIT_MEMORY`: the client declares its
contract's `memoryBytes`, the host lazily allocates a shared
`WebAssembly.Memory` and returns the buffer: first client's capacity wins.
After that, ports only carry task dispatch.

```
client → host   { type: 'SHARED_CONNECT', memoryBytes, memory? }
host   → client { type: 'SHARED_MEMORY',  buffer, clientIndex }
client → host   { type: 'EXECUTE_TASK',   messageId, taskId, args }
host   → client { messageId, success, result | error }
client → host   { type: 'SHARED_DISCONNECT' }
```

Task execution reuses `TaskRegistry` verbatim: args/result schema validation
and error replies are identical to the pool path.

## Host: worker entry

```ts
import { sharedWorkerHost } from '@atolljs/core';
import './task.handlers';   // TaskRegistry.register(...) calls
sharedWorkerHost();         // installs onconnect → attachSharedPort(port)
```

Source: `src/shared/sharedWorkerHost.ts`.

## Client: page side

```ts
import { connectSharedWorker } from '@atolljs/core';

const worker = await connectSharedWorker({
  createWorker: () => new SharedWorker(
    new URL('./incidents.sharedWorker.ts', import.meta.url),
    { type: 'module' }
  ),
  sharedMemory: incidentsMemory,
  tasks: { initIncidents: InitIncidents, queryIncidents: QueryIncidents },
});

await worker.queryIncidents({ offset: 0, limit: 50 });  // typed method
worker.sharedMemory.metrics.read();                     // same buffer as every other client
worker.disconnect();                                    // this client only: worker stays up
```

Source: `src/shared/sharedWorkerClient.ts`.

## Notes

- **Reactivity is unchanged**: once the contract binds,
  `observe`/`watch`/framework bindings work the same; the buffer is just
  physically shared across contexts now.
- **Safari has no SharedWorker**: feature-detect and fall back to
  `WorkerPool`.
- **Same COOP/COEP requirements**: it's still SharedArrayBuffer. Iframed
  clients additionally need the full embedding chain from
  [cross-origin-isolation.md](cross-origin-isolation.md).
- **Concurrency**: one worker serializes task execution. No broadcast is
  needed for state: writes reach every client through the shared buffer, not
  through messages.
