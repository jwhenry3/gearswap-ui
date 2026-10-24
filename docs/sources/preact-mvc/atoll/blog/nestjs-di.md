---
date: 2026-09-30
series: Server-side Atoll
---

# Dependency Injection Across the Boundary

## `@AtollService`: a NestJS provider whose methods run in a pool

> **Problem.** In a NestJS app you're usually forced to choose between
> clean DI and off-thread execution: worker code lives outside the
> provider graph, reached through bespoke client calls.
>
> **Fix.** `@AtollService`/`@AtollTask` plus `AtollModule.registerPool`
> and `runAtollWorker`: the same class is an injectable on the API thread
> and a real provider inside the worker, with `withSharedBuffer` sharing
> buffers across pools.

NestJS is where this question matters most, because Nest's value
proposition is that *the provider graph is the architecture*. If worker
code lives outside that graph, reached through a bespoke client with
its own error conventions, you've given up the reason you chose the
framework.

So the test to judge this by: can a service run in a worker while its
consumers inject it like nothing changed?

## The service-level facade

One class-level decorator marks *every* method for offload: the class
is the interop surface, and it can use injected dependencies and shared
memory like any provider:

```ts
// report.service.ts: the facade
@Injectable()
@AtollService({ pool: 'reports' })
export class ReportService {
  constructor(
    @Inject(ScanTelemetry) private readonly telemetry: ScanTelemetry,
  ) {}

  /** Full-table aggregate over the shared buffer: runs in the worker. */
  execSummary() {
    this.telemetry.note('execSummary');       // the worker's own instance
    const conn = incidentsMemory.lists.incidents;
    const bySeverity = [0, 0, 0, 0];
    for (let i = 0; i < conn.recordCount; i++) {
      conn.readAt(i, rec, ['severity', 'status', 'region', 'customers']);
      bySeverity[rec.severity]++;
      // ...same million-row scan the browser demos run
    }
    return { total: conn.recordCount, bySeverity /* … */ };
  }

  /** Proof of context: this worker's threadId + its injected state. */
  workerInfo() {
    return { threadId, scans: this.telemetry.scans };
  }
}
```

The consumer can't tell, and that's the point. `DashboardService` is a
plain provider with **zero** Atoll imports:

```ts
// dashboard.service.ts: a service calls a service
@Injectable()
export class DashboardService {
  constructor(
    @Inject(ReportService) private readonly reports: ReportService,
  ) {}

  /** One response composed from two pool dispatches. */
  async overview() {
    const [summary, worker] = await Promise.all([
      this.reports.execSummary(),   // EXECUTE_TASK → 'reports' pool
      this.reports.workerInfo(),    // EXECUTE_TASK → 'reports' pool
    ]);
    return { ...summary, generatedBy: worker };
  }
}
```

Every call dispatches as a `ReportService.method` task. That zero-import
property is what separates a facade from a leak with better branding.

The symmetric half is the module: it registers the pool on the API
thread *and* boots inside the worker, so it's the boundary on both
sides:

```ts
// facade.module.ts
@Module({
  imports: [
    AtollModule.registerPool({
      name: 'reports',
      // message-only pool: borrows the incidents pool's buffer,
      // resolved lazily per spawn so respawns get it too
      worker: withSharedBuffer(
        () => new Worker(new URL('./facade.worker.ts', import.meta.url)),
        () => getAtollPool('incidents')?.sharedBuffer,
      ),
      poolSize: 2,
    }),
  ],
  providers: [ScanTelemetry, ReportService, DashboardService],
})
export class FacadeAtollModule {}

// facade.worker.ts: the whole worker entry
await bindSharedBuffer();              // the incidents pool's buffer
await runAtollWorker(FacadeAtollModule);
```

On the API thread, `registerPool` spawns the workers and `ReportService`
resolves to the dispatching proxy. In the worker, `runAtollWorker` boots
a real Nest application context over the *same module*: the pool
provider resolves to nothing and the `@AtollService` bodies execute on
the DI'd instance, so `ScanTelemetry` is genuinely that worker's own.
`withSharedBuffer`/`bindSharedBuffer` do the other trick: a message-only
pool binds a *different* pool's buffer on spawn: the reports pool reads
the same million incidents the housed-API pool serves. One buffer, two
pools, zero copies.

`@AtollTask` remains for per-method dispatch when only some of a class
belongs off-thread.

## Housed APIs: routes that only exist in workers

The facade pushes *method calls* across the boundary. Housed APIs push
*routes*: a URL subtree whose controllers exist only inside workers.
Each housed worker boots a full Nest app on an internal port: no
`runAtollWorker`, it serves HTTP instead of tasks:

```ts
// housed.worker.ts: a dedicated HTTP worker, not a task worker
await bindSharedBuffer();   // same incidents buffer, bound before boot
const app = await NestFactory.create(HousedApiModule);
await app.init();
serveHttp(app.getHttpServer(), { listen: 0 });  // announces HTTP_PORT up
```

The worker-side module is a plain Nest module: `controllers`, `providers`,
no `registerPool` (pools only spawn on the main thread). The controllers
are ordinary too: `@Controller('api/housed/incidents')` with `@Get`
routes that scan the shared buffer directly and stamp `threadId` on each
response. Injecting `IncidentsAnalytics`, the same `@AtollService`
class the API thread RPCs into, runs the trick in reverse: inside a
worker the pool registry is empty, so its methods execute their real
bodies on this worker's own instance. Per-worker state is genuinely
per-worker.

On the main thread, the `'housed'` pool registers exactly like
`'reports'`, message-only, `withSharedBuffer` off the incidents pool,
and the app proxies the prefix:

```ts
// main.ts, /api/housed/* forwards into the pool's internal listeners
const pool = getAtollPool('housed');
const tracker = workerHttpPorts(pool);   // follows HTTP_PORT announcements
app.use('/api/housed', proxyToWorker({
  pool,
  tracker,
  to: '/api/housed',   // express stripped the mount, restore it in-worker
  worker: (workers) => workers[cursor++ % workers.length],  // round-robin
}));
```

The lifecycle is the part worth noting: a worker announces its listener
with an `HTTP_PORT` handshake (`workerHttpPorts` tracks them, with a
query covering announcements that raced the tracker), the `worker:`
selector can round-robin or pin to a slot, and a respawned worker
re-announces and takes its routes back automatically. WebSockets get the
same treatment through `proxyUpgradeToWorker`, and on Node ≥ 26
`createHttpCluster` adds a second listener where the main thread hands
each accepted socket to a worker *unparsed*: per-connection, so it
lives on its own port rather than sharing the app's.

The discipline worth taking from this even if you never install the
package: **the class is the contract; where its body runs is
configuration, not refactor.** Same idea as `islandComponent`, same idea
as the worker client: one pattern, every layer of the framework.

Source: the [NestJS bindings guide](../frameworks/nestjs.md), service
facades and housed APIs, and the runnable modules in
`examples/nestjs/src/facade/` and `examples/nestjs/src/housed/`.
