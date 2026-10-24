---
date: 2026-10-04
series: Micro-frontends
---

# Where Worker-rendered MFEs Pay Off

## Use cases, and the honest limits

> **Problem.** "Micro-frontends" is a solution looking for a use case
> half the time: teams adopt the architecture for the org chart and
> pay the runtime cost everywhere. Knowing when worker isolation is the
> *point* versus overhead is the difference between a platform and a
> pile of iframes.
>
> **Fix.** Reach for worker MFEs where isolation, polyglot freedom, or
> CPU-hungry widgets are the actual requirement, and keep ordinary
> islands (or plain components) for everything else.

The previous three posts covered *how*: worker isolation, the
contract, distribution. This one is about *when*, including when not
to bother.

## The strangler: migrating off a legacy shell

The most common real use case isn't polyglot-for-fun: it's
*escape velocity*. An AngularJS-era or Vue 2 app that can't be
rewritten wholesale gets a new shell, and each feature area migrates
behind a contract one at a time. The contract gives the migration a
stable seam: the shell mounts `islandComponent(contract)` and doesn't
care whether the worker behind it is the old framework or the new one.
Rewrites become swaps: the contract stays fixed while the
implementation changes teams, frameworks, and deploy cadence
underneath.

## Genuinely separate teams

Independent release cadence is the classical MFE justification, and it
holds up *when the cadence is real*. A platform org shipping a shell
that hosts widgets from five product teams gets two concrete wins from
the worker shape:

- **Versioned contracts**: the schema'd props/events are the
  compatibility surface; a producer bumping a prop type fails the
  consumer's typecheck, and a mismatch at runtime fails with a schema
  error naming the field instead of a silent no-op.
- **Blast radius**: a broken widget wedges its worker, not the page.
  `destroy()` is a `worker.terminate()` away; there's no shared DOM,
  no shared store, no CSS-less shadow DOM conventions to negotiate.

## Third-party and untrusted-ish widgets

A vendor widget running in your page has your page's capabilities:
same `window`, same DOM. Running it in a worker narrows the surface
considerably: it can only touch the DOM through the op stream, it
can't read other islands' proxies (`app@N` scoping), and it can't
monkey-patch the shell's globals because they aren't in its realm.
It's not a security boundary, same-origin workers still share storage
and can fetch, but it's a meaningful capability reduction for "we
embed a partner's widget and would prefer it didn't reach into our
app."

## CPU-hungry components

The perf case predates the MFE case: a charting surface, a Monaco-like
editor, a table over a million rows. In a worker, render cost lands
off the main thread: the page keeps compositing while the island
grinds. Wrap that in a contract and the heavy component *is* an MFE:
independently versioned, maybe even a different framework chosen for
the job (Solid's fine-grained updates for a ticker, React for a form
builder), with no cross-team coordination beyond the schema.

## Plugin surfaces

An extension point is an MFE with extra steps: the host defines a
contract, plugins implement workers against it, and the host's UI is
just a list of `islandComponent(contract)` mounts. The schema's
runtime validation matters more here than anywhere: you can't
typecheck a plugin you don't control, so `updateProps` failing with a
schema error is the honest version of "the host API changed."

## When *not* to bother

Honest limits, because the architecture isn't free:

- **One team, one framework, one repo**: skip the contract and the
  publish pipeline; `mountIsland` / `islandComponent` with a local
  worker entry gets you the perf isolation without the distribution
  machinery.
- **Tight UI coupling**: MFEs communicate through serializable
  props/events. A widget that needs to share a text selection, drag
  state, or a thousand-datum hover sync with the shell is fighting the
  boundary; shared memory helps for bulk state but not for
  frame-synchronous gestures.
- **Content-heavy pages**: islands render in workers, so SSR/SEO for
  MFE content means prerendering the shell around them, not streaming
  the island itself. If the *content* must be in the HTML, that's a
  different architecture.
- **Latency-critical interactivity in the seam**: every
  `updateProps`/`emit` is a `postMessage` round-trip. Cheap, but not
  free; don't put per-mousemove traffic across it.

The shape of the rule: if the isolation is the requirement, worker
MFEs earn their weight, and the contract + publish pipeline in
`examples/mfe-publish` is the working template. If it isn't, a local
island (or just a component) is less code.

Source: the [islands guide](../islands.md), the
[micro-frontends guide](../islands-remote.md), and the series'
first post on [the runtime tax](microfrontends.md).
