---
date: 2026-09-24
series: Inside Atoll
---

# Reactivity Without Messages

## `Atomics` beats `postMessage` fan-out

> **Problem.** Reflecting worker state in UI means a `postMessage` for
> every field change, to every client: whether or not anything is
> subscribed.
>
> **Fix.** Put a version counter on each shared-memory field and let
> watchers sleep on `Atomics.waitAsync`: a write resolves every waiter
> with zero messages, and `observe`/`watch` layer on top.

Getting worker state into a UI conventionally means a subscription
fan-out: the worker posts updates, the main thread forwards them to
whoever subscribed: a message for every field change, on every client,
even when nothing is looking at that field. It's the part of every
worker integration everyone builds and nobody enjoys.

Shared memory enables a different answer. Every field in a contract
carries a version counter; when a worker writes, `Atomics.add` bumps it.
Watchers on the main thread aren't polling and aren't waiting on
messages: they're parked on `Atomics.waitAsync`, asleep until the
counter moves. One write in the worker resolves every waiter. **Zero
messages.**

## The surface

```ts
import { observe, watch } from '@atolljs/core';

// ObservableValue<T>: get() + subscribe(); each @atolljs/* binding
// adapts this to its framework.
const stop = progress.subscribe((v) => render(v));

const unwatch = watch(incidentsMemory.state.metrics, (m) => render(m));
// or a selector: only re-fire when the projected value changes
watch(incidentsMemory.state.metrics, (m) => m.critical, (n) => alert(n));
```

Three properties make this usable as a UI primitive rather than a demo
trick:

- **Lazy binding.** `observe(memory, key)` is safe before the contract
  binds: it returns `undefined` and activates its watch when `bind()`
  lands. Components don't gate on pool startup.
- **Snapshot-stable.** `get()` only re-reads when the version counter
  moved, so selectors don't fire on unrelated writes.
- **Refcounted.** The underlying `Atomics` watch starts on the first
  subscriber and stops on the last unsubscribe. A page with no listeners
  pays nothing.

Task handles share the shape, `queryTask.subscribe((snap) => …)`
streams `{pending, result, error}` snapshots, so worker progress and
shared state render through one subscription model.

The payoff for adoption: `usePool`/`useTask` in React and their
equivalents in the other bindings are *thin adapters* over
`ObservableValue`. Atoll's change notification composes with your
framework's reactivity instead of competing with it: you never have to
explain to a teammate which of two reactive systems owns a value.

Source: the [reactivity guide](../reactivity.md); the version counters
it watches live in [shared memory](../shared-memory.md).
