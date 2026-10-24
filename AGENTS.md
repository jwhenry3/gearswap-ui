# GearSwapUI

## Architecture

Single target: a **browser UI** (`src/app/`, Preact + `@preact-mvc/core`) served
by the Windower addon over localhost, viewed either in a normal browser tab
(`//gsui open`), in the **Wails/WebView2 overlay** (distributed build,
`overlay/wails/` → `addon/gearswapui/overlay/gsui-overlay.exe`), or in the
**Electron overlay** (dev, `overlay/`, `npm run overlay`). `//gsui overlay`
prefers the bundled exe and falls back to the Electron dev launcher.

### Addon — `addon/gearswapui/`

- `gearswapui.lua` — LuaSocket HTTP server (default port 17890, `//gsui port`),
  SSE state stream, GearSwap file CRUD, `/api/icon` (DAT extraction via
  `icon_extractor`, cached under `data/icons/`), `POST /api/command`
  (`{"cmd": ...}` → `windower.send_command`), static UI serving with
  `Cache-Control: no-cache` on HTML. `//gsui` commands: `open`, `overlay`,
  `start`, `stop`, `status`, `port`, `refresh`, `swap` (scanner commands),
  `equip <set>`.
- `swapui.lua` — headless GearSwap profile scanner powering `//gsui equip`,
  `swap list/add/remove/scan`. No UI.
- `icon_extractor.lua` — decodes FFXI DAT item icons to BMP.
- `ui/` — vite build output; deploy copies `addon/gearswapui/` to
  `windower/addons/gearswapui/` (keep in sync; `data/` there is live state).

### Web UI — `src/app/`

- `sets/sets.store.ts` — profile-scoped `FileSets` model: sets + set-type
  bindings per GearSwap file, `sets.*` auto-import on selection, auto-save of
  the previous profile on switch, managed `<gearswapui sets>` block spliced
  into `get_sets()` (default handlers injected only when the profile has
  none). localStorage `gsui.sets.v2` is metadata/unbound-set cache; profile
  Lua is authoritative.
- `sets/sets.view.tsx` — file picker, save/dirty/reload header, set dropdown
  + new-set dialog, icon grid with `×` clear + `!` missing markers, bindings
  panel, slot/bag/text-filtered item picker, detail panel.
- `inventory/inventory.view.tsx`, `files/files.view.tsx` — bag/slot filters,
  icons, detail panel; file browser/editor.
- `core/addon-api.service.ts` — same-origin API client (state SSE, files,
  `sendCommand`, `iconUrl`, `reloadGearswap`); `VITE_GSUI_API` for dev.
- `core/host.ts` — shell shim: `host.hide()`/`host.quit()` call the Wails
  Go bindings (`window.go.main.App.*`) when present, `window.close()`
  otherwise; Esc-hide is wired in `main.tsx` (capture phase — Electron
  handles Esc natively via `before-input-event`).

### Overlay — `overlay/`

- `wails/` — the shippable shell (Wails **v3**, ~11MB exe, `go build -tags
  production`): probes `127.0.0.1:17890-17899` for `/api/status`
  (`$GSUI_PORT` overrides), then `SetURL` navigates the frameless +
  AlwaysOnTop window to the addon page once `app.Run` has created the
  window impl (`SetURL` is a no-op while `NativeWindow()` is nil).
  `SingleInstanceOptions` surfaces the first window on re-launch;
  `Windows.HiddenOnTaskbar` keeps it out of the taskbar/alt-tab.
  `keepPinned` goroutine re-asserts `HWND_TOPMOST` every 2s (skipped while
  focused, same as Electron), and `WindowMinimise` → `Show()` undoes the
  frameless auto-minimize quirk. The window has two modes: a 56px
  transparent **fab** (`--fab` arg; the addon auto-spawns it on load,
  `settings.fab`, `//gsui fab on|off`) and the full UI.
  `expand()`/`collapse()` swap min-size/resizable/bounds; both geometries
  persist in `%LOCALAPPDATA%/gearswapui/window.json`. The page picks what
  to render from viewport size (`fabMode` signal in host.ts);
  `body.fab-mode` drops the opaque background so the button reads
  circular — `BackgroundType: BackgroundTypeTransparent` makes the
  WebView2 backdrop transparent. Chrome on the foreign-origin page works
  through Wails' raw message channel — v3 routes `wails:drag` /
  `wails:resize:<cursor>` from any main-frame origin (unlike v2's
  origin-gated bindings), and `gsui:expand`/`gsui:collapse`/`gsui:quit`
  land in `RawMessageHandler`; `src/app/core/host.ts` posts them via
  `chrome.webview.postMessage`. Esc and × collapse to the fab; only
  `//lua unload` (taskkill) or fab right-click quits the process.
  Drag region: `--wails-draggable` in `src/styles.css`; edge-resize
  cursors/zones are detected in-page (8px border, fab mode excluded)
  since `WM_NCHITTEST` never reaches the webview child window.
  Logs to `%LOCALAPPDATA%/gearswapui/overlay.log`; WebView2 UDF at
  `%LOCALAPPDATA%/gearswapui/webview2`.
- `launch.mjs` — dev path: spawns Electron detached, strips
  `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE` (set in this
  machine's env), pipes child stdio to `overlay.log`, exits immediately.
- `main.cjs` — borderless always-on-top (`screen-saver` level) window loading
  `http://127.0.0.1:<GSUI_PORT|17890>/`; single-instance lock (re-invoke =
  focus + `reloadIgnoringCache`, which doubles as the refresh path);
  `disableHardwareAcceleration` (frameless resize crashed some GPU stacks);
  `minimize` → `restore` (frameless+skipTaskbar auto-minimize quirk);
  periodic `moveTop` re-pin; `Esc` hides. Header is the drag region via
  injected CSS.

## Verify / build

- `npm run build:addon` — typecheck + vite build into `addon/gearswapui/ui/`
- `npm run build:overlay` — go build the Wails shell into
  `addon/gearswapui/overlay/gsui-overlay.exe`
- `npm run deploy` — sync `addon/gearswapui/` → `../addons/gearswapui/`
  (live Windower install; preserves its `data/`)
- `npm run release` — build ui + overlay, then `dist/gearswapui-<ver>.zip`:
  the standalone addon (extract into `addons/`)
- `node scripts/smoke-test.mjs` — runs the real `gearswapui.lua` under
  fengari with stubs; covers HTTP routes, SSE, file CRUD, swap scanner,
  commands
- fengari cannot parse `'x':method()` literal calls in Windower libs — those
  can't be exercised locally

## Removed paths (historical)

- `src/ingame/` prim-based in-game UI, `igui_bridge.lua`, compiled `igui/` —
  superseded by the overlay (OS-level window = free input capture, no
  blockinput/hitList hacks).
- `tools/inputguard/` WH_MOUSE_LL companion — hook installed but never fired
  callbacks on this machine.
- `fenestra/` + `src/fenestra/` — dev-Windower port scaffold; Fenestra has no
  releases, failing CI, missing console/stack-traces, and a known unfixed
  action-injection bug.
