---
date: 2026-10-01
series: Micro-frontends
---

# Micro-frontends Without the Runtime Tax

## Why the shell shouldn't ship the MFE's framework

> **Problem.** The classical micro-frontend pitch, "teams ship
> independently, each in their own framework", quietly means every
> framework runtime lands on the same main thread, in the same module
> graph, contending for the same event loop. Two frameworks in one page
> is a curiosity; five is a tax you pay per keystroke.
>
> **Fix.** Put each MFE in a worker. The shell imports a
> framework-neutral *contract*, not the component, so the MFE's
> framework runtime lives only inside the worker bundle, and the page
> carries exactly one framework: the shell's own.

Micro-frontend architecture has always had an asterisk. Module
federation, import maps, iframe sandwiches: the orchestration differs,
but they share a constraint: every MFE's renderer runs on the host
page's main thread. Pick Angular for one widget and Vue for another and
the "independent teams" story quietly becomes "every user loads every
framework, and they all fight over the same 16ms frame budget."

The teams that accept this do it for a real reason: the isolation is
what they're buying, not the polyglot party trick. Separate release
cadence, separate ownership, a widget that can't take the page down
when it crashes. The polyglot part is almost an accident.

Worker-rendered islands flip the cost structure. The MFE isn't a module
the shell imports and renders: it's a *worker the shell spawns*. Its
framework, its reactivity, its render loop all live behind the
`postMessage` boundary; only serialized DOM ops cross back:

```
shell (React)                worker
─────────────                ──────────────
islandComponent(contract) →  real Vue app renders
  ↕ DOM op stream               ops serialize out
props in / events out        ↓ mountIsland replays
                             into a <div>
```

Three properties fall out of that shape:

- **The shell bundles no foreign framework.** A React shell hosting a
  Vue island loads zero bytes of Vue: it's in the worker bundle,
  invisible to the page's module graph.
- **Crash isolation is real.** A wedged MFE wedges its worker. The
  shell notices a dead island; the rest of the page keeps compositing.
- **The integration surface shrinks to data.** Props in, events out:
  both schema-validated. There's no shared `window`, no shared store,
  no import of the MFE's component tree to type-check against.

The consequence that matters for polyglot architectures: "any supported
framework in the shell × any supported framework in the worker" is a
25-cell matrix that all runs through the same op protocol: no
per-pair glue code. This repo's examples mount five MFEs written in
five frameworks inside five different shells, through the same API.

None of this makes coordination free: versioned deploys, shared
design tokens, and "who owns the header" remain organizational
problems. But the runtime tax, five frameworks on one thread, is
gone, because only one of them ever executes there.

Next post: [the contract that makes the boundary typed](mfe-contract.md).

Source: the [islands engine guide](../islands.md) and the
[remote-worker guide](../islands-remote.md).
