# The docs site and GitHub Pages deploy

The consumer-facing documentation lives in `docs-consumer/`, a Vite +
Preact app modeled on the Atoll `docs-consumer/` architecture. It is
deployed to GitHub Pages together with a static landing page and the two
live demo apps. This doc describes the moving parts.

## Layout

```
pages-landing/      static site root: index.html, 404.html, favicon.svg,
                    social.png (the og:image share card). No build step;
                    copied verbatim into dist-pages/.
docs-consumer/      the docs app. `npm run build` does tsc + Vite client
                    build + SSR bundle build + prerender.mjs, emitting one
                    static HTML file per route into dist/.
scripts/
  pages-lib.mjs     the demo mount table (docs/demo, docs/enterprise).
  assemble-pages.mjs  builds dist-pages/: landing + docs + demo mounts +
                    versioned snapshots + versions.json + .nojekyll.
  build-pages.mjs   builds every app (demos with --base=./) then assembles.
  serve-pages.mjs   build + serve dist-pages on :4190.
  serve-static.mjs  dependency-free static file server (index.html +
                    404.html semantics).
  snapshot-docs.mjs builds a release docs tarball (docs-v<x.y.z>.tar.gz)
                    with VITE_DOCS_VERSION stamped in.
  fetch-docs-versions.mjs
                    downloads docs-*.tar.gz release assets into
                    docs-versions/ via the gh CLI.
.github/workflows/pages.yml
                    manual (workflow_dispatch) + workflow_call Pages deploy.
.github/workflows/publish.yml
                    release pipeline: stage packages → docs-snapshot job
                    attaches the tarball to the release → deploy-docs calls
                    pages.yml.
```

The assembled tree:

```
dist-pages/
  index.html 404.html favicon.svg social.png  from pages-landing/
  docs/                           from docs-consumer/dist
    social.png                    from docs-consumer/public
    demo/                         from dist/ (root app)
    enterprise/                   from examples/enterprise/dist
    v0.1.0/ v0.1.1/ …             release snapshots (docs-versions/*.tar.gz)
    versions.json                 manifest the version switcher reads
  .nojekyll
```

Everything is static. The islands demos use ordinary Web Workers, not
SharedArrayBuffer, so no COOP/COEP service worker is needed (unlike
Atoll's docs, which ship a cross-origin-isolation shim).

## The docs app (docs-consumer/)

- `src/App.tsx` — the route table and shell (header, sidebar, article).
  Routes are plain objects `{ id, path, label, section, element }`.
- `src/ssg.tsx` — exports `ROUTES` and `renderRoute(id)` for prerendering.
- `src/routeMeta.ts` — per-route `<title>`, description, canonical URL.
  `metaFor` qualifies non-root pages labeled "Overview" (e.g. `islands`
  becomes "Islands overview") so titles stay unique.
- `src/link.ts` — route-relative URL helpers (`href` etc.) so links work
  under any Pages base path; `docsBaseUrl()` resolves the canonical
  origin for sitemap/OG tags (`DOCS_BASE_URL` env, fallback localhost).
- `prerender.mjs` — runs after the Vite builds: loads `dist-ssg/ssg.js`,
  emits `dist/<route>/index.html` per route with meta injected into the
  HTML template, plus `robots.txt`, `sitemap.xml`, and `docs.js` (a tiny
  vanilla-JS nav enhancer; the emitted pages do not ship a Preact
  runtime). Every route gets `og:*`/`twitter:*` tags including
  `summary_large_image`; `og:image`/`twitter:image` are
  `${DOCS_BASE_URL}social.png`, which each build serves from its own
  tree (`docs-consumer/public/social.png`), so release snapshots resolve
  inside their own `docs/v<x.y.z>/` mount.
- `src/components/` — `CodeBlock` (highlight.js, optional `worker`/`shell`
  side label), `DemoFrame` (dev → dev-server URL, prod → relative mount),
  `SiteHeader`.
- `src/pages/` — one file per route. Writing a new page = add the file +
  add a route entry in `App.tsx`.

## Why the demos mount inside docs/

`DemoFrame` embeds `./demo/` and `./enterprise/` — relative iframe URLs.
The demos live inside the docs tree so the whole `dist-pages/` folder
works under any Pages base (`user.github.io/repo/`). The framework
router derives its base path from `document.baseURI` (see
`framework.md` → Router), so an app mounted at `docs/demo/` routes
`/todos` internally while `Link` emits `/docs/demo/todos`. Explicit
`RouterModule.forRoot(routes, { basePath })` overrides that derivation.

Demos build with `vite build --base=./` so their asset URLs are relative;
the same dist works at any mount depth.

## Dev vs production demo URLs

`DemoFrame` switches on `import.meta.env.DEV`:

- dev: `http://localhost:<port>/` (the example's dev server; enterprise is
  pinned to a deterministic port in `examples/enterprise/vite.config.ts`)
- prod: `./<mount>/` (the assembled Pages tree)

## Deploy

`pages.yml` runs on `workflow_dispatch` or `workflow_call` (publish.yml's
deploy-docs job): `ci-install` → `fetch-docs-versions.mjs` → build docs +
demos → `assemble-pages.mjs` → `upload-pages-artifact` → `deploy-pages`.
`DOCS_BASE_URL` defaults to `https://<owner>.github.io/<repo>/docs/`
derived from `github.repository` (the `DOCS_BASE_URL` repo variable
overrides it), so canonical/sitemap/OG image URLs are correct without
extra setup; links themselves are relative and work regardless. The
landing page hardcodes its own absolute OG tags since it is the site
root and has no base-path problem.

The internals docs (`docs/*.md`) are deliberately not part of the
deployed site; they are the repo's second memory (see `docs/AGENTS.md`).

## Versioned docs snapshots

The docs version switcher mirrors the atoll design: each release ships an
immutable copy of the whole docs tree (pages + demo mounts) as a
`docs-v<x.y.z>.tar.gz` release asset, and Pages mounts it at
`docs/v<x.y.z>/`.

- `publish.yml`'s `docs-snapshot` job runs `snapshot-docs.mjs <tag>`,
  which rebuilds the docs tree with `VITE_DOCS_VERSION=v<x.y.z>` and
  `DOCS_BASE_URL=<pages origin>/docs/<ver>/`, tars `mountDocsTree`'s
  output, and `gh release upload`s it.
- `prerender.mjs` reads `VITE_DOCS_VERSION` into
  `<meta name="preact-mvc:version">` on every page and adds
  `robots: noindex` on snapshot builds so immutable copies never outrank
  latest.
- `docs.js` derives the live version from the mount path (the `v<x.y.z>`
  segment right before the route), computes the docs root as
  `'../' × (depth + (versioned ? 1 : 0))`, and drives the
  `select.version-switch` in `SiteHeader`: fetch `versions.json` from the
  docs root, repopulate options, navigate by segment swap preserving the
  current route. The select stays `hidden` until a manifest proves
  snapshots exist.
- `assemble-pages.mjs` extracts each `docs-versions/docs-v<x.y.z>.tar.gz`
  into `dist-pages/docs/v<x.y.z>/` and writes `versions.json` (newest
  first) at the docs root. Because `versions.json` is fetched from the
  live root, a page inside an old snapshot still learns about newer
  releases.
- `fetch-docs-versions.mjs` pulls the release assets via `gh` before
  assemble; without `gh` it warns and exits 0 so local `serve:pages`
  still works.
- Snapshot pages resolve their own assets inside the snapshot (every
  `../` stays within `docs/v<x.y.z>/`); only the Home tab and the version
  select cross the boundary.

## Invariants

- New standalone projects get the shared `.npmrc` and an entry in
  `scripts/ci-install.mjs` (`docs-consumer` already has both).
- If a docs page documents an API, verify the snippet against the package
  source; do not document from memory.
- Keep worker entries bundler-detectable (`new Worker(new URL(...))`
  inline) in every demo; the mounted builds rely on Vite's detection.
- When the deploy tree changes (new demo, new mount), update this file
  and `pages-lib.mjs`'s `DEMOS` table in the same change.
