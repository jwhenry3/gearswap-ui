---
date: 2026-10-02
series: Micro-frontends
---

# The Contract Is the MFE

## A framework-free module between producer and consumer

> **Problem.** Cross-team MFE integration drifts on types: the shell
> guesses prop names, event payloads get `any`, and "the API is whatever
> the component happens to accept": discoverable only by reading the
> producer's source, which you shouldn't have to import.
>
> **Fix.** Publish a framework-neutral contract module. It carries the
> app key, `z` schemas for props and events, and a worker factory:
> nothing else. The shell imports *that*; its own framework's facade
> derives the typed component surface at compile time.

Once an MFE lives in a worker, the question "what does the shell
import?" gets an interesting answer: *not the component*. The component
, plus its entire framework, is inside the worker bundle, which the
browser fetches as an asset. What the shell imports is a contract:

```ts
// counter.contract.ts: the package's ONLY export.
// No framework imports: this file runs on both threads.
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

That's the whole public API: four fields:

| Field | What it pins down |
|-------|-------------------|
| `app` | the registry key the worker registers under, shell and worker must agree |
| `props` | a `z` schema; the *worker* validates props on mount and every `updateProps` |
| `events` | named `z` schemas; `emit('incremented', payload)` validates against the declared schema inside the worker |
| `worker` | a factory returning the `Worker`, local source entry in dev, prebuilt asset or remote origin when published |

Two properties are worth noticing. First, the schemas aren't just for
type derivation: they're enforced at runtime, *inside* the worker, on
the trust boundary where a shell from another team actually needs
validation. A producer that ships a prop rename breaks with a schema
error naming the field, not a silent `undefined`.

Second, `worker` is a *factory*, so the deployment shape is a consumer
decision. Same contract can point at a bundled dev entry, a
package-relative prebuilt artifact, or a CDN origin: the producer
doesn't have to know which.

## The shell's side

Each supported framework has a facade that turns the contract into an
idiomatic component: `islandComponent` for React:

```tsx
import { islandComponent } from '@atolljs/react-island';
import counterContract from '@atolljs/mfe-counter';

const CounterIsland = islandComponent(counterContract);

<CounterIsland
  label="alpha"                                  // typed from props schema
  onEvent={(name, payload) => {                 // name: 'incremented'
    // payload: { count: number; label: string } // typed per event
  }}
/>
```

`label` is optional-string because the schema says so; `payload`'s
shape narrows per event name because the events map says so. All of it
flows from the contract module: the shell never imports worker source
and doesn't need the worker's framework installed. A Vue shell gets
`defineIslandComponent(contract)` with the same inference; Angular
types the contract through an injectable.

And the worker side attaches the *same* contract object, so the two
ends can't drift on the `app` key or drift on schemas:

```ts
// counter.worker.tsx: inside the worker bundle
export default defineReactMonoWorker(CounterApp, {
  contract: counterContract,   // mount, updateProps, emit all validated
});
```

One module, imported by both sides, checked by the compiler on the
shell side and enforced by the runtime on the worker side. That's the
whole seam, and it's the artifact you version.

Next post: [shipping the worker bundle: npm vs CDN](mfe-publishing.md).

Source: the [micro-frontends guide](../islands-remote.md) and
`examples/mfe-publish` + `examples/mfe-consumer` in the repo.
