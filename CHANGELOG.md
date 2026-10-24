# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-23

Initial release — a Windower 4 addon (`gearswapui`) that runs a local HTTP
server and serves a Web UI (Preact) in a frameless, always-on-top overlay,
replacing the web interface for inventory, GearSwap set, and macro
management.

### Added

**Overlay & addon shell**

- Wails v3 / WebView2 overlay: frameless always-on-top window, single
  instance, collapsible 56px floating button ("fab") mode, native
  drag/resize via Wails message channel, per-mode window geometry
  persistence. Electron dev path via `overlay/launch.mjs`.
- LuaSocket HTTP server on `127.0.0.1:17890` (auto-probes the next 9 ports),
  SSE state stream, static UI serving, `POST /api/command` passthrough to
  `windower.send_command`.
- `//gsui` commands: `open`, `overlay`, `fab`, `start`, `stop`, `status`,
  `port`, `refresh`, `equip <set>`, `swap`.

**Inventory**

- Browse all storage bags (inventory, safe, storage, locker, satchel, sack,
  case, wardrobe 1-8); unavailable bags shown disabled, not hidden.
- Search, equipment-only, bag, and equip-slot filters; item detail panel
  with augments/extdata, jobs, flags, and duplicate locations.
- Item icons decoded from FFXI DAT files (`icon_extractor`), cached as BMP
  and served via `/api/icon`.
- In-game actions: equip, unequip (per equip slot), use, drop, and move
  between bags (packet injection).

**GearSwap sets**

- Profile file browser over `addons/GearSwap/data`, Lua read/write, and
  `gs reload`.
- Build `sets.*` tables from scanned inventory via a slot grid + filtered
  item picker; items resolve loosely by canonical id, name, and augments —
  bag position is a hint, not an identity.
- Set-type bindings (idle/engaged/precast/… with nested paths like
  `precast['Utsusemi: Ichi']`) persisted in a managed
  `<gearswapui sets>` block spliced inside the profile's `get_sets()`,
  with guarded default handlers injected only for bare profiles.
- Quick-equip scanner (`//gsui swap`) listing equippable `sets.*` paths.

**Macro editor**

- Reads and writes FFXI macro storage under `USER/<content id>/`
  (`mcr*.dat` palettes, `mcr*.ttl` book titles) — 40 books × 10 pages ×
  20 macros with 6 command lines each.
- Fully decoded file format: MD5-verified 24-byte header recomputed on
  every write, `.gsui-bak` backup per save, lossless auto-translate
  (`[AT:xxxxxxxx]`) and raw-byte (`\xNN`) round-tripping.
- Editor UI: book/page pickers, Ctrl/Alt 2×10 macro grid, label + line
  editor with byte counters, palette copy/paste, book rename.
- **Live apply**: `PUT /api/macros/palette?apply=1` forces the client to
  re-read a book while logged in — switches to another book, writes while
  the target book is unloaded, switches back and selects the page (≥1.5s
  between switches, per Windower/Lua#1892).

**Tooling**

- Vite build (`npm run build:addon`), Go build (`npm run build:overlay`),
  incremental locked-file-tolerant deploy (`scripts/deploy.mjs`), release
  packaging (`scripts/package.mjs`), GitHub release workflow.
- Fengari smoke test (`scripts/smoke-test.mjs`) driving the real addon
  over `node:net` — covers HTTP endpoints, SSE, static SPA serving, file
  CRUD, macro parse/write/apply, and addon commands.
