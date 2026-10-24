# Svelte: `@atolljs/svelte` + `@atolljs/svelte-island`

Read when: working on `packages/svelte/` (binding) or `packages/svelte-island/`
(shell + worker renderer for Svelte islands).

## Binding: `@atolljs/svelte`

Svelte 5 runes adapter. Functions must be called during component init;
teardown happens in an `$effect` cleanup. Source:
`packages/svelte/src/reactivity.svelte.ts`. Example:
`examples/svelte/src/incidents.svelte.ts`, `examples/svelte/src/App.svelte`.

| Export | Signature | What it does |
|---|---|---|
| `observableValue` | `observableValue(source): { value: T }` | Subscribe to any observable snapshot as rune-backed state. |
| `sharedValue` | `sharedValue(memory, key, select?, options?): { value: T \| undefined }` | Bind one shared-memory field as rune state; optional selector + equality. |
| `taskState` | `taskState(task \| asyncFn): { data, pending, settled, elapsedMs, error, run, runOnce }` | Bind an AsyncTask, or any async fn, snapshot getters plus triggers. |

Note: bindings live in a `.svelte.ts` module so `$state`/`$effect` runes
compile outside components.

## Worker islands: `@atolljs/svelte-island`

A Svelte action + headless state factory on the shell side, plus the Svelte 5
**worker renderer**: `svelteIslandApp` runs a compiled component with the real
`mount()`/`unmount()` against the instance's proxy document.

### Shell surface

| Export | Signature | What it does |
|---|---|---|
| `island` | `<div use:island={{ worker\|client, app, props, onEvent, slots }} />` | Action form: mounts on the element; action `update()` forwards as `updateProps`. |
| `createIslandState` | `createIslandState(options): { status, error, handle, attach }` | Headless form: mount/attach yourself and read `status`/`error`/`handle` as reactive `$state`. |

```svelte
<script lang="ts">
  import { island } from '@atolljs/svelte-island';
  let width = $state(640);
</script>

<div use:island={{
  worker: () => new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' }),
  app: 'charts',                    // or an islandApp-stamped reference
  props: { width },                 // action update() → updateProps
  onEvent: (name, payload) => { ... },
}} class="island-box" />
```

`worker`/`client`/`app` are mount-stable: swap them through `{#key}`.

Reference shell: `examples/react-dom-worker/src/svelte/Shell.svelte`:
mounts the registry's Svelte worker apps (`counter` ×2, `notes`, and the
1M-row `incidents` benchmark) via `use:island`, with `$state` mediation
replacing hand-wired `updateProps`. Each island gets its own client:
Svelte schedules render work through ambient `document` resolution, so
two mounts sharing one worker can route ops to the wrong instance.

### Worker renderer

| Export | Signature | What it does |
|---|---|---|
| `defineSveltePolyWorker` | `defineSveltePolyWorker({ apps: { name: Component \| IslandApp } })` | Registry worker: compiled components wrapped automatically. |
| `defineSvelteMonoWorker` | `defineSvelteMonoWorker(Component)` | 1:1 instance worker: mounted namelessly. |
| `svelteIslandApp` / `svelteIsland` | `svelteIslandApp<P>(Component): RenderedIslandApp` | The adapter: for shared `definePolyWorker` registries. |
| `emit` / `runInInstance` | re-exported | The worker entry needs no direct islands import. |

```ts
// counter.worker.ts: the whole worker entry
import Counter from './Counter.svelte';
import { defineSveltePolyWorker, emit } from '@atolljs/svelte-island/worker';

export const worker = defineSveltePolyWorker({ apps: { counter: Counter } });
// or a 1:1 instance worker: defineSvelteMonoWorker(Counter)
```

```svelte
<!-- Counter.svelte: a completely ordinary component -->
<script lang="ts">
  import { emit } from '@atolljs/svelte-island/worker';
  let { label = 'count' } = $props();
  let count = $state(0);
</script>
<button onclick={() => { count++; emit('bumped', count); }}>{label}: {count}</button>
```

### Semantics & requirements

- `mount` runs the component's real `mount()` into `doc.body` with a
  `$state`-backed props box: `island.updateProps` mutates the box, Svelte
  patches in place (same DOM elements survive).
- Event dispatches end with a `flushSync()` so state updates land in the
  dispatch's own op batch.
- `{#if}`/`{#each}`/`{@html}` anchors rely on the proxy DOM's comment nodes
  and `template.content` handling: bundled, no setup needed. Most of the DOM
  surface Svelte's client runtime touches lives in the proxy DOM itself
  (`ProxyComment` + `createComment`, kind-aware `cloneNode`, `nodeName`,
  `namespaceURI` + `*AttributeNS`, `importNode`, listener `this`-binding +
  synthesized `composedPath()`); adapter-side shims are Svelte-specific and
  installed lazily at first mount.
- **Svelte 5 with runes, compiled components only**: components must be
  compiled by vite-plugin-svelte / the svelte compiler for the client target.
  There is no legacy/SSR fallback: the renderer needs the DOM runes runtime.
- `structuredClone`-able props (they cross `postMessage`; `mountIsland`
  rejects uncloneable values naming the offending key).
- **Never let an `$effect` read `$state` it also writes** (e.g. emitting a
  `lastMs` it just assigned). A self-invalidating effect that can't converge
  (`performance.now()` always differs) re-schedules a new svelte `Batch`
  inside the current flush; `Batch.#process` tail-recurses and the worker
  dies with an opaque `RangeError: Maximum call stack size exceeded` →
  `WorkerCrashedError`: svelte's `infinite_loop_guard` never fires because
  the recursion path bypasses its counter. Compute into a local and assign
  after the reads (see `Incidents.svelte`).
