# LinkedIn: Micro-frontends in Workers

Micro-frontend post adapted from
[`../blog/micro-frontends-in-workers.md`](../blog/micro-frontends-in-workers.md)
(the Dev.to long-form). Copy the block between the rules verbatim:
LinkedIn renders no markdown, so the emojis and line breaks are the
formatting.

---

**Micro-frontends promise independent teams and independent deploys: then quietly put every framework on the same main thread.**

Module federation, import maps, iframe sandwiches. The orchestration varies, but the physics don't: every MFE's runtime lands in the same module graph, fighting for the same 16ms frame budget. "Pick your own framework" becomes "every user loads every framework."

I built **AtollJS** around a different answer: run each micro-frontend inside a real Web Worker: the actual React, Vue, Solid, Svelte, or Angular runtime, rendering off-thread and streaming DOM ops back to the page.

What that buys you:

**Real isolation**: a wedged MFE wedges its worker, not your page. `destroy()` is a `worker.terminate()` away.

**Independent deployment**: the worker bundle is a URL. Ship it inside an npm package or from a CDN on its own release cadence: the shell never rebuilds to pick up a new MFE version.

**Zero runtime tax**: a React shell hosting a Vue island loads zero bytes of Vue. The framework lives entirely inside the worker bundle.

**A typed seam, not a handshake**: each MFE publishes one framework-free contract module: app key, schema'd props, schema'd events, worker factory. The shell's facade derives the component types from it, and the worker enforces it at runtime.

The matrix it unlocks: **any supported framework in the shell × any supported framework in the worker**: 25 combinations, one op protocol, zero glue code. The repo mounts all five MFEs in all five shells to prove it.

Scaffold one in a command:

`npx @atolljs/cli new my-mfe --framework react --mfe`

Docs + live demos of every combination: https://jwhenry3.github.io/atolljs/consumer/island-mfe/
Repo (the publish/consume pair is a working e2e): https://github.com/jwhenry3/atolljs

#microfrontend #javascript #typescript #webdev #reactjs #vuejs #angular #webworkers

---

## Teaser variant (short post)

Micro-frontends put every framework on one main thread: AtollJS puts
each MFE in a real Web Worker. The shell imports a framework-free
contract (schema'd props, schema'd events, worker factory) and never
bundles the MFE's framework. Ship the worker from npm or a CDN, crash
one island without touching the rest.

Docs + live demos → https://jwhenry3.github.io/atolljs/consumer/island-mfe/
