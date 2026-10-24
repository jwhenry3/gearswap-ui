# Reef: the fixed-width schema vocabulary

Read when: working on `src/contract/reef.ts` or `src/contract/listSchema.ts`,
declaring schemas for `field.list`/`field.object`/`field.array`/`field.string`,
or debugging "can't lay out" compile errors.

`reef` is the structural barrier between a declared schema and the raw
buffer. Every helper mints a schema that does two jobs at once: the
layout compiler reads its `_zod.def` to derive a byte width, and `.parse`
enforces the declared domain at the write boundary. One declaration is both
the shape of the record and the shape of its bytes: there is no second place
where the layout is expressed.

The schemas come from a vendored engine (`src/contract/zod.ts`) that speaks
zod v4's definition vocabulary, `def.type`, `def.format`, `def.checks`,
`def.shape`, `def.element`, so the layout compiler reads atoll-minted and
consumer-supplied zod schemas through the same duck-typed surface. No zod
package ships with the SDK.

## Scalar helpers

All ten scalar storage kinds have one spelling. int32/uint32/float32/
float64/int64/uint64 are format-tagged; reef fills the gaps with bounded
ints the compiler narrows identically.

| Helper | Output | Storage | Domain enforced |
|---|---|---|---|
| `reef.i8()` / `reef.u8()` | `number` | 1 byte | −128..127 / 0..255 |
| `reef.i16()` / `reef.u16()` | `number` | 2 bytes | −32768..32767 / 0..65535 |
| `reef.i32()` / `reef.u32()` | `number` | 4 bytes | int32 / uint32 range |
| `reef.i64()` / `reef.u64()` | `bigint` | 8 bytes | int64 / uint64 range |
| `reef.f32()` / `reef.f64()` | `number` | 4 / 8 bytes | float |
| `reef.int(min, max)` | `number` | narrowest covering kind | `min..max` |
| `reef.boolean()` | `boolean` | flag byte |: |
| `reef.string(bytes)` | `string` | `bytes` inline UTF-8 | UTF-8 length ≤ `bytes` |

`reef.int(min, max)` declares the *domain*; the compiler picks the narrowest
covering width: `reef.int(0, 3)` stores as `u8` while still rejecting `9`.
Declared bounds can be stricter than storage, never looser.

## Composers

| Helper | Produces | Consumed by |
|---|---|---|
| `reef.object(shape)` | fixed-layout record schema | `field.object({ schema })`, `field.list({ schema, count })` |
| `reef.array(el)` | fixed-stride element schema | `field.array({ schema })`: must be bounded with `.max(n)` or `.length(n)` |
| `reef.string(n)` | inline string schema | `field.string({ schema })`, record members |

```ts
const metricsSchema = reef.object({
  total: reef.f64(),
  open: reef.u32(),
  flag: reef.boolean(),
  tag: reef.string(8),
});

export const memory = defineSharedMemory({
  state: { metrics: field.object({ schema: metricsSchema }) },   // one inline record: no maxBytes
  lists: { rows: field.list({ schema: metricsSchema, count: 1_000_000 }) },
});
```

`reef.object` members are themselves fixed-width members: nested
`reef.object` is *not* supported (a record's member must compile to a scalar
or inline string; see rejections below).

## How members compile

`memberToSpec` (`src/contract/listSchema.ts`) reads `schema._zod.def` and maps
each member to a binary spec: this is the table both `reef` helpers and
consumer-supplied zod schemas go through:

- **number formats**: `int32`/`uint32`/`float32`/`float64` (classic or mini)
  map to `i32`/`u32`/`f32`/`f64`.
- **bounded safeints**: `z.number().int().min(a).max(b)` narrows
  narrowest-first, unsigned-preferred: `u8 → i8 → u16 → i16 → u32 → i32`,
  falling back to `f64` when no bound covers.
- **bigint formats**: `int64`/`uint64` → `i64`/`u64`; bare `z.bigint()` → `i64`.
- **boolean** → `{ bool: true }` (flag byte).
- **string** → `{ string: n }` where `n` comes from the `bytes` metadata:
  `reef.string(n)` registers it automatically; a plain zod string needs
  `.meta({ bytes: n })`.
- **spec tokens**: `'u32'`, `{ string: 10 }`, `{ bool: true }` are still
  accepted directly in member maps (e.g. via `listSchema`).

## Mixing consumer zod

`reef` schemas are atoll-minted, but the compiler is duck-typed on
`_zod.def`: consumers can pass classic `zod` or `zod/mini` schemas anywhere
a schema is accepted, and they introspect identically:

```ts
import { z } from 'zod';
reef.object({ id: z.uint32(), level: z.number().int().min(0).max(3), tag: reef.string(8) });
```

Composition is directional: consumer zod members mix *into* reef containers
fine, but a reef schema can't be a member of a *real* `z.object`/`z.array`:
zod dispatches element parsing through its own `_zod.run` internals, which a
vendored schema doesn't implement. When a wire schema needs a reef value,
compose with `reef.object`/`reef.array` instead. `instanceof z.ZodType` is
false for reef schemas: check `typeof s.parse === 'function'` and
`s._zod.def`, or accept the `Schema<T>` interface.

## The fluent surface

Every schema `reef` mints (and `memory.schemas` derivatives and
`listSchema` results) carries the classic chain spellings via `fluent()`
(`src/contract/zod.ts`):

- `.refine(fn, msg?)`, `.min(v)`, `.max(v)`, `.length(n)`, `.int()`:
  appended through `.check()`, so `def.type` survives (a refined
  `reef.string` still lays out as a fixed-width string; `.min`/`.max`
  dispatch to `minLength`/`maxLength` on sized kinds, `gte`/`lte` on numbers).
- `.meta()` reads, `.meta(m)` writes: backed by the engine's registry.
- `.check()`, `.register()`, `.parse()`, `.safeParse()`, `.shape` (objects)
  are the underlying schema surface.

Checks that change layout-relevant facts (`.min`/`.max` on a bounded int,
`.meta` adding `bytes` to a string) are read back by the compiler on the
returned schema: chain freely, the final schema is what's compiled.

## What can't be fixed-width

Compile fails loudly rather than guessing a width:

- `z.date()`, `z.enum()`, `z.object` members nested inside a record,
  `z.union()`, etc. → `member "x": zod "..." can't lay out as a
  fixed-width scalar`.
- A string member with no byte budget → ``member "x": z.string() needs
  .meta({ bytes: n })`` (raw `zod/mini` strings can't carry the meta to the
  vendored registry: use `reef.string(n)` or a classic `.meta()` string).
- `field.array({ schema })` with an unbounded `z.array` → `z.array() needs
  .max(n) or .length(n)`; a non-fixed-width element → `element isn't a
  fixed-width member: use field.list for arrays of records`.
- `field.list` with a non-object schema → `schema must be a reef.object() of
  fixed-width members`.

Dynamic payloads (arbitrary JSON, maps, optionals) go through the codec
escape hatch instead: `field.object({ maxBytes })` / `field.array({ maxBytes })`
/ `field.string({ maxBytes })` encode with the contract's codec: the schema
is then optional validation, not layout.

### Message-domain kinds

`@atolljs/core` also exports the raw engine as `z`, the zod/mini-style
schema layer reef is built on, extended with layout-free kinds for
contracts that ride `postMessage` instead of the buffer
(`defineIslandContract` prop/event schemas; see
[islands.md](islands.md#island-contracts)):

- `z.optional(inner)`, `z.nullable(inner)`: wrapper members; in
  `z.object` shapes an optional-output member produces an optional key
  (`{ label?: string }`).
- `z.literal(v)`, `z.union([members])`, `z.record(element)`: value
  equality, first-match unions, elementwise maps.
- `z.callback<F>()`: declares a `callbackProp` function member; the wire
  `{__cb:id}` handle is unmarshalled to a callable BEFORE schema parse, so
  parse sees a real function.
- `z.unknown()` accepts anything.

These kinds have no byte width: inside a `field.*`/`reef.object` layout
they fail compilation loudly, which is correct: they only ever ride the
message channel. `fluent` schemas also gain `.optional()`/`.nullable()`
wrappers; bare `z` members use the `z.optional(...)` factory (zod/mini
spelling).

## `listSchema` and `memory.schemas`

`listSchema({ id: 'u32', site: { string: 10 } })` builds the same record
schema from *token* members: the shape you would otherwise hand-write as
`reef.object({...})`; token members get storage-bounded schemas (e.g. `'u8'`
→ 0..255) so validation catches out-of-range writes at the boundary.

`memory.schemas.<path>` exposes the field's schema: the declared one for
schema-backed fields, or a derived scalar/object schema for token-declared
fields (`field.number()` → `f64` schema, `field.list` token members → a
built object schema). All carry `.parse`/`.safeParse` and the fluent
spellings.

## Bundle surface

`reef` runs on the vendored schema engine: zod is not an `@atolljs/core`
dependency, so the contract layer contributes a few kB of first-party code
and zero external bytes. `preserveModules` keeps it separable: no
`reef`/`listSchema` import → no schema code in the consumer's bundle at all.
Consumer-side schemas may still be classic zod or `zod/mini`: the layout
compiler introspects them through `_zod.def`, from whatever they already
have installed.
