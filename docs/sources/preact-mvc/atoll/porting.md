# Porting: new framework bindings & island renderers

Read when: writing a new `packages/<fw>` binding or `packages/<fw>-island`
package for a framework atoll doesn't ship yet.

Two independent contracts to implement: a binding works without islands,
an island renderer works without a binding.

## Part 1: the binding (`packages/<fw>`)

The binding is three adapters over two core primitives, `observe()` and
`toTask()`, funneled through `ObservableValue<T>` (`{ get(), subscribe(fn)
→ unsubscribe }`, see `src/reactive.ts`/`src/observable.ts`).

| Adapter | Wraps | Shape |
|---|---|---|
| `xObservable(source)` | `ObservableValue<T>` | framework's reactive cell, seeded with `get()`, written in `subscribe`, unsubscribed on scope teardown |
| `xSharedValue(memory, key, select?, options?)` | `observe()` | `xObservable(observe(...))`, keep the `\| undefined` overloads |
| `xTask(source)` | `toTask()` | `{ state: xObservable(task), run, runOnce }`, pass `AsyncTask \| async fn` through |

Template: `packages/vue/src/index.ts`: the entire binding is ~40 lines.

Per-framework teardown hook (the only line that actually differs):

- React, `useSyncExternalStore(subscribe, get)`; unsubscribe is its own cleanup
- Vue, `onScopeDispose(stop)`
- Solid, `onCleanup(stop)`
- Svelte 5, `return stop` from `$effect` in a `.svelte.ts` module
- Angular: `inject(DestroyRef).onDestroy(stop)`

Invariants to preserve:

- `get()` is `undefined` until bound + first write: SSR-safe by
  construction; keep `\| undefined` in the public types.
- One subscription per binding; teardown is the framework's scope hook,
  never a manual `destroy()`.
- `select`/`SliceOptions` pass through untouched; selectors must be pure.
- `run`/`runOnce` are returned by identity: no per-render wrappers.
- `observe()`/`toTask()` created inside the adapter, not at module scope.
- Framework is a peer dep; entry is `src/index.ts` shipped unbuilt.

## Part 2: the island renderer (`packages/<fw>-island`)

Two entries: the `/worker` split IS the bundle boundary:

- `src/index.ts` (shell): main-thread mount surface, imports only
  `@atolljs/islands` main entry (`mountIsland`, `connectIslandWorker`,
  `islandAppNameOf`). No framework renderer here.
- `src/worker.ts` (adapter): produces `RenderedIslandApp`s; the only file
  allowed to import the framework's renderer.

### Worker contract (`src/worker.ts`)

`RenderedIslandApp` = `{ mount(ctx: { instance, doc, props }) → RenderedHandle
| void }`: see `packages/islands/src/worker/defineWorkers.ts`. `ctx.doc` is
the instance's `ProxyDocument`; every mutation already serializes to ops.
Map your framework's host-op interface onto it (Vue's `createRenderer`,
Solid's universal renderer, Svelte's `mount()`, Angular's `Renderer2`), or a
reconciler host config (`newElement`/`newText`/`serializeProps`/
`ROOT_CONTAINER` exports: the react-island shape).

`RenderedHandle` per capability: `update(props)` for fine-grained patching
(props REPLACE: no merge), `sync(fn)` for a synchronous commit lane,
`flush()` for async-scheduled work, `dispose()` for teardown. Omit `update`
→ the runtime rebuilds (dispose + clear + remount).

Ship the conveniences: `fwIslandApp(Component)`, `define<Fw>PolyWorker`
/`define<Fw>MonoWorker` (wrap + delegate to `definePolyWorker`/
`defineMonoWorker`), `fwIsland(name, c)` = `islandApp(name, fwIslandApp(c))`,
and re-export `emit`/`runInInstance` so worker entries need no second
specifier.

Pitfalls already burned into the existing adapters (`*-island/src/worker.ts`
headers are the detailed reference):

- **Realm resolution**: module-level renderers' `create*` host ops get no
  node arg; resolve the instance via
  `getActiveInstance() || getLastActiveInstance() ||
  getLastTouchedInstance()` → `docForInstance()`. Async scheduler flushes
  (Vue/Solid microtasks) commit outside tasks: without the chain their ops
  land on the wrong instance's document.
- **Event invokers**: one stable function per (el, event) holding `.value` =
  current handler; capture is a distinct slot; modifier/opts changes mean
  detach + re-listen.
- **Form props are accessors**: `el.value = x`, not `setAttribute`.
- **Namespaces**: svg/mathml route through `createElementNS`.
- **Instance-less work**: timers/continuations mutating DOM wrap in
  `runInInstance(instance, fn)` + `bumpOpsVersion()`.

### Shell port (`src/index.ts`)

Port `useIsland` (`packages/vue-island/src/index.ts` is the reference):
`{ host, handle, status, error }`; mount on non-null host via
`mountIsland`; reactive props → `updateProps` deduped on `JSON.stringify`
identity; `client`/`worker`/`app`/`slots` mount-stable (document swap-via-
key); generation counter guards async mount races; scope disposal destroys.
The component wrapper is a thin shim reading framework props through the
options object.

### Which package to copy

| Framework shape | Reference |
|---|---|
| `createRenderer`-style host ops | `packages/vue-island` (smallest) |
| Fine-grained signals / universal renderer | `packages/solid-island` |
| Compile-to-DOM, programmatic `mount()` | `packages/svelte-island` |
| Renderer2-style abstraction + DI | `packages/angular-island` |
| Full reconciler host config | `packages/react-island` (hostConfig.ts + reactInstance.ts) |

## Testing

`InProcessWorker` (`src/testing/inProcessWorker.ts`): real registry, real
op stream, real shared-memory binding; only the thread is faked.
`flushObservers()` settles pending notifications. Island packages exercise
`mountIsland` end-to-end under vitest/happy-dom: see
`packages/islands/test/`.

## Consumer docs

The docs site's "Extending" section (`/consumer/custom-bindings/`,
`/consumer/custom-islands/`) is the end-user version of this page: keep the
two in sync when contracts change.
