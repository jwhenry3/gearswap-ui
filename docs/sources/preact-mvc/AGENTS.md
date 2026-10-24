# docs/ — the project's second memory

This folder is externalized memory for the framework. The root `AGENTS.md`
sets the contract: **read the relevant pages here before extensive work,
and update them in the same change as the code they describe.**

## Layout

- `atoll/` — vendored Atoll worker-framework docs. READ-ONLY source
  material: it describes *their* implementation (`packages/islands`,
  `packages/react-island`, `packages/angular-island`), which our packages
  now wrap directly: `@preact-mvc/atoll` is a facade over
  `@atolljs/islands` + `@atolljs/core`, and `@preact-mvc/atoll-island` is
  our `*-island` adapter on top of it.
- `framework.md` — our architecture: DI, modules, views, signals, router,
  lifecycle, component metadata, ownership enforcement.
- `islands.md` — our islands package: the op protocol, proxy DOM, worker
  runtime, adapter, driver, shell API, and every deliberate divergence
  from the Atoll design.
- `blog/` — long-form articles (announcements, introductions). Markdown
  posts with YAML frontmatter (`date`, `pinned`); open with ordinary
  paragraphs, not the atoll Problem/Fix blockquote. Blog and marketing
  copy style: no emojis, no em dashes (use `:` or `,`).
- `marketing/` — platform adaptations of blog posts, one file per channel:
  `# <Platform>: <Title>` header, a note naming the source post, a
  `---`-delimited verbatim copy block. LinkedIn files (`<topic>.md`) are
  plain-text copy (no markdown) ending with a `## Teaser variant` short
  post; Dev.to files (`<topic>-devto.md`) carry dev.to frontmatter and
  the article verbatim.

The **consumer-facing docs site** is `docs-consumer/` (a Vite app), the
GitHub Pages landing page is `pages-landing/`, and `scripts/*pages*.mjs`
assembles `dist-pages/`. Those are code, not second-memory docs; this
folder's files describe the site architecture:

- `docs-site.md` — how the docs site + Pages deploy work.

## Rules for editing docs

- If docs and code disagree, the code is right: fix the doc.
- Do not document APIs from memory. Verify against `src/` first.
- Keep code snippets compilable: if an example would not typecheck against
  the real API, it does not belong here.
- No em dashes in prose; use `:` or `,` instead.
- When you change an op, wire message, or instance-lifecycle invariant,
  update `islands.md` in the same commit.
