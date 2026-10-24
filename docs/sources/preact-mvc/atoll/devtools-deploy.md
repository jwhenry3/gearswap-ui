# Devtools in production: deployment topologies

Read when: shipping `?__atoll_devtools`-gated apps, hosting the dashboard
outside `vite dev`, running `atoll-devtools` as a reachable aggregate, or
debugging a deployed pool. Architecture and invariants live in
[devtools.md](devtools.md); this doc covers putting the pieces behind a
real URL.

## The two pieces, and why they decouple

The dashboard is a static `index.html` + `main.js`
(`packages/devtools/app/`, no build step). The event transport is chosen
per app by `connectDevtools()` / `initDevtools()`, not by the dashboard:
the app broadcasts or websockets regardless of where a viewer is. So
"deploying the devtools" is two independent questions: *where do events
go*, and *where does a human open the dashboard*.

- **BroadcastChannel** (browser `auto` default): events never leave the
  origin. The dashboard must be served on that same origin, and it must
  be told so via `window.__ATOLL_TRANSPORT = 'broadcast'` (the vite
  plugin injects it when it serves `/__atoll/` in dev and when it emits
  the dashboard into a `vite build`; a hand-made static copy needs it
  added by hand).
- **WebSocket** (`transport: 'websocket'` or `url`, and every Node app):
  events go to `/events` on a `createDevtoolsServer` instance; the
  dashboard served by that same server reads them back on `/view`. No
  flag injection needed: served without the tag, `index.html` defaults
  to the aggregate path.

## Topology A: same-origin static dashboard (zero backend)

With vite, the plugin does it for you: whenever the built bundle contains
`@atolljs/devtools` code (the app calls `initDevtools()`), `vite build`
copies the dashboard into `<outDir>/__atoll/`, so the overlay flyout never
points at a missing page. The broadcast flag is set by an external
`atoll-transport.js` script, so a CSP without `'unsafe-inline'` still
allows it. An import tree-shaken away (say, behind `import.meta.env.DEV`)
doesn't count. Override with `devtools.build`:

```ts
// vite.config.ts
atoll({ devtools: { build: false } }) // never ship /__atoll/
atoll({ devtools: { build: true, dir: 'debug/devtools' } }) // always, elsewhere
```

Without vite, copy `packages/devtools/app/` into your deploy at
`/__atoll/` and add the broadcast flag to its `index.html` before
`</head>`:

```html
<script>window.__ATOLL_TRANSPORT="broadcast"</script>
```

Either way, `?__atoll_devtools` and the overlay flyout then work exactly like dev:
`initDevtools()` activates on the param, the sink broadcasts, the flyout
iframes `/__atoll/?mini=1`. Same-origin isolation carries into
production for free: the dashboard can only ever hear apps on its own
origin. Two production-only details:

- **Serve the app's COOP/COEP headers on `/__atoll/` too.** In dev the
  vite middleware echoes `server.config.server.headers`; on a static
  host that's your job (and for `vite preview`, set `preview.headers`).
  Without COOP `same-origin` the flyout iframe lands in a separate
  browsing-context group and the overlay goes blank. If your app ships
  `SharedArrayBuffer` the headers exist anyway.
- **Apps mounted under a sub-path can't use the absolute default.** If
  the dashboard copy sits inside the app's own mount (`/<base>/<app>/__atoll/`),
  pass a relative overlay src: `overlay: { src: '__atoll/?mini=1' }` resolves
  it next to the app's page, where an absolute `/__atoll/` would escape the
  mount. With a vite `base`, `import.meta.env.BASE_URL + '__atoll/?mini=1'`
  points at the same place the plugin emits to. The `full page ↗` link derives from the same `src`, so it stays
  correct either way. This repo's docs demos do exactly this:
  the plugin emits `__atoll/` into each demo's build, and
  `mountDevtoolsApp` in `scripts/pages-lib.mjs` plants a flag-injected
  copy in any demo mount that lacks one.
- **This mode is browser-only and single-origin.** Node sessions and
  other origins can't join a BroadcastChannel: use topology B for those.

## Topology B: hosted aggregate server

`atoll-devtools` / `createDevtoolsServer` (loopback `127.0.0.1:4780` by
default) serves the dashboard *and* ingests events. Run it reachable:
bind `host: '0.0.0.0'` directly or keep it loopback behind a reverse
proxy terminating TLS:

```ts
// devtools-server.ts — your own process, or a sidecar
import { createDevtoolsServer } from '@atolljs/devtools/server';

createDevtoolsServer({ host: '0.0.0.0', port: 4780 });
```

Point apps at it; the `url` option implies websocket transport:

```ts
initDevtools({
  transport: 'websocket',
  url: 'wss://devtools.internal.example.com/events',
  session: { name: 'checkout-web' },
  overlay: { src: 'https://devtools.internal.example.com/?mini=1' },
});
```

The cross-origin `overlay.src` works because the dashboard page uses the
server's `/view` socket, not BroadcastChannel: it renders wherever it's
iframes from. Browser and Node sessions aggregate on one dashboard,
tagged `runtime: 'browser' | 'node'`.

**The server has no auth.** Loopback is the designed deployment; the
moment it's reachable, put your own controls in front: proxy auth, mTLS,
an internal ingress rule, anything. Treat it like exposing a metrics
endpoint, because that's what it is.

## Gating in production

`?__atoll_devtools` activates `initDevtools()` in a production build
too: anyone can append it. Under topology A that's self-limiting (events
only reach a dashboard on your origin). Under topology B every visitor
who appends the param streams to your aggregate, so gate on something
you control:

```ts
initDevtools({
  enabled: searchParams.has('debug') && user.isStaff,   // overrides the param
  transport: 'websocket',
  url: 'wss://devtools.internal.example.com/events',
});
```

`enabled: false` is a full no-op: no sink, no probes, no worker
forwarding. Node gates on `ATOLL_DEVTOOLS` in the environment instead:
set it per deploy, per pod, per incident.

## Production debugging workflow

What a deployed dashboard buys you that a dev one doesn't:

- **Post-mortem sessions.** A closed page doesn't vanish: the server
  retains it as an *ended* session (`closedTtlMs`, 30 min default) with
  its replay tail intact, so "it glitched and they closed the tab" is
  still inspectable. Pin sessions you're comparing; the TTL and the
  20-session cap only touch unpinned ones.
- **The aggregate view.** Node services and browser tabs on one map:
  when a `/api/query` request is slow you see the API's task waterfall
  and the page's in the same timeline, workers stamped `poolId#slot`.
- **Reconnect tolerance.** Apps buffer up to `bufferCap` events
  (50,000 default) while the socket is down and flush on reconnect:
  a restarting devtools server doesn't lose the incident.
- **Targeted enablement.** Because `enabled` is per-page-load and
  `ATOLL_DEVTOOLS` is per-process, you light up exactly the session
  under investigation and pay nothing everywhere else: `enabled: false`
  and unset env are both literally zero-cost paths.

## Deploy checklist

- Dashboard hosted (static `/__atoll/` + broadcast flag, *or* the
  server's own app dir) and reachable where you debug.
- Apps: `initDevtools` before pools spawn, `enabled` wired to your
  gate, `transport`/`url`/`overlay.src` set for the topology.
- `/__atoll/` serves COOP/COEP matching the app (flyout iframe).
- Aggregate server behind auth + TLS; treat `/events` ingest and
  `/view` as equally sensitive.
- Node: `ATOLL_DEVTOOLS` set only where you want streams; the init
  module imported first (`import './devtools'`).
