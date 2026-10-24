# Reactivity & tasks

Read when: working on `src/reactive.ts`, `observable.ts`, `task.ts`,
`log.ts`, or any framework binding's subscription adapters.

The SDK's reactivity layer is framework-neutral: everything reduces to
`ObservableValue`, `get()` + `subscribe()`, which each
`@atolljs/*` binding adapts to its framework.

## `observe()`: fields as snapshots

```ts
import { observe } from '@atolljs/core';

// ObservableValue<T>: get() + subscribe(). Binds lazily: undefined until the
// contract is bound, activates its watch when bind() lands.
const progress = observe(incidentsMemory, 'signals.seedProgress');
const stop = progress.subscribe((v) => console.log(v));
```

`observe(memory, key)` is the primitive bindings consume. It's safe before
bind (returns `undefined`, activates on `onBound`), snapshot-stable (`get()`
only re-reads when the shared version counter moved), and refcounted (watch
starts on the first subscriber, stops on the last unsubscribe).

## `watch()` / `reactive()`: low-level

```ts
import { reactive, watch } from '@atolljs/core';

// Low-level: observe writes through the shared version counter.
const unwatch = watch(incidentsMemory.state.metrics, (m) => render(m));

// Selector form: callback only fires when the slice changes.
watch(incidentsMemory.state.metrics, (m) => m.critical, (n) => alert(n));

// reactive() gives a signal-tracked connector (solid-js under the hood):
// get() is tracked, set() writes through, observeRemote() polls the counter.
const conn = reactive(incidentsMemory.signals.seedProgress);
```

> **Node note:** under `node`/`worker`/`deno` export conditions `solid-js`
> resolves to its SSR build where effects never re-run. `watch`/`observe`
> detect this at runtime and fall back to driving callbacks straight off the
> shared version counter: same semantics, no signals. (The fallback makes
> callbacks fire asynchronously even for local writes; `reactive()`'s
> signal-tracked `get()` still requires the client build.)

## `defineTask()` / `toTask()`: latest-wins async

```ts
import { defineTask, toTask } from '@atolljs/core';

// Latest-wins async runner: rapid re-runs drop stale results.
// Snapshot: { data, pending, settled, elapsedMs, error }.
const queryTask = defineTask((q: QueryArgs) => incidents.queryIncidents(q));

queryTask.run({ offset: 0, /* ... */ });   // fire a run
queryTask.runOnce();                       // no-op if pending/settled
queryTask.subscribe((snap) => console.log(snap.pending));

// Usually you never call defineTask yourself: every binding's task helper
// accepts a plain async function and wraps it per call site:
//   useTask(incidents.queryIncidents)   // React
//   taskState(incidents.queryIncidents) // Angular / Svelte
// toTask() is the shared normalizer behind them.
const same = toTask(incidents.queryIncidents);
```

Task state is per call site, not per module: two components each calling
`useTask(incidents.queryIncidents)` get independent pending/data snapshots.
Pass a stable function reference: client methods are referentially stable,
and composite flows (seed then compute) belong in a module-level `async`
function like the incidents package's `initIncidents`.

## Logging

```ts
import { scoped, setLogLevel, setLogSink } from '@atolljs/core';

const log = scoped('my-domain');
log.debug('...', { detail: 1 });

setLogLevel('debug');                      // trace|debug|info|warn|error
setLogSink((entry) => myTelemetry(entry)); // route logs anywhere
```
