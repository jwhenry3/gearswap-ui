# Next.js: `@atolljs/nextjs`

Read when: working on `packages/nextjs/` or `examples/nextjs/`.

The Next.js story is two-sided:

- **Client**: `@atolljs/nextjs` re-exports the React hooks for App Router
  apps, packaged so client components import them under a `'use client'`
  boundary while server components never touch `Worker`. Source:
  `packages/nextjs/src/index.ts`. Example: `examples/nextjs/src/useIncidents.ts`,
  `examples/nextjs/src/IncidentsApp.tsx`.
- **Server**: route handlers run on Node, so `@atolljs/node` works inside
  them: `createNodePool`/`createNodeWorker` give a handler its own
  `node:worker_threads` pool with a shared buffer readable on the API
  thread. Example: `examples/nextjs/src/app/api/atoll/`: `POST` dispatches
  a CPU-bound hash task; `GET` reads `jobsDone` from shared memory with zero
  dispatch. The `globalThis` singleton survives dev-mode HMR re-evaluation.

  The example carries the pattern further: `api/jobs/` is a fire-and-forget
  job queue whose progress counters live in shared memory, `api/incidents/`
  is a read-model API serving the 1M-record buffer directly off the API
  thread, and `src/instrumentation.ts` warms every pool (plus the incidents
  seed) in Next's `register()` boot hook. The consumer docs cover each as a
  sub-page under Backend → Next.js.

| Export | Signature | What it does |
|---|---|---|
| `useObservable` | `useObservable(source: ObservableValue<T>): T` | Subscribe to any observable snapshot (task or field). |
| `useSharedValue` | `useSharedValue(memory, key, select?, options?): T \| undefined` | Bind one shared-memory field to React state; optional selector + equality to slice updates. |
| `useTask` | `useTask(task \| asyncFn): { data, pending, settled, elapsedMs, error, run, runOnce }` | Bind an AsyncTask, or any async fn (e.g. a client method, wrapped via `toTask`): to state and get its triggers. |

```tsx
'use client';   // required: the hooks read browser-side state

import { useSharedValue, useTask } from '@atolljs/nextjs';
import { counterMemory } from '../counter.memory';
import { counter } from '../counter';   // connectWorker client: safe to import under SSR

export function Counter() {
  const count = useSharedValue(counterMemory, 'count');
  const increment = useTask(counter.increment);  // client method → latest-wins task
  return <button onClick={() => increment.run(1)}>count: {count ?? '…'}</button>;
}
```

Notes:

- Components using the hooks carry the `'use client'` directive: the app
  boundary component is the edge; `app/page.tsx` can stay a server component
  that just renders it.
- Importing the `connectWorker` client is SSR-safe: the pool spawns lazily on
  the first method call, never during a server render.
- The COOP/COEP `headers()` in `next.config.ts` are only needed when the pool
  uses `sharedMemory`: a message-only pool needs neither the headers nor
  `SharedArrayBuffer`.
- Next.js is server-rendered, so it isn't copied into the unified `dist/`
  tree: `next start` serves it on its own port (`serve:all` runs it
  alongside the static bundle).
- **Not part of the GitHub Pages artifact.** `scripts/assemble-pages.mjs`
  mounts only static `dist/` builds; a static host can't render a Next.js
  app or answer its route handlers, so the docs site's embedded demo frame
  is blank there by design. Run `npm run dev` in `examples/nextjs/` or
  `npm run serve:all` to see it live.
- Deploying for real means a Node runtime (`next start`, a Node host,
  Vercel). `output: 'export'` produces static HTML, client components
  still hydrate and client-side pools still spawn, but route handlers are
  dropped and `next.config.ts` `headers()` is not emitted, so a
  shared-memory pool needs the host (or a COI service worker, see
  [cross-origin-isolation.md](../cross-origin-isolation.md)) to send
  COOP/COEP. A message-only pool needs neither.
