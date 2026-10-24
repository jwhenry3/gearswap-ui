# Worker islands

Read when: working on `packages/islands/` (the engine, driver, op protocol),
`mountIsland`/`connectIslandWorker`, or any island mount site.

`@atolljs/islands` renders framework trees *inside* Atoll workers: the
worker owns the render loop and every commit serializes to an op stream the
main thread replays as real DOM mutations. Opt-in DOM rendering off the main
thread: the shell keeps events, layout, and slots; the worker keeps the app.
Source: `packages/islands/src/island.ts` (driver), `src/ops.ts` (protocol),
`src/worker/` (worker side).

## Vocabulary

| Term | Meaning |
|---|---|
| **Atoll** | The fabric: worker pools, contracts, shared memory, task dispatch (`@atolljs/core`). Islands are one workload built on it. |
| **PolyWorker** | `definePolyWorker({ apps })`: a worker *definition* (one script) over a *registry* of apps. Every worker spawned from it can render any registered app; the mount picks which. The shared-dependencies shape: one bundle, one framework copy. |
| **MonoWorker** | `defineMonoWorker(app)`: a worker definition pinned to a single app. The isolated-dependencies shape: own bundle, own failure domain, nothing reachable outside it. |
| **Island** | The mounted unit: `mountIsland()` puts one instance of a registered app into a container element. Each mount mints an `app@N` **instance key** that scopes its op queue, proxy document, and events. |
| **Shell** | The main-thread side: plain DOM, or any framework via the `*-island` packages. |

## How it fits together

```
┌───────────────────────────── main thread ─────────────────────────────┐
│  mountIsland driver: replays op batches onto real DOM in `el`,        │
│  dispatches real events back, pushes container size via ResizeObserver │
└──────────────┬─────────────────────────────────▲──────────────────────┘
   EXECUTE_TASK │ postMessage          op batches │ (task results) + flush
   (mount/update│                      emits     │
    Props/dispatch/flush/unmount)                │ doorbell: SharedArrayBuffer
┌──────────────▼─────────────────────────────────┴──────────────────────┐
│  worker: definePolyWorker({ apps }) / defineMonoWorker(app)           │
│  per instance: reconciler or proxy-DOM app → mutations serialize to ops│
└───────────────────────────────────────────────────────────────────────┘
```

Inside the worker, a real `react-reconciler@0.34` (React islands) or the
per-framework renderer (Vue/Svelte/Solid/Angular islands) commits against a
DOM-free host surface; every commit serializes to an op stream. Imperative
(non-framework) apps get a proxy `document` whose mutations emit the same ops.
Events work the other direction: a worker-side `addEventListener` becomes a
`listen` op, the driver attaches a real listener, and each dispatch
round-trips back to the worker as an instance-scoped task.

The shared-memory contract here is only a *doorbell*: a commit counter the
main thread `observe()`s to trigger `flush()` as a push. Ops themselves always
ride the pool's ordinary postMessage channel. Drop the doorbell entirely and
islands still work on the 50ms poll: that's the message-only mode, no
`SharedArrayBuffer` and no COOP/COEP requirement.

## Quickstart

```ts
// render.worker.ts: the whole worker entry
import { definePolyWorker } from '@atolljs/islands/worker';
import { reactIslandApp } from '@atolljs/react-island/worker';

export const renderWorker = definePolyWorker({
  apps: {
    dashboard: reactIslandApp(DashboardApp),          // a React component
    vanilla: { imperative: (doc, props) => { ... } }, // or pure proxy-DOM code
  },
});
```

Framework apps enter the registry wrapped: `reactIslandApp`,
`vueIslandApp`, … adapt a component to the worker's `RenderedIslandApp`
contract. Single-framework registries skip the wrap: each `*-island` package
ships `define*PolyWorker`/`define*MonoWorker` helpers that take plain
components (`defineReactPolyWorker({ apps: { dashboard: DashboardApp } })`).

```ts
// main thread: one call; `worker` builds an island-owned client internally
import { mountIsland } from '@atolljs/islands';

const island = await mountIsland({
  worker: () => new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' }),
  el: document.getElementById('island')!,
  app: 'dashboard',
  props: { ... },
  onEvent: (name, payload) => { ... },         // island → shell emit() channel
  slots: { preview: (el) => mountCanvas(el) }, // transclusion holes
});
island.updateProps({ ... });
island.destroy();
```

Pass `client: connectIslandWorker({ worker })` instead of `worker` when
several islands should share one worker: multi-island-per-worker. The client
is released when its last island destroys. The choice between the two is
the topology decision: a `worker:` mount spawns a worker, a `client:` mount
doesn't (see [Definitions, workers, instances](#definitions-workers-instances)).

## `mountIsland` options

| Option | Notes |
|---|---|
| `el` | Container element the op stream replays into. Required. |
| `worker` / `client` | Exactly one: a bundler-detectable worker factory (or URL) this mount owns, or a shared `connectIslandWorker` client. |
| `app` | Registry key into `apps`. Optional for MonoWorkers: a single-registered-app worker resolves its sole app regardless of the requested name. |
| `props` | Serialized to the worker via `structuredClone`: uncloneable values reject naming the offending key. `callbackProp(fn)` markers pass shell functions through. |
| `onEvent` | Receives every worker-side `emit(name, payload)`. |
| `slots` | `{ name: (el \| null) => void }`: when a `data-atoll-slot` element's create op lands, the real element is handed here; called again with `null` on removal/rename. The element stays worker-owned; its contents are yours. |
| `onActivity` | Fired after each applied op batch: stats/keepalive hook. |
| `onOps` | `(ops, elapsedMs)` after each replay: pair with client timing to split worker-vs-main cost before committing a workload to an island. |
| `mode` | `'push'` (default: SAB doorbell) or `'poll'` (50ms drain). With the `worker` shorthand, `'poll'` also builds a doorbell-free client: no SharedArrayBuffer, no isolation headers. |
| `mountTimeout` | Bounds the mount handshake: default 15s, `0` disables. A worker entry that loads but never answers rejects with a named error instead of pending forever; hard failures reject immediately. A failed mount releases the instance and terminates an island-owned client. |

Driver-side prop application follows DOM conventions: `class`/`className`
write the property, `onX` refs become real listeners, and `style` objects
merge key-by-key with React-DOM unit semantics: numbers on non-unitless
properties gain a `px` suffix (`style={{ height: 24000000 }}` works;
unitless keys like `opacity`/`zIndex` pass through verbatim), custom
properties and kebab-case keys go through `setProperty`.

## `IslandHandle`

| Member | Notes |
|---|---|
| `app` / `pid` | The registry name, and the instance's random worker-side id: proof each island is a distinct render instance (stable across remounts). |
| `updateProps(props)` | Shell→island channel: re-renders the root with new serialized props. Framework renderers patch fine-grained; imperative apps rebuild (dispose + clear + re-mount on a fresh document). |
| `setMode(mode)` | Switch push↔poll after mount. Doorbell rebinds re-watch transparently. |
| `flush()` | Manual drain of ops committed outside task calls: poll mode's mechanism, rarely needed under push. |
| `destroy()` | Releases the instance via `unmount`; terminates the worker when this island owns the client, leaves siblings running when it's shared. |
| `opsApplied` / `flushCalls` | Replay counters: the demo's aggregate stats read these. |

### Devtools hooks

While devtools is enabled when it mounts, a main-thread island registers
with the `island.*` dashboard commands
(`packages/islands/src/devtoolsCommands.ts`) and emits `island:props` on
mount and every `updateProps`, `island:event` with a payload preview, and
`island:ops` with an estimated `bytes` size (plus an
`atoll replay <instance>` User Timing measure per batch). From the
dashboard, `island.updateProps` calls the handle's `updateProps` with the
edited JSON: it **replaces** the props, and every `'[fn]'` placeholder (how
`island.props` shows a function or `callbackProp` marker) is restored from
the current props at the same path, so callbacks survive a read-edit-write
round trip. Other non-JSON values (binary data, Maps, Sets, Dates) come
back as display values and replace the originals. `island.setMode` calls
`setMode`. Nested islands (`parent~app@N`) live in their parent's worker
and aren't commandable; their DOM appears in the outer island's
`island.tree`. See [devtools.md](devtools.md#control-channel-dashboard--app).

## Definitions, workers, instances

Three levels, easy to conflate:

| Level | Created by | Count decided by |
|---|---|---|
| **Definition** (the script) | `definePolyWorker` / `defineMonoWorker` in a worker entry | your source: one per entry file |
| **Worker** (an OS thread) | an island *client*: `connectIslandWorker`, explicit or built by a mount | one per client (pinned to `workers: 1`, a dedicated worker with no pool) |
| **Instance** (one island, `app@N`) | each `mountIsland` call | one per mount |

The definition only declares what a worker *can* render. Both definers build
the same runtime; they differ in the registry: many apps for a PolyWorker,
exactly one for a MonoWorker. The **mount site** decides the topology:

```ts
// main thread: a factory over the PolyWorker entry (render.worker.ts)
const renderEntry = () =>
  new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });

// 1. worker: (shorthand): the mount builds its own client, so this mount
//    SPAWNS a new worker from the definition and renders the chosen app in it
await mountIsland({ el: a, worker: renderEntry, app: 'counter' });
await mountIsland({ el: b, worker: renderEntry, app: 'notes' });
// → 2 workers from one PolyWorker script, one island each

// 2. client: the mounts reuse ONE existing worker: no spawn, each mount adds
//    an instance (own reconciler root, proxy document, op queue, pid) to it
const shared = connectIslandWorker({ worker: renderEntry });
await mountIsland({ el: c, client: shared, app: 'counter' });
await mountIsland({ el: d, client: shared, app: 'counter' });
await mountIsland({ el: e, client: shared, app: 'notes' });
// → 1 worker hosting 3 instances
```

Under the hood `mountIsland` is `client ?? connectIslandWorker({ worker })`
(`packages/islands/src/island.ts`), and every task carries the instance key,
so the worker's `mounts` map keeps co-located instances apart.

What "shared dependencies" buys depends on which form you use:

| Shape | Bundle (download, parse, code cache) | Runtime (framework copy in memory, event loop) | Failure domain |
|---|---|---|---|
| MonoWorker, one worker per mount | per app | per worker | per island |
| PolyWorker, `worker:` per mount | **shared**: same script URL | per worker: each worker is its own realm and evaluates its own copy of the framework | per island |
| PolyWorker, shared `client:` | **shared** | **shared**: one framework copy, one thread | the whole client: a long synchronous render in one instance stalls its siblings, a crash takes them all |

A MonoWorker can sit behind a shared client too: its sole app then renders
once per mount in one worker (same runtime, one registry entry).

Reference: `examples/react-dom-worker/src/shell.tsx` uses both. Two
clients are built from the SAME PolyWorker factory: `counterClient` hosts
`counter@1`, `counter@2` and `nestedhost@3` in one worker, and `notesClient`
spawns a second worker from the same script for `notes@4`. Islands mounted
with `worker:` (`incidents`, the nested sub-island) each get their own. The
devtools app map draws exactly this: a 1:1 worker as its island's mark, a
shared client as a ring holding one node per instance (see
[devtools.md](devtools.md)).

Choosing:

- **Shared `client:`** when islands are small, interact with the same data, and
  you'd rather keep one framework runtime warm than pay per-worker memory.
- **`worker:` per mount** (PolyWorker) when islands should fail and stall
  independently but you still want one bundle to ship and cache.
- **MonoWorker** when an island's dependencies are heavy or private (a chart
  library, a map engine, a remote MFE): nothing else's code rides its bundle.

The React shell's **ops console** puts all three shapes side by side on one
page, from a second PolyWorker (`examples/react-dom-worker/src/worker/console.worker.tsx`):

- row A mounts `pulse` + `export` on one shared client, so the export's
  ~1.2s synchronous aggregation freezes the pulse beside it;
- row B mounts the same two apps with `worker` each, so the pulse keeps
  ticking;
- row C mounts `regions`, whose worker nests `region.worker.tsx` both ways:
  three region cards on one shared sub-client (a recompute stalls every
  card) and a `forecast` model on its own sub-worker (it stalls nothing).

A main-thread heartbeat shows the page itself never stalls.

References: `examples/react-dom-worker/src/worker/react.worker.tsx`
(React registry: counter/notes/incidents), `…/console.worker.tsx` +
`…/region.worker.tsx` (the ops console), `…/render.worker.ts`
(the seven-island showcase registry), `…/vanilla.worker.ts`,
`…/map.worker.ts` (mono), `…/vue.worker.ts` (Vue island).

Worker discipline: `connectIslandWorker` pins `workers: 1`, so every island
client is a `DedicatedWorker` (no pool, no queue): a tree lives in one
worker's memory, so scale out with more clients (more workers), not wider
pools. Heavy compute an island needs belongs on a separate compute client
(`connectSubWorker` inside the island worker), sized by its own `workers`
count; see [tasks-and-pool.md](tasks-and-pool.md#how-many-workers).
Everything else in `connectWorker` config (`concurrency`, `taskTimeout`,
`respawn`, `lazy`…) passes through, plus one islands-only option:
`doorbell: false` skips the shared-memory contract entirely: the pool
constructor throws on `sharedMemory` without `SharedArrayBuffer`, so this is
*required* on non-isolated pages (poll transport then covers flushes;
`setMode('push')` on such a client just polls). The `worker:`-shorthand form
of `mountIsland` does this implicitly when `mode: 'poll'` is passed.

**Islands can nest, with the same API.** A worker-rendered island mounts a
sub-worker inside itself with the same `mountIsland` call, or for React the
same `<Island>`/`islandComponent`/`lazyIsland` (imported from
`@atolljs/react-island/worker`): a proxy `el` (inside the parent's shadow
tree) switches the driver to a nested mounter that replays the inner
island's ops into proxy nodes, so the inner DOM rides the parent's op
stream to the page. `worker` and `client` keep their meaning one level down:
`worker` spawns a sub-worker for that mount, a `connectIslandWorker` client
built inside the parent worker hosts several sub-island instances. Nested
instance keys are hierarchical, `parent~app@N` (`'nestedhost@1~nested@1'`),
and the devtools app map draws the parent→sub-worker→sub-island branch. See
[islands-worker.md](islands-worker.md#one-mount-api-on-both-threads).

## Island contracts

`defineIslandContract({ app, props, events, worker? })` publishes a
framework-free wire contract: the registry key plus `Schema` shapes for
props and the declared `emit` vocabulary. It exists so a shell mounts a
foreign-framework island by typed contract: importing the MFE's contract
module, never its component or framework. `islandAppNameOf` resolves the
contract to its `app` key, so `app: checkoutContract` works everywhere an
app reference does; `*-island` facades (`islandComponent(contract)`,
`lazyIsland` over a contract module, Angular's `{ contract }` config, the
Svelte `IslandContractOptions` type) derive props and a narrowed `onEvent`
from it.

Contracts are enforced worker-side: `withContract(contract, app)` stamps
a registry entry (or the adapters' `contract` option), then mount/
updateProps/emit payloads parse against it. See
[the cross-framework section](islands-frameworks.md#island-contracts--the-cross-framework-seam)
and [worker enforcement](islands-worker.md#contracts---withcontract-and-wire-enforcement).

## Worker entries per bundler

The `worker` option is a factory: the bundler must see the worker script as
an entry, which is where setups diverge:

- **Vite / webpack 5**: `() => new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`: the `new URL` literal is what the bundler detects; don't hoist or compute it.
- **Vite alternative**: `import XWorker from './x.worker.ts?worker'` then `worker: () => new XWorker()`.
- **esbuild / others**: the URL pattern needs the bundler's worker handling (esbuild bundles it only in `format: 'esm'` builds); otherwise compile the worker entry separately and pass a resolved URL.

A path the bundler didn't resolve shows up as a `mountIsland` `mountTimeout`
rejection naming the unanswered entry, not a silent hang.

A **remote** URL is also legal: `worker: () => new Worker('https://cdn…/x.worker.js',
{ type: 'module' })`. The bundler-detection rule doesn't apply (nothing to
bundle), but CORS/COEP and versioning rules do: see
[islands-remote.md](islands-remote.md).

## Shell packages

`@atolljs/islands` itself is framework-free on the shell side: `mountIsland`
takes a plain element. When the shell is a framework app, the companion
`*-island` packages wrap the same calls idiomatically: `<Island/>`/
`lazyIsland` for [React](frameworks/react.md), `useIsland`/`<AtollIsland>` for
[Vue](frameworks/vue.md), the `use:island` action for
[Svelte](frameworks/svelte.md), `createIsland`/`Island` for
[Solid](frameworks/solid.md), and `<atoll-island>`/`[atollIsland]` for
[Angular](frameworks/angular.md). The same packages also carry the worker
renderers: see [islands-frameworks.md](islands-frameworks.md).
