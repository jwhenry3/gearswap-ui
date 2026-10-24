# Cross-origin isolation

Read when: touching headers config, `serve-static.mjs`, iframe embedding,
or debugging `SharedArrayBuffer is undefined`.

`SharedArrayBuffer` is only exposed when `window.crossOriginIsolated === true`.
That flag, not CORS, is the gate, and every page in this repo (apps, docs,
embedded demos) has to satisfy it independently.

Everything on this page is opt-in: it applies only when a pool or worker uses
`sharedMemory`. A message-only `connectWorker`/`WorkerPool` (no `sharedMemory`
contract) needs no COOP/COEP headers and no `SharedArrayBuffer`: the
handshake becomes a bare `INIT` and this page doesn't apply.

## Top-level documents

A document becomes cross-origin isolated by sending two headers:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Verified in a clean-room check (`scripts/diag-sab.mjs`): a document with no
headers reports `crossOriginIsolated: false` / `SharedArrayBuffer: undefined`;
the same document with COOP+COEP reports `true` / `function`.

## Inside an iframe: the full chain

Embedding an app that uses shared memory in a cross-origin iframe requires
four independent pieces. If any one is missing, Chrome blocks the navigation
with `ERR_BLOCKED_BY_RESPONSE` or the child loads without isolation.

1. **Parent sends COEP**: the embedding page must itself be cross-origin
   isolated.
2. **`allow="cross-origin-isolated"` on the `<iframe>`**: the parent must
   *delegate* isolation to the frame. Without it, a fully-configured child is
   still blocked. (Set in `docs-consumer/src/components/DemoFrame.tsx`.)
3. **Child sends COEP + COOP**: under a `require-corp` parent, a
   cross-origin document must be capable of isolation itself.
4. **Child sends CORP**: the resource-policy opt-in for the cross-origin
   fetch: `same-site` suffices when embedder and app share a site (e.g.
   different `localhost` ports); use `cross-origin` for arbitrary embedders.

## Measured requirement matrix

COEP parent on `:5991`, children cross-origin on `:5993`, iframe carries
`allow="cross-origin-isolated"`: Chrome's CDP `blockedReason` for each child
header set:

| Child headers | Result | blockedReason |
|---|---|---|
| COEP + COOP + CORP same-site | loads, `crossOriginIsolated: true`, SAB live in-frame |: |
| COEP + COOP, no CORP | blocked | `corp-not-same-origin-after-defaulted-to-same-origin-by-coep` |
| CORP same-site, no COEP | blocked | `coep-frame-resource-needs-coep-header` |
| no headers | blocked | `corp-not-same-origin-…` |

Framing permission is a separate axis: `frame-ancestors` CSP controls *who may
embed*, while CORP controls *whether the response can be consumed
cross-origin*.

## Quirks that bit us

- **`localhost` and `127.0.0.1` are different *sites*.** `CORP: same-site`
  between two `localhost` ports passes; the same layout on `127.0.0.1` fails
  (`corp-not-same-site`). Match the hostname between embedder and child, or
  widen CORP.
- **`credentialless` iframes can't isolate.** A credentialless frame is never
  cross-origin isolated, SAB is undefined inside it, so the demo frames must
  not use it.
- **Dev servers don't hot-reload headers.** `ng serve` and `next dev` read
  header config at startup: restart them after editing, or the inspector
  shows stale responses.
- **Stable `index.html` URLs cache aggressively.** Assets are content-hashed
  but the document URL never changes: this repo stamps links with
  `?v=<build id>` and serves `Cache-Control: no-store` on every surface.
- **Worker script responses need the page's COEP too.** Under
  `require-corp`, Chrome refuses a `new Worker(...)` fetch whose response
  lacks a compatible `Cross-Origin-Embedder-Policy`: the failure surfaces as
  `net::ERR_BLOCKED_BY_RESPONSE` and an uninformative `Worker.onerror` ("worker
  error"), not a JS exception. Custom dev middleware that answers
  `?worker_file` requests itself (see `@atolljs/vite`) must echo
  `server.headers` onto the response; vite's own pipeline does this
  automatically.

## Hosts that can't set headers (GitHub Pages)

When the server can't send headers at all, a **service worker** can inject
them: it intercepts every response in its scope and rewrites the headers
before the document parses. This repo ships `coi-sw.js` (source in
`pages-landing/public/`, copied beside each entry point by `assemble-pages.mjs`),
modeled on `coi-serviceworker`:

- Each entry HTML registers `./coi-sw.js` via an inline snippet. The script
  lands in the same directory so its scope covers the page's own subtree.
- The first visit installs the SW then reloads once: a document is only
  isolated if it was *fetched while controlled*. The reload is once-per-path
  per tab (a `sessionStorage` flag), never a loop.
- COEP is `credentialless` under `react-dom-worker/` (the map island loads
  no-cors OSM tiles that `require-corp` would block: same rule as
  `serve-static.mjs`), `require-corp` elsewhere. Browsers that don't know
  `credentialless` simply stay non-isolated.
- The snippet no-ops when `crossOriginIsolated` is already true (dev
  servers, `serve:all`), so it never interferes locally.

Graceful degradation is the other half: islands detect the missing SAB and
run `mode: 'poll'` with `doorbell: false` (`connectIslandWorker({ doorbell:
false })` skips the shared-memory contract entirely: the pool constructor
throws on `sharedMemory` without SAB, so the flag is mandatory, not
cosmetic). The incidents demos can't degrade, shared memory *is* the demo,
so their `index.html` shows a notice instead.

## Where this repo sets it

| Surface | Config |
|---|---|
| static preview (`serve:all`) | `scripts/serve-static.mjs` |
| vite dev servers (examples + docs-consumer) | `server.headers` in each `vite.config.ts` |
| angular dev server | `serve.options.headers` in `angular.json` |
| next.js (`dev` + `start`) | `headers()` in `next.config.ts` |
| iframe delegation | `allow="cross-origin-isolated"` in `docs-consumer/src/components/DemoFrame.tsx` |
| GitHub Pages deploy | `coi-sw.js` service worker (source `pages-landing/public/coi-sw.js`, fanned out by `scripts/assemble-pages.mjs`; inline register+reload snippet in every entry `index.html`) |

Re-run the empirical check anytime: `node scripts/diag-sab.mjs` spins up fresh
servers and probes the matrix in real Chromium;
`node scripts/diag-iframe.mjs <url>` verifies live embedding end to end.
