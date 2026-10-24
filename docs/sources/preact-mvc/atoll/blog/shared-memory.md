---
date: 2026-09-22
series: Inside Atoll
---

# Shared Memory Is a Contract, Not a Buffer

## Why AtollJS's `SharedArrayBuffer` layer starts with a schema

> **Problem.** `SharedArrayBuffer` gives you raw bytes and nothing else:
> byte offsets duplicated across thread boundaries drift silently, and the
> first mismatched constant is a corruption bug that throws nothing.
>
> **Fix.** Declare the layout once, as a schema: `defineSharedMemory`
> compiles a deterministic fixed-width layout that both threads import,
> so the two sides can't disagree.

If you've ever allocated a `SharedArrayBuffer` and then written
`Float64Array` offsets into a comment so both files agree: you already
know the failure mode this post is about.

`postMessage` at least serializes for you: slow, but correct. Raw
shared memory is fast *and* gives you nothing to keep the two sides
honest. The platform hands you a slab of bytes; the layout, the
versioning, the cross-thread agreement are yours to invent. Most code
invents it as constants in two files that drift the first time someone
adds a field.

AtollJS makes the layout a type. This is `defineSharedMemory`:

```ts
export const incidentsMemory = defineSharedMemory({
  lists: {
    incidents: field.list({
      schema: reef.object({
        id: reef.u32(), severity: reef.int(0, 3), status: reef.int(0, 2),
        site: reef.string(10), /* … */
      }),
      count: 1_000_000,
    }),
  },
  signals: { seedProgress: field.number() },
});
```

One declaration, imported by the main thread and every worker. The spec
compiles to a deterministic byte layout: same offsets everywhere,
because there's only one source of them. Fork it and you're back to
comments; import it and drift is impossible.

## Fixed width is the feature

A `SharedArrayBuffer` can't grow, so every field is fixed-width: which
sounds like a limitation until you see what it composes into:

| Field | Storage |
|---|---|
| `field.number()` | 8-byte `f64` |
| `field.string({ schema })` | length header + inline UTF-8, budget from `reef.string(n)` |
| `field.array({ schema })` | count + bounded inline elements |
| `field.list({ schema, count })` | fixed-layout record array |

`reef.object` members are fixed-width, so a million-record `field.list` is
a flat array of structs: `readAt(i)` and `writeAt(i)` are pointer
arithmetic, not parsing. The benchmark island scans and sorts a million
incidents through this layout. There's no decode step because there's
nothing to decode.

And every field carries a version counter: the mechanism the reactivity
post builds on.

## What the contract buys you

- **Zero-copy reads.** `read()` on a typed-array field hands back a live
  view. State never crosses `postMessage`.
- **One source of truth.** Both threads speak the same layout because
  they import the same object.
- **Introspection.** `memory.fields()` reports `{path, byteOffset,
  byteLength}` for every slot: powering debugging and the Redis
  adapter's field-by-field mirroring covered in the server-side posts.

The takeaway: the buffer is plumbing; the *contract* is the API. Pools,
reactivity, islands, persistence: everything else in this framework
stands on that single sentence.

Source: the [shared-memory guide](../shared-memory.md) and the
[reef schema reference](../reef.md); the persistence half lands in
[the Node.js docs](../frameworks/node.md).
