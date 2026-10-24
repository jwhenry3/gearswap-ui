# Remote worker bundles: islands served from another origin

> Scaffolding: `atoll add mfe <name>` (existing project) or
> `atoll new <dir> --mfe` (standalone package) emits the contract, the
> contracted worker entry, and a `vite.mfe.config.ts` publish build.



Islands don't require the worker script to ship with the page. The `worker`
option is a factory, `(() => Worker) | URL`, and the client only ever
touches the resulting `Worker` instance: `postMessage` carries the op
protocol, the SharedArrayBuffer doorbell is *posted*, not fetched.

One browser rule shapes the whole remote topology: **a worker's script URL
must be same-origin with the page**: `new Worker('https://cdn…')` throws
`SecurityError`, and CORS headers do not lift it (CORS governs the fetches a
worker *makes*, not the worker's own construction). The escape hatch is a
same-origin module shim that imports the remote bundle: a `blob:` URL
inherits the page's origin, and the `import` inside it fetches cross-origin
with CORS:

```ts
const shim = `import ${JSON.stringify('https://mfe.example.com/ticker@1.4.0.worker.js')};`;
worker: () =>
  new Worker(
    URL.createObjectURL(new Blob([shim], { type: 'text/javascript' })),
    { type: 'module' },
  ),
```

This is the "published MFE" topology: the MFE team builds and deploys its
worker bundle independently; the shell wires against a framework-free
contract. The contract is still the binding, `app` key, prop schema, event
schemas, worker factory, the remote URL only changes where the factory
points.

A working end-to-end pair lives in [`examples/mfe-publish`](../examples/mfe-publish/)
(producer, contract + `vite.mfe.config.ts` publish build) and
[`examples/mfe-consumer`](../examples/mfe-consumer/) (shell, imports the
contract by package name, mounts the prebuilt bundle or the remote origin).

## Two distribution shapes

- **CDN / static host**: the contract's `worker` factory points at a remote
  URL. Covered by the rest of this doc.
- **npm package**: the MFE package ships both artifacts: the contract as
  its `exports` entry (`import contract from '@scope/my-mfe'`) *and* the
  built bundle under `dist-mfe/` (include it in `files`). The bundle is
  referenced package-relative as a plain **asset**: hoist the `new URL`
  rather than writing `new Worker(new URL(...))` inline:
  ```ts
  // Hoisted = asset semantics: the consumer's bundler emits the file
  // VERBATIM. Inline inside new Worker() it would be detected as a worker
  // entry and re-bundled: same code, wasted build work.
  const bundledWorkerUrl = new URL('../../dist-mfe/ticker.worker.js', import.meta.url);
  worker: () => new Worker(bundledWorkerUrl, { type: 'module' }),
  ```
  Caveat: vite's dep optimizer must not pre-bundle the contract: the
  `new URL` asset resolution has to see the real file. Exclude it:
  `optimizeDeps: { exclude: ['@scope/my-mfe'] }`.

Either way, the contract module itself is the package's *module* entry; the
worker bundle is a *fetched asset*: they're two entry points, but only the
contract belongs in `exports`/`main`. The publish build stays single-entry
(`build.lib` with two entries would code-split shared modules, including
the contract, into runtime `import`s inside the worker bundle, breaking
self-containment and requiring CORS on every chunk).

## What changes vs. local entries

The inline `new Worker(new URL('./x.worker.ts', import.meta.url))` literal
exists **only** so the bundler statically detects a *local* entry
([islands.md](islands.md#worker-entries-per-bundler)). A remote URL has
nothing to bundle, it is fetched at runtime, so the factory may compute,
hoist, or env-inject it freely:

```ts
const MFE_BASE = import.meta.env.VITE_MFE_ORIGIN ?? 'https://mfe.example.com';
const WORKER_URL = `${MFE_BASE}/ticker@${TICKER_VERSION}.worker.js`;

export const tickerContract = defineIslandContract({
  app: 'ticker',
  props: z.object({ label: z.string().optional(), intervalMs: z.number().optional() }),
  events: { tick: z.object({ count: z.number() }) },
  // Same-origin blob shim: see above. new Worker(WORKER_URL) directly
  // would throw SecurityError.
  worker: () =>
    new Worker(
      URL.createObjectURL(
        new Blob([`import ${JSON.stringify(WORKER_URL)};`], {
          type: 'text/javascript',
        }),
      ),
      { type: 'module' },
    ),
});
```

Consequences to plan for:

- **No bundler fingerprinting.** A local `import.meta.url` entry is hashed
  and cache-busted by Vite; a remote URL is not. Pin a version (or content
  hash) in the URL yourself, `ticker@1.4.0.worker.js`, and bump it on
  deploy, or a stale cached script will silently run an older app.
- **Self-contained bundle.** The remote script must carry its own
  `@atolljs/islands/worker` runtime *and* its framework renderer: a
  mono-worker entry (`defineMonoWorker` / `define*MonoWorker`) compiled as a
  single chunk. Any `import` it makes cross-origin needs CORS too, so one
  bundled file is the practical shape.
- **Worker-side validation still runs.** The remote bundle's
  `define*MonoWorker(app, { contract })` stamps the contract: mount,
  `updateProps`, and `emit` payloads parse against it inside the worker,
  same as local.

## Serving requirements (remote side)

| Requirement | Why |
|---|---|
| `Access-Control-Allow-Origin` | The same-origin shim's `import <remote url>` is a CORS fetch: without the header it fails inside the worker and the island never mounts. |
| HTTPS | A `http://` worker on an `https://` page is blocked as mixed content. |
| Long cache + versioned URL | The URL is the cache key: see fingerprinting above. |
| `Cross-Origin-Resource-Policy` | Only needed if the script is fetched `no-cors`. Module workers are CORS-mode, so `Access-Control-Allow-Origin` already satisfies **both** `COEP: require-corp` and `COEP: credentialless` pages: one header covers it. |

A minimal static host config:

```
Access-Control-Allow-Origin: https://shell.example.com   (or *)
Content-Type: text/javascript
Cache-Control: public, max-age=31536000, immutable
```

## Shell requirements (unchanged)

Nothing about the remote script relaxes the page-side rules
([cross-origin-isolation.md](cross-origin-isolation.md)):

- The SharedArrayBuffer doorbell still needs **COOP + COEP on the page**.
  The worker's origin doesn't matter: the buffer travels through
  `postMessage`.
- If the page can't be isolated, pass the doorbell-free path as usual,
  `mode: 'poll'` on the mount options (facades that expose it) or
  `workerOptions.doorbell: false`, and the op queue falls back to polling.
- `mountIsland`/facade call sites are identical; they consume the contract
  the same way whether `contract.worker` points at `import.meta.url` or a
  CDN origin.

## Registry workers over the wire

A remote `definePolyWorker` bundle can serve several apps from one URL:
the poly topology applies unchanged. Two subtleties:

- **Share the client, not the Worker.** Facades that take a `client`
  option co-locate multiple mounts in one worker; spawning `new Worker(...)`
  per contract gives each MFE its own OS thread: usually what you want, but
  for a remote *registry* bundle prefer one `connectIslandWorker({ worker })
  ` client passed to each mount.
- **One app key per contract.** Each contract still pins a single `app`
  name; the remote bundle just hosts more than one of them.

## Publish-build gotchas

`vite build --config vite.mfe.config.ts` is a `build.lib` over the worker
entry: a different pipeline than an app build, with two sharp edges:

- **Define `process.env.NODE_ENV`.** App builds substitute it automatically;
  lib mode doesn't, and framework dev/prod checks crash on a bare `process`
  inside a browser worker.
  `define: { 'process.env.NODE_ENV': '"production"' }`.
- **Stub the contract's own worker URL.** The worker entry imports the
  contract, so the contract's `worker` factory is bundled too, dead code
  (a worker never spawns itself), but its `new URL('../../dist-mfe/…',
  import.meta.url)` still resolves during the build and inlines the
  *previous* output into its own successor, the bundle grows every
  rebuild. A tiny `enforce: 'pre'` transform replacing the URL with a stub
  kills it. Both fixes are in the scaffolded `vite.mfe.config.ts` (see
  `examples/mfe-publish/` for the working version).

## Failure modes

| Symptom | Cause |
|---|---|
| `SecurityError` at `new Worker(...)` | Direct cross-origin script URL: worker scripts must be same-origin regardless of CORS. Use the same-origin blob/file shim above. |
| `mountTimeout` rejection naming the URL | Script unreachable, or missing `Access-Control-Allow-Origin` on the shim's import fetch: the worker never evaluated its `define*` call. |
| Worker boot OK, mount fails with "app not registered" / unknown app | The remote bundle doesn't contain the contract's `app` key: URL/schema drift between contract version and deployed bundle. |
| `ZodError` at mount or on emit | Prop/event payload drift: the contract the shell imported doesn't match the one stamped inside the deployed bundle. Version the two together. |
| Islands render but feel laggy | Non-isolated page → poll transport; check COOP/COEP rather than the remote URL. |

The drift row is the one that matters operationally: the contract is the
*typed promise* between shell and remote worker, so publish contract module
and worker bundle as one versioned pair: the shell upgrading its contract
without the CDN bundle following (or vice versa) is the classic split-brain.
