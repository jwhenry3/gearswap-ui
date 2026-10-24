---
title: Five Frameworks, One Page, Zero Runtime Tax, Micro-frontends in Web Workers
published: false
description: AtollJS runs each micro-frontend in a real Web Worker, true isolation, independent deployment, and a shell that never bundles the MFE's framework.
tags: microfrontend, javascript, webdev, typescript
cover_image:
canonical_url:
date: 2026-10-02
---

# Five Frameworks, One Page, Zero Runtime Tax: Micro-frontends in Web Workers

## Your micro-frontends are sharing one thread. AtollJS's aren't.

The micro-frontend pitch is great: teams own their features, ship on
their own cadence, pick the framework that fits the problem. The
asterisk nobody puts in the README: every one of those frameworks runs
on the **same main thread**, in the **same module graph**, fighting for
the **same 16ms frame budget**.

Module federation, import maps, iframe sandwiches: the orchestration
varies, but the physics don't. Pick Vue for one widget and Angular for
another and every user loads every runtime. "Independent teams" quietly
becomes "every framework on every page, all the time."

I built [AtollJS](https://github.com/jwhenry3/atolljs) around a
different answer: **run each micro-frontend inside a real Web Worker**.
Not a shim, not a renderer subset: the actual React/Vue/Solid/Svelte/
Angular runtime, rendering in its own thread, streaming DOM ops back to
the page.

The result is the thing micro-frontends always promised:

- **Real isolation**, a wedged MFE wedges its worker, not your page
- **Real independent deployment**, the worker bundle is a URL; ship it
  from npm or a CDN without touching the shell
- **Zero runtime tax**: the shell never imports or bundles the MFE's
  framework. A React shell hosting a Vue island loads *zero bytes of
  Vue*

## The trick: the shell imports a contract, not a component

Here's the part that makes it work. Instead of importing the MFE's
component tree, the shell imports a **framework-neutral contract**:
the MFE's entire public API in one dependency-free module:

```ts
// counter.contract.ts: the package's only export.
// No framework imports: runs on the main thread AND inside the worker.
import { z } from '@atolljs/core';
import { defineIslandContract } from '@atolljs/islands';

export const counterContract = defineIslandContract({
  app: 'counter',
  props: z.object({ label: z.string().optional() }),
  events: {
    incremented: z.object({ count: z.number(), label: z.string() }),
  },
  worker: () => new Worker(bundledWorkerUrl, { type: 'module' }),
});
```

Four fields: which app to register, what props it accepts, what events
it emits, and where its worker lives. The schemas aren't decorative:
the worker enforces them at runtime, so a producer that ships a prop
rename fails loudly with a schema error naming the field instead of a
silent `undefined` three teams away.

## The shell gets a real component anyway

From the consumer side it's just your framework, fully typed. React
shell:

```tsx
import { islandComponent } from '@atolljs/react-island';
import counterContract from '@atolljs/mfe-counter';

const CounterIsland = islandComponent(counterContract);

<CounterIsland
  label="alpha"                    // typed from the props schema
  onEvent={(name, payload) => {    // payload narrows per event name
    console.log(name, payload);    // 'incremented', { count, label }
  }}
/>
```

Vue, Solid, Svelte, and Angular shells get the same inference through
their own facades: `defineIslandComponent`, an injectable, whatever's
idiomatic. The types flow from the contract module, so the shell never
installs the worker's framework *or its types*.

And since the worker attaches the **same contract object**, the two
ends can't drift:

```ts
// counter.worker.tsx: inside the worker bundle
export default defineReactMonoWorker(CounterApp, {
  contract: counterContract,  // mount, updateProps, emit all validated
});
```

## The 5×5 matrix, with no glue code

The matrix that falls out of this is the fun part: **any supported
framework in the shell × any supported framework in the worker**: all
25 combinations ride the same op protocol. No per-pair adapters, no
glue code.

The repo proves it rather than claiming it:
[`examples/`](https://github.com/jwhenry3/atolljs/tree/main/examples)
has five shell apps, React, Vue, Solid, Svelte, Angular, each
mounting the same five worker-rendered MFEs written in all five
frameworks. Same API every time.

## Independent deployment is the actual product

This is where worker MFEs stop being a neat demo and start being an
architecture. A published MFE is **two artifacts in two lanes**:

```json
// package.json: the producer
{
  "exports": { ".": "./src/mfe/counter.contract.ts" },
  "files": ["src/mfe", "dist-mfe"]
}
```

- The **contract** is the module entry: consumers `import` it.
- The **worker** is a fetched asset: `dist-mfe/counter.worker.js`, one
  self-contained bundle from `vite build --config vite.mfe.config.ts`.

Two distribution shapes, both working end-to-end in the repo:

1. **npm package**: ship `dist-mfe/` inside the package. The
   contract's `new URL('../../dist-mfe/counter.worker.js', import.meta.url)`
   makes the consumer's bundler emit it **byte-for-byte**.
2. **CDN / remote origin**: point the contract's factory at your CDN.
   Versioned URLs mean the shell and the MFE upgrade on independent
   schedules: the whole point.

One gotcha worth knowing if you go remote: worker script URLs must be
same-origin (`new Worker('https://cdn…')` throws `SecurityError`
regardless of CORS). The escape is a one-line `blob:` shim that imports
the remote bundle: it's in the docs and the generated contract
template.

## Scaffolding, not boilerplate

You don't hand-write any of this:

```bash
# standalone publishable MFE package
atoll new my-mfe --framework react --mfe

# add an MFE to an existing project
atoll add mfe counter
```

That emits the contract, the worker, a self-contained publish build,
and a dev harness that mounts the island through its own contract, so
`vite dev` previews exactly what your consumers will see.

## Honest limits

This isn't free magic, so the caveats:

- Workers are **capability isolation, not a security boundary**:
  same-origin workers still share storage and can fetch. Great for
  untrusted-*ish* vendor widgets; not a sandbox.
- Cross-seam traffic is `postMessage`: cheap, but don't put
  per-mousemove state through it.
- If you have one team, one framework, one repo: skip the distribution
  machinery entirely. A plain `mountIsland` gets you the worker perf
  isolation without the packaging story.

## Try it

If "isolation and independent deployment" is why you wanted
micro-frontends in the first place:

- **Docs + live demos of all 25 combos:**
  [jwhenry3.github.io/atolljs/consumer/island-mfe](https://jwhenry3.github.io/atolljs/consumer/island-mfe/)
- **Repo:** [github.com/jwhenry3/atolljs](https://github.com/jwhenry3/atolljs)
  , the `mfe-publish` / `mfe-consumer` pair is a working
  publish-consume round-trip
- **npm:** [npmjs.com/org/atolljs](https://www.npmjs.com/org/atolljs)

Curious what breaks when you try this in your stack: drop a comment.

Source: the [islands guide](../islands.md), the
[micro-frontends guide](../islands-remote.md), and the full series
starting with [the runtime tax](microfrontends.md).
