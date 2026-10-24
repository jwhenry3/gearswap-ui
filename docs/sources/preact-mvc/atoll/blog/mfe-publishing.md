---
date: 2026-10-03
series: Micro-frontends
---

# Publishing an MFE: npm or CDN

## Two artifacts, two distribution shapes

> **Problem.** "Ship the MFE" sounds like one artifact until you try:
> the worker must be a *fetched asset* (the browser constructs a
> `Worker` from a URL: nothing `import`s it), while the contract must
> be a *module* (the shell `import`s it for types). Fuse them into one
> bundle and something breaks: usually the worker's self-containment.
>
> **Fix.** Keep them separate. `package.json` `exports` points at the
> contract source; `files` ships `dist-mfe/` so the prebuilt worker
> travels inside the package, or the contract's factory points at a
> CDN origin instead. Both verified end-to-end in the repo's examples.

A published MFE is two artifacts with different *kinds* of entry:

| Artifact | Kind | How the consumer reaches it |
|----------|------|------------------------------|
| `src/mfe/x.contract.ts` | module | `import` via the package `exports` map |
| `dist-mfe/x.worker.js` | fetched asset | `new Worker(url)`: a URL, never an `import` |

The subtlety that bites people: the worker is **not** a second
`build.lib` entry. A two-entry lib build code-splits the shared
contract module out of `x.worker.js`, leaving runtime `import`s inside
the worker: suddenly your "one file" MFE needs CORS on every chunk.
The publish build stays single-entry:

```ts
// vite.mfe.config.ts: one entry, one self-contained file
export default defineConfig({
  build: {
    lib: { entry: 'src/mfe/counter.worker.tsx', formats: ['es'] },
    outDir: 'dist-mfe',
    rollupOptions: {
      output: { entryFileNames: 'counter.worker.js' },
    },
  },
});
```

And the package keeps the two artifacts in their own lanes:

```json
{
  "exports": { ".": "./src/mfe/counter.contract.ts" },
  "files": ["src/mfe", "dist-mfe"]
}
```

## Shape 1: npm package

`dist-mfe/` ships inside the package. The contract's factory references
it package-relative, hoisted into a `new URL` so the consumer's bundler
treats it as an asset: emitted **verbatim**, not re-bundled:

```ts
const bundledWorkerUrl = new URL(
  '../../dist-mfe/counter.worker.js',
  import.meta.url,
);
worker: () => new Worker(bundledWorkerUrl, { type: 'module' }),
```

Why the hoist matters: `new Worker(new URL(...))` *inline* is the
bundler-detectable worker-entry form: it re-bundles the file as a
worker entry. For an already-built artifact you want verbatim-copy
asset semantics instead. The repo's `mfe-consumer` verifies this: the
emitted asset is byte-identical to the producer's `dist-mfe` output.

## Shape 2: remote origin

Point the factory at a CDN (or `vite preview` serving `dist-mfe/`).
One rule survives every refactor of this code: **worker script URLs
are same-origin**: `new Worker('https://cdn…')` throws `SecurityError`
no matter how generous the CORS headers, because CORS governs the
fetches a worker *makes*, not the script it's *built from*. The escape
is a same-origin shim that imports the remote bundle:

```ts
const shim = `import ${JSON.stringify(`${mfeOrigin}/counter.worker.js`)};`;
return new Worker(
  URL.createObjectURL(new Blob([shim], { type: 'text/javascript' })),
  { type: 'module' },
);
```

The `blob:` URL inherits the page's origin, the construction is legal,
and the remote module fetch inside needs only
`Access-Control-Allow-Origin` on the bundle.

## What actually got debugged building this

The `examples/mfe-publish` + `examples/mfe-consumer` pair exists
because this path had real bugs:

- **The contract rides inside the worker bundle**: its
  package-relative URL resolved the *previous* `dist-mfe` output and
  inlined it as a base64 data URI. Each rebuild embedded the last
  bundle: 745 kB → 4.8 MB → 10.4 MB. The publish config stubs the dead
  URL with an `enforce: 'pre'` transform.
- **Lib mode doesn't define `process.env.NODE_ENV`**: React's worker
  bundle crash-looped on `process is not defined`. A `define` fixes it
  *and* treeshakes the dev paths (745→381 kB).

Both are now in the CLI's generated `vite.mfe.config.ts`, so
`atoll add mfe <name>` and `atoll new <dir> --mfe` produce a publish
config that already knows about them.

Final post: [where worker-rendered MFEs actually pay off](mfe-use-cases.md).

Source: the [micro-frontends guide](../islands-remote.md),
`examples/mfe-publish/vite.mfe.config.ts`, and the e2e pair
`mfe-publish` + `mfe-consumer`.
