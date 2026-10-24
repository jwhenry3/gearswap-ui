---
date: 2026-09-26
series: Islands
---

# Islands That Render in Workers

## Real framework components, off the main thread

> **Problem.** Heavy components, a million-row table, say, block the
> main thread on every render. "Move it to a worker" normally means giving
> up your framework's renderer and hand-syncing the DOM.
>
> **Fix.** Islands: the component itself runs in the worker under its real
> framework, commits serialize to an op stream, and `mountIsland` replays
> them into a container. The main thread never renders.

"Islands" in this industry usually means small interactive widgets in a
mostly-static page: a like button here, a date picker there. A fine
pattern that's answering the wrong question for CPU-bound UI.

The better question: what if the *component itself*, the React render,
the Vue reactivity, the Svelte compiled output, ran inside a worker?
Not a shadow of it; the real renderer. With only DOM diffs crossing to
the main thread?

That's what the islands engine is. The entire main-thread API:

```ts
import { mountIsland } from '@atolljs/islands';

const island = await mountIsland({
  worker: () => new Worker(
    new URL('./render.worker.ts', import.meta.url), { type: 'module' },
  ),
  el: document.getElementById('island')!,
  app: 'dashboard',
  props: { /* cloneable */ },
  onEvent: (name, payload) => { /* island → shell emit() */ },
  slots: { preview: (el) => mountCanvas(el) }, // transclusion holes
});
island.updateProps({ theme: 'dark' });
island.destroy();
```

Inside that worker a *real* framework renders: React, Vue, Solid,
Svelte, Angular. Not a DSL, not a subset. The repo's benchmark mounts
the same million-record incident table in all five; the worker does the
render and the virtualization while the main thread stays free to type
and scroll.

## Worker shapes, because one size doesn't fit all

- **MonoWorker**: one worker, one app. The simplest entry.
- **PolyWorker**: `definePolyWorker({ apps })`: several islands sharing
  one worker, one module graph, one framework runtime. The
  bundle-optimization shape.
- **Shared clients**: `connectIslandWorker({ worker })` mounts several
  islands on one worker; the client releases when its last island
  destroys.

Every mount gets an `app@N` instance key that scopes its op queue, proxy
document, and events: two counters on the same worker can't see each
other's DOM.

And because this is Atoll, worker components read the same shared memory
your tasks write: the UI isn't off in a message-passing silo, which is
what separates this from every "render worker" experiment that ends at
a tech demo.

Next post: the proxy document that makes this possible.

Source: the [islands engine guide](../islands.md) and the
[framework bindings reference](../islands-frameworks.md).
