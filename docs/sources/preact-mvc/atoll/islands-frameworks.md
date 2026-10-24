# Framework islands: the `*-island` packages

Read when: working on `packages/vue-island`, `svelte-island`, `solid-island`,
`angular-island`, `react-island`, or writing a new worker renderer.

Each framework ships one `*-island` package covering both ends: a **shell
surface** (mount a worker-hosted tree as an ordinary element in that
framework's app) and a **worker renderer** (run the framework's own renderer
against the proxy DOM). All five speak the same op protocol: a registry
worker can mix them freely.

## The packages

| Package | Shell surface | Worker renderer | updateProps |
|---|---|---|---|
| `@atolljs/react-island` | `<Island/>`, `islandComponent`, `lazyIsland` | `defineReactPolyWorker`, `react-reconciler@0.34` host config → instance records | reconciler re-render |
| `@atolljs/vue-island` | `useIsland`, `<AtollIsland>`, `islandComponent`, `lazyIsland` | `defineVuePolyWorker`, Vue `createRenderer` → proxy DOM | fine-grained (`cloneVNode` + `render`) |
| `@atolljs/svelte-island` | `use:island` action, `createIslandState` | `defineSveltePolyWorker`, Svelte 5 `mount()` into `doc.body`, `$state` props box | fine-grained (props box mutation) |
| `@atolljs/solid-island` | `createIsland`, `Island`, `islandComponent`, `lazyIsland` | `defineSolidPolyWorker`, `solid-js/universal` `createRenderer` | fine-grained (per-key signal props) |
| `@atolljs/angular-island` | `islandComponent` facades, `<atoll-island>`, `[atollIsland]`, `AtollIslandModule` | `@AngularIsland` decorator + `defineAngularPolyWorker`: `RendererFactory2`/`Renderer2` → proxy DOM + `createComponent`, zoneless, root `output()`/`model()` → `emit` bridging | `setInput` + manual CD |

Per-framework detail: [frameworks/vue.md](frameworks/vue.md),
[svelte.md](frameworks/svelte.md), [solid.md](frameworks/solid.md),
[angular.md](frameworks/angular.md), [react.md](frameworks/react.md). The
worker entries each re-export `emit`/`runInInstance` so a worker bundle needs
no direct `@atolljs/islands` import.

## Mixed registries

A `definePolyWorker({ apps })` registry accepts `{ imperative }` defs and
any framework's adapter output side by side: wrap each component with
`reactIslandApp`/`vueIslandApp`/`svelteIslandApp`/`solidIslandApp`/
`angularIslandApp` when it should sit in a shared `definePolyWorker`
rather than that framework's own `define*PolyWorker` (which wraps plain
components automatically). Bare components are not registry values:
the registry is framework-agnostic, so the adapter is the stamp that says
which renderer owns the app:

```ts
import { definePolyWorker } from '@atolljs/islands/worker';
import { reactIslandApp } from '@atolljs/react-island/worker';
import { vueIslandApp } from '@atolljs/vue-island/worker';
import { svelteIslandApp } from '@atolljs/svelte-island/worker';

export const worker = definePolyWorker({
  apps: {
    dashboard: reactIslandApp(DashboardApp),  // React
    notes:     vueIslandApp(VueNotes),        // Vue
    editor:    svelteIslandApp(Editor),       // Svelte
    map:       { imperative: buildMap },      // proxy DOM, no framework
  },
});
```

The demo's Vue island runs exactly this way: its own worker entry
(`examples/react-dom-worker/src/worker/vue.worker.ts`), Vue but no React in
the bundle.

## Island contracts: the cross-framework seam

The registry key alone doesn't type a foreign app's props: an Angular
component's `IslandInputs<C>` requires `@angular/core` declarations
resolvable wherever the type is consumed, which a React shell for a
distributed MFE shouldn't need. `defineIslandContract` (`@atolljs/islands`)
closes that gap: a framework-free module the MFE publishes and BOTH sides
import: the shell for types, the worker for enforcement:

```ts
// checkout.contract.ts: imports nothing framework-specific
import { z } from '@atolljs/core';
import { defineIslandContract } from '@atolljs/islands';

export const checkout = defineIslandContract({
  app: 'checkout',                                    // the registry key
  props: z.object({ label: z.optional(z.string()), total: z.number() }),
  events: { paid: z.object({ total: z.number() }) },
  // optional worker factory makes the contract itself a lazy module:
  worker: () => new Worker(new URL('./checkout.worker.ts', import.meta.url), { type: 'module' }),
});
```

`z` is the vendored schema engine: message-domain kinds (`optional`,
`nullable`, `literal`, `union`, `record`, `callback<F>` for `callbackProp`
members) beyond reef's fixed-width set; any `Schema<T>` (`{ parse }`)
works, including consumer zod. Props/events stay structured-cloneable:
that's still the wire.

Shell facades accept the contract directly: the key resolves via
`contract.app`, props infer `P`, and `onEvent` narrows to `E`:

```tsx
// React / Solid: islandComponent(contract) or lazyIsland over the module
const Checkout = islandComponent(checkout);
<Checkout count={2} onEvent={(name, payload) => name === 'paid' && …} />
const CheckoutLazy = lazyIsland(() => import('./checkout.contract'));

// Vue: same contract overload
const Checkout = islandComponent(checkout);

// Angular, the `contract` config field (types ride a phantom carrier
// through IslandInputs/IslandEvents, no component class needed)
const CheckoutIsland = islandComponent({ contract: checkout, selector: 'x-checkout' });
// <x-checkout [props]="{ count: 2 }" [onEvent]="onCheckoutEvent" />

// Svelte: IslandContractOptions<C> narrows the action's props/onEvent
<div use:island={{ app: checkout, props: { count: 2 }, onEvent }} />
```

Worker side, attach the contract to the registry entry: every adapter
takes it (`angularIslandApp(C, { contract })` is even type-checked against
the component's `IslandInputs`/`IslandEvents`, so drift fails in the MFE's
own build), or stamp any app shape directly with
`withContract(contract, app)`. Enforcement (mount/updateProps/emit
validation) is worker-side: see
[islands-worker.md#contracts](islands-worker.md#contracts---withcontract-and-wire-enforcement).

## Bundle composition: what's in a worker bundle

The `/worker` entry is framework-neutral: `definePolyWorker`, the proxy DOM,
the op protocol, event dispatch, `emit`/`callbackProp`, instance lifecycle.
Framework runtimes arrive only through the binding you import:

- **React islands**: `react` + `react-reconciler` + the host config live in
  `@atolljs/react-island/worker` (`src/reactInstance.ts` + `hostConfig.ts`),
  imported the moment a worker entry uses `reactIslandApp` or
  `defineReactPolyWorker`. A worker whose registry holds only
  Vue/Svelte/Solid/Angular/imperative apps never loads it: the package
  boundary IS the lazy boundary: no dynamic import, no runtime chunk, the
  adapter simply isn't in the bundle.
- **Vue/Svelte/Solid/Angular islands**: each `-island` package statically
  imports only its own framework. A `defineVuePolyWorker` entry bundles
  islands core + Vue, and no other framework.
- **Imperative-only**: islands core alone (plus `htmlparser2`, which the
  proxy DOM's `innerHTML`/`insertStaticContent` need).

## Real libraries: what works

**Imperative libraries.** The `map` island in `examples/react-dom-worker` runs
**Leaflet 1.9, unmodified from npm**, entirely worker-side:
`installDomShim(doc)` then `await import('leaflet')` (dynamic import is
required: Leaflet reads `document`/`window` at module scope for Browser
detection). Verified working: tile `<img>` ops, divIcon markers, controls,
attribution, drag-pan (document-level listeners registered mid-gesture), wheel
zoom, delegated marker clicks, and `doc.onResize` → `invalidateSize()`.

**React libraries.** The `charts` island runs **recharts 3.x, unmodified**, as
an ordinary React tree in the worker: `ComposedChart` with
grid/axes/tooltip/legend/bar/line, `onClick` handlers, and `emit`: verified
end-to-end with a bar-click round-trip. It exercises the general machinery:
namespaced SVG ops (host context tracks `<svg>`/`<foreignObject>` boundaries
so `createElementNS` lands correctly, including through portals),
`ProxyElement` refs as react-dom `createPortal` containers via
`getPublicInstance`, instance-resolved `document`/`window` for
selector/`getComputedStyle` calls, and `currentTarget` synthesis for mouse
middleware. Use fixed chart dimensions, `ResponsiveContainer` has no layout
to observe, and prefer `isAnimationActive={false}` to skip
measurement-feedback render passes that converge but cost op volume.

### Known limits for DOM-heavy libraries

- **Geometry is one box.** Only the island container is measured (pushed);
  libraries that measure arbitrary elements still get 0: SVG-specific reads
  (`getBBox`, `getTotalLength`, `getComputedTextLength`) too, which is why
  recharts text truncation/animation sizing degrades to stub values.
- **`preventDefault`/`stopPropagation` are no-ops**: the real event already
  dispatched on the main thread; the worker can't cancel it.
- **Async-library callbacks that mutate DOM or emit outside a task** must
  re-enter via `runInInstance(instance, fn)`: timers and promise
  continuations have no active instance.
- **`getContext('2d'/'webgl')` is out of scope** for the op protocol:
  canvas-based libraries belong on `OffscreenCanvas`, which is a different
  transport.

## Workload fit

Every event costs one postMessage round trip: `pointermove`, per-keystroke
input, and scroll handlers re-render on worker latency, and `preventDefault`
can't work because the real event already dispatched. Keep high-frequency
input on the main thread (slots exist for exactly this) and put coarse
interactions, clicks, toggles, form submits, behind the island. On the other
side of the ledger, main-thread replay scales with op *count*, not tree size:
fine-grained updates replay in ~1ms while whole-tree rebuilds cost an order of
magnitude more per frame. `mountIsland`'s `onOps` hook reports the
worker/main split if you want to measure a workload before committing it to
an island.

`react`/`react-dom`/`react-reconciler` are peer deps of `@atolljs/react-island`
only: `@atolljs/islands` itself is framework-free, so imperative-only and
non-React consumers install zero React.
