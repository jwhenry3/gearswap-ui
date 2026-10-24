---
date: 2026-10-13
pinned: true
---

# Introducing PreactMVC

## Why Angular and Preact?
Building scalable and maintainable frontend applications becomes a difficult task when the framework is too opinionated or too loose. The goal is to provide familiar patterns on both sides while sacrificing nothing. Once thought to be nigh impossible is now brought into fruition by bridging similarities between two very different frameworks.

Angular thrives on structural architecture design and enforcing boundaries that make sense for large scale applications. We know through many years that MVC is a solid pattern not to be dismissed easily. We also know that through many years of exploring flexible developer experiences that React's ability to adapt is unrivaled. Where these two can come together is through Preact's Signals library and combining the efforts that Angular and React have honed into a solid set of practices.


## Angular's architecture, rendered by Preact: modules, DI, and class views without the template compiler
Pick a side, the industry says. Want structure? Buy the whole framework: template compiler, DI container, opinionated everything, and a migration path when the ecosystem moves on without you. Want flexibility? Assemble it yourself: but the structure you improvise at ten files becomes tribal knowledge at a hundred, and the conventions that kept things tidy exist only in the senior dev's head. Frameworks sell you structure *or* freedom, and quietly charge you for the one you gave up.

PreactMVC refuses the trade. It gives you Angular's structural machinery (hierarchical injectors, module ownership, an enforced MVC split) as a *library* over ordinary Preact: opt into scope enforcement where it pays, and stay plain JSX everywhere else. Signals replace change detection, every Preact library works unmodified, and the same view classes optionally render inside Web Workers as islands. The sales pitch in one sentence: this is structure you *call*, not structure you *join*.

## Flexibility: render() is just Preact

```tsx
// counter.view.tsx
import { Component, Controller, View, inject, signal } from '@preact-mvc/core';

@Controller()
class CounterController {
  count = signal(0);
  inc = () => this.count.value++;
}

@Component({ controllers: [CounterController] })
export class CounterView extends View {
  private c = inject(CounterController);

  render() {
    return <button onClick={this.c.inc}>count: {this.c.count.value}</button>;
  }
}
```

A view is a class constructed once per mount inside its own injector scope: `inject()` in field initializers, signals as plain fields, and a `render()` that stays plain JSX forever. No hooks rules, no deps arrays, no memoization audits. Construction is setup; render is projection.

And because `render()` returns ordinary Preact vnodes, flexibility extends to the ecosystem itself. Icon sets, UI kits, `preact/compat` React shims: drop them in. Function components keep their hooks and get `useService`/`useController`/`Provide` as bridges into the injector. Signal-aware libraries subscribe directly: our signals *are* `@preact/signals`. Everything else takes two moves: provide the client through DI, bridge `subscribe` into a scope-bound signal. The enterprise demo runs TanStack Query, ECharts, zod, and a Tailwind/shadcn layer with zero adapter packages: that is what "no lock-in" looks like measured.

## Structure: the injector graph is the app map

```ts
@Module({
  imports: [RouterModule.forRoot(routes), QueryModule.forRoot()],
  providers: [SessionService],              // scoped here, visible down
  controllers: [DashboardController],       // shared by this module's views
  components: [DashboardView],              // may only mount in this scope
  bootstrap: [DashboardView],
})
export class DashboardModule {}
```

`components` is an ownership declaration, not a registry: a declared view refuses to mount outside an injector carrying its module. That is the difference between structure as convention and structure as contract: the architecture diagram is enforced at mount time, not reviewed at PR time.

Providers are Angular's shapes: a class, `{ provide, useClass }`, `{ provide, useValue }`, `{ provide, useFactory, deps }`. Resolution walks view scope, module scopes, root. `DestroyRef` ties teardown to the scope, so a subscription created in a constructor dies with the view: the same guarantee `useEffect` cleanup reaches for, made declarative.

The `@Controller` layer completes the MVC split Angular implied but never enforced: controllers own interaction state, views project signals, injectable stores own domain state. Declaration decides lifetime: transient, view-scoped, or module-shared.

## Structure that bends: opt out wherever it pays

The strictness is per-declaration, not global:

- **Undeclared views mount anywhere.** `components` is opt-in enforcement, not a gate: skip it and the view is just a value you import, function components included.
- **Standalone views carry their module.** `@Component({ imports })` pulls a module's providers into one view's scope, so a feature can exist with no owning module at all.
- **The router is a module too.** `RouterModule.forRoot(routes)` is a provider import, and routes can mount either a loose `component` or a full `module` with its own injector.

You buy structure exactly where you need it: the payment boundary, the admin surface, the team's shared feature. Everything else stays the JSX you would have written anyway.

## Why use this?

Because the alternative is choosing between a framework that owns your codebase and one that leaves it ungoverned. PreactMVC is for developers who want the module map, the injector scoping, and the MVC discipline: priced as four small packages, rendered by the 3kB engine you already trust, compatible with the ecosystem you already use.

```bash
npm install -g @preact-mvc/cli
pmvc new my-app --islands
cd my-app && pmvc serve
```

The docs site walks DI, views, signals, the router, and the islands contract end to end, with the demo and enterprise apps embedded live: [jwhenry3.github.io/preact-mvc](https://jwhenry3.github.io/preact-mvc/)
