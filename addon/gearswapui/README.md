# gearswapui (Windower 4 addon)

Companion addon for the gearswap-ui frontend. It runs a small local HTTP
server (LuaSocket) that:

- serves the bundled frontend from `./ui`
- streams the player's inventory / wardrobes over SSE at `/api/events`
- exposes GearSwap lua files under `addons/GearSwap/data` for listing,
  reading, and writing
- optionally reuses GearSwap's own `extdata.lua` to decode augment data
- draws a small on-screen panel listing every `sets.*` path found in the
  current job's GearSwap file (and its `include()`s); click a set to
  equip it via `gs equip`

## Install

1. Copy this whole `gearswapui` folder into `Windower4/addons/`.
2. Build the frontend into `./ui` (from the repo root):

   ```
   npm run build:addon
   ```

   That produces `addons/gearswapui/ui/index.html` + assets inside the
   addon folder.

3. In game: `//lua load gearswapui` (or add it to your init script).

## Commands

| Command                  | Action                                        |
| ------------------------ | --------------------------------------------- |
| `//gsui`                 | show status / help                            |
| `//gsui ui`              | toggle the in-game UI (inventory/sets/files)  |
| `//gsui open`            | open the UI in the default browser            |
| `//gsui start`           | start the local server                        |
| `//gsui stop`            | stop the local server                         |
| `//gsui port <n>`        | change the port (saved to data/settings.xml)  |
| `//gsui refresh`         | push a fresh state snapshot to clients        |
| `//gsui swap`            | toggle the in-game UI (same as `//gsui ui`)   |
| `//gsui swap scan`       | rescan the GearSwap file for `sets.*` paths   |
| `//gsui swap list`       | print discovered sets to the chat log         |
| `//gsui swap add <path>` | pin a set path the scanner can't see          |
| `//gsui swap remove <p>` | remove a pinned set path                      |
| `//gsui equip <path>`    | equip a set, e.g. `//gsui equip idle.Town`    |

## Set scanner

`swapui.lua` is a headless module that finds `sets.*` paths by scanning the
GearSwap file GearSwap itself would load for the current player/job
(`data/<name>/`, `data/common/`, `data/`, plus the
`%APPDATA%/Windower/GearSwap` mirrors, following `include()` and `require()`
calls one level at a time). The in-game UI's Sets tab renders the result
and equips sets on click.

- Only assignments the scanner can see are listed — sets built at runtime
  (e.g. via `set_combine` inside functions, or Mote-style dynamic paths)
  can be pinned with `//gsui swap add`.
- Pinned paths persist in `data/settings.xml`.

## HTTP API

All endpoints are on `http://127.0.0.1:<port>` (default `17890`) and send
CORS headers, so a vite dev server on another origin can also talk to it.

| Route                                   | Description                              |
| --------------------------------------- | ---------------------------------------- |
| `GET /api/status`                       | addon version, port, gearswap dir        |
| `GET /api/state`                        | full inventory snapshot (JSON)           |
| `GET /api/events`                       | SSE stream of `state` events             |
| `GET /api/gearswap/files`               | list `.lua` files in GearSwap data dir   |
| `GET /api/gearswap/file?path=<rel>`     | read a file (relative to data dir)       |
| `PUT /api/gearswap/file?path=<rel>`     | write a file (raw lua body)              |
| `POST /api/gearswap/reload`             | runs `gs reload`                         |
| `GET /*`                                | static files from `ui/` (SPA fallback)   |

File paths are sandboxed: only `.lua` files beneath the GearSwap `data`
directory can be read or written, `..` is rejected.

## Data shape

```jsonc
{
  "timestamp": 1750000000,
  "player": { "name": "X", "main_job": "WAR", "main_job_id": 1,
              "main_job_level": 99, "sub_job": "NIN", ... },
  "bags": [
    { "id": 0, "key": "inventory", "name": "Inventory", "enabled": true,
      "max": 80, "count": 42,
      "items": [
        { "slot": 1, "id": 12345, "count": 1, "status": 0,
          "equipped": false, "extdata": "0123...", "augments": ["..."] }
      ] }
  ],
  "catalog": {
    "12345": { "id": 12345, "name": "...", "category": "Armor",
               "level": 99, "ilvl": 119, "slots": ["feet"],
               "jobs": ["WAR"], "all_jobs": false, "rare": true,
               "ex": true, "flags": 33089, "stack": 1 }
  }
}
```
