# SolidJS: `@atolljs/solidjs` + `@atolljs/solid-island`

Read when: working on `packages/solidjs/` (binding) or `packages/solid-island/`
(shell + worker renderer for Solid islands).

## Binding: `@atolljs/solidjs`

Signal adapter. The SDK itself uses `solid-js` internally for `reactive()`, so
shared values are native tracked signals. Source:
`packages/solidjs/src/index.ts`. Example: `examples/solid/src/incidents.ts`,
`examples/solid/src/App.tsx`.

| Export | Signature | What it does |
|---|---|---|
| `createObservable` | `createObservable(source: ObservableValue<T>): Accessor<T>` | Subscribe to any observable snapshot (task or field). |
| `createSharedValue` | `createSharedValue(memory, key, select?, options?): Accessor<T \| undefined>` | Bind one shared-memory field to an Accessor; optional selector + equality. |
| `createTask` | `createTask(task \| asyncFn): { state: Accessor<TaskSnapshot>, run, runOnce }` | Bind an AsyncTask, or any async fn, to a signal and get its triggers. |

Notes: `createEffect` re-runs the page task whenever the memoized query spec
changes; subscriptions auto-dispose via `onCleanup` when the owner/component
is destroyed.

## Worker islands: `@atolljs/solid-island`

Shell primitives that mount a worker-hosted Solid tree, plus the Solid
**worker renderer**: `solidIslandApp` runs a plain Solid component against
`solid-js/universal`'s `createRenderer` bound to the instance's proxy
document.

### Shell surface

| Export | Signature | What it does |
|---|---|---|
| `createIsland` | `createIsland({ worker\|client, app, props: P \| (() => P), onEvent, slots }): { ref, handle, status }` | Headless mount: set `ref` on the container; props may be a plain value, an accessor, or a reactive getter (tracked → `updateProps`). |
| `Island` | `Island(options): HTMLElement` | No-JSX component form: returns the mounted `div` itself. |
|| `islandComponent` | `islandComponent<P>('name')` \| `islandComponent(StampedApp)` | The pure-contract proxy: the shell never imports the implementation; a registry key + a type-only props import is the whole contract. |
|| `lazyIsland` | `lazyIsland(loader: () => Promise<{ default: A } \| A \| { app: A; worker? }>)` | `lazy()` mirrored: suspends under `<Suspense>` on the dynamic import (a real bundler split point), then mounts the stamped app by reference. Contract modules can carry `worker` too. |

The proxies return the same mount as `Island` plus a `fallback` sibling:
the worker app's props go inline; shell concerns (`worker`/`client`/
`onEvent`/`slots`/`containerProps`…) split off by name.

```tsx
import { createIsland } from '@atolljs/solid-island';
import { ChartsApp } from './worker/apps';

const renderWorker = () =>
  new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });

function Shell() {
  const island = createIsland({
    worker: renderWorker,                 // or client: connectIslandWorker({...})
    app: ChartsApp,                       // or the registry name 'charts'
    props: () => ({ width: width() }),    // accessor: tracked, pushes updateProps
    onEvent: (name, payload) => ...,
    slots: { preview: (el) => el && render(() => <Canvas/>, el) },
  });
  return <div ref={island.ref} class="island-box" />;
}
```

Callbacks are read at call time (fresh closures never remount);
`app`/`worker`/`client` are mount-stable: swap via keyed remount.

### Worker renderer

| Export | Signature | What it does |
|---|---|---|
| `defineSolidPolyWorker` | `defineSolidPolyWorker({ apps: { name: Component \| IslandApp } })` | Registry worker: components wrapped automatically. |
| `defineSolidMonoWorker` | `defineSolidMonoWorker(Component)` | 1:1 instance worker: mounted namelessly. |
| `solidIslandApp` / `solidIsland` | `solidIslandApp<P>(Component): RenderedIslandApp` | The adapter: for shared `definePolyWorker` registries. |
| `h`, `insert`, `insertNode`, `spread`, `setProp`, `effect`, `memo`, `use`, `createComponent`, `mergeProps`, `render`, `createElement`, `createTextNode` | the universal-renderer runtime surface | Everything `babel-preset-solid`'s `generate: 'universal'` output calls, plus `h` for hand-authoring. Core primitives (`createSignal`, `createEffect`, `mapArray`, `createContext`…) come straight from `solid-js`. |
| `emit` / `runInInstance` | re-exported | The worker entry needs no direct islands import. |

`mount` renders the component into the instance's proxy `body` under a Solid
root (so `dispose()` tears down every signal/effect with the island). Wire
props arrive as getter-driven per-key signals: `updateProps` bumps only the
changed keys, so the DOM patch is exactly as fine-grained as the reads (one
`utext`/`attr` op per changed dependent, never a rebuild).

### JSX (optional)

Components are plain functions: nothing requires a JSX transform. To write
JSX in worker components, point Solid's compiler at the *universal* render
target with this package's worker entry as the runtime module, **scoped to
worker code only**: the shell keeps the normal DOM transform:

```ts
// vite.config.ts
plugins: [
  solidPlugin({
    include: [/\.worker\.[tj]sx?$/, /worker\/.*\.[tj]sx?$/],
    solid: { generate: 'universal', moduleName: '@atolljs/solid-island/worker' },
  }),
  solidPlugin({ exclude: [/\.worker\.[tj]sx?$/, /worker\/.*\.[tj]sx?$/] }),
]
```

Reference shell: `examples/react-dom-worker/src/solid-shell.ts`: mounts
the registry's Solid worker apps (`counter` ×2 on a shared client, `notes`,
and the 1M-row `incidents` benchmark) via `Island()` inside `solid-js/html`
templates (no JSX transform on the shell), with signal mediation replacing
hand-wired `updateProps`.

### Caveats

- **Pin the client build in worker bundles.** `solid-js`'s exports map
  resolves `solid-js` (and `solid-js/web`, `solid-js/store`) to
  `dist/server.js` under the `worker`, `node`, and `deno` conditions: the
  SSR build, where effects **never re-run** (including the `import 'solid-js'`
  inside `solid-js/universal` itself). A renderer on the server build mounts
  fine and then never updates. Fix: `resolve: { alias: { 'solid-js': 'solid-js/dist/solid.js' } }`
  or drop `worker`/`node` from `resolve.conditions` for the worker bundle.
  The adapter probes and throws if it happens anyway. In this repo,
  `vitest.config.ts` does the equivalent: exact-match alias
  `/^solid-js$/ → dist/solid.js` plus `server.deps.inline: [/solid-js/]`.
- **`el.textContent` vs `insert()` children.** `textContent` emits one `utext`
  op and records a *phantom* text child (no instance id). On an element that
  also holds `insert()`-managed children, a later `insert(el, node,
  phantomText)` resolves its anchor to nothing driver-side and the trees
  drift. Convention: dynamic text goes through `insert()` as a real text node;
  compiled universal JSX already does this.
