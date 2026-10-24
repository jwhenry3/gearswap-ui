# LinkedIn: AtollJS Devtools

Feature post adapted from [`../blog/devtools.md`](../blog/devtools.md).
Copy the block between the rules verbatim: LinkedIn renders no markdown,
so the emojis and line breaks are the formatting.

---

**Every worker, every task, every island: one live map.** 🗺️

Your worker pool is a black box. Console.log across eight threads is a scramble, the browser's own devtools barely admit workers exist, and the question that matters (*which worker is slow, and doing what?*) has no answer.

So I built devtools for **AtollJS**: one line to turn on, zero cost when off:

```ts
import { initDevtools } from '@atolljs/devtools';
initDevtools({ session: { name: 'my-app' } });
// my-app/?__atoll_devtools → on. Without the param → no-op.
```

What you get:

🗺️ **The app map**: a live canvas drawn like the atoll it's named for: session at the center, pools on the rim, workers mid-orbit, islands on the outer orbit as framework marks. Zoom, drill, inspect.

🌊 **A task waterfall**: one swimlane per worker slot, queued→dispatched→settled, with per-task p95s and failure counts.

📡 **Real network + memory**: `fetch()` logging from main thread *and* workers, per-field shared-memory write rates, per-worker heaps.

🔍 **Post-mortem sessions**: a disconnected page is retained as an ended session, so history stays attributed after the crash.

The design choices that make it cheap:

⚡ **A sink, not a wire**: `emitDevtools` is one branch on a module sink; nothing transports until something installs one. "Off" costs nothing.

🧵 **One transport per app, never per worker**: a `poolSize: 32` pool still costs one connection; workers forward events over the task channel the pool already owns.

🔒 **The transport is the scoping**: BroadcastChannel in the browser means same-origin isolation by spec. No filter, a guarantee.

🖥️ **Node too**: `ATOLL_DEVTOOLS=1` + `npx atoll-devtools` and your Express/Nest pools show up on the same dashboard.

Docs + live demos: https://jwhenry3.github.io/atolljs/

#typescript #javascript #webdev #webworkers #devtools #nodejs

---

## Teaser variant (short post)

Your worker pool is a black box. One URL param opens it.
AtollJS devtools: one gated line of code, zero cost when off: app map,
task waterfall, fetch log, per-field shared-memory writes, per-worker
heaps: browser and Node on one dashboard.

Docs → https://jwhenry3.github.io/atolljs/
