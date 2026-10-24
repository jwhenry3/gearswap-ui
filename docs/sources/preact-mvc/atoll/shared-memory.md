# Shared memory contracts

Read when: working on `src/contract/`, adding/changing field kinds,
debugging layout or codec behavior.

`defineSharedMemory(spec, options?)` declares a fixed, deterministic layout
over a `SharedArrayBuffer`. Both threads import the same object; the pool
binds it on the main thread and the worker bootstrap binds it inside workers:
identical memory on both sides. Reference contract:
`packages/incidents/src/contract/memory.contracts.ts`.

## Field kinds

| Factory | Type | Storage |
|---|---|---|
| `field.number()` | `number` | 8 bytes (f64) |
| `field.boolean()` | `boolean` | 1 byte stored, descriptor reserves 8 |
| `field.string({ maxBytes })` · `field.string({ schema })` | `string` | 4-byte length + inline UTF-8, budget derives from `reef.string(n)` |
| `field.object({ schema })` | `T` | inline fixed record, width derives from `reef.object(...)` members |
| `field.object({ maxBytes, schema? })` | `T` | 4-byte length + codec-encoded payload |
| `field.array({ schema })` | `T[]` | count header + bounded inline elements: from `z.array(el).max(n)` |
| `field.array({ maxBytes, schema? })` | `T[]` | same, codec-encoded |
| `field.int32Array({ length })` / `float64Array` / `bigInt64Array` / `uint8Array` | typed array | raw view, `read()` is zero-copy |
| `field.list({ schema, count })` | record array | fixed-layout records, `schema` is a `reef.object` of fixed-width members (`reef.u32()`, `reef.string(10)`) |

## Intent groups

Spec fields may nest one level under an intent group: the incidents contract
uses `lists` (record arrays scanned in workers), `state` (codec-encoded
snapshots), and `signals` (reactive scalars). The group is purely declarative:
allocation is a flat layout underneath, and every surface mirrors the nesting:
`memory.state.metrics`, `memory.spec.state.metrics`,
`memory.schemas.state.metrics`, and observers addressed by path
(`observe(memory, 'signals.seedProgress')`).

## The `reef` datatype wrapper

Every shared-memory value is fixed-width: a `SharedArrayBuffer` cannot
resize, so strings and encoded objects declare byte budgets and list members
compile to scalar widths. `reef` is the curated fixed-width vocabulary:
`reef.u8()`-`reef.u64()`, `reef.f32()`/`reef.f64()`, `reef.int(min, max)`,
`reef.boolean()`, `reef.string(bytes)`, and the `reef.object`/`reef.array`
composers. Each mints a schema: layout and validation come from
the same declaration (see [reef.md](reef.md) for the vendored engine and
consumer-zod interop).

Fixed width composes upward: `field.object({ schema })` with a `reef.object`
stores one inline record (byteLength is derived: there is no `maxBytes` to
guess), `field.array({ schema })` with a bounded `z.array(el).max(n)` stores a
count + inline elements, and `field.string({ schema })` reads its budget from
`reef.string(n)`. `maxBytes` remains the escape hatch for payloads no fixed
width can describe: its presence selects the codec path.

## Connectors

Every field exposes a `Connector<T>`: `read()` / `write(v)`, plus a shared
*version counter* bumped by `Atomics` on each write. That's how the other
thread observes changes without messages.

List fields return a `ListConnector<R>` with record-level access:
`readAt(i, out, fields?)`, `writeAt(i, record)` (partial writes supported via
a field list), and `commit()` to bump the version counter after a batch:
`writeAt` is intentionally pure memory access.

## Codecs and schemas

Structured fields encode through the contract's codec: `msgpackrCodec` (the
default: MessagePack with structure sharing, the fastest option for uniform
records) or `jsonCodec`. Optional zod schemas (`listSchema`,
object/array `schema` options) validate values at the boundary. Every field
also surfaces its schema on `memory.schemas.<name>` and its descriptor on
`memory.spec.<name>`: list members may be zod schemas directly
(`z.uint32()`, bounded `z.int().min().max()`,
`z.string().meta({ bytes: n })`), which compile to the same layout while
carrying their own validation. Register custom field kinds globally with
`registerConnectorFactory(kind, factory)` or per contract via
`SharedMemoryOptions.plugins`.

## Custom connectors & the allocator

A field kind is just a registered `ConnectorFactory`:
`(descriptor: FieldDescriptor, ctx: ConnectorContext, byteOffset) => Connector`
(`src/contract/sharedMemory.ts`). The context hands the factory the
`SharedArrayBuffer`, the contract's codec, and the field's slot in the shared
version counter; the returned connector's `read()`/`write(v)` own that region.
`registerConnectorFactory(kind, factory)` registers a custom storage backend
SDK-wide; `plugins` overrides per contract.

Underneath the pool sits `MemoryManager` (`src/pool/memory.ts`): the
allocator it wraps when `sharedMemory` is configured. It owns a shared
`WebAssembly.Memory` (`initialPages` 16 = 1 MB, `maximumPages` 16384 = 1 GB by
default), grows it via `ensureCapacity(bytes)`, and exposes storage through
`getView(type, byteOffset?, length?)` and `getBuffer()`. Both the
`WorkerPool` and the SharedWorker host use it; you only need it directly when
managing buffers yourself.

## Binding lifecycle

`memory.bind(buffer)` installs connectors. Reading a field before binding
throws: use `memory.bound` and `memory.onBound(cb)` to sequence code that
must wait (this is what makes SSR and lazy pool construction safe).

## Persistence adapters

The buffer stays the synchronous source of truth, the contract's
`read()`/`write()` surface can't be async, but an adapter can mirror field
regions to external storage behind it. `WorkerPoolConfig.persistence` is the
attach point: the pool calls the factory with the contract right after
`bind`, and calls the handle's `stop()` on `terminate()`.

`@atolljs/node/redis` ships the reference implementation: the
shared-memory analog of NestJS's Redis WebSocket adapter:

```ts
import { redisMemoryAdapter } from '@atolljs/node/redis';

createNodePool({
  worker, sharedMemory: incidentsMemory,
  persistence: redisMemoryAdapter(redis, { name: 'incidents' }),
});
```

- **Persistence**: each field's byte region mirrors to a Redis hash
  (`{key}:{name}` members = field paths, base64 values). A `syncIntervalMs`
  loop diffs the per-field version counters (the same Atomics block
  `observe()` uses: no hot-path instrumentation) and `hset`s dirty fields.
  `ready` resolves after the initial `hgetall` restore; `stop()` (or
  `pool.terminate()`) performs a final flush.
- **Replication** (optional `subscriber`): dirty fields also publish
  `{src, path, b64}` to `{key}:{name}:ops`; subscribers write the bytes into
  their own buffer and bump the local version counter so observers fire.
  Last-write-wins per field; an instance id prevents echo.
- Adapter-facing accessors on the contract: `memory.buffer` (the bound
  SharedArrayBuffer) and `memory.fields()` (`{path, byteOffset, byteLength}`
  per field): these exist so other stores can implement the same pattern.
- Caveat: list `writeAt` only flushes after `commit()`: writes are detected
  via the version counter, same as observers.

See `packages/node/src/redis.ts` and `test/redisMemory.test.ts`.
