_addon.name = 'gearswapui'
_addon.author = 'gearswap-ui'
_addon.version = '1.0.0'
_addon.commands = { 'gsui', 'gearswapui' }

--[[
    GearSwap UI companion addon.

    Runs a small local HTTP server (LuaSocket) that:
      * serves the bundled frontend from ./ui
      * streams player inventory/wardrobe state over SSE at /api/events
      * exposes GearSwap lua files under addons/GearSwap/data for read/write

    Commands:
      //gsui          - status + help
      //gsui open     - open the UI in the default browser
      //gsui overlay  - launch the Electron overlay window
      //gsui start    - start the server
      //gsui stop     - stop the server
      //gsui port <n> - change the port (restarts the server)
      //gsui refresh  - push a fresh state snapshot to connected clients
      //gsui swap     - toggle the on-screen set picker (see //gsui swap help)
      //gsui equip <set> - equip a sets.* path via GearSwap (`gs equip`)
]]

local socket = require('socket')
local res = require('resources')
local config = require('config')
local ok_macros, macrofs = pcall(require, 'macros')
if not ok_macros then macrofs = nil end

local defaults = {
    port = 17890,
    autostart = true,
    -- auto-launch the floating overlay button on load; //gsui fab off
    -- disables it (then use //gsui overlay to open manually)
    fab = true,
    poll_interval = 1.5,
    swapui = {
        -- headless set scanner: custom[] holds sets added via `//gsui swap add`
        custom = {},
    },
}
local settings = config.load(defaults)
config.save(settings)

local CHAT_COLOR = 207

local function log(msg)
    windower.add_to_chat(CHAT_COLOR, '[gsui] ' .. msg)
end

local function log_err(msg)
    windower.add_to_chat(39, '[gsui] ' .. msg)
end

----------------------------------------------------------------------
-- Path helpers
----------------------------------------------------------------------

local function join(a, b)
    if a:sub(-1) ~= '\\' and a:sub(-1) ~= '/' then
        a = a .. '\\'
    end
    return a .. b
end

local ui_dir = join(windower.addon_path, 'ui')

local function gearswap_data_dir()
    local candidates = {
        'addons\\GearSwap\\data',
        'addons\\gearswap\\data',
    }
    for _, rel in ipairs(candidates) do
        local dir = join(windower.windower_path, rel)
        if windower.dir_exists(dir) then
            return dir
        end
    end
    return join(windower.windower_path, 'addons\\GearSwap\\data')
end

----------------------------------------------------------------------
-- Minimal JSON encoder
----------------------------------------------------------------------

local json

do
    local function esc(s)
        return (s:gsub('[%c"\\]', function(c)
            if c == '"' then return '\\"' end
            if c == '\\' then return '\\\\' end
            return string.format('\\u%04x', c:byte())
        end))
    end

    local function encode(v)
        local t = type(v)
        if t == 'nil' then
            return 'null'
        elseif t == 'boolean' or t == 'number' then
            return tostring(v)
        elseif t == 'string' then
            return '"' .. esc(v) .. '"'
        elseif t == 'table' then
            -- Decide array vs object: __json_array forces array, otherwise
            -- array when every key is an integer 1..n. Check the marker first:
            -- it is itself a string key and would defeat the key scan.
            local n = #v
            local is_arr = rawget(v, '__json_array') == true
            if not is_arr then
                is_arr = next(v) ~= nil
                if is_arr then
                    for k in pairs(v) do
                        if type(k) ~= 'number' or k < 1 or k > n or k % 1 ~= 0 then
                            is_arr = false
                            break
                        end
                    end
                end
            end
            if is_arr then
                local parts = {}
                for i = 1, n do
                    parts[i] = encode(v[i])
                end
                return '[' .. table.concat(parts, ',') .. ']'
            end
            local parts = {}
            for k, val in pairs(v) do
                if type(k) == 'string' and k ~= '__json_array' then
                    parts[#parts + 1] = '"' .. esc(k) .. '":' .. encode(val)
                end
            end
            return '{' .. table.concat(parts, ',') .. '}'
        end
        return 'null'
    end

    json = { encode = encode }
end

local function json_array(t)
    rawset(t, '__json_array', true)
    return t
end

----------------------------------------------------------------------
-- Inventory collection
----------------------------------------------------------------------

local BAGS = {
    [0] = 'inventory',
    [1] = 'safe',
    [2] = 'storage',
    [4] = 'locker',
    [5] = 'satchel',
    [6] = 'sack',
    [7] = 'case',
    [8] = 'wardrobe',
    [9] = 'safe2',
    [10] = 'wardrobe2',
    [11] = 'wardrobe3',
    [12] = 'wardrobe4',
    [13] = 'wardrobe5',
    [14] = 'wardrobe6',
    [15] = 'wardrobe7',
    [16] = 'wardrobe8',
}

-- resources.lua post-processes bitmasks into S sets: jobs/slots/races hold
-- member ids as keys, flags holds flag-name strings as keys. Iterate pairs.
local function set_has(set, key)
    return type(set) == 'table' and rawget(set, key) == true
end

local SLOT_NAMES = {}
do
    for i = 0, 15 do
        local s = res.slots and res.slots[i]
        SLOT_NAMES[i] = (s and (s.en or s.english)) or ('slot' .. i)
    end
end

local JOB_SHORTS = {}
do
    for i = 1, 23 do
        local j = res.jobs and res.jobs[i]
        JOB_SHORTS[i] = j and (j.ens or j.en) or nil
    end
end

local function decode_slots(slotset)
    local out = json_array({})
    if type(slotset) ~= 'table' then return out end
    for slot_id in pairs(slotset) do
        if SLOT_NAMES[slot_id] then
            out[#out + 1] = SLOT_NAMES[slot_id]
        end
    end
    return out
end

local function decode_jobs(jobset)
    local out = json_array({})
    local count = 0
    if type(jobset) == 'table' then
        for job_id in pairs(jobset) do
            local name = JOB_SHORTS[job_id]
            if name then
                out[#out + 1] = name
                count = count + 1
            end
        end
    end
    return out, count >= 22
end

local function decode_flags(flagset)
    local out = json_array({})
    if type(flagset) == 'table' then
        for name in pairs(flagset) do
            if type(name) == 'string' then
                out[#out + 1] = name
            end
        end
        table.sort(out)
    end
    return out
end

-- Optional: reuse GearSwap's extdata augment decoder when it is installed.
local extdata_decoder = nil
local extdata_tried = false

local function try_extdata(item_id, extdata_hex)
    if not extdata_tried then
        extdata_tried = true
        local path = join(windower.windower_path, 'addons\\GearSwap\\extdata.lua')
        if windower.file_exists(path) then
            local ok, ret = pcall(dofile, path)
            if ok then
                if type(ret) == 'table' and type(ret.decode) == 'function' then
                    extdata_decoder = ret
                elseif type(_G.extdata) == 'table' and type(_G.extdata.decode) == 'function' then
                    extdata_decoder = _G.extdata
                end
            end
        end
        if extdata_decoder == nil then
            log('GearSwap extdata decoder not available; sending raw extdata only.')
        end
    end
    if not extdata_decoder or not extdata_hex or extdata_hex == '' then
        return nil
    end
    -- Rebuild the binary extdata string from hex.
    local raw = (extdata_hex:gsub('..', function(cc)
        return string.char(tonumber(cc, 16))
    end))
    local ok, decoded = pcall(extdata_decoder.decode, { id = item_id, extdata = raw })
    if ok and type(decoded) == 'table' and type(decoded.augments) == 'table' then
        local out = json_array({})
        for _, aug in pairs(decoded.augments) do
            if type(aug) == 'string' then
                out[#out + 1] = aug
            elseif type(aug) == 'table' then
                out[#out + 1] = aug
            end
        end
        if #out > 0 then
            return out
        end
    end
    return nil
end

local function item_meta(id)
    local item = res.items and res.items[id]
    if not item then
        return nil
    end
    local jobs, all_jobs = decode_jobs(item.jobs)
    local flags = item.flags
    return {
        id = id,
        name = item.en or item.english or item.name or ('item ' .. id),
        name_log = item.enl,
        category = item.category,
        level = item.level,
        ilvl = item.ilvl or item.ilevel or item.superior_level,
        slots = decode_slots(item.slots),
        jobs = jobs,
        all_jobs = all_jobs,
        flags = decode_flags(flags),
        rare = set_has(flags, 'Rare'),
        ex = set_has(flags, 'Exclusive'),
        stack = item.stack,
        type = item.type,
        description = item.description,
    }
end

local function hex(s)
    if not s then return nil end
    return (s:gsub('.', function(c)
        return string.format('%02X', c:byte())
    end))
end

local function collect_state()
    local state = {
        timestamp = os.time(),
        bags = json_array({}),
        catalog = {},
    }

    local player = windower.ffxi.get_player()
    if player then
        local main_job = res.jobs and res.jobs[player.main_job_id]
        local sub_job = player.sub_job_id and res.jobs and res.jobs[player.sub_job_id]
        state.player = {
            name = player.name,
            main_job = main_job and (main_job.ens or main_job.en) or tostring(player.main_job_id),
            main_job_id = player.main_job_id,
            main_job_level = player.main_job_level,
        }
        if player.sub_job_id and player.sub_job_id > 0 then
            state.player.sub_job = sub_job and (sub_job.ens or sub_job.en)
                or tostring(player.sub_job_id)
            state.player.sub_job_id = player.sub_job_id
            state.player.sub_job_level = player.sub_job_level
        end
    end

    -- get_items() / get_bag_info() are keyed by lowercase bag name
    -- ('inventory', 'wardrobe2', ...) matching the BAGS values; numeric ids
    -- are accepted too, so fall back to both.
    local all_items, bag_infos = nil, nil
    local ok_items, items_t = pcall(windower.ffxi.get_items)
    if ok_items and type(items_t) == 'table' then all_items = items_t end
    local ok_infos, infos_t = pcall(windower.ffxi.get_bag_info)
    if ok_infos and type(infos_t) == 'table' then bag_infos = infos_t end

    -- items.equipment maps equip slot name -> {slot=<bag index>,
    -- bag_id=<bag>}. Flatten to 'bag:index -> /unequip slot' so equipped
    -- items can report which slot they occupy.
    local EQUIP_CMD = {
        lear = 'l.ear', rear = 'r.ear',
        lring = 'l.ring', rring = 'r.ring',
    }
    local equip_slots = {}
    if type(all_items) == 'table' and type(all_items.equipment) == 'table' then
        for slot_name, eq in pairs(all_items.equipment) do
            if type(eq) == 'table' and tonumber(eq.slot) then
                local key = ('%.0f:%.0f'):format(tonumber(eq.bag_id) or 0, tonumber(eq.slot))
                equip_slots[key] = EQUIP_CMD[slot_name] or slot_name
            end
        end
    end

    for bag_id, bag_key in pairs(BAGS) do
        local items = all_items and (all_items[bag_key] or all_items[bag_id])
        local info = bag_infos and (bag_infos[bag_key] or bag_infos[bag_id])
        if type(items) == 'table' or type(info) == 'table' then
            local bag = {
                id = bag_id,
                key = bag_key,
                name = bag_key:gsub('(%a)(%a*)', function(a, b) return a:upper() .. b end),
                enabled = not (type(info) == 'table' and info.enabled == false),
                max = type(info) == 'table' and info.max or nil,
                count = type(info) == 'table' and info.count or nil,
                items = json_array({}),
            }
            local res_bag = res.bags and res.bags[bag_id]
            if res_bag and (res_bag.en or res_bag.english) then
                bag.name = res_bag.en or res_bag.english
            end

            if type(items) == 'table' then
                for slot, entry in pairs(items) do
                    if type(slot) == 'number' and type(entry) == 'table' and entry.id and entry.id > 0 then
                        local ext = hex(entry.extdata)
                        local rec = {
                            slot = entry.slot or slot,
                            id = entry.id,
                            count = entry.count,
                            status = entry.status,
                            equipped = entry.status == 5,
                            equip_slot = equip_slots[('%.0f:%.0f'):format(bag_id, tonumber(entry.slot) or tonumber(slot) or -1)],
                            extdata = ext,
                        }
                        local augs = try_extdata(entry.id, ext)
                        if augs then
                            rec.augments = augs
                        end
                        bag.items[#bag.items + 1] = rec
                        -- Explicit int format: tostring() on a float can
                        -- produce '12345.0' and break id lookups.
                        local key = ('%.0f'):format(entry.id)
                        if state.catalog[key] == nil then
                            state.catalog[key] = item_meta(entry.id) or { id = entry.id, name = 'item ' .. entry.id }
                        end
                    end
                end
            end
            table.sort(bag.items, function(a, b) return a.slot < b.slot end)
            state.bags[#state.bags + 1] = bag
        end
    end
    table.sort(state.bags, function(a, b) return a.id < b.id end)

    return state
end

----------------------------------------------------------------------
-- GearSwap file API
----------------------------------------------------------------------

local function sanitize_rel_path(p)
    if type(p) ~= 'string' or p == '' then return nil end
    if p:find('%.%.') or p:find('^[/\\]') or p:find('^%a:') then return nil end
    if not p:match('^[%w%._%-%/\\ ]+$') then return nil end
    if not p:lower():match('%.lua$') then return nil end
    return p
end

local function list_gearswap_files()
    local dir = gearswap_data_dir()
    local files = json_array({})
    local found = windower.dir_exists(dir)
    if found then
        local function scan(sub)
            local base = sub and join(dir, sub) or dir
            local entries = windower.get_dir(base)
            if type(entries) ~= 'table' then return end
            table.sort(entries)
            for _, name in ipairs(entries) do
                local full = join(base, name)
                if windower.dir_exists(full) then
                    if not sub then
                        scan(name) -- one level deep: player-named folders
                    end
                elseif name:lower():match('%.lua$') then
                    files[#files + 1] = {
                        path = sub and (sub .. '/' .. name) or name,
                        name = name,
                        dir = sub or '',
                    }
                end
            end
        end
        scan(nil)
    end
    return { dir = dir, found = found, files = files }
end

local function read_gearswap_file(rel)
    rel = sanitize_rel_path(rel)
    if not rel then return nil, 'invalid path' end
    local full = join(gearswap_data_dir(), rel)
    local f = io.open(full, 'rb')
    if not f then return nil, 'not found' end
    local content = f:read('*a')
    f:close()
    return { path = rel, content = content }
end

local function write_gearswap_file(rel, content)
    rel = sanitize_rel_path(rel)
    if not rel then return nil, 'invalid path' end
    if type(content) ~= 'string' then return nil, 'missing content' end
    local full = join(gearswap_data_dir(), rel)
    -- Create the parent directory when writing into a new player folder.
    local parent = full:match('^(.*)[/\\][^/\\]+$')
    if parent and not windower.dir_exists(parent) then
        windower.create_dir(parent)
    end
    local f, err = io.open(full, 'wb')
    if not f then return nil, tostring(err) end
    f:write(content)
    f:close()
    return { ok = true, path = rel }
end

----------------------------------------------------------------------
-- On-screen swap UI
----------------------------------------------------------------------

local swapui = nil
do
    local ok, mod = pcall(dofile, join(windower.addon_path, 'swapui.lua'))
    if ok and type(mod) == 'table' then
        swapui = mod
        swapui.setup({
            cfg = settings.swapui,
            save = function() config.save(settings) end,
            data_dir = gearswap_data_dir,
            player = function()
                local ok2, p = pcall(windower.ffxi.get_player)
                if ok2 then return p end
                return nil
            end,
            jobs = res.jobs,
            log = log,
            log_err = log_err,
        })
    else
        log_err('swapui.lua failed to load: ' .. tostring(mod))
    end
end

----------------------------------------------------------------------
-- HTTP server
----------------------------------------------------------------------

local MIME = {
    html = 'text/html; charset=utf-8',
    js = 'text/javascript; charset=utf-8',
    mjs = 'text/javascript; charset=utf-8',
    css = 'text/css; charset=utf-8',
    json = 'application/json; charset=utf-8',
    svg = 'image/svg+xml',
    png = 'image/png',
    jpg = 'image/jpeg',
    ico = 'image/x-icon',
    map = 'application/json',
    woff = 'font/woff',
    woff2 = 'font/woff2',
    ttf = 'font/ttf',
    txt = 'text/plain; charset=utf-8',
}

local server = nil
local bound_port = nil
local conns = {}          -- all accepted connections: {sock, buf}
local last_state_json = nil
local last_poll = 0
local pending_state = nil -- cached state table between polls
local heartbeat_at = 0
local last_job_id = nil   -- job the swap list was last scanned for

local CORS = 'Access-Control-Allow-Origin: *\r\n'
    .. 'Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n'
    .. 'Access-Control-Allow-Headers: Content-Type\r\n'

local function status_line(code)
    local names = {
        [200] = 'OK', [204] = 'No Content', [400] = 'Bad Request',
        [404] = 'Not Found', [405] = 'Method Not Allowed',
        [500] = 'Internal Server Error',
    }
    return 'HTTP/1.1 ' .. code .. ' ' .. (names[code] or 'Status')
end

-- Non-blocking send can write partially; loop until the buffer drains.
local function send_all(sock, data)
    local i = 1
    local tries = 0
    while i <= #data do
        local sent, err, last = sock:send(data, i)
        if sent then
            if sent < i then
                -- No forward progress: don't spin the prerender loop forever.
                tries = tries + 1
                if tries > 2000 then return false end
            end
            i = sent + 1
        elseif last and last >= i then
            i = last + 1
        else
            if err == 'closed' then return false end
            tries = tries + 1
            if tries > 2000 then return false end
        end
    end
    return true
end

local function send_and_close(conn, code, body, ctype, no_cache)
    body = body or ''
    local resp = status_line(code) .. '\r\n'
        .. 'Content-Type: ' .. (ctype or 'text/plain; charset=utf-8') .. '\r\n'
        .. 'Content-Length: ' .. #body .. '\r\n'
        .. (no_cache and 'Cache-Control: no-cache\r\n' or '')
        .. CORS
        .. 'Connection: close\r\n\r\n'
        .. body
    pcall(send_all, conn.sock, resp)
    conn.closed = true
    pcall(function() conn.sock:close() end)
end

local function send_json(conn, code, tbl)
    send_and_close(conn, code, json.encode(tbl), 'application/json; charset=utf-8')
end

local function current_state_json()
    if pending_state == nil then
        pending_state = collect_state()
        last_state_json = json.encode(pending_state)
    end
    return last_state_json
end

local function broadcast_state()
    local body = 'event: state\ndata: ' .. current_state_json() .. '\n\n'
    for _, conn in ipairs(conns) do
        if conn.sse and not conn.closed then
            local ok = send_all(conn.sock, body)
            if not ok then
                conn.closed = true
                pcall(function() conn.sock:close() end)
            end
        end
    end
end

local function serve_static(conn, url_path)
    local path = url_path:gsub('^/+', '')
    if path == '' then path = 'index.html' end
    path = path:gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end)
    if path:find('%.%.') then
        return send_and_close(conn, 400, 'bad path')
    end
    local full = join(ui_dir, path)
    local f = io.open(full, 'rb')
    if not f then
        -- SPA fallback: extensionless paths get index.html
        if not path:match('%.[%w]+$') then
            f = io.open(join(ui_dir, 'index.html'), 'rb')
            path = 'index.html'
        end
        if not f then
            return send_and_close(conn, 404,
                'not found - is the UI built? expected files in ' .. ui_dir)
        end
    end
    local body = f:read('*a')
    f:close()
    local ext = path:match('%.([%w]+)$')
    -- hashed assets can cache hard; index.html and friends must revalidate or
    -- a stale cached shell pins the browser to an old bundle after a rebuild
    local no_cache = ext == nil or ext:lower() == 'html'
    send_and_close(
        conn,
        200,
        body,
        MIME[ext and ext:lower()] or 'application/octet-stream',
        no_cache
    )
end

local routes = {}

routes['GET /api/status'] = function(conn)
    send_json(conn, 200, {
        addon = _addon.name,
        version = _addon.version,
        port = bound_port or settings.port,
        sse_clients = (function()
            local n = 0
            for _, c in ipairs(conns) do if c.sse and not c.closed then n = n + 1 end end
            return n
        end)(),
        gearswap_dir = gearswap_data_dir(),
    })
end

routes['GET /api/state'] = function(conn)
    send_and_close(conn, 200, current_state_json(), 'application/json; charset=utf-8')
end

routes['GET /api/gearswap/files'] = function(conn)
    send_json(conn, 200, list_gearswap_files())
end

routes['GET /api/gearswap/file'] = function(conn, req)
    local rel = req.query.path
    local out, err = read_gearswap_file(rel)
    if not out then
        return send_json(conn, 404, { error = err })
    end
    send_json(conn, 200, out)
end

routes['PUT /api/gearswap/file'] = function(conn, req)
    local out, err = write_gearswap_file(req.query.path, req.body)
    if not out then
        return send_json(conn, 400, { error = err })
    end
    send_json(conn, 200, out)
end

routes['POST /api/gearswap/file'] = routes['PUT /api/gearswap/file']

routes['POST /api/gearswap/reload'] = function(conn)
    windower.send_command('gs reload')
    send_json(conn, 200, { ok = true })
end

-- Run a windower command on behalf of the UI (`//gs equip`, etc.)
-- Pull a top-level string field out of a JSON body by hand: the bundled
-- json table is encode-only, and Lua patterns can't quantify captures so
-- "(escape|char)*" style matchers silently fail. Scan the string literal
-- directly, honoring backslash escapes.
local function json_string(body, key)
    local _, e = body:find('"' .. key .. '"%s*:%s*"')
    if not e then return nil end
    local i, out = e + 1, {}
    while i <= #body do
        local c = body:sub(i, i)
        if c == '"' then
            return table.concat(out)
        elseif c == '\\' then
            local n = body:sub(i + 1, i + 1)
            if n == 'n' then out[#out + 1] = '\n'
            elseif n == 't' then out[#out + 1] = '\t'
            elseif n == 'r' then out[#out + 1] = '\r'
            elseif n == 'u' then i = i + 4 -- \uXXXX: commands are ASCII, skip
            else out[#out + 1] = n end
            i = i + 2
        else
            out[#out + 1] = c
            i = i + 1
        end
    end
    return nil -- unterminated string
end

routes['POST /api/command'] = function(conn, req)
    local cmd = json_string(req.body or '', 'cmd')
    if type(cmd) ~= 'string' or cmd == '' then
        return send_json(conn, 400, { error = 'missing cmd' })
    end
    windower.send_command(cmd)
    send_json(conn, 200, { ok = true })
end

-- Item actions that need native calls/packet injection rather than a
-- windower command (equip/use go through POST /api/command instead).
-- body: {"action":"drop","bag":0,"index":<slot>,"count":<n>}
--       {"action":"move","bag":<id>,"index":<slot>,"count":<n>,"target":<bag id>}
routes['POST /api/item'] = function(conn, req)
    local body = req.body or ''
    local action = body:match('"action"%s*:%s*"([^"]+)"')
    local function num(k) return tonumber((body:match('"' .. k .. '"%s*:%s*(%d+)'))) end
    local bag, index = num('bag'), num('index')
    local count, target = num('count') or 1, num('target')
    if action == 'drop' then
        if bag ~= 0 or index == nil then
            return send_json(conn, 400, { error = 'drop needs inventory bag + index' })
        end
        local ok, err = pcall(windower.ffxi.drop_item, index, count)
        if not ok then
            return send_json(conn, 500, { error = tostring(err) })
        end
        return send_json(conn, 200, { ok = true })
    elseif action == 'move' then
        if not (bag and index and target) then
            return send_json(conn, 400, { error = 'move needs bag/index/target' })
        end
        local ok_p, packets = pcall(require, 'packets')
        if not ok_p or type(packets) ~= 'table' then
            return send_json(conn, 500, { error = 'packets lib unavailable' })
        end
        -- 0x029 move item; target index 0x52 = "any free slot" in the dest bag
        packets.inject(packets.new('outgoing', 0x029, {
            ['Count'] = count,
            ['Bag'] = bag,
            ['Target Bag'] = target,
            ['Current Index'] = index,
            ['Target Index'] = 0x52,
        }))
        return send_json(conn, 200, { ok = true })
    end
    send_json(conn, 400, { error = 'unknown action' })
end

----------------------------------------------------------------------
-- FFXI macro files (<ffxi>/USER/<content id>/mcr*.dat + mcr*.ttl)
-- The client only guarantees reading these at login; while a character is
-- logged in it may rewrite them from memory, so PUT responses carry a
-- `logged_in` flag the UI turns into a warning.
----------------------------------------------------------------------

local function macro_logged_in()
    local ok, info = pcall(windower.ffxi.get_info)
    return ok and type(info) == 'table' and info.logged_in == true
end

local function macro_char_dir(char_id)
    if type(char_id) ~= 'string' or not char_id:match('^[%w]+$')
        or type(windower.ffxi_path) ~= 'string' then
        return nil
    end
    local dir = join(join(windower.ffxi_path, 'USER'), char_id)
    return windower.dir_exists(dir) and dir or nil
end

routes['GET /api/macros'] = function(conn)
    if not macrofs then
        return send_json(conn, 500, { error = 'macros module unavailable' })
    end
    local chars = {}
    for _, d in ipairs(macrofs.find_char_dirs(windower.ffxi_path)) do
        local pals = macrofs.read_palettes(d.path)
        for _, p in ipairs(pals) do
            for _, m in ipairs(p.macros) do
                m.lines = json_array(m.lines)
            end
            p.macros = json_array(p.macros)
        end
        chars[#chars + 1] = {
            id = d.id,
            titles = json_array(macrofs.read_titles(d.path)),
            palettes = json_array(pals),
        }
    end
    send_json(conn, 200, {
        logged_in = macro_logged_in(),
        characters = json_array(chars),
    })
end

-- Delay between client macro-book switches. PR #1892: loading a book twice
-- in rapid succession can corrupt + wipe its files — pace commands at the
-- client's own minimum delay.
local MACRO_SWITCH_DELAY = 1.5
local macro_schedule = coroutine.schedule or function(f) f() end

-- body: {"char":"<content id>","index":<0-399>,
--        "macros":[{"name":"x","lines":["/a",...x6]}, ... x20]}
-- ?apply=1 (and logged in): force the client to re-read the book by
-- switching away before writing, then switching back — the file lands
-- while the book is unloaded so the stale in-memory copy can't clobber it.
routes['PUT /api/macros/palette'] = function(conn, req)
    if not macrofs then
        return send_json(conn, 500, { error = 'macros module unavailable' })
    end
    local body = macrofs.json_decode(req.body or '')
    if type(body) ~= 'table' then
        return send_json(conn, 400, { error = 'invalid json' })
    end
    local dir = macro_char_dir(body.char)
    local index = tonumber(body.index)
    if not dir then
        return send_json(conn, 400, { error = 'unknown character' })
    end
    if not index or index < 0 or index >= 400 or index % 1 ~= 0 then
        return send_json(conn, 400, { error = 'bad palette index' })
    end
    if type(body.macros) ~= 'table' or #body.macros > 20 then
        return send_json(conn, 400, { error = 'macros must be an array of up to 20' })
    end

    local apply = (req.query.apply == '1' or req.query.apply == 'true')
        and macro_logged_in()
    if apply then
        -- Validate + build the image now so errors stay synchronous; the
        -- bytes land in a scheduled step between book switches.
        local image, path = macrofs.palette_image(dir, index, body.macros)
        if not image then
            return send_json(conn, 400, { error = tostring(path) })
        end
        local book = math.floor(index / 10) + 1
        local page = index % 10 + 1
        local other = book == 1 and 2 or 1
        windower.send_command(('input /macro book %d'):format(other))
        macro_schedule(function()
            macrofs.commit_image(path, image)
            macro_schedule(function()
                windower.send_command(('input /macro book %d'):format(book))
                macro_schedule(function()
                    windower.send_command(('input /macro set %d'):format(page))
                end, MACRO_SWITCH_DELAY)
            end, MACRO_SWITCH_DELAY)
        end, MACRO_SWITCH_DELAY)
        return send_json(conn, 200, {
            ok = true,
            applied = true,
            file = macrofs.palette_file(index),
            book = book,
            palette = page,
            logged_in = true,
        })
    end

    local ok, err = macrofs.write_palette(dir, index, body.macros)
    if not ok then
        return send_json(conn, 400, { error = tostring(err) })
    end
    send_json(conn, 200, {
        ok = true,
        file = macrofs.palette_file(index),
        logged_in = macro_logged_in(),
    })
end

-- body: {"char":"<content id>","book":<1-40>,"title":"RDM"}
routes['PUT /api/macros/title'] = function(conn, req)
    if not macrofs then
        return send_json(conn, 500, { error = 'macros module unavailable' })
    end
    local body = macrofs.json_decode(req.body or '')
    if type(body) ~= 'table' then
        return send_json(conn, 400, { error = 'invalid json' })
    end
    local dir = macro_char_dir(body.char)
    local book = tonumber(body.book)
    if not dir then
        return send_json(conn, 400, { error = 'unknown character' })
    end
    if not book or book < 1 or book > 40 or book % 1 ~= 0 then
        return send_json(conn, 400, { error = 'book must be 1-40' })
    end
    if type(body.title) ~= 'string' then
        return send_json(conn, 400, { error = 'missing title' })
    end
    local ok, err = macrofs.write_title(dir, book, body.title)
    if not ok then
        return send_json(conn, 400, { error = tostring(err) })
    end
    send_json(conn, 200, { ok = true, logged_in = macro_logged_in() })
end

-- Item icons: serve extracted .bmp files; decode the DAT on first request.
-- item_by_id() coroutine.yield()s mid-write, so we drive it in a coroutine.
routes['GET /api/icon'] = function(conn, req)
    local id = tonumber(req.query.id)
    if not id or id <= 0 then
        return send_json(conn, 400, { error = 'bad id' })
    end
    local dir = join(join(windower.addon_path, 'data'), 'icons')
    local path = dir .. '\\' .. tostring(id) .. '.bmp'
    if not windower.file_exists(path) then
        local ok_x, icon_extractor = pcall(require, 'icon_extractor')
        if ok_x and icon_extractor and icon_extractor.item_by_id then
            if not windower.dir_exists(dir) then
                pcall(windower.create_dir, dir)
            end
            local co = coroutine.create(function()
                icon_extractor.item_by_id(id, path)
            end)
            local ok, err = true, nil
            repeat
                ok, err = coroutine.resume(co)
            until coroutine.status(co) == 'dead' or not ok
            if not ok then
                return send_json(conn, 500, { error = tostring(err) })
            end
        end
    end
    if not windower.file_exists(path) then
        return send_json(conn, 404, { error = 'no icon' })
    end
    local f = io.open(path, 'rb')
    if not f then return send_json(conn, 404, { error = 'no icon' }) end
    local bmp = f:read('*a')
    f:close()
    send_and_close(conn, 200, bmp, 'image/bmp')
end

routes['GET /api/events'] = function(conn)
    conn.sse = true
    local head = status_line(200) .. '\r\n'
        .. 'Content-Type: text/event-stream\r\n'
        .. 'Cache-Control: no-cache\r\n'
        .. CORS
        .. 'Connection: keep-alive\r\n\r\n'
    local ok = send_all(conn.sock, head)
    if not ok then
        conn.closed = true
        return
    end
    -- Send an immediate snapshot so the UI renders without waiting for a diff.
    send_all(conn.sock, 'event: state\ndata: ' .. current_state_json() .. '\n\n')
end

local function parse_request(conn)
    local buf = conn.buf
    local head_end = buf:find('\r\n\r\n', 1, true)
    if not head_end then
        -- Header cap: bail on garbage.
        if #buf > 16384 then
            send_and_close(conn, 400, 'headers too large')
        end
        return nil
    end
    local head = buf:sub(1, head_end - 1)
    local method, target = head:match('^(%S+)%s+(%S+)')
    if not method then
        send_and_close(conn, 400, 'bad request')
        return true
    end
    local headers = {}
    for line in head:gmatch('[^\r\n]+') do
        local k, v = line:match('^([%w%-]+):%s*(.+)$')
        if k then headers[k:lower()] = v end
    end
    local clen = tonumber(headers['content-length']) or 0
    local body_start = head_end + 4
    if #buf - (body_start - 1) < clen then
        return nil -- wait for the rest of the body
    end
    local body = buf:sub(body_start, body_start + clen - 1)

    local path, qs = target:match('^([^?]*)%??(.*)$')
    local query = {}
    for pair in (qs or ''):gmatch('[^&]+') do
        local k, v = pair:match('^([^=]+)=?(.*)$')
        if k then
            v = v:gsub('+', ' '):gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end)
            query[k] = v
        end
    end

    return {
        method = method,
        path = path,
        query = query,
        headers = headers,
        body = body,
    }
end

local function handle_request(conn, req)
    if req.method == 'OPTIONS' then
        return send_and_close(conn, 204, '')
    end
    if conn.sse then return end -- already streaming

    local handler = routes[req.method .. ' ' .. req.path]
    if handler then
        local ok, err = pcall(handler, conn, req)
        if not ok then
            log_err('handler error: ' .. tostring(err))
            if not conn.closed then
                send_json(conn, 500, { error = 'internal error' })
            end
        end
        return
    end

    if req.method == 'GET' then
        return serve_static(conn, req.path)
    end
    send_and_close(conn, 405, 'method not allowed')
end

local function service_sockets()
    if not server then return end

    -- Accept pending connections.
    while true do
        local client = server:accept()
        if not client then break end
        client:settimeout(0)
        client:setoption('tcp-nodelay', true)
        conns[#conns + 1] = { sock = client, buf = '' }
    end

    -- Pump each connection.
    for _, conn in ipairs(conns) do
        if not conn.closed and not conn.sse then
            local data, err, partial = conn.sock:receive(4096)
            local chunk = data or partial
            if chunk and #chunk > 0 then
                conn.buf = conn.buf .. chunk
            end
            if err == 'closed' then
                conn.closed = true
                pcall(function() conn.sock:close() end)
            else
                local req = parse_request(conn)
                if req then
                    handle_request(conn, req)
                    conn.buf = ''
                end
            end
        end
    end

    -- Prune dead connections.
    for i = #conns, 1, -1 do
        if conns[i].closed then
            table.remove(conns, i)
        end
    end
end

----------------------------------------------------------------------
-- Server lifecycle + polling
----------------------------------------------------------------------

local function start_server()
    if server then return true end
    local base_port = tonumber(settings.port) or 17890
    for offset = 0, 9 do
        local s, err = socket.bind('127.0.0.1', base_port + offset)
        if s then
            s:settimeout(0)
            server = s
            bound_port = base_port + offset
            if bound_port ~= base_port then
                log('port ' .. base_port .. ' busy, using ' .. bound_port .. ' instead')
            end
            log('listening on http://127.0.0.1:' .. bound_port ..
                ' - run //gsui open to launch the UI')
            return true
        end
    end
    log_err('could not bind a port near ' .. base_port)
    return false
end

local function stop_server()
    if server then
        pcall(function() server:close() end)
        server = nil
    end
    bound_port = nil
    for _, conn in ipairs(conns) do
        pcall(function() conn.sock:close() end)
    end
    conns = {}
    log('server stopped')
end

local function poll_state()
    local now = os.clock()
    if now - last_poll < (tonumber(settings.poll_interval) or 1.5) then
        return
    end
    last_poll = now
    local ok, state = pcall(collect_state)
    if not ok then
        return
    end
    pending_state = state
    -- GearSwap reloads the user file on job change; rescan the set list.
    if swapui and state.player then
        local jid = state.player.main_job_id
        if last_job_id ~= nil and jid ~= last_job_id then
            pcall(swapui.rescan)
        end
        last_job_id = jid
    end
    local encoded = json.encode(state)
    if encoded ~= last_state_json then
        last_state_json = encoded
        broadcast_state()
    end
end

-- Heartbeat keeps EventSource connections alive through proxies.
local function heartbeat()
    local now = os.clock()
    if now - heartbeat_at < 25 then return end
    heartbeat_at = now
    for _, conn in ipairs(conns) do
        if conn.sse and not conn.closed then
            local ok = send_all(conn.sock, ': heartbeat\n\n')
            if not ok then
                conn.closed = true
                pcall(function() conn.sock:close() end)
            end
        end
    end
end

local function pump()
    if not server then return end
    local ok, err = pcall(service_sockets)
    if not ok then
        log_err('socket error: ' .. tostring(err))
    end
    local ok2, err2 = pcall(poll_state)
    if not ok2 then
        log_err('poll error: ' .. tostring(err2))
    end
    heartbeat()
end

-- prerender is a DirectX hook: when the overlay fully occludes the game
-- (or it's minimized) presents can stop, which would starve the socket
-- pump entirely. time change (~0.6s ticks) and incoming chunks are driven
-- by the game loop, so they keep the server alive regardless of rendering.
windower.register_event('prerender', pump)
windower.register_event('time change', pump)
windower.register_event('incoming chunk', pump)

-- spawn the overlay shell. fab=true launches the collapsed floating
-- button (bundled exe only — no Electron fallback, it's too heavy to
-- auto-spawn). Returns true if something was launched.
local function launch_overlay(fab)
    local exe = windower.addon_path .. 'overlay\\gsui-overlay.exe'
    if windower.file_exists(exe) then
        os.execute('start "" "' .. exe .. '"' .. (fab and ' --fab' or ''))
        return true
    end
    if fab then return false end
    -- dev build: Electron via the repo sibling (needs node + npm i);
    -- launch.mjs scrubs ELECTRON_RUN_AS_NODE from the inherited env
    local script = windower.addon_path ..
        '..\\..\\gearswapui\\overlay\\launch.mjs'
    if windower.file_exists(script) then
        os.execute('start "" node "' .. script .. '"')
        return true
    end
    log_err('no overlay found (expected ' .. exe .. ')')
    return false
end

windower.register_event('addon command', function(cmd, ...)
    cmd = (cmd or ''):lower()
    local args = { ... }

    if cmd == '' or cmd == 'help' then
        log('commands: open | overlay | fab | start | stop | status | port <n> | refresh | swap | equip <set>')
    elseif cmd == 'open' then
        if server or start_server() then
            windower.open_url('http://127.0.0.1:' .. bound_port .. '/')
        end
    elseif cmd == 'overlay' then
        if not (server or start_server()) then return end
        if launch_overlay(false) then
            log('overlay launched')
        end
    elseif cmd == 'fab' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.fab = (sub == 'on')
            config.save(settings)
            log('auto-fab ' .. (settings.fab and 'enabled' or 'disabled'))
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true) then
            log('fab launched')
        end
    elseif cmd == 'start' then
        start_server()
    elseif cmd == 'stop' then
        stop_server()
    elseif cmd == 'status' then
        if server then
            log('listening on http://127.0.0.1:' .. bound_port ..
                ' | gearswap dir: ' .. gearswap_data_dir())
        else
            log('server stopped')
        end
    elseif cmd == 'port' then
        local p = tonumber(args[1])
        if not p or p < 1 or p > 65535 then
            log_err('usage: //gsui port <number>')
        else
            settings.port = p
            config.save(settings)
            if server then
                stop_server()
                start_server()
            end
            log('port set to ' .. p)
        end
    elseif cmd == 'refresh' then
        pending_state = nil
        last_state_json = nil
        poll_state()
        broadcast_state()
        if swapui then pcall(swapui.rescan) end
        log('state pushed to clients')
    elseif cmd == 'equip' then
        local path = table.concat(args, ' ')
        if path == '' then
            log_err('usage: //gsui equip <set path>  e.g. //gsui equip idle.Town')
        elseif swapui then
            swapui.equip(path)
        else
            windower.send_command('gs equip ' .. path)
        end
    elseif cmd == 'swap' then
        -- swapui is a headless scanner powering `//gsui equip` and the
        -- list/add/remove bookkeeping commands.
        local sub = (args[1] or ''):lower()
        if not swapui then
            log_err('set scanner unavailable (swapui.lua failed to load)')
        elseif sub == 'scan' then
            log('scanning gearswap files... ' .. swapui.rescan() .. ' set(s) found')
        elseif sub == 'list' then
            swapui.list()
        elseif sub == 'add' then
            local canon, err = swapui.add(table.concat(args, ' ', 2))
            if canon then
                log('added ' .. canon .. ' to the swap list')
            else
                log_err('swap add: ' .. tostring(err))
            end
        elseif sub == 'remove' or sub == 'del' or sub == 'rm' then
            local canon, err = swapui.remove(table.concat(args, ' ', 2))
            if canon then
                log('removed ' .. canon .. ' from the swap list')
            else
                log_err('swap remove: ' .. tostring(err))
            end
        else
            log('usage: //gsui swap [scan|list|add <set>|remove <set>]')
        end
    else
        log('unknown command: ' .. cmd .. ' (try //gsui help)')
    end
end)

windower.register_event('load', 'login', function()
    if settings.autostart and not server then
        start_server()
    end
    -- the floating button is always present while the addon is loaded —
    -- on reload the running instance ignores --fab and just stays visible
    if settings.fab and server then
        launch_overlay(true)
    end
    pending_state = nil
    last_state_json = nil
    last_job_id = nil
    if swapui then pcall(swapui.rescan) end
end)

windower.register_event('unload', function()
    stop_server()
    if swapui then pcall(swapui.destroy) end
    -- take the overlay down with the addon — the fab is part of it
    os.execute('taskkill /F /IM gsui-overlay.exe >nul 2>nul')
end)

if settings.autostart then
    start_server()
end
