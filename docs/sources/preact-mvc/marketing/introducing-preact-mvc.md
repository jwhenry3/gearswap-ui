# LinkedIn: Introducing PreactMVC

Launch/announce post adapted from [`../blog/introducing-preact-mvc.md`](../blog/introducing-preact-mvc.md).
Copy the block between the rules verbatim: LinkedIn renders no markdown,
so line breaks carry the formatting. No emojis, no em dashes (house
style: `:` or `,`).

---

**Angular got application shape right. React got developer experience right. PreactMVC keeps both.**

Angular's architecture has carried large apps for years: injectors that scope services, modules that own providers, an MVC split that gives every class a job. React proved the flexible end: components are values, JSX composes, nothing between you and the DOM.

The bridge is Preact signals. PreactMVC puts Angular's structure on top of them:

- **Modules and DI**: `@Module`, `@Component`, `@Injectable`, `inject()` in field initializers. Declared components refuse to mount outside their module's scope: architecture enforced at mount, not reviewed at PR time.

- **Views are classes**: built once per mount, `render()` is plain JSX with auto-tracked signal reads. No hooks rules, no deps arrays.

- **Structure is opt-in**: undeclared views mount anywhere, standalone views carry their own module. Buy structure exactly where it pays.

- **No lock-in**: `render()` returns ordinary Preact vnodes, so every Preact library works unchanged: UI kits, `preact/compat`, TanStack Query, ECharts, zod. Provide the client through DI, bridge `subscribe` into a signal.

Structure you call, not structure you join.

Docs + live demos: https://jwhenry3.github.io/preact-mvc/

Scaffold an app: `npm install -g @preact-mvc/cli && pmvc new my-app`

#typescript #javascript #webdev #angular #reactjs #preact

---

## Teaser variant (short post)

Angular's architecture on Preact: modules, hierarchical DI, and class
views rendered as plain vnodes, signals instead of change detection,
structure enforced only where you declare it, and the whole Preact
ecosystem unchanged.

Docs + live demos → https://jwhenry3.github.io/preact-mvc/
