# @atolljs/devtools: instrumentation, transports, and the dashboard

Read when: touching `packages/devtools/`, the `emitDevtools`/sink seam in
`src/devtools.ts`, worker `ATOLL_DEVTOOLS` forwarding in
`src/worker/workerBootstrap.ts` / `src/pool/workerPool.ts`, the
`/__atoll/` mount in `packages/vite/`, or any devtools hook in core:
`src/userTiming.ts`, the log tee in `src/log.ts`, `src/reactiveGraph.ts`,
`src/contract/memoryDevtools.ts`, `src/pool/devtoolsCommands.ts`,
`packages/islands/src/devtoolsCommands.ts`.

The user-facing surface (options, views, URL gate) lives in
`packages/devtools/README.md` and the consumer docs site. This doc covers
the architecture and the invariants that are easy to break. Production
deployment topologies (hosted dashboard, aggregate server, gating):
[devtools-deploy.md](devtools-deploy.md).

## Architecture in one paragraph

Core instrumentation never transports anything itself. `src/devtools.ts`
exposes a **sink seam**: `emitDevtools(event)` is one branch on a module
sink. `connectDevtools()` installs the transport sink (`setDevtoolsSink`,
one slot); extra listeners attach with `addDevtoolsSink(fn)` (returns a
remover; the OpenTelemetry exporter uses it), and events fan out to every
listener, each wrapped so one failing listener can't break the app. Any
installed sink or listener makes `devtoolsEnabled()` true, so pools spawned
afterwards turn on worker forwarding.
Transports are pluggable sink implementations: BroadcastChannel (browser
default) and WebSocket (aggregate server / Node) produce identical event
streams. The dashboard (`packages/devtools/app/`, a dependency-free static
site) renders whichever stream it hears. Workers never own a transport:
they wrap each event in an `ATOLL_DEVTOOLS` postMessage on the existing
task channel and the main thread re-emits through its sink.

## Transport selection

`connectDevtools()` defaults to `transport: 'auto'`:

- **Browser window → BroadcastChannel** (`src/broadcast.ts`, channel
  `atoll-devtools`). Pure client: no backend. Same-origin isolation is
  structural: a dashboard can only see apps on its own origin, which is
  the product answer to "don't aggregate foreign app instances". Each app
  keeps a bounded batch tail (500) in memory and answers viewer `view`
  pings with re-`hello` + replay, so late-joining dashboards still get
  history. `bye` on `pagehide` ends the session.
- **Node / `url` / `transport: 'websocket'` → `/events` WebSocket** to the
  standalone server (`src/server.ts`, loopback, default port 4780). This
  is the *opt-in aggregate*: cross-origin apps, Node processes, and
  post-mortem retention that outlives the page.

The dashboard picks the mirror side: `window.__ATOLL_TRANSPORT ===
'broadcast'` (injected by the vite plugin when serving `index.html`)
means it builds the session registry from channel frames itself,
hello→live, bye→ended, and owns pins/dismiss/TTL locally. Otherwise it
connects to `/view` and the server owns everything. A third value,
`'extension'`, is the Chrome DevTools panel (see
[Chrome DevTools extension](#chrome-devtools-extension)): `window.__ATOLL_BRIDGE`
stands in for the BroadcastChannel (`postMessage`/`onmessage`, plus
`onreset`) and everything else follows the broadcast path.

## Invariants

- **`?__atoll_devtools` is the whole gate.** `initDevtools()` returns
  `null` without it: no sink, no broadcast, no overlay button, no worker
  forwarding, no fetch/memory probes. The `enabled` option overrides.
  `connectDevtools()` ignores the param (always-on low-level API). Node
  gates on the `ATOLL_DEVTOOLS` env var.
- **Call `initDevtools()` before pools spawn.** The pool stamps
  `devtools: devtoolsEnabled()` into each worker's INIT handshake;
  `enableWorkerDevtoolsForwarding()` runs only when that flag is true.
  Workers spawned before a sink existed never emit: by design (the flag
  is also what keeps disabled workers fully quiet: no sink, no probes,
  no `ATOLL_DEVTOOLS` messages on the wire).
- **One transport per app, never per worker.** Worker events ride the
  task channel back to the main thread (`forwardDevtools` stamps
  `worker: {poolId, slot}`), which is why a `poolSize: 32` pool still
  costs one broadcast/socket and why the event stream is single-ordered
  for the timeline views. Do not give workers their own connection.
- **`devtoolsEnabled()` guards hot-path event construction.**
  `memory:write` fires on every shared-memory commit: the call sites in
  `src/contract/sharedMemory.ts` check `devtoolsEnabled()` before
  building the event object, not just rely on the sink no-op. Keep that
  pattern for any event emitted at write-rate frequency; pool task
  events (bounded by RPC throughput) still allocate before the no-op.
- **The `/__atoll/` iframe needs the app's COOP/COEP.** The vite
  middleware echoes `server.config.server.headers` on `/__atoll/`
  responses: without COOP `same-origin` the flyout iframe lands in a
  separate browsing-context group and `contentDocument` is `null` (the
  same rule the worker middleware follows; see
  [cross-origin-isolation.md](cross-origin-isolation.md)).
- **`@atolljs/devtools` resolves through `pluginContainer.resolveId`**
  in the vite plugin, not `createRequire` alone: workspace consumers
  reach the package via vite alias, and node resolution misses it (the
  failure mode is `/__atoll/` silently falling through to the SPA
  fallback and serving the app inside its own flyout).
- **BroadcastChannel is per-origin by spec**: that *is* the scoping.
  Don't add app/session filtering to compensate; multiple tabs of the
  same app legitimately appear as separate sessions.

## Dashboard app (`app/`)

Static `index.html` + `main.js`, no build step, no dependencies.

- `?mini=1` → `body.mini`: hides the session sidebar/`#scope`, session
  columns and group rows, compacts tables, and reparents the map block
  into a dedicated `tv-map` sub-tab (inserted before the generic subnav
  binding so it gets the standard handler; default tab). The map canvas
  flex-fills the tab.
- `body.local` (any broadcast context, mini or full) hides the session
  machinery: broadcast mode is structurally single-origin.
- Runner ids (`nextDevtoolsId` in `src/devtools.ts`): a runner with a
  config `name` is `<slug>-p` (pool) or `<slug>-w` (dedicated worker),
  with a counter on repeats (`sla-p`, `sla-p2`); unnamed ones are
  `pool-N` / `worker-N`. Slugs never contain `#`, `~` or `|`, the
  qualification separators below. Island `worker` shorthands (core
  `mountIsland` and every `*-island` shell) default `name` to the app.
- The app map is one canvas: session disc → pools inner orbit (P marks)
  → workers outer orbit. The session disc is the main thread: when the
  shell passes `initDevtools({ session: { framework: 'react' } })` it
  carries that framework's mark (`drawHub`) and the label reads
  `main thread · react`. A dedicated runner (`connectWorker` with
  `workers: 1`, the default, and every `connectIslandWorker` client) has
  no pool: its `pool:init` carries `dedicated: true`, and the map skips
  the P mark: the hub spoke runs straight to the
  worker on the outer orbit, labeled with that id (no `#slot` suffix,
  nested runners included). A worker hosting ONE island is drawn *as* that
  island: its framework mark on the worker's spot, or a W when it has no
  framework. The tag is the mount's `framework` option; when omitted, the
  driver asks the worker (`renderer(instance)` task, only while devtools
  is enabled): package adapters set `RenderedIslandApp.renderer`
  ('react', 'vue', 'svelte', 'solid', 'angular'), imperative apps report
  null. The tag is per instance: a host's mark says nothing about the
  sub-islands it spawns, and each sub-island reports its own. A worker
  hosting several (one shared
  `connectIslandWorker` client) is a container: a ring with a W badge
  on its edge for the worker itself (click → worker inspector), and one
  node per instance inside, its framework mark or, untagged, a hollow
  disc with the app's initial, each labeled outward with its `app@N`.
  A plain worker is a W (`ROLE_MARKS`, routed through `drawFwMark`).
  Island nodes carry their worker key, so inspecting the worker rings
  them too. Zoom tiers keep island marks on
  the rim (the atoll-logo look). `state.inspect`,
  `state.inspectWorker`, `state.sel` drive the accent-ring highlight;
  every selection path ends in `render()` → `drawAppMap` so the ring
  paints immediately.
- Task throughput (`drawThroughput`): per-second settle counts, bucketed
  on the dashboard clock (see [Time basis](#time-basis)) and summed
  across the selected sessions, windowed to the last 60s, on a
  1/2/5-rounded y-axis (0, mid, max) with `-60s`/`-30s`/`now` ticks; the
  `#tput-stats` line above it gives latest (last full second), peak and
  average rate, settled total and failures.
- Nested workers: a pool spawned inside a worker (`mountIsland` on a proxy
  element / `connectSubWorker`) forwards its events through the parent
  worker, which qualifies every forwarded pool id as
  `outerPool#slot~childPool`. Ids are minted per context, so a sub-pool is
  often *also* named `pool-1` (or reuses a host's name): qualification is unconditional because
  a worker only ever sees its own local id space. The map hangs each
  sub-worker off whatever spawned it, with a violet link: a sub-island's
  key (`parent~app@N`) names the spawning *instance*, so the link starts
  at that instance's node (`nestedhost@3` inside its container, not the
  worker as a whole); a worker-level spawn (`connectSubWorker`, no
  island) links from the host's W badge, or the host node itself. Each
  sub-worker is a violet W, or its island(s) in a violet ring, labeled
  with its own key segment (the link already shows the parent):
  recursively for deeper nesting.
- Framework icons are the real logos: `app/fw-logos.js` holds Simple Icons
  (CC0) 24×24 path data and official brand hex per `framework` tag
  (`react`, `vue`, `svelte`, `solid`, `angular`, `vanilla` as the
  JavaScript badge, `leaflet`, `nextjs`). Copy new entries from a pinned
  Simple Icons release rather than drawing them by hand. `drawFwMark` fills
  the path on a disc (light when the brand colour is too dark for the
  dashboard, e.g. Angular, Solid, Next.js); unknown tags get a lettered
  disc. It is drawn once into offscreen canvases → cached data URLs →
  `<img class="fwicon">` everywhere tables need an icon. One icon
  implementation feeds map + tables: don't fork it.

## Node apps

Node takes the WebSocket path by construction: `autoBroadcast()` requires
`window.document`, and a `worker_threads.BroadcastChannel` would only scope
to the same process anyway. There is no `/__atoll/` page or overlay: the
standalone server (`npx atoll-devtools`) is the dashboard.

- **Gate**: `initDevtools()` checks `process.env.ATOLL_DEVTOOLS` when there's
  no `location`: `ATOLL_DEVTOOLS=1 npm run start` enables, anything else is
  a no-op. `connectDevtools()` stays the always-on API. Node apps import
  from `@atolljs/devtools/node` (`src/node.ts`): same API minus the
  browser-only surface, so browser bundlers/tsconfigs never see `node:*`
  (the `nodeWs` fallback loads through a computed dynamic import for the
  same reason).
- **Init order**: put `initDevtools()` in a module imported *first* from the
  entry (`import './devtools'`), not in the entry body: in Node apps the
  pool typically spawns inside a sibling module's top-level code (see
  `examples/express/src/devtools.ts` + `main.ts`), and ESM evaluates all
  imports before the entry body runs. Nest pools spawn inside
  `NestFactory.create`, so the same pattern works there
  (`examples/nestjs/src/devtools.ts`).
- **WebSocket**: the client uses the global `WebSocket` (Node ≥ 22). On
  older Node it lazily loads `src/nodeWs.ts`, a dependency-free RFC6455
  client (masked frames out, `decodeFrames` shared with the server), so
  `node:net`/`node:crypto` never enter browser bundles. If neither exists
  the sink installs but stays dead.
- **Memory**: `installMemoryProbe` falls back to `process.memoryUsage()`
  when `performance.memory`/`measureUserAgentSpecificMemory` are absent:
  emits `heapBytes` (heapUsed) + `rssBytes`, and works inside
  `worker_threads`, so per-worker heap columns populate for Node pools.
- **Coverage**: `net:fetch` is outbound `fetch()` only: inbound HTTP
  handled by Express/Nest/worker-housed APIs is not instrumented. Islands
  never appear (nothing renders in Node).

## Server-side session lifecycle (`server.ts`)

`closedAt` stamps on socket close; a sweep (default 60s, `sweepMs`)
evicts closed sessions older than `closedTtlMs` (30 min): removed from
`closedSessions` *and* replay tail purged, then the list rebroadcasts.
`pinned` sessions are exempt from both the TTL and the 20-session cap
(the cap evicts oldest unpinned first). Viewers toggle via
`{type:'pin', sessionId, pinned}`; pins are server-authoritative and fan
out through the `sessions` broadcast. In broadcast mode the dashboard
implements the same rules client-side.

## Wire protocol

JSON frames (`src/protocol.ts`). App→server on `/events`:
`{type:'hello', session}` then `{type:'batch', events[]}`. Viewer→server
on `/view`: `{type:'sessions'}` then `{type:'batch', session, events}`
fan-out plus `{type:'dismiss'}`/`{type:'pin'}` requests. BroadcastChannel
mode reuses the same frame shapes minus the socket.

`SessionInfo.env` (`SessionEnv`, captured by `captureEnv()` in
`src/control.ts` at connect) carries `crossOriginIsolated`,
`sharedArrayBuffer`, `hardwareConcurrency`, `userAgent`, and Node's
`process.version`: the runtime facts the audits reason over.

## Event vocabulary (newer events)

Beyond the lifecycle events above (`pool:*`, `worker:*`, `task:*`,
`memory:bind`/`write`, `island:mount`/`unmount`/`task`/`ops`, `net:*`,
`runtime:memory`), the `DevtoolsEvent` union in `src/devtools.ts` carries:

| Event / field | Emitted by | Notes |
|---|---|---|
| `task:dispatch.argBytes` | `WorkerPool` / `DedicatedWorker` dispatch | `estimateCloneBytes(args)` |
| `task:settle.resultBytes` | the reply path, `ok` outcome only | `estimateCloneBytes(result)`; failures, timeouts, aborts and crashes carry none |
| `island:ops.bytes` | both island drivers' `applyOps` | `estimateCloneBytes(ops)` per batch |
| `island:event.payload` | both island drivers | `previewValue(payload, 1024)` |
| `island:props` | `mountIsland` / sub-island mount and every `updateProps` | `propsPreview`: `jsonSafe` (callbacks as `'[fn]'`) then a 4096-char preview |
| `memory:watch-hit` | `src/contract/memoryDevtools.ts` | a dashboard watchpoint matched; `{ path, version, value, rule }` |
| `runtime:longframe` | `packages/devtools/src/probes.ts` | LoAF (or `longtask`) on the browser main thread: `ms`, `blockingMs`, up to 5 `scripts` |
| `runtime:frames` | same probe | one per second: `fps`, `dropped` (frames over ~2x the display interval) |
| `log` | `src/log.ts` | every entry that passes the emitting thread's `setLogLevel`, `data` as `previewValue(data, 1024)` |
| `reactive:node` | `src/reactiveGraph.ts` | dependency-graph node: `id`, `kind`, `label`, `deps`, `owner`, `disposed` |

The size and preview helpers (`estimateCloneBytes`, budget 5000 nodes;
`previewValue`, default 2048 chars, functions as `'[fn]'`, binary as a
size label, cycles cut) allocate: call them only behind
`devtoolsEnabled()`, like every other event construction.

- **Log tee.** `log()` writes to its sink first, then mirrors into
  `emitDevtools` when a sink is installed (a `teeing` flag stops a transport
  that logs from recursing). Worker entries forward like any worker event,
  so a worker's logs before its INIT handshake, or from a worker spawned
  before devtools, are lost.
- **Reactive graph.** Kinds map onto the shallow SDK reactivity:
  `source` is a shared-memory field, id `mem:<path>`, owner `'shared'`, the
  same id on every thread so a worker writer and a main-thread watcher meet
  at one node; `bridge` is a version-counter watcher (`Atomics.waitAsync` or
  the 50ms poll); `derived` is a selector slice; `effect` is a `watch`
  callback or an `observe` subscriber fan-out. Non-source ids are per-thread
  counters (`b3`, `e7`), qualified by the dashboard with the event's
  thread/worker stamp. Only subscriptions created while devtools is enabled
  are graphed.
- **Watch hits.** Main-thread writes are checked synchronously on the
  connector write path (behind the existing `devtoolsEnabled()` check, and
  only when `memoryWatches.size > 0`). Worker writes are caught by a
  main-thread observer on each watched field's version counter, so a burst
  between two observations coalesces to its latest value.
- **User Timing** (`src/userTiming.ts`, `measureReplay` in
  `packages/islands/src/island.ts`): while devtools is enabled, the pool
  reply paths record `atoll task <taskId>` (main thread, track = runner id),
  the worker bootstrap records `atoll run <taskId>` (track `tasks`), and the
  main-thread island driver records `atoll replay <instance>` (track
  `islands`), all in Chrome's `atoll` track group via `detail.devtools`.
  Each measure is `clearMeasures`'d immediately: the Performance panel
  captured it at measure time, and per-task entries would otherwise grow the
  buffer without bound (and trip Node's buffer-size warning).
- **Jank probe** (`installJankProbe`, `connectDevtools({ jank })`, default
  on): reference-counted, browser main thread only. Frames with
  `blockingDuration === 0` and under 50ms of script are skipped as
  throttled renders. While hidden, frames are judged by script time alone
  (`HIDDEN_SCRIPT_MS`, 100ms; a `longtask` entry's duration stands in) and
  carry `hidden: true`, so consumers keep background work separate from
  foreground jank. The frame sampler restarts its window on any gap over a
  second.

## Control channel (dashboard → app)

The transports are bidirectional: a dashboard can invoke commands the app
registered.

- **Registry** (`src/devtools.ts`): `registerDevtoolsCommand(name,
  handler)` returns an unregister function (a later registration under the
  same name replaces the earlier one); `listDevtoolsCommands()`;
  `runDevtoolsCommand(name, args)`, which also answers the built-in
  `devtools.commands` with the list. Names are dotted by area. Args and
  results must be structured-cloneable and JSON-safe.
- **Frames**: `ControlRequest` `{type:'control', sessionId, id, cmd,
  args?}` and `ControlResult` `{type:'control-result', sessionId, id, ok,
  result?, error?}`. `answerControl` (`src/control.ts`) runs the command
  and JSON round-trips the result. Over BroadcastChannel every app hears
  the request and only the matching `session.id` answers. Over WebSocket
  the server relays to the live app with that session id (or replies
  `'session is not live'`) and routes the result back to the requesting
  viewer only.
- **Dashboard side** (`app/main.js`): `control(sessionId, cmd, args,
  timeoutMs = 5000)` returns a promise; `hasCommand(sid, cmd)` reads a
  per-session cache of `devtools.commands`, refreshed (debounced) when a
  live session appears and whenever a `pool:init`, `island:mount` or
  `memory:bind` arrives.
  Controls gate on that cache, on the session being live, and on not
  replaying a recording.

Commands register lazily, only while devtools is enabled, and only on the
main thread's registry (the one with a transport):

| Command | Args | Registered by |
|---|---|---|
| `pool.list` | | `src/pool/devtoolsCommands.ts`, with the first live runner; removed with the last |
| `pool.stats` | `{ poolId }` | same |
| `worker.kill` | `{ poolId, slot }` (slot default 0) | same: runs the runner's real crash handler with `'killed from devtools'` (in-flight calls reject with `WorkerCrashedError`, respawn if enabled) |
| `pool.chaos` | `{ poolId, delayMs?, failRate?, timeoutRate? }` | same: rates in 0..1, `failRate + timeoutRate ≤ 1`; `{ poolId }` alone clears |
| `island.list` | | `packages/islands/src/devtoolsCommands.ts`, with the first island mounted while devtools is on |
| `island.tree` | `{ instance, maxNodes? }` | same: DOM tree of the container, `maxNodes` default 3000, capped at 20000 |
| `island.highlight` | `{ instance, id \| null }` | same: outlines the tree node in the page; `null` clears |
| `island.props` | `{ instance }` | same: `{ props: jsonSafe, preview }` |
| `island.updateProps` | `{ instance, props }` | same: replaces props, restoring `'[fn]'` placeholders from the current props at the same path |
| `island.setMode` | `{ instance, mode: 'push' \| 'poll' }` | same |
| `memory.read` | | `src/contract/memoryDevtools.ts`, on the first `SharedMemory.bind()` while devtools is on: every bound field's preview and version |
| `memory.watch` | `{ path, rule }` | same: rules `change`, `>`, `<`, `>=`, `<=`, `==`, `!=` (`rule` default `change`) |
| `memory.unwatch` | `{ path }` | same |
| `memory.watches` | | same |
| `reactive.nodes` | | `src/reactiveGraph.ts`, with the first graph node: this thread's live nodes |
| `devtools.commands` | | built into `runDevtoolsCommand` |

Chaos is applied at dispatch (`applyChaos`): an injected failure settles
through the runner's reply path with `'chaos: injected failure'` (outcome
`error`) and never reaches the worker; an injected timeout settles through
the real timeout path (outcome `timeout`) and still posts the call, exactly
like a real timeout. With chaos unset a runner's only cost is one field
check per dispatch.

Runners and islands inside a worker register in that worker's registry,
which no transport reaches: `pool.*` / `island.*` reject ids containing
`~` with an explanatory error. A nested island's DOM is replayed into its
top-level island's container, so `island.tree` on the outer instance
includes it.

## Panel plugins (`app/api.js`)

`main.js` owns the event reducer, the core views (Dashboard 10, Tasks 20,
Network 30, Memory 40, Log 90 in nav order) and the transport. Feature
panels live in `app/panels/<name>.js`, export `setup(api)`, and are listed
in `PANELS` in `main.js` (setup order: performance, inspect-island,
memory-values, reactivity, actions, recorder, audits, shell last). Panels
never edit `main.js` state shapes; they keep their own state, fed by hooks:

- `onEvent(fn(session, event))`, `onBatch(fn(session, events))` (the
  recorder taps this), `onReconcile(fn(liveIds))`, `onRender(fn)`,
  `onTick(fn)` (once a second), `onReset(fn)`, `onInspectIsland(fn(key,
  island, { extra, actions }))`, `onInspectWorker(fn(key, worker, {
  actions }))`, `onNavigate(fn)`.
- `addView({ id, label, order, html, badge, title })` (Performance 25,
  Reactivity 45, Audits 80), `addSubview(viewId, { id, label, html, order
  })` (Memory › Values at 5), `openView`, `openSub`, `addPaletteItem({ id,
  title, group, hint?, keys?, when?, run })`, `addToolbarButton({ id, label,
  title, order, onClick })`, `setViewIntro(viewId, html)`, `toast(msg,
  kind, ms)`.
- `control`, `hasCommand`, `liveSessions()`, `selectedOrOnlyLive()`,
  `ingest(session, events)` (the one ingest path: replays go through it
  too), `reset()`, `reannounce()`, `livePaused` (set while replaying),
  `isMini`, `transport`.

Render contract: render and inspector hooks run on every `render()`
(rAF-batched, many times a second under load). A panel that owns inputs
builds them once and updates in place.

The shell panel (`panels/shell.js` + pure `panels/route.js`) adds the
palette, `g`+letter / `[` `]` / `/` / `s` / `?` shortcuts, the More menu,
view intros, and hash routing (`#/<view>[/<sub>][?session=&island=&worker=]`).
Inside the flyout iframe it only `replaceState`s (a `pushState` there would
add entries to the host page's joint history) and posts each route to the
parent (`atoll-devtools:route`), which is how the overlay's "full page ↗"
link carries the current view. The overlay listens for Alt+Shift+D on the
host page and for an `atoll-devtools:toggle` message the iframe posts for
the same chord.

The overlay moves by its header and resizes from any edge or corner. Every
move and resize is clamped so the whole panel, header close button included,
stays inside `document.documentElement.clientWidth`/`clientHeight` (the
viewport minus page scrollbars), and resizing stops at a 340×220 minimum.
The first drag pins a corner- or center-anchored panel to explicit
`left`/`top`. It refits on window `resize`, on a `ResizeObserver` callback
for `<html>` (a scrollbar appearing fires no `resize` event), and at the
start of each drag, so a persisted size from a larger screen can't overflow.

## Time basis

Every event's `at` is `performance.now()` on the thread that emitted it,
and worker-forwarded events keep the worker's `at` (`forwardDevtools`
doesn't re-stamp). Thread epochs are unrelated, so `at` is only comparable
within one thread: the task waterfall (one session's main-thread task
events) uses it directly. **Anything that rolls with time buckets on the
dashboard clock** (`performance.now()` at ingest) instead: the task
throughput chart (`state.tput`), the main-thread heap series, the
Performance view, and the audit aggregates. The Log view shows the
dashboard's wall clock at receipt next to the event's own elapsed time. A
side effect: a late joiner's replayed tail is stamped on arrival, so it
lands as one burst on dashboard-clock series.

## Recordings

`panels/recorder.js` keeps a rolling capture of received frames (50,000
events) and an explicit recording (capped at 500,000). Export writes
`{ format: 'atoll-devtools-recording', version: 1, exportedAt, sessions,
frames: [{ t, sessionId, events }] }` (`panels/recording-format.js`), `t`
being the dashboard clock at receipt. Import sets `api.livePaused`,
resets, and re-ingests through `api.ingest` under copies of the sessions
renamed with a `'⏺ '` prefix and marked closed, so every control gate
reads "ended" and no command can reach a live app.

## Chrome DevTools extension

`packages/devtools-extension/` (private, MV3) adds an **atoll** panel to
Chrome DevTools that runs the same `app/` dashboard against the inspected
tab. `npm run build:extension` writes `packages/devtools-extension/dist/`;
load it with chrome://extensions, Developer mode, "Load unpacked".

- **Push relay: content script, service worker, panel.** A content script
  (`src/content.js`: `<all_urls>`, top frame, `document_start`, isolated
  world) is passive on every page: it only registers a
  `chrome.runtime.onMessage` listener, opening no port and no channel. The
  panel connects an `atoll-panel` port to the service worker
  (`src/hub.js`) with the inspected tab id; the hub sends
  `{ type: 'atoll-attach' }` to that tab's top frame with
  `tabs.sendMessage`, and the content script connects an `atoll-page` port
  and joins `BroadcastChannel('atoll-devtools')` (an isolated-world channel
  hears the page's same-origin channel, verified in Chromium). App frames
  (`hello` / `batch` / `bye` / `control-result`) are pushed to the panel as
  they arrive; `view` and `control` go the other way. The hub pairs ports
  by tab id, accepts page ports only from frame 0, and shape-checks every
  frame. No `inspectedWindow.eval`, no polling.
- **Navigation**: the old document's port drops, the panel shows
  `connecting…`, and the hub retries the attach (200ms, 500ms, 1s, 2s,
  then every 3s). A new page port after an earlier one sends `reset`, so
  `onreset` clears the dashboard and re-sends `view`, and the app answers
  with `hello` plus its replay tail. SPA navigations keep the port.
- **Detach**: closing the panel disconnects the page port; the content
  script closes its channel and goes passive. The panel pings the service
  worker every 15s (port messages keep an MV3 worker alive from Chrome
  114, the manifest minimum) and reconnects, with a reset, if it restarts.
- **Permissions**: no `permissions` or `host_permissions` keys, but the
  `<all_urls>` content script makes Chrome show "Read and change all your
  data on all websites" at install. Tabs open before install (or before an
  extension reload) have no content script and show `reload the page to
  connect`; so do `chrome://` and Web Store pages, which the service worker
  can't tell apart without the `tabs` permission.
- **Build**: `scripts/build.mjs` copies `app/` verbatim, writes
  `app/panel.html` (`index.html` plus the bridge script and light-theme
  CSS), and generates the classic `content.js` from `src/frames.js` +
  `src/content.js` (manifest content scripts can't be modules). The build
  fails if `index.html` gains an inline `<script>`, which the extension CSP
  would block.
- **Test hook**: outside DevTools, `app/panel.html?tabId=N` names the tab to
  inspect, so a browser test can open the panel as a plain tab.
- **Panel context** (`body.ext`): the shell uses real history, keeps its own
  last-view key, hides "copy link", and also opens the palette on
  Ctrl/Cmd+Shift+K because DevTools uses Ctrl/Cmd+K.
- **Limits**: top frame plus same-origin frames only; origin-wide like the
  flyout (other same-origin tabs appear too, and a `view` ping also replays
  to an open flyout); history clears on navigation and after a service
  worker restart; port messages are JSON, so frames JSON can't carry are
  dropped; the light theme is a filter over the dark palette; aggregate
  server and Node sessions aren't shown (use the standalone dashboard).

## OpenTelemetry export (`@atolljs/devtools/otel`)

`exportOtel(opts)` maps the event stream to OTLP/HTTP JSON (no
dependencies) and POSTs batches to `${endpoint}/v1/traces|metrics|logs`
(default endpoint `http://localhost:4318`). It attaches with
`addDevtoolsSink`, so it runs alongside a dashboard transport or alone, and
like every sink it must be installed **before pools spawn**.

- **Traces**: one CLIENT span per task call (`atoll.task <taskId>`,
  correlated on pool id + call id, with an `atoll.dispatch` event), island
  round trips (`atoll.island <instance> <method>`) and fetches (HTTP
  semantic-convention attributes, credentials redacted from `url.full`).
  Successful spans leave status unset; `error`, `timeout`, `queue-full` and
  `crashed` outcomes set status error; `aborted` stays unset.
- **Metrics** (cumulative): `atoll.task.settled`, `atoll.task.duration`,
  `atoll.task.queue_wait`, `atoll.task.in_flight`, `atoll.island.ops`,
  `atoll.runtime.heap`/`rss`, `atoll.runtime.long_frames`/`blocking`/`fps`,
  `atoll.memory.writes`, `atoll.worker.errors`/`respawns`.
- **Logs**: `log` events (severity trace 1, debug 5, info 9, warn 13,
  error 17) and worker errors/respawns.
- **Clocks**: main-thread events convert exactly (`performance.timeOrigin +
  at`). Worker-forwarded events keep the worker's clock (not rebased), so
  the exporter estimates each worker's offset as the smallest observed
  receive-minus-`at` gap; durations stay exact, absolute times are late by at
  most the fastest delivery seen.
- **Transport**: retries only 429/502/503/504 and network errors
  (Retry-After honoured, else jittered backoff); the oldest queued
  spans/logs drop past `maxQueue`. Browsers flush with `keepalive` on
  `pagehide`/hidden (bodies under 60KB); Node flushes on `beforeExit`, which
  doesn't fire on `process.exit()` or signals, so call `close()`. The
  exporter ignores `net:fetch` events for its own endpoint and never logs
  through `log()`.

The aggregate server forwards too: `createDevtoolsServer({ otlp: { endpoint,
headers?, serviceName? } })` or `atoll-devtools --otlp <url> [--otlp-headers
k=v,k2=v2] [--otlp-service <name>]` (same flags on `atoll devtools`). Each app
session becomes its own resource (`service.name` = session name,
`service.instance.id` = session id). Limitations: each task call is its own
trace (no cross-thread parent context), and metrics are cumulative only.

## Limitations

- Only main-thread runners and islands are commandable; sub-pools and
  nested islands are visible but not controllable.
- Commands exist only for runners/islands/contracts created while
  devtools was enabled, and `memory.*` only once a contract has bound.
- `argBytes` / `resultBytes` / `bytes` are estimates (5000-node walk), not
  measured clone sizes.
- The jank probe watches the browser main thread only; workers and Node
  report no frames. The flyout iframe shares the app's main thread, so
  dashboard rendering counts as app jank: measure from the full page.
- Watch hits from worker writes coalesce between main-thread observations;
  list fields support only the `change` rule.
- `island:props` and `island.props` are `jsonSafe` copies: binary data,
  Maps, Sets and Dates become display values, so writing them back through
  `island.updateProps` replaces the originals. Only `'[fn]'` placeholders
  are restored.
- Audits and Performance work on what the dashboard has received: a
  dashboard that joins late sees only the replay tail, and a `pool:init`
  that already left the tail makes that pool look spawned-before-devtools.
