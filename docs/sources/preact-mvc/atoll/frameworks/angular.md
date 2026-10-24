# Angular: `@atolljs/angular` + `@atolljs/angular-island`

Read when: working on `packages/angular/` (binding) or
`packages/angular-island/` (shell + worker renderer for Angular islands).

## Binding: `@atolljs/angular`

Signal adapter for zoneless Angular. Call in an injection context (field
initializer or constructor) so subscriptions release on destroy. NgModule apps
get the same pools through `AtollModule`: the NestJS binding's
`forRoot`/`registerPool` vocabulary. Source: `packages/angular/src/index.ts`.
Example: `examples/angular/src/app.component.ts` + `.html`.

| Export | Signature | What it does |
|---|---|---|
| `provideAtoll` | `provideAtoll({ pools: AtollPoolDeclaration[] }, ...features)` | Register worker pools or `connectWorker` clients (`{ name, client }`) as environment providers: terminated on injector destroy; also usable at route level. |
| `injectAtollPool` | `injectAtollPool<T>(name): T` | Inject a pool registered by `provideAtoll` inside an injection context; mockable via TestBed. |
| `AtollModule` | `AtollModule.forRoot({pools?})` / `forRootAsync` / `registerPool(decl)` / `registerPoolAsync` | NgModule alternative to `provideAtoll`: same pool tokens + lifecycle, declared on the importing module; async forms resolve their factory before bootstrap. |
| `@InjectAtollPool` | `@InjectAtollPool(name)` | Constructor-parameter decorator form of `injectAtollPool` for `@Injectable()` classes. |
| `observableSignal` | `observableSignal(source: ObservableValue<T>): Signal<T>` | Subscribe to any observable snapshot (task or field). |
| `sharedValue` | `sharedValue(memory, key, select?, options?): Signal<T \| undefined>` | Bind one shared-memory field to a Signal; optional selector + equality. |
| `taskState` | `taskState(task \| asyncFn): { state: Signal<TaskSnapshot>, run, runOnce }` | Bind an AsyncTask, or any async fn, to a Signal and get its triggers. |

NgModule form: `AtollModule` (from the docs' moduleSnippet):

```ts
@NgModule({
  imports: [
    AtollModule.forRoot(),       // or forRoot({ pools: [{ name: 'incidents', client: incidents }] })
    IncidentsModule,            // imports AtollModule.registerPool({ name: 'incidents', client: incidents })
  ],
})
export class AppModule {}

@Injectable()
export class IncidentsService {
  // parameter-decorator form of injectAtollPool
  constructor(@InjectAtollPool('incidents') private readonly pool: IncidentsClient) {}
}
```

Works with OnPush + zoneless change detection out of the box.

## Worker islands: `@atolljs/angular-island`

Shell components that mount a worker-hosted tree in an Angular app, plus the
Angular **worker renderer**: `angularIslandApp` bootstraps a standalone
component via `createComponent` against a `Renderer2`/`RendererFactory2` bound
to the instance's proxy document (the same abstraction platform-server uses).

### The facade: `@AngularIsland` + `islandComponent`

The decorator-driven pairing is the primary interface: the worker's
top-level component IS the contract. `@AngularIsland` stamps the registry
name (`@AngularIsland`, `@AngularIsland('name')`, or
`@AngularIsland({ name, providers })`: default `CounterComponent` →
'counter') and registers the class so `defineAngularPolyWorker()` collects
it; `islandComponent<C>` generates a standalone shell component whose
`props`/`onEvent` are typed from the class's `input()`/`model()`/`output()`
fields (`IslandInputs<C>`/`IslandEvents<C>`) via `import type`.

> **Minification caveat**: the bare form derives the registry key from the
> class's `.name` at runtime, which minifiers mangle (`CounterComponent` →
> `n9`). Explicit keys (`@AngularIsland('counter')`, or the `apps` record
> form of `defineAngularPolyWorker`) survive any production build: prefer
> them anywhere code is minified.

```ts
// worker entry
@AngularIsland('counter')
@Component({ standalone: true, selector: 'atoll-counter', template: `…` })
export class CounterComponent {
  readonly label = input('count');      // → props key
  readonly bumped = output<number>();   // → island event 'bumped'
}
export const worker = defineAngularPolyWorker(); // collects every @AngularIsland

// shell: `import type` keeps the worker module out of the bundle
const CounterIsland = islandComponent<CounterComponent>({
  app: 'counter', worker: renderWorker, selector: 'counter-island',
});
// <counter-island [props]="{ label: 'alpha' }" [onEvent]="onBumped" />
```

Root-component `output()`/`model()` fields bridge onto the island's emit
channel under their public names (`x = model()` → `'xChange'`), with the
adapter handling instance re-entry: the component's declared API is the
island's event contract, and manual `emit()` remains for non-output paths.
`islandComponent`'s generated class carries a hand-authored `ɵcmp`
(`ɵɵdefineComponent` + `ɵɵInheritDefinitionFeature`), so it resolves under
AOT and JIT without shell-side compiler requirements.

### Shell surface

| Export | Signature | What it does |
|---|---|---|
| `islandComponent` | `islandComponent<C>({ app?, selector?, client? \| worker?, workerOptions?, mode? })` | Generates a standalone facade component typed against the worker component class: `<counter-island [props]/>`. |
| `IslandInputs<C>` / `IslandEvents<C>` / `IslandEventHandler<C>` | mapped types over the component class | Props/event inference from `input()`/`model()`/`output()` fields: type-only, zero bundle cost. |
| `AtollIslandComponent<C>` | `<atoll-island [client\|worker] [app] [props] [mode] [onEvent] [slots] />` | Low-level standalone component: generic over the worker component type for inference; `app` accepts the class itself (stamp-resolved). |
| `AtollIslandDirective<C>` | `<div atollIsland [client\|worker] … />` | Directive form for elements you already render. |
| `AtollIslandModule` | `imports: [AtollIslandModule]` | NgModule re-export of the standalone pair. |

Either `client` (shared `connectIslandWorker` handle) or `worker`
(`() => new Worker(...)`, island-owned) is required. Reference shell:
`examples/react-dom-worker/src/angular-shell.ts`: three facades
(`<counter-island>` ×2 sharing one client, `<notes-island>`,
`<incidents-island>` with a `worker` shorthand) mounted in a standalone JIT
component, `[mode]` bound to a signal, events typed via
`IslandEventHandler<C>`.

### Worker renderer

| Export | Signature | What it does |
|---|---|---|
| `@AngularIsland` | `@AngularIsland \| @AngularIsland('name') \| @AngularIsland({ name?, providers? })` | Class decorator, stamps `islandAppName` (default: kebab-cased class name minus `Component`, **mangled under minification**, pass the key explicitly in production builds) and registers the component for the no-arg worker form. |
| `defineAngularPolyWorker` | `()` \| `({ apps: [C, …] })` \| `({ apps: { name: C \| { component, providers } } })` | Registry worker: no-arg collects decorated components; array names by stamp/class name; record form unchanged. |
| `defineAngularMonoWorker` | `defineAngularMonoWorker(Component, options?)` | 1:1 instance worker: mounted namelessly. |
| `angularIslandApp` / `angularIsland` | `angularIslandApp(Component, { providers? }): RenderedIslandApp` | The adapter: mounts in a bare environment injector; `providedIn: 'root'` services and `options.providers` resolve. |
| `angularIslandNameOf` | `angularIslandNameOf(Component \| string)` | Resolves the registry name a shell `[app]`/worker registry would use for the class. |
| `emit` / `runInInstance` | re-exported | Manual emit for non-output paths; the worker entry needs no direct islands import. |

```ts
// counter.worker.ts: the whole worker entry
import '@angular/compiler';                     // JIT decorator components only
import { Component, input, output, signal } from '@angular/core';
import { AngularIsland, defineAngularPolyWorker } from '@atolljs/angular-island/worker';

@AngularIsland('counter')   // explicit key: survives minification
@Component({
  standalone: true,
  selector: 'atoll-counter',
  template: `<button (click)="inc()">{{ label() }}: {{ n() }}</button>`,
})
export class CounterComponent {
  readonly label = input('count');
  readonly n = signal(0);
  readonly bumped = output<number>();
  inc() { this.n.update((v) => v + 1); this.bumped.emit(this.n()); }
}

export const worker = defineAngularPolyWorker();
```

### Semantics & limits

- `mount` creates the component in a bare environment injector
  (`providedIn: 'root'` services and `options.providers` resolve); change
  detection is zoneless: every dispatched listener and `setInput` ends in a
  synchronous `detectChanges` plus the `AfterRenderManager` pass, so
  `afterRenderEffect`/`effect()` run, and signal writes from timers/promise
  continuations queue a microtask tick inside the instance.
- **`import '@angular/compiler'` in the worker entry for JIT (decorator)
  components**: missing it throws a named error at mount. AOT/`ɵcmp`
  components (real `ngc` output, or hand-written defs) need nothing: the
  worker bundle stays compiler-free.
- `input()`/`model()`/`output()` fields on JIT components work through the
  adapter's signal-member interop (bindings, transforms, `ngOnChanges`), but
  **`input({ alias })` aliases aren't discoverable**: bind by field name, or
  use AOT.
- The Sanitizer is **passthrough**: worker output is not sanitized.
- `@defer` with `on immediate` works; interaction/viewport/idle triggers are
  untested (no real viewport/hover events exist worker-side). Forms
  (`ngModel`) and animations (no driver) are unexplored.
- `structuredClone`-able props (they cross `postMessage`; `mountIsland`
  rejects uncloneable values naming the offending key).
