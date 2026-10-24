---
date: 2026-09-27
series: Islands
---

# The Proxy DOM

## How worker-rendered UI stays fast: an op stream, not a VDOM diff

> **Problem.** A worker can't touch `document`, and serializing rendered
> HTML per commit re-sends the whole subtree: losing element identity,
> focus, scroll position, and event targets.
>
> **Fix.** Give the worker a proxy document and stream diffs: DOM
> mutations become ops (`createElement`, `setAttribute`, …) replayed
> incrementally on the main thread, scoped per `app@N` island instance.

The objection writes itself: *a worker can't touch the DOM.* True, and
it's exactly why most off-main-thread rendering experiments end at a
`<canvas>` or a proof-of-concept nobody ships.

Atoll's answer is a **proxy document**: inside the worker, a JS object
implements just enough `document` for a real framework renderer to
target, `createElement`, `appendChild`, `setAttribute`, text nodes,
listeners, and every mutation lands on an op queue instead of a DOM.

## The pipeline

```
worker render → proxy DOM mutations → op queue → flush (postMessage)
                                              ↓
main thread: driver replays op batches onto real DOM in `el`
```

Events flow the other way: the driver forwards real DOM events into the
island's instance, and `emit()` sends app-defined messages to the
shell's `onEvent`. Instance keys (`app@N`) scope every queue and every
document, so islands sharing a worker are fully isolated.

## Why ops, not HTML

The obvious alternative, ship rendered markup per commit, re-sends the
whole subtree and destroys node identity: focus lost, scroll state gone,
event targets orphaned. Ops are the *diffs* a framework's commit phase
already computes. A two-character text change is a two-field message.
That's the granularity worth paying a thread boundary for.

The split that decides whether this is fast:

- **Worker side**: framework render + op serialization. Million-row
  table re-renders: ~2-3 ms.
- **Main-thread side**: op replay + real DOM writes. A virtualized
  table holds ~22 live DOM rows regardless of logical size: replay
  cost tracks what's *visible*, not what's *stored*.

One rule keeps the stream coherent: worker-initiated DOM work outside a
task re-enters through `runInInstance(instance, fn)` and
`bumpOpsVersion()`. Ambient `document`/`window` lookup inside a worker
is a heuristic, not a contract: worth knowing before you reach for it.

And the doorbell: with shared memory, an `Atomics` poke wakes the main
thread the moment ops queue. Drop it, or run somewhere without SAB
headers, and islands flush over ordinary `postMessage`. Same ops, same
DOM, one fewer capability required. That's the kind of degradation a
production system should have: silent and graceful, not a blank page.

Source: the [islands engine guide](../islands.md) and the
[worker-side contract](../islands-worker.md).
