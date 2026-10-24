# Framework architecture

Angular-inspired modules/DI/decorators + MVC organization + class-based JSX
views rendered by Preact + signal reactivity. Source: `packages/core/src/`
(published in-repo as `@preact-mvc/core`).

## The stack in one paragraph

`View` classes are the components. They are real JSX imports (identity comes
from the import binding, not a registry). Preact renders them through a vnode
interceptor (`options.vnode`) that constructs each view inside a fresh child
injector at mount time. Models are injectable services (`@Injectable`);
controllers are injectable view logic (`@Controller`); views render signals
read inside `render()`. `@Module` composes providers and declares component
ownership; `@Component({ providers, controllers, imports })` gives a view its
own scope and can make it standalone.

## Dependency injection (`injector.ts`)

- `Injector(parent?, name?)` — hierarchical. `provide(provider)` registers
  class / `useValue` / `useClass` / `useFactory({ deps })` providers.
- `inject(token)` — resolves inside an injection context (construction via
  `instantiate`, or `runInInjectionContext`). Walks ancestor injectors.
- Provider-vs-transient: registered providers memoize per registering scope;
  `@Controller` classes injected *without* a registration are transient —
  one fresh instance per injecting scope.
- `inject()` searches the **whole ancestor chain for an explicit
  registration first**; only when none exists does the current scope
  auto-instantiate the controller. This is what makes declaration scope
  meaningful (see the controller-scope matrix below).
- `InjectionToken('desc', { factory })`, `providedIn: 'root'` on
  `@Injectable` — both resolve against the root injector.
- `DestroyRef` — every injector pre-registers itself; `inject(DestroyRef)`
  gives classes a handle to `onDestroy(fn)` registrations run at
  `deactivate()`.

## Signals (`signals.ts`)

Re-exports `@preact/signals`: `signal`, `computed`, `effect`, `batch`,
`untracked`. One addition: **`effect()` is scope-bound**. Created inside a
constructor or field initializer (i.e. inside `instantiate`), it registers
its disposer on the current injector's `DestroyRef` and dies at
`deactivate()`. Outside an injection context it is the raw primitive and
must be disposed manually. Field-initializer effects work because field
initializers run inside the injection context — declare them *below* the
signals they read (effects run once immediately at construction).

## Views (`view.ts`)

- `class X extends View<P>` — `render()` returns JSX. `this.props` is
  available from field initializers onward: the host constructs views as
  `inj.instantiate(cls, props)` so props exist during construction.
- Mount path: `options.vnode` sees a `View` subclass → swaps in a host
  component → at mount the host creates `new Injector(parent, 'view X')`,
  registers `@Component({ imports/providers/controllers })` into it,
  instantiates the view inside it, and renders through a
  `InjectorContext.Provider`.
- Lifecycle: `onInit`/`onDestroy` on views and injected controllers run on
  injector activate/deactivate, wired through `useLayoutEffect` so they pair
  correctly even on same-tick mount+unmount.
- `setState`/`forceUpdate` on a View throw intentionally; refs on views
  throw. State lives in signals.
- **Error boundary**: mount/render failures render a fallback box (with
  Retry) instead of taking down the whole tree.
- Function components are untouched by all of this — they get real Preact
  semantics (hooks legal). Hooks inside `View.render()` are forbidden by
  convention: they run during the host's render pass and conditional renders
  would scramble hook order.

## Modules (`module.ts`) and decorators (`decorators.ts`)

- `@Module({ providers, imports, controllers, components, bootstrap })`.
- `createModuleInjector(cls, parent)` — caches one injector per
  (module class, parent injector) pair; `imports` are registered into it
  recursively. `injector.modules` is the transitive closure of the module
  and its imports.
- **Ownership**: `components`/`bootstrap` declarations register
  view-class → module. Mounting a declared view whose owner is not in the
  ancestor chain's `modules` closure throws a clear error at mount (the
  boundary catches it locally). Undeclared views mount freely — the import
  binding is their identity.
- `@Component({ providers, controllers, imports })` — `imports` makes a
  view standalone (Angular's `standalone` + `imports` pattern): the module's
  providers and component visibility enter the view's own scope.

Controller scope matrix:

| Where declared | Lifetime |
|---|---|
| nowhere (`inject(Ctrl)`) | transient, one per injecting scope |
| `@Component({ controllers })` | shared with that view's subtree |
| `@Module({ controllers })` | shared across the module's scope |
| `@Component({ imports: [M] })` | M's providers enter the view's scope |

`useController(C)` (context.ts) is the explicit escape hatch: always a fresh
instance owned by the calling function component's mount.

## Router (`router/`)

Signal-based on top of `preact-router`: `Router` holds the URL and the
matched chain as signals; `RouterOutlet` re-renders on navigation.
`RouterModule.forRoot(routes)` returns a module-shaped provider bundle.
Route entries may carry `component`, `module`, and `children`; module
routes create the module injector under that outlet level. `:param`
segments decode into merged `params`; `*` is a wildcard. `Link` intercepts
clicks for `navigate()`.

**Nested routes.** The URL resolves against `children` as a chain
outermost → innermost (`router.matches`), each `<RouterOutlet/>` rendering
its depth via context — a parent shell stays mounted while the child
swaps. A route with children matches by prefix; a leaf must consume the
whole tail. Params merge across levels (inner wins). Module routes nest
injectors the same way: the child's module injector parents under the
level that mounted it.

**preact-router interop.** The outermost outlet mounts a preact-router
`<Router>` bridge (a `default` sink child claims every URL). `navigate()`
goes through `route()`, so embedded preact-router `<Router>`s update on
our navigations; foreign `route()` calls and preact-router's global
`<a href>` click interceptor flow back through the bridge's `onChange`
into `router.url`. `Link` stops propagation so its own handler and the
global interceptor don't double-navigate.

**Base path.** The router knows its mount prefix so the same bundle runs at
site root or nested under a static tree (the Pages demos mount under
`docs/demo/`). Resolution order: `RouterModule.forRoot(routes, { basePath })`
wins; otherwise the Router derives the base from `document.baseURI`'s
directory at construction (the Vite demo ships no `<base>` tag, so baseURI
is simply its URL). Matching strips the base; `navigate` and `Link` hrefs
prepend it. An app on `/docs/demo/` sees `/todos` and emits
`/docs/demo/todos`. Deep-linking still needs the host to serve
`index.html` for the path; GitHub Pages uses `404.html` or a redirect shim.

## Bootstrap

`bootstrap(AppComponent, { routes?, module? })` — builds the root injector
(registering the root module if given), renders `InjectorContext.Provider`
around the app component. `src/main.tsx` is the entry.

## Invariants not to break

- Construction is the only injection context; `inject()` elsewhere throws.
- Lifecycle pairs on scope activate/deactivate, never on render alone.
- Declared components enforce scope; undeclared ones stay free.
- Ops and wire shapes in `packages/atoll/` are documented in `islands.md`.
