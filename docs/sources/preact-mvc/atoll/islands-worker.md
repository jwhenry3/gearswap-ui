# Inside the worker: island authoring surface

Read when: working on `packages/islands/src/worker/`, the proxy DOM,
instances, op emission, worker entry points, or writing island apps /
renderers.

The `/worker` entry of `@atolljs/islands` is what a worker bundle
imports (`src/worker/index.ts`): the two worker definers, the proxy DOM, the
op protocol, event dispatch, `emit`/`callbackProp`, and instance lifecycle:
framework-neutral by construction: it contains no framework import, so a
non-React registry never parses `react`/`react-reconciler`. React's
reconciler adapter (`reactInstance` + `hostConfig`) lives in
`@atolljs/react-island/worker`: importing that entry is what pulls React
into a worker bundle, once, shared across every React app in the registry.

## Three app kinds

`apps` values (or the `defineMonoWorker` argument) are one of two shapes:
bare component functions are NOT registry values:

```ts
// A PolyWorker registry mixes both kinds freely, and any mix of
// frameworks, since each *-island adapter wraps its component into the
// RenderedIslandApp shape:
export const worker = definePolyWorker({
  apps: {
    dashboard: reactIslandApp(DashboardApp),        // RenderedIslandApp (React)
    counter:   vueIslandApp(Counter),               // RenderedIslandApp (Vue)
    map:       { imperative: buildMap, dispose },   // imperative proxy-DOM
  },
});

// RenderedIslandApp: the contract every worker renderer satisfies:
interface RenderedIslandApp {
  mount(ctx: { instance: string; doc: ProxyDocument; props: Record<string, unknown> }):
    {
      update?(props): void;  // fine-grained re-render (else rebuild)
      sync?(fn): void;       // commit inside the task batch (React)
      flush?(): void;        // drain out-of-task work (passive effects)
      dispose?(): void;
    } | void;
}
```

For a single-framework registry the per-package definers wrap for you:
`defineReactPolyWorker({ apps: { dashboard: DashboardApp } })` maps each
component through `reactIslandApp`: same for Vue/Svelte/Solid/Angular.

An imperative app's optional `dispose(doc)`, and a rendered handle's
`dispose()`, run inside the instance's scope *before* its proxy document is
torn down (unmount, remount, updateProps rebuild): cancel library timers,
animation loops, and listeners there so deferred work can't mutate a dead
instance.

`islandApp(name, app)` stamps an app with its registry name: a data
property, so the stamp survives minification (unlike `fn.name`). A shell-side
component reference then resolves to the wire key, and `definePolyWorker`
warns when a stamp and its registry key drift apart. `IslandAppProps<A>`
infers a reference's props type from its signature.

### Contracts: `withContract` and wire enforcement

`defineIslandContract` (`@atolljs/islands`) names the app and declares the
props/events wire shape as `Schema`s: the vendored `z` from
`@atolljs/core`, consumer zod, or any `{ parse }` object. `withContract`
stamps it onto a registry app (or it arrives via an adapter's `contract`
option: `angularIslandApp(C, { contract })`, `reactIslandApp(App,
contract)`, `define*MonoWorker(C, { contract })`):

```ts
import { z } from '@atolljs/core';
import { defineIslandContract, withContract } from '@atolljs/islands/worker';

export const checkout = defineIslandContract({
  app: 'checkout',
  props: z.object({ count: z.number(), label: z.optional(z.string()) }),
  events: { paid: z.object({ total: z.number() }) },
});

definePolyWorker({ apps: { checkout: withContract(checkout, checkoutApp) } });
```

Enforcement is worker-side, at the points a payload crosses:

- **mount / updateProps** parse props AFTER `unmarshalCallbackProps`
  restores `callbackProp` callables: declare function members
  `z.callback<Fn>()` (or `z.optional(z.callback<Fn>())`). A rejected parse
  rejects the task, which `mountIsland`/`updateProps` surfaces as a named
  error (`[island "checkout"] props for "checkout@1" rejected by contract:
  expected number`). Parse output also strips undeclared keys: the
  contract is the authoritative wire shape. `updateProps` sees the FULL
  prop set (it replaces, not merges), so required members must be present
  every call.
- **`emit`** parses payloads for event names the contract declares:
  `emit('paid', { total: 'x' })` throws inside the dispatch/mount task.
  Undeclared names pass through untouched: the contract describes the
  wire, it doesn't fence forward-compatible additions (a newer worker may
  emit events an older shell doesn't know).

Unstamped apps skip all of it: the map lookup is per-instance and absent
for most mounts, so this is opt-in and free when unused. The schema objects
also survive in the contract for the shell to introspect or validate
against; `Schema<T>` is deliberately loose, so heavy validation libraries
are optional.

## The proxy document

Every instance owns a `ProxyDocument` (`src/worker/proxyDom.ts` →
`src/worker/dom/*`): a DOM-free surface whose mutations serialize to ops.
What a renderer or imperative app can rely on:

- **Tree ops**: `createElement`/`createElementNS`/`createTextNode`/
  `createComment`, `insertBefore`/`appendChild`/`removeChild` (fragments splice
  their children in), `cloneNode` (kind-aware), `template.content`,
  `importNode`.
- **Attributes & content**: `setAttribute`/`setAttributeNS`, reflected-property
  accessors (`id`, `src`/`href`, `value`/`checked`, `tabIndex`…),
  `classList`/`style`/`dataset` proxies, `textContent`, `innerHTML`
  (htmlparser2, comment-preserving), CDATA sections.
- **Reads**: shadow-tree traversal: `children`,
  `querySelector`/`getElementsBy*`, `nodeName`/`namespaceURI`, the
  ChildNode/ParentNode conveniences (`before`/`after`/`remove`).
- **Comments are real anchors**: nodeType 8 over a real empty text node
  driver-side, so branch markers (Vue `v-if`, Svelte `{#if}`) keep a position.
  Frameworks should use `doc.createComment`, not empty text nodes.
- **Events**: `addEventListener` with `{ once, passive, capture }`: options
  cross the wire, `once` auto-detaches worker-side.

Coverage tests: `packages/islands/test/proxyDomSurface.test.ts`.

#### Measuring the engine

`src/metrics.ts` separates engine cost from app cost behind a flag: the
`instance.ts` chokepoints (`pushOp`, `newElement`/`newText`,
`serializeProps`, `registerHandler`, `takeOps`, `emit`) wrap their bodies in
a re-entrancy-guarded timer: a shared depth counter means only the
outermost instrumented frame records, so a `dom/*` method calling `pushOp`
never double-counts. `instrumentPrototype` (applied by the bench to the
`dom/*` classes) extends the same accounting to imperative-app shadow-tree
work; the residual `workerMs − recordMs` is renderer/adapter time.
`proxyInstanceStats()` snapshots the retained state (`instances` are never
pruned, event dispatch may still resolve detached target ids, so
`liveNodes` is nodes-ever-allocated; the bench diffs before/after per
island). `proxyMetrics.enabled` defaults off and stays off in production.

### Geometry: one honest box

The proxy DOM is write-path plus container geometry: a `ResizeObserver` on the
island container pushes its size into the instance, and
`doc.body`/`documentElement`/elements marked `doc.markContainer(el)` report it
from `clientWidth`/`offsetWidth`/`getBoundingClientRect`. Everything else
returns honest 0/empty and warns once. `doc.onResize(cb)` re-fires on each
push: Leaflet's `map.invalidateSize()` hooks it in the demo.

### `installDomShim(doc)`: running real libraries

Puts the proxy doc on `globalThis.document` plus a `window` facade:
`document`/`window` listeners land on the island container (id 0) so
delegation works, `window.innerWidth/innerHeight` reflect the pushed size,
timers/`matchMedia`/scroll are stubbed, and `globalThis.Element` becomes
`ProxyElement` for `instanceof` checks. `globalThis.addEventListener` and
`self` are never touched: the pool's message channel lives there.
`uninstall()` (or `doc.dispose()`) restores the globals.

For libraries that read `document`/`window` at module scope (Leaflet's Browser
detection), install the shim then `await import('leaflet')`: a static import
would evaluate against bare worker globals. Reference:
`examples/react-dom-worker/src/worker/map.ts`.

### Instance-aware globals

`definePolyWorker`/`defineMonoWorker` install a dispatcher
(`installInstanceDispatcher`) so `document`/`window`/`Element`, plus
`Node`/`Text`/`Comment` and stubs like `HTMLMediaElement`/`customElements`,
are *accessors*, not fixed globals: inside an instance task they resolve that
instance's document; outside tasks they resolve the sole or last-active
instance's; explicit assignments (like `installDomShim`) take precedence.
React instances get a working `document`/`window` for free: libraries that
read them during render or in deferred callbacks just work. On the main-thread
driver, element checks are structural (`nodeType`), never
`instanceof Element`: the same global may be a proxy in in-process setups.

## Instance discipline

`mount`/dispatch tasks run inside the instance's scope, but work a renderer or
library kicks off afterwards, timers, promise continuations, framework
microtask schedulers (Vue's queue, Svelte's tick), has no active instance.
Resolve via `getActiveInstance() || getLastActiveInstance()` and prefer the
captured `ctx.instance`/`ctx.doc` over ambient lookup: on a shared client
whose islands run interleaved async work, last-active can resolve the
*sibling* instance: treat it as a convenience, not a contract. The contract
for worker-initiated work is `runInInstance(instance, fn)`, and after mutating
outside a dispatch task, `bumpOpsVersion()` rings the doorbell so the driver
flushes the queued ops.

## Islands inside islands: nested `mountIsland`

A worker-rendered island can mount a *real* sub-worker inside itself —
an island inside an island. The surface is the SAME function (and, for
React, the same components: see
[One mount API on both threads](#one-mount-api-on-both-threads)):
`mountIsland` discriminates on its mount target, so a **proxy** `el`
(anything `ctx.doc` or a React ref produced inside the parent instance)
takes the nested path while a real element takes the main-thread driver.
The nested mounter lives in `worker/subIsland.ts` and registers itself at
module load — every worker entry already imports this module, so nested
mounting is always armed inside island workers (and the main-thread
bundle never loads the proxy DOM).

```ts
import { mountIsland } from '@atolljs/islands/worker';

const sub = await mountIsland({
  el: hostProxyEl,                    // a ProxyElement from ctx.doc / a React ref
  worker: () => new Worker(new URL('./inner.worker.ts', import.meta.url),
                           { type: 'module' }),  // stays bundler-detectable
  app: 'counter',
  props: { label: 'nested' },
  onEvent: (name, payload) => emit(name, payload), // relay to the shell
});
```

Every proxy mutation serializes to an op on the parent instance's queue,
so the sub-island's DOM tunnels upward through the parent's own op
stream — the main thread sees one flat op batch and can't tell which
worker produced it. No new wire format. Options, handle (`IslandHandle`
with `instance` reading `parent~app@N`), transport, callback props, and
shared-client semantics are identical to a top-level mount.

- **Instance keys are hierarchical**: the sub-instance mints as
  `parent~app@N` (`'nestedhost@1~nested@1'`), unique across the topology;
  the registry still resolves the app name off the last `~`/`@`.
- **Events round-trip two hops**: a `listen` on a replayed node becomes a
  proxy `addEventListener`, emits a `listen` op to the page, and the real
  event's payload dispatches back down to the sub-worker — with
  `targetId` translated between the two proxy id spaces.
- **Geometry forwards**: the parent instance's pushed container size is
  forwarded as the sub-island's `setSize`, and re-pushed on resize.
- **Platform limit**: nested `new Worker` needs an engine that supports
  it — Chrome/Firefox/Node. Safari workers can't spawn workers, so design
  the nesting depth by capability, not aesthetics.

### One mount API on both threads

Nothing about a nested mount needs a separate API. The page and a worker
use the same functions and components with the same options; the mount
target picks the path.

| Surface | On the page | Inside a worker island | Routed by |
|---|---|---|---|
| Core | `mountIsland` from `@atolljs/islands` | `mountIsland` from `@atolljs/islands/worker` | `el`: real element → DOM driver, ProxyElement → nested mounter |
| Shared client | `connectIslandWorker` from `@atolljs/islands` | `connectIslandWorker` from `@atolljs/islands/worker` (or `@atolljs/react-island/worker`) | thread-agnostic: spawns from whichever thread calls it |
| React | `Island`, `islandComponent`, `lazyIsland` from `@atolljs/react-island` | the same three from `@atolljs/react-island/worker` | the component's container div is a ProxyElement inside a worker |

`worker` vs `client` means the same thing on either thread:

- **`worker`** (a `() => new Worker(new URL(...))` factory): this mount
  builds its own client, so it **spawns** a worker (a sub-worker when the
  caller is itself a worker) and destroys it on unmount.
- **`client`** (a `connectIslandWorker` result): this mount adds an
  **instance** to that existing worker. Build the client where it should
  live: on the page for top-level islands, inside the parent worker (for
  example in a component's `useState` initializer) for sub-islands.

```tsx
// inside a worker-rendered React app (its module is in the parent worker's
// bundle, so the `new Worker` literal stays bundler-detectable)
import { useState } from 'react';
import { connectIslandWorker, Island } from '@atolljs/react-island/worker';

const regionEntry = () =>
  new Worker(new URL('./region.worker.tsx', import.meta.url), { type: 'module' });

function Regions({ regions }: { regions: string[] }) {
  // one sub-worker, one instance per card
  const [cards] = useState(() => connectIslandWorker({ worker: regionEntry }));
  return (
    <>
      {regions.map((r) => (
        <Island key={r} client={cards} app="region" props={{ region: r }} />
      ))}
      {/* spawns its own sub-worker from the same script */}
      <Island worker={regionEntry} app="forecast" />
    </>
  );
}
```

Options carry over unchanged: `props`, `onEvent`, `onReady`, `onError`,
`onActivity`, `mode`, `workerOptions` (including `doorbell`), `framework`,
`slots`, and container attributes (`className`, `style`, `data-*`). The
`worker` shorthand builds its client doorbell-free under `mode: 'poll'` on
both threads. Inside a worker, `onEvent` runs in the parent instance's
scope, so a re-`emit` relays the event to the page.

**Slots in nested mounts.** A nested mount's `slots[name]` receives the
anchor's ProxyElement (not a real element), so worker-side content renders
into it: the React `Island` portals `slots` content there, exactly as on the
page. A nested mount claims only the names it lists (`name in slots`); a
claimed anchor is re-marked `data-atoll-sub-slot` so the page never claims it
as well. Unclaimed `data-atoll-slot` anchors keep bubbling to the outer
island's `slots` on the page, where the shell can fill them with real DOM.

**Other renderers.** Any framework that hands you a ref to a
worker-rendered element can nest: pass that ref (a ProxyElement) as `el` to
`mountIsland` and destroy the handle on unmount. `SubIsland` from
`@atolljs/react-island/worker` remains as an alias of `Island` that tags
`framework: 'react'` and stamps `data-atoll-sub-island` on its host div.

**Devtools framework marks.** `framework` is optional on every mount, page
or nested: when omitted, the driver asks the worker which renderer the
mounted app uses (the `renderer(instance)` task, called only while
devtools is enabled). Package adapters (`reactIslandApp`, `vueIslandApp`,
`svelteIslandApp`, `solidIslandApp`, `angularIslandApp`) set
`RenderedIslandApp.renderer`; imperative apps report `null` and draw as a
plain worker. The tag is per instance: a host doesn't inherit its
sub-islands' renderer, and a sub-island spawned from an imperative host
still reports its own. A plain `defineWorker` worker has no proxy DOM, so
it can't host islands at all; its `connectSubWorker` children show as
sub-workers, not islands.

`worker`/`client`/`app` are mount identity: swap them with a React `key`.
References: `examples/react-dom-worker/src/worker/console.worker.tsx`
(`regions`: three cards on one shared sub-client plus a `worker`-form
forecast, both from `region.worker.tsx`) and `…/react.worker.tsx`
(`nestedhost` → `nested` via `nested.worker.tsx`).

## Channels: emit, callbackProp, slots

```ts
import { emit, runInInstance, bumpOpsVersion, getActiveInstance }
  from '@atolljs/islands/worker';
import { Slot } from '@atolljs/react-island/worker'; // React islands only
import { callbackProp } from '@atolljs/islands'; // shell side

// island → shell: lands in mountIsland's onEvent. Call inside a handler or
// commit-phase effect, while a task holds the instance.
emit('rowSelected', { id: row.id });

// shell → island: pass in props, the worker receives a callable.
//   shell:     props: { onSave: callbackProp((id) => save(id)) }
//   worker:    props.onSave(id) → fires fn(...args) on the shell.
// Fire-and-forget (no return channel); nested markers in prop objects work.
// Out-of-task callers still flush: the callable rings the doorbell itself.

// Library callbacks on timers/promises have no active instance: re-enter:
const instance = getActiveInstance()!;
map.on('zoomend', () =>
  runInInstance(instance, () => { emit('zoomChanged', { zoom: map.getZoom() }); bumpOpsVersion(); }));

// <Slot name="wave"/>: React helper rendering a leaf data-atoll-slot element
// whose contents the shell fills. Any renderer can emit the same leaf:
doc.createElement('div').setAttribute('data-atoll-slot', 'wave');
```

Mediation is unidirectional by convention: an island's `emit` lands in
`onEvent`, the shell sets state, and it flows back in as props: no hand-wired
`updateProps` calls. Slots are the escape hatch for content the worker can't
own (canvases, closed libraries like Google Maps JS): the worker owns the box,
the shell owns the contents: real DOM, real events, zero wire.

## Events dispatched in

A worker-side `addEventListener` emits a `listen` op; the driver attaches a
real listener and each dispatch posts back as an instance-scoped task. The
payload is spec-shaped for pointer-family events, clientX/Y, screenX/Y,
button, `which` (button+1), modifiers, wheel deltaX/Y/deltaMode, pointerType,
scrollTop, with absent numerics normalized to 0 rather than leaking
`undefined` into library math. `target`/`currentTarget` materialize as proxy
nodes (id-0 listeners get the instance root), `e.target.value`/`checked` are
stamped from the dispatched form state, and a synthesized `composedPath()`
exists for delegated-propagation runtimes. `preventDefault`/`stopPropagation`
are no-ops: the real event already dispatched on the main thread; renderers
should not promise it.

## Writing a worker renderer

Implement `RenderedIslandApp.mount(ctx)`: render into `ctx.doc` with your
framework's native renderer (every mutation already serializes), return
`{ update?, sync?, flush?, dispose? }`. Omit `update` and `updateProps`
degrades to imperative semantics: dispose + fresh document + remount.
`sync`/`flush` are the task-ordering hooks: a renderer whose commits are
scheduled (React's reconciler) wraps event-handler invocation in `sync` so
its ops land in the dispatch batch, and drains deferred work in `flush`.
`dispose` runs inside the instance before its document dies: unmount roots,
stop effects. The five `*-island` packages in `packages/` are the reference
implementations (`react-island/src/worker.ts` is the shortest full example:
wrap → sync lane → dispose).

## Testing islands in-process

`@atolljs/core/testing/inProcessWorker` ships a `Worker` test double
that runs the whole protocol in-process: real task registry, real op stream,
real shared-memory binding; only the thread boundary is faked:

```ts
import { InProcessWorker } from '@atolljs/core/testing/inProcessWorker';
vi.stubGlobal('Worker', InProcessWorker);
InProcessWorker.handlerModules = [() => import('./my.worker')];

const island = await mountIsland({ worker: () => new Worker(url, { type: 'module' }), ... });
```

Entry modules load lazily on first pool init (like a real worker script, and
even for doorbell-free, message-only pools); a module that throws fires an
`error` event and the worker drops subsequent tasks, so mount failures reject
instead of hanging. `InProcessWorker.created` tracks spawned instances;
`flushObservers()` settles microtasks + the shared-memory observer loop.
