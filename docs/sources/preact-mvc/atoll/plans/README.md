# docs/plans: deferred design & product plans

Non-binding roadmap and idea capture. Unlike the rest of `docs/` (which
describes the code as it exists), files here describe work we *might* do:
use cases not yet built, gaps not yet closed, tools not yet designed.

- [shared-worker-use-cases.md](shared-worker-use-cases.md), use cases for
  `connectSharedWorker` beyond cross-tab state (deferred 2026-10-03)
- [devtools-dashboard.md](devtools-dashboard.md), debugging/analytics
  tooling for AtollJS apps (active scoping)

Conventions:

- Date and status each file. "Deferred" means deliberately parked, not lost.
- When a plan is implemented, move its content into the relevant `docs/` doc
  (or delete it) in the same change that ships the feature: plans must not
  become stale second sources of truth.
