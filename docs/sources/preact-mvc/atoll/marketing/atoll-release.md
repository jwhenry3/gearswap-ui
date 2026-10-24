# LinkedIn: Introducing AtollJS

Launch/announce post adapted from [`../blog/introducing-atoll.md`](../blog/introducing-atoll.md).
Copy the block between the rules verbatim: LinkedIn renders no markdown,
so the emojis and line breaks are the formatting.

---

**Web workers are the only real threads the browser gives you, and for 15 years the platform handed you `Worker`, `postMessage`, and `SharedArrayBuffer`… with zero structure on top.**

So most apps use them the same way: post a function some data, await the result. That works: until the work isn't a function call. A million-row scan. A UI tree re-rendering every frame. State both threads need *live*, not cloned-and-stale.

I built **AtollJS** to make the thread boundary a contract. Four layers:

🧩 **Shared memory as a schema**: `defineSharedMemory` compiles a typed spec into a deterministic byte layout. One declaration imported by both threads: they can't drift, because there's only one source of offsets.

📞 **Worker calls as method calls**: `connectWorker` gives you a typed proxy over a lazily-spawned pool. Queueing, timeouts, cancellation, crash respawn: a pool call always settles.

⚡ **Results as reactivity**: `observe()` a shared field and components re-render when the worker writes it. The diff flows through a version counter, not a message.

🏝️ **UI rendered inside the worker**: React, Vue, Solid, Svelte, and Angular components run off-thread against a proxy DOM and stream serialized ops back. The shell stays a thin facade; island chunks only load when they mount.

And on the server nothing changes: `@atolljs/nestjs` puts the pool behind real DI: each worker boots its own Nest application context.

Same discipline at every layer: **declare once, in types both threads share.**

Docs + live demos: https://jwhenry3.github.io/atolljs/
Scaffold an app in one command: `npx @atolljs/cli new`

#typescript #javascript #webdev #webworkers #reactjs #nodejs

---

## Teaser variant (short post)

Workers give browsers real threads but no structure: AtollJS makes the
boundary a typed contract: shared memory as schema, pools as proxies,
reactivity over fields, whole framework trees rendered inside workers.

Docs + live demos → https://jwhenry3.github.io/atolljs/
