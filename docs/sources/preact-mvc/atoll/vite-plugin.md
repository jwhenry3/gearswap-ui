# @atolljs/vite: dev worker bundling

Read when: touching `packages/vite/`, worker dev-server behavior, or
debugging "worker error"/silent worker loads in a generated app's `vite dev`.

## The problem it removes

Vite dev serves every module, including worker entries, through the browser
transform pipeline. Browser plugins inject code that assumes `window`:

- `@vitejs/plugin-react` appends `import * as RefreshRuntime from
  "/@react-refresh"` to every transformed module; the runtime reads `window`
  unguarded → `ReferenceError` inside the worker → respawn loop.
- `/@vite/client` hot-context imports and SFC HMR wrappers have the same
  problem.

Excluding worker files per-plugin is fragile (each browser plugin needs its
own filter, and `exclude` arrays *replace* defaults: a naive
`exclude: /\.worker\./` on plugin-react stops excluding `node_modules`, which
moves the injection into `.vite/deps` chunks instead).

More fundamentally, worker-side HMR is meaningless: a worker can't partially
reload its module graph: any source change needs a respawn anyway.

## What the plugin does

Dev-server work only: production builds keep vite's normal worker bundling.
In `vite build` the plugin only copies the devtools dashboard (step 6).

1. **Intercepts `?worker_file`/`?sharedworker_file` requests** in
   `configureServer` before vite's transform middleware, so worker entries
   never enter the per-module pipeline at all: no plugin excludes needed.
2. **Bundles the entry with esbuild** (`format: 'esm'`, `platform: 'browser'`)
   with `import.meta.env.*`/`process.env.NODE_ENV`/`import.meta.hot` defined.
   Resolution is bridged through `server.pluginContainer.resolveId`, so vite
   aliases and tsconfig paths behave identically inside the worker.
   Style/asset imports resolve to empty modules (styles are a main-thread
   concern in the islands model); plugin-owned virtual modules load through
   `pluginContainer.load` with no browser transforms applied.
3. **Watches the bundle's input graph** (esbuild metafile) via
   `server.watcher`; a change to any input clears the cached bundle and sends
   `full-reload`. The next page load respawns workers on the fresh bundle:
   that *is* the worker reload flow.
4. **Echoes `server.config.server.headers` on the worker response**:
   required: under COEP `require-corp`, Chrome blocks worker scripts whose
   response lacks the embedder policy (`ERR_BLOCKED_BY_RESPONSE`, surfaced as
   an opaque `worker error`). See [cross-origin-isolation.md](cross-origin-isolation.md).
5. **Serves the devtools dashboard at `/__atoll/`** (`?mini=1` for the
   overlay's compact layout), resolved through `pluginContainer.resolveId`
   so workspace aliases find `@atolljs/devtools` even when it isn't in the
   app's `node_modules`, with the same header echo (COOP decides whether the
   flyout's iframe can even see its document). See [devtools.md](devtools.md).
6. **Emits the dashboard into builds that use it.** In `writeBundle`, a
   client `vite build` copies the dashboard into `<outDir>/__atoll/`
   (`devtools.dir` renames the folder), flagged for BroadcastChannel by an
   external `atoll-transport.js` (no inline script, so strict CSPs pass).
   `devtools.build` defaults to `'auto'`: emit when some chunk renders code
   from the `@atolljs/devtools` package, so a shipped overlay always has
   its iframe target. `true` always emits, `false` never. SSR builds are
   skipped. Headers and sub-path mounts are the host's job: see
   [devtools-deploy.md](devtools-deploy.md) topology A.

Worker graphs containing framework SFCs (`.vue`/`.svelte`/`.astro`/`.md`/
`.mdx`) can't be bundled by esbuild: the middleware detects the marker and
falls back to `next()`, i.e. vite's normal per-module serving. That's safe
for those plugins (`@vitejs/plugin-vue`, `vite-plugin-svelte` only inject
HMR code gated on `import.meta.hot`, which evaluates to `false` in workers);
the per-plugin exclude trap is a plugin-react problem, and React graphs are
always pure JS/TS: they always take the bundle path.

On any other bundle failure the middleware returns 500 and pushes the error
to the vite error overlay.

## Notes for maintainers

- **Worker entry URLs arrive as dev URLs, not fs paths.** A request path is
  only root-relative when the file is inside the project root: vite serves
  anything outside it (workspace-linked packages, `file:` deps) as
  `/@fs/<abs>`. Always unwrap through `toFsPath`; resolving the raw path
  against root produced `<root>/@fs/...` (`Could not resolve`, worker crash
  loop). Note `win32.isAbsolute('/x')` is true, so the absolute check there
  requires a drive letter rather than `isAbsolute()` alone.
- **Ships compiled JS.** The plugin runs inside `node_modules` in consumer
  projects: `.ts` there hits `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`
  (same constraint as the CLI bin). `npm run build` emits `dist/index.js` +
  `dist/index.d.ts`; `scripts/publish.mjs` runs every package `build` script
  before staging.
- **`esbuild` is a real dependency** (not peer): vite 8 no longer carries
  esbuild internally.
- **Nested workers recurse through the same middleware**: a
  `new Worker(new URL('./sub.worker.ts', import.meta.url))` literal inside a
  bundled module is re-anchored to an absolute `/@fs/…?worker_file` URL at
  bundle time (the bundle's `import.meta.url` is the entry's URL, so a
  relative spec would resolve against the wrong directory and miss the
  interception). The nested request bundles identically — arbitrary depth,
  `new SharedWorker(…)` included. The same literal-only contract applies:
  hoisted/computed/spec'd URLs are left alone, and `vite build` emits nested
  worker chunks through rollup's own detection.
- `AtollViteOptions.jsxImportSource` covers non-React JSX runtimes: the CLI
  emits `atoll({ jsxImportSource: 'solid-js' })` for solid scaffolds.
- The functional test (`packages/vite/test/atoll.test.ts`) runs a real vite
  `createServer` against `test/fixture` and asserts bundle content, header
  echo, alias bridging, and watch → `full-reload`.
