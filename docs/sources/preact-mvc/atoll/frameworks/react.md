# React: `@atolljs/react` + `@atolljs/react-island`

Read when: working on `packages/react/` (binding) or `packages/react-island/`
(shell components for worker islands).

## Binding: `@atolljs/react`

Hook adapter over `useSyncExternalStore`. SSR-safe: field reads return
`undefined` until the contract binds on the client.
Source: `packages/react/src/index.ts`. Example glue/view:
`examples/react/src/useIncidents.ts`, `examples/react/src/App.tsx`.

| Export | Signature | What it does |
|---|---|---|
| `useObservable` | `useObservable(source: ObservableValue<T>): T` | Subscribe to any observable snapshot (task or field). |
| `useSharedValue` | `useSharedValue(memory, key, select?, options?): T \| undefined` | Bind one shared-memory field; optional selector + equality to slice updates. |
| `useTask` | `useTask(task \| asyncFn): { data, pending, settled, elapsedMs, error, run, runOnce }` | Bind an AsyncTask, or any async fn (e.g. a client method, wrapped via `toTask`): to state and get its triggers. |

Notes: memoize query objects (`useMemo`) so effects only re-fire when the spec
actually changes; `runOnce()` makes init tasks StrictMode-safe (double mounts
skip a second run).

## Worker islands: `@atolljs/react-island`

A worker-hosted React (or imperative proxy-DOM) tree mounted as an ordinary
element in a React shell. The worker's render loop produces serialized DOM
ops; the components own the mount lifecycle and replay them onto a real `div`.
See [../islands.md](../islands.md) for the engine, topologies, and options:
all the island rules apply unchanged.

### The proxy API

| Export | Signature | What it does |
|---|---|---|
| `lazyIsland` | `lazyIsland(loader: () => Promise<{ default: A } \| { app, worker? } \| A>): FC<IslandAppProps<A> & IslandShellProps>` | React.lazy mirrored: suspends on the dynamic import (a real bundler split point), then mounts the resolved app with props inferred from its signature. Contract modules `{ app, worker }` carry their own worker factory. |
| `islandComponent` | `islandComponent<P>('name')` \| `islandComponent(StampedApp)` | The pure-contract proxy: the shell never imports the implementation; a registry key + a type-only props import is the whole contract. |
| `Island` | `<Island app={ref\|name} worker props onEvent slots onReady/>` | The underlying building block: declarative `mountIsland` as a component. `props` dedups by serialized identity. |
| `islandApp` | `islandApp('name', app)` | Stamps an app (component or `{imperative}` def) with its registry name: a data property, so references survive minification. Bare components fall back to `displayName`/`fn.name`: dev convenience; bundlers mangle `fn.name`, which is what the stamp exists for. |
| `definePolyWorker` / `defineMonoWorker` | from `atoll-islands/worker` | Registry worker (many named apps, shareable clients) vs the 1:1 instance worker (mounted namelessly, minimal bundle). |
| `Slot` / `emit` | `<Slot name>` / `emit(name, payload)` | Transclusion leaf + island→shell channel: see [../islands-worker.md](../islands-worker.md). |
| `Island` / `islandComponent` / `lazyIsland` / `connectIslandWorker` | from `@atolljs/react-island/worker` | The SAME mount components (and shared-client factory) for use inside a worker island: a nested mount spawns or reuses a sub-worker. |

### Nested islands: the same components inside a worker

`@atolljs/react-island/worker` re-exports `Island`, `islandComponent` and
`lazyIsland` unchanged. Rendered by a worker island, their container div is a
ProxyElement, so `mountIsland` routes the mount to the nested path; nothing
else differs. `worker={factory}` spawns a sub-worker for that mount;
`client={connectIslandWorker({ worker })}` built inside the parent worker
(a `useState` initializer keeps it per instance) hosts several sub-island
instances in one sub-worker. `onEvent` runs in the parent instance's scope,
so `emit` relays to the page; `slots` portal worker-side content into the
sub-island's anchors, and unlisted slot names bubble to the page shell.
`SubIsland` is kept as an alias. Details:
[../islands-worker.md](../islands-worker.md#one-mount-api-on-both-threads).

Reference: `examples/react-dom-worker/src/worker/console.worker.tsx`
(`regions`), mounted in the shell's ops console next to the same
definition's apps on a shared client and on per-mount workers.

### Mounting: the proxies make islands look local

Each `lazyIsland` loader returns the `islandApp`-stamped component, so props
infer from the worker component's own signature and the dynamic import
code-splits worker dependencies (a heavy island's deps fetch only when it
mounts: a static import pulls them into the shell chunk eagerly).
`<Suspense>` covers the module load; the proxy's `fallback` prop covers the
worker-mount window: mounting can't suspend because a suspended tree never
commits and the container must be in the DOM first.

Reference shell: `examples/react-dom-worker/src/shell.tsx`: mounts the
framework-native islands (`counter` ×2 + `nestedhost` on a shared client,
`notes` via `islandComponent`, the 1M-incident benchmark via `lazyIsland`)
with the mediation pattern (`onEvent → setState → <Island props>`) replacing
hand-wired `updateProps`, then the ops console: one PolyWorker mounted on a
shared client, with `worker` per mount, and nested.

`lazyIsland` also accepts a contract module carrying its own worker:
`lazyIsland(() => import('./incidents.island'))` resolves `{ app, worker }`
(`app` may be a bare registry-key string) so the island is a self-contained
split point.

### Notes

- **Mediation is unidirectional**: an island's `emit` lands in `onEvent`, the
  shell sets state, and it flows back in as props.
- **Two fallback phases:** `<Suspense>` for the module load, the proxy's
  `fallback` prop for the worker mount.
- **Fixed-dimension libs** (recharts) get width/height as props: measurement
  reads on the proxy DOM return zero for everything but the container.
- **Structural walls stay walls:** closed libraries that need real DOM
  (Google Maps JS) are housed via transclusion slots or iframe elements: the
  worker owns the box, the shell owns the contents.
