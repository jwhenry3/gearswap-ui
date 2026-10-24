---
date: 2026-09-30
---

# Shipping SharedArrayBuffer

## COOP/COEP, cross-origin isolation, and what works without it

> **Problem.** `SharedArrayBuffer` silently disappears without
> `crossOriginIsolated`: code that worked in dev ships to production and
> finds `SharedArrayBuffer: undefined`.
>
> **Fix.** Two headers, `Cross-Origin-Opener-Policy: same-origin` and
> `Cross-Origin-Embedder-Policy: require-corp`, and everything that
> doesn't need SAB (islands, pools, dispatch) runs header-free anyway.

Here's the bug report every shared-memory project eventually gets: the
demo works locally, deploys fine, and in production `SharedArrayBuffer`
is `undefined` and nothing renders. That's `crossOriginIsolated`:
browsers gate SAB behind cross-origin isolation because shared memory is
a Spectre-class timing primitive.

The fix is two response headers:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Send both and `crossOriginIsolated: true`: SAB is live in-frame. Miss
either, or pull a third-party subresource that doesn't send CORP/CORS,
and isolation fails *silently*: the global just isn't there. The hosting
page in these docs carries the full header matrix, including iframe
embedding.

## What works anyway

The part that should make adoption *less* nerve-wracking, not more: the
capability requirement is narrower than the feature set.

- **Islands** render over plain `postMessage`: the `Atomics` doorbell
  is an optimization, not a dependency. Drop it and commits flush on the
  ordinary message channel; same DOM, zero headers.
- **Pools and task dispatch** need `postMessage`, full stop. Shared
  memory is the zero-copy fast path for *state*: you lose live
  `observe`/`watch` reads, not the compute.
- **Islands' fallback "poll mode"** replays ops with no shared state at
  all.

One line, then: **shared memory and `Atomics` reactivity are the fast
path, and they're gated; everything else ships to any static host.** If
you can set two headers you get the whole stack. If you can't, hosted
storefront, locked-down CDN, an iframe you don't control, the
degradation is graceful, not a blank page.

That's a deployment story you can put in front of a skeptical reviewer.

Source: the [cross-origin isolation guide](../cross-origin-isolation.md)
: deployment headers, iframe embedding, and the poll-mode fallback.
