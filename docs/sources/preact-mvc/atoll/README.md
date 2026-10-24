# Atoll: project documentation

In-repo documentation for `@atolljs/core` and its packages, written for
both developers and coding agents. **Agents: read the index below, then read
every doc relevant to your task before making extensive changes**: these
files encode non-obvious invariants (fixed-width memory layout, instance
scoping, bundler worker-detection rules) that are easy to violate.

The consumer-facing site (`docs-consumer/`) documents the published package
surface for end users. These docs cover the framework as it exists in this
repository: internals, contracts, and conventions.

## Reading map

| If you're working on… | Read |
|---|---|
| Anything (first contact) | [overview.md](overview.md), architecture, repo layout, how to run |
| `src/contract/`, memory layout, fields, codecs | [shared-memory.md](shared-memory.md) |
| `src/contract/reef.ts`, `listSchema.ts`, schema vocabulary, layout compilation | [reef.md](reef.md) |
| `src/pool/`, `src/worker/`, task dispatch | [tasks-and-pool.md](tasks-and-pool.md) |
| `src/reactive.ts`, `observable.ts`, `task.ts`, `log.ts` | [reactivity.md](reactivity.md) |
| `src/shared/`, SharedWorker host/client | [shared-worker.md](shared-worker.md) |
| COOP/COEP headers, iframe embedding, `SharedArrayBuffer` availability | [cross-origin-isolation.md](cross-origin-isolation.md) |
| `packages/islands/`, `mountIsland`, driver, op protocol | [islands.md](islands.md) |
| `packages/islands/src/worker/`, proxy DOM, instances, worker entries | [islands-worker.md](islands-worker.md) |
| `packages/*-island/`, Vue/Svelte/Solid/Angular worker renderers | [islands-frameworks.md](islands-frameworks.md) |
| `examples/mfe`, `examples/*-host`, inter-framework contract demos | [islands-worker.md](islands-worker.md) (Contracts) |
| Contract `worker` pointing at a CDN/remote bundle | [islands-remote.md](islands-remote.md) |
| `examples/mfe-publish` + `examples/mfe-consumer`, publish/consume pair | [islands-remote.md](islands-remote.md) |
| Writing a new `packages/<fw>` binding or `<fw>-island` renderer | [porting.md](porting.md) |
| `packages/cli`, the `atoll` scaffold/doctor bin | `packages/cli/README.md` |
| `packages/vite`: dev worker bundling (no refresh/HMR in workers) | [vite-plugin.md](vite-plugin.md) |
| `packages/devtools`, `app/` dashboard, `emitDevtools`/sink seam, `ATOLL_DEVTOOLS` forwarding | [devtools.md](devtools.md) |
| Dashboard outside `vite dev`, aggregate server hosting, production debugging | [devtools-deploy.md](devtools-deploy.md) |

Framework bindings: **frontend**:

| If you're working on… | Read |
|---|---|
| `packages/react`, `packages/react-island` | [frameworks/react.md](frameworks/react.md) |
| `packages/vue`, `packages/vue-island` | [frameworks/vue.md](frameworks/vue.md) |
| `packages/solidjs`, `packages/solid-island` | [frameworks/solid.md](frameworks/solid.md) |
| `packages/svelte`, `packages/svelte-island` | [frameworks/svelte.md](frameworks/svelte.md) |
| `packages/angular`, `packages/angular-island` | [frameworks/angular.md](frameworks/angular.md) |
| `packages/nextjs` | [frameworks/nextjs.md](frameworks/nextjs.md) |

Framework bindings: **backend**:

| If you're working on… | Read |
|---|---|
| `packages/nestjs` | [frameworks/nestjs.md](frameworks/nestjs.md) |
| `packages/node`, adapter, HTTP offload (clustering, gateway, housed APIs), cross-pool buffer sharing, Redis memory persistence | [frameworks/node.md](frameworks/node.md) |
| `examples/express`, `examples/fastify`, `examples/hono`, `examples/koa` | [frameworks/node-backends.md](frameworks/node-backends.md) |
| `examples/nextjs/src/app/api/`, server-side pools in route handlers | [frameworks/nextjs.md](frameworks/nextjs.md) (server section) |

## Core concepts (read in order)

1. [overview.md](overview.md): the three layers: contracts, worker pair, reactivity
2. [shared-memory.md](shared-memory.md), `defineSharedMemory`, `field.*`, connectors
   · [reef.md](reef.md), the fixed-width schema vocabulary (`reef.*`), layout
   compilation, zod interop
3. [tasks-and-pool.md](tasks-and-pool.md): `defineWorker`/`connectWorker`, services, pool config
4. [reactivity.md](reactivity.md): `observe`/`watch`/`reactive`, `defineTask`, logging
5. [shared-worker.md](shared-worker.md): one worker + buffer across tabs/iframes
6. [cross-origin-isolation.md](cross-origin-isolation.md): when SAB exists at all

## Islands (off-main-thread rendering)

- [islands.md](islands.md), vocabulary (Atoll/PolyWorker/MonoWorker/Island), `mountIsland`, topologies, transport modes
- [islands-worker.md](islands-worker.md), app kinds, proxy DOM, `installDomShim`, `emit`/`callbackProp`/`Slot`, instance discipline, testing
- [islands-frameworks.md](islands-frameworks.md), the `*-island` packages, mixed registries, bundle composition, real-library limits
- [islands-remote.md](islands-remote.md), worker bundles served from another origin (CORS/COEP, versioned URLs, contract pairing)

## Deferred work

- `docs/plans/`: non-binding roadmap and idea capture (deferred use cases,
  tools not yet designed). Consult when planning features; unlike the rest
  of `docs/` these do **not** describe the code as it exists.

## Conventions for agents

- Prefer linking file paths (`packages/islands/src/island.ts`) over copying
  source: the files are the truth; these docs describe behavior and invariants.
- When you change a documented API or invariant, update the corresponding doc
  in the same change.
- `packages/*/README.md` files are the per-package contract: keep them and
  these docs consistent.
