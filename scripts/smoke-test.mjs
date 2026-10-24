// End-to-end smoke test for addon/gearswapui/gearswapui.lua.
//
// Runs the real addon under fengari (Lua 5.3 in JS) with stubbed windower /
// res / config globals and a `socket` module backed by node:net, then drives
// real HTTP requests against it. Usage: `node scripts/smoke-test.mjs`.

import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, readFileSync, openSync, closeSync, fstatSync, readSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

const { LUA_REGISTRYINDEX, LUA_OK, LUA_MULTRET, LUA_TSTRING, LUA_TNUMBER, LUA_TBOOLEAN, LUA_TFUNCTION, LUA_TTABLE } = lua;

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const addonDir = join(repoRoot, 'addon', 'gearswapui');
const addonFile = join(addonDir, 'gearswapui.lua');
const uiDir = join(addonDir, 'ui');
assert.ok(existsSync(join(uiDir, 'index.html')), 'run `npm run build:addon` first — ui/index.html missing');

// Fake Windower root with a GearSwap data dir.
const fakeRoot = mkdtempSync(join(tmpdir(), 'gsui-'));
const gsData = join(fakeRoot, 'addons', 'GearSwap', 'data');
mkdirSync(gsData, { recursive: true });
writeFileSync(join(gsData, 'DUMMY.lua'), '-- dummy\n');
mkdirSync(join(gsData, 'Tester'), { recursive: true });
const WAR_LUA = [
  '-- tester war',
  'sets = {}',
  'function get_sets()',
  "    sets.idle = { main = 'Test Sword' }",
  "    sets.idle.Town = { head = 'Test Helm' }",
  '    sets.engaged = {}',
  '    sets.precast = {}',
  '    sets.precast.FC = {}',
  '    sets.precast["Utsusemi: Ichi"] = { main = \'Test Sword\' }',
  '    -- sets.commented.Out = {} -- should not appear',
  '    if sets.engaged == nil then end',
  'end',
].join('\n') + '\n';
writeFileSync(join(gsData, 'Tester', 'WAR.lua'), WAR_LUA);

// Fake FFXI install with a USER/<content id> macro dir. Fixtures are built
// in the real on-disk format (verified against retail files):
//   24B header (u32 ver + u32 field + md5 of bytes 24+) + 4B zero gap
//   + 20 records x (6 x 61B lines + 8B name + pad) — last record 2B pad
//   mcr.ttl: 24B header + 20 x 16B book titles
const crypto = await import('node:crypto');
const ffxiDir = join(fakeRoot, 'ffxi');
const macroDir = join(ffxiDir, 'USER', 'deadbee');
mkdirSync(macroDir, { recursive: true });
const MD5_OFF = 24;
const mcrHdr = (body) =>
  Buffer.concat([
    Buffer.from([1, 0, 0, 0, 0x7e, 0x3b, 0xb7, 0x44]),
    crypto.createHash('md5').update(body).digest(),
  ]);
function buildPalette(macros) {
  const parts = [Buffer.alloc(4)]; // zero gap after the md5
  for (let i = 0; i < 20; i++) {
    const m = macros[i] ?? {};
    for (let j = 0; j < 6; j++) {
      const b = Buffer.alloc(61);
      b.write(String(m.lines?.[j] ?? '').slice(0, 60), 'latin1');
      parts.push(b);
    }
    const nb = Buffer.alloc(8);
    nb.write(String(m.name ?? '').slice(0, 8), 'latin1');
    parts.push(nb, Buffer.alloc(i < 19 ? 6 : 2));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([mcrHdr(body), body]);
}
function buildTitles(titles) {
  const parts = [];
  for (let i = 0; i < 20; i++) {
    const t = Buffer.alloc(16);
    t.write(String(titles[i] ?? `Book ${i + 1}`).slice(0, 16), 'latin1');
    parts.push(t);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([mcrHdr(body), body]);
}
writeFileSync(join(macroDir, 'mcr.dat'), buildPalette([
  { name: 'TestMcr', lines: ['/say hello', '', '', '', '', ''] },
  { name: 'AT', lines: ['\xfd\x02\x02\x12\x34\xfd rest', '', '', '', '', ''] },
]));
writeFileSync(join(macroDir, 'mcr10.dat'), buildPalette([
  { name: 'Stone', lines: ['/console stone', '', '', '', '', ''] },
]));
writeFileSync(join(macroDir, 'mcr.ttl'), buildTitles(['Book 1', 'RDM']));

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

// ---------- helpers for pushing JS values ----------

function push(v) {
  if (v == null) lua.lua_pushnil(L);
  else if (typeof v === 'boolean') lua.lua_pushboolean(L, v);
  else if (typeof v === 'number') lua.lua_pushnumber(L, v);
  else if (typeof v === 'string') lua.lua_pushstring(L, to_luastring(v));
  else if (v instanceof Uint8Array) lua.lua_pushlstring(L, v, v.length);
  else if (typeof v === 'function') lua.lua_pushjsfunction(L, v);
  else if (Array.isArray(v)) {
    lua.lua_createtable(L, v.length, 0);
    v.forEach((item, i) => {
      push(item);
      lua.lua_rawseti(L, -2, i + 1);
    });
  } else if (typeof v === 'object') {
    lua.lua_createtable(L, 0, Object.keys(v).length);
    for (const [k, val] of Object.entries(v)) {
      push(val);
      if (/^\d+$/.test(k)) {
        // Numeric key: swap to rawseti-style numeric keying.
        const i = Number(k);
        lua.lua_pushnumber(L, i);
        lua.lua_insert(L, -2);
        lua.lua_rawset(L, -3);
      } else {
        lua.lua_setfield(L, -2, to_luastring(k));
      }
    }
  }
  return 1;
}

function jsval(i) {
  const t = lua.lua_type(L, i);
  if (t === LUA_TNUMBER) return lua.lua_tonumberx(L, i, null);
  if (t === LUA_TBOOLEAN) return lua.lua_toboolean(L, i);
  if (t === LUA_TSTRING) return to_jsstring(lauxlib.luaL_tolstring(L, i, null));
  return null;
}

// js function factory: body receives arg values, returns pushed result count
function fn(body) {
  return (L) => {
    const n = lua.lua_gettop(L);
    const args = [];
    for (let i = 1; i <= n; i++) args.push(jsval(i));
    return push(body(...args));
  };
}

// ---------- socket module over node:net ----------

const clientWrap = new WeakMap();

function wrapClient(c) {
  if (clientWrap.has(c)) return clientWrap.get(c);
  const w = { c, buf: Buffer.alloc(0), ended: false };
  c.on('data', (d) => (w.buf = Buffer.concat([w.buf, d])));
  c.on('end', () => (w.ended = true));
  c.on('close', () => (w.ended = true));
  const tbl = {
    settimeout: fn(() => true),
    setoption: fn(() => true),
    getsockname: fn(() => push('127.0.0.1') + 0), // unused
    close: fn(() => {
      c.destroy();
      return null;
    }),
    receive: (L) => {
      const n = jsval(2) ?? 0;
      if (w.buf.length > 0) {
        const take = n > 0 ? Math.min(n, w.buf.length) : w.buf.length;
        const out = w.buf.subarray(0, take);
        w.buf = w.buf.subarray(take);
        lua.lua_pushlstring(L, new Uint8Array(out), out.length);
        return 1;
      }
      if (w.ended) {
        lua.lua_pushnil(L);
        lua.lua_pushstring(L, to_luastring('closed'));
        lua.lua_pushstring(L, to_luastring(''));
        return 3;
      }
      lua.lua_pushnil(L);
      lua.lua_pushstring(L, to_luastring('timeout'));
      lua.lua_pushstring(L, to_luastring(''));
      return 3;
    },
    send: (L) => {
      // luaL_checklstring returns the raw Lua bytes (Uint8Array) — keep byte
      // fidelity or the reported byte count won't match Lua's #data.
      const data = lauxlib.luaL_checklstring(L, 2, null);
      const i = jsval(3) ?? 1;
      const bytes = Buffer.from(data.subarray(i - 1));
      try {
        c.write(bytes);
        lua.lua_pushnumber(L, i - 1 + bytes.length); // last index written
        return 1;
      } catch {
        lua.lua_pushnil(L);
        lua.lua_pushstring(L, to_luastring('closed'));
        lua.lua_pushnumber(L, i - 1);
        return 3;
      }
    },
  };
  clientWrap.set(c, tbl);
  return tbl;
}

const socketModule = {
  bind: (L) => {
    const host = to_jsstring(lauxlib.luaL_checklstring(L, 1, null));
    const port = lua.lua_tonumberx(L, 2, null);
    const srv = createServer();
    const pending = [];
    srv.on('connection', (c) => pending.push(c));
    try {
      srv.listen(port, host);
    } catch (e) {
      lua.lua_pushnil(L);
      lua.lua_pushstring(L, to_luastring(String(e)));
      return 2;
    }
    const tbl = {
      settimeout: fn(() => true),
      setoption: fn(() => true),
      getsockname: fn(() => {
        lua.lua_pushstring(L, to_luastring(host));
        lua.lua_pushnumber(L, port);
        return 2;
      }),
      close: fn(() => {
        srv.close();
        return null;
      }),
      accept: (L) => {
        const c = pending.shift();
        if (!c) {
          lua.lua_pushnil(L);
          lua.lua_pushstring(L, to_luastring('timeout'));
          return 2;
        }
        return push(wrapClient(c));
      },
    };
    return push(tbl);
  },
};

// ---------- windower / res / config stubs ----------

const events = new Map(); // name -> [lua refs]
const chats = [];
const commands = [];

// resources post-processes bitmasks into S sets: jobs/slots hold member ids
// as keys, flags holds flag-name strings as keys.
const ITEM = {
  12345: {
    id: 12345, en: 'Test Helm', enl: 'test helm', category: 'Armor',
    level: 99, ilvl: 119, jobs: { 1: true }, slots: { 4: true },
    flags: { Rare: true, Exclusive: true }, stack: 1,
  },
  22222: {
    id: 22222, en: 'Test Sword', category: 'Weapon', level: 99, ilvl: 119,
    jobs: { 1: true }, slots: { 0: true }, flags: {}, stack: 1,
  },
};

const resModule = {
  items: ITEM,
  jobs: { 1: { ens: 'WAR', en: 'Warrior' }, 13: { ens: 'NIN', en: 'Ninja' } },
  slots: { 0: { en: 'Main' }, 1: { en: 'Sub' }, 4: { en: 'Head' } },
  bags: {},
};

const bags = {
  0: {
    enabled: true, max: 80, count: 2,
    items: {
      1: { id: 12345, count: 1, status: 0, slot: 1 },
      2: { id: 22222, count: 1, status: 5, slot: 2 },
    },
  },
  8: {
    enabled: true, max: 80, count: 1,
    items: { 1: { id: 22222, count: 1, status: 0, slot: 1 } },
  },
  1: { enabled: false, max: 80, count: 0, items: {} },
};

// Bag id -> windower.ffxi bag key, mirroring the addon's BAGS table.
const BAG_KEYS = { 0: 'inventory', 1: 'safe', 8: 'wardrobe' };

let loggedIn = false;

const windower = {
  addon_path: addonDir + '\\',
  windower_path: fakeRoot + '\\',
  ffxi_path: ffxiDir + '\\',
  ffxi: {
    get_info: fn(() => ({ logged_in: loggedIn })),
    get_player: fn(() => ({
      name: 'Tester', main_job_id: 1, main_job_level: 99,
      sub_job_id: 13, sub_job_level: 49,
    })),
    get_bag_info: fn((id) => {
      if (id == null) {
        const all = {};
        for (const [bid, b] of Object.entries(bags)) {
          all[BAG_KEYS[bid] ?? bid] = { enabled: b.enabled, max: b.max, count: b.count };
        }
        return all;
      }
      const b = bags[id];
      return b ? { enabled: b.enabled, max: b.max, count: b.count } : null;
    }),
    get_items: fn((id) => {
      if (id == null) {
        const all = {};
        for (const [bid, b] of Object.entries(bags)) {
          all[BAG_KEYS[bid] ?? bid] = { ...b.items, max: b.max };
        }
        return all;
      }
      const b = bags[id];
      return b ? { ...b.items, max: b.max } : {};
    }),
  },
  add_to_chat: fn((_mode, msg) => {
    chats.push(msg);
    console.log('  [chat]', msg);
    return null;
  }),
  register_event: (L) => {
    const n = lua.lua_gettop(L);
    const ref = (() => {
      lua.lua_pushvalue(L, n);
      return lauxlib.luaL_ref(L, LUA_REGISTRYINDEX);
    })();
    for (let i = 1; i < n; i++) {
      const name = to_jsstring(lauxlib.luaL_checklstring(L, i, null));
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(ref);
    }
    return 0;
  },
  send_command: fn((s) => {
    commands.push(s);
    return null;
  }),
  open_url: fn((u) => {
    console.log('  [open_url]', u);
    return null;
  }),
  dir_exists: fn((p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  }),
  // extracted icon bmps are treated as already on disk so itemIcon() resolves
  // without the real icon_extractor + FFXI dats
  file_exists: fn((p) => existsSync(p) || /\.bmp$/i.test(p)),
  create_dir: fn((p) => {
    mkdirSync(p, { recursive: true });
    return true;
  }),
  get_dir: fn((p) => {
    try { return readdirSync(p); } catch { return {}; }
  }),
  get_windower_settings: fn(() => ({ ui_x_res: 1920, ui_y_res: 1080 })),
};

function fireEvent(name, ...args) {
  let last;
  const top0 = lua.lua_gettop(L);
  for (const ref of events.get(name) ?? []) {
    lua.lua_rawgeti(L, LUA_REGISTRYINDEX, ref);
    for (const a of args) push(a);
    const rc2 = lua.lua_pcall(L, args.length, 1, 0);
    if (rc2 !== LUA_OK) {
      const msg = to_jsstring(lauxlib.luaL_tolstring(L, -1, null));
      lua.lua_pop(L, 2); // error object + converted copy
      throw new Error(`event ${name} failed: ${msg}`);
    }
    last = lua.lua_toboolean(L, -1);
    lua.lua_pop(L, 1);
  }
  if (process.env.GSUI_DEBUG && lua.lua_gettop(L) !== top0) {
    console.log(`[stack] ${name}: ${top0} -> ${lua.lua_gettop(L)} (abs top=${L.top} ci.top=${L.ci.top} funcOff=${L.ci.funcOff})`);
  }
  return last;
}

// ---------- load the addon ----------

lua.lua_createtable(L, 0, 4);
lua.lua_setglobal(L, to_luastring('_addon'));
push(windower);
lua.lua_setglobal(L, to_luastring('windower'));

// fengari's io table lacks io.open — back it with node fs.
lua.lua_getglobal(L, to_luastring('io'));
lua.lua_pushjsfunction(L, (L) => {
  const path = to_jsstring(lauxlib.luaL_checklstring(L, 1, null));
  const mode = jsval(2) || 'r';
  let fd;
  try {
    fd = openSync(path, mode.startsWith('w') ? 'w' : 'r');
  } catch (e) {
    lua.lua_pushnil(L);
    lua.lua_pushstring(L, to_luastring(String(e)));
    return 2;
  }
  const handle = {
    read: (L) => {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      lua.lua_pushlstring(L, new Uint8Array(buf), size);
      return 1;
    },
    write: (L) => {
      const s = lauxlib.luaL_checklstring(L, 2, null);
      writeSync(fd, Buffer.from(s));
      lua.lua_pushvalue(L, 1);
      return 1;
    },
    close: fn(() => {
      closeSync(fd);
      return true;
    }),
  };
  return push(handle);
});
lua.lua_setfield(L, -2, to_luastring('open'));
lua.lua_pop(L, 1);

// package.loaded stubs so `require` returns our modules directly
lauxlib.luaL_getsubtable(L, lua.LUA_REGISTRYINDEX, to_luastring('_LOADED'));
push(socketModule);
lua.lua_setfield(L, -2, to_luastring('socket'));
push(resModule);
lua.lua_setfield(L, -2, to_luastring('resources'));
push({
  load: (L) => {
    lua.lua_pushvalue(L, 1); // return the defaults table unchanged
    return 1;
  },
  save: fn(() => null),
});
lua.lua_setfield(L, -2, to_luastring('config'));

// `config` override pinning the server to a quiet test port (the real addon
// may be running in-game on 17890 while this test executes).
const configStub = `
package.loaded['config'] = {
    load = function(defaults)
        local copy = {}
        for k, v in pairs(defaults) do copy[k] = v end
        copy.port = 18791
        return copy
    end,
    save = function() end,
}
`;

{
  const rc = lauxlib.luaL_dostring(L, to_luastring(configStub));
  assert.equal(rc, LUA_OK, 'config stub failed: ' + to_jsstring(lauxlib.luaL_tolstring(L, -1, null)));
}
lua.lua_settop(L, 0); // clear any stub leftovers before loading the addon
lua.lua_settop(L, 0); // clear any stub leftovers before loading the addon

// package.path += <addon>/? so sibling modules (macros.lua) resolve the
// same way Windower resolves them for a loaded addon.
lauxlib.luaL_dostring(
  L,
  to_luastring(`package.path = package.path .. ';${addonDir.replace(/\\/g, '/')}/?.lua'`),
);

const rc = lauxlib.luaL_dofile(L, to_luastring(addonFile));
if (rc !== LUA_OK) {
  console.error('addon load failed:', to_jsstring(lauxlib.luaL_tolstring(L, -1, null)));
  process.exit(1);
}
console.log('addon loaded');
if (process.env.GSUI_DEBUG) {
  console.log('stack after dofile:', lua.lua_gettop(L));
  for (let i = 1; i <= lua.lua_gettop(L); i++) {
    const s = lua.lua_tostring(L, i);
    console.log(' stack', i, lua.lua_typename(L, lua.lua_type(L, i)), s ? to_jsstring(s) : null);
  }
}

fireEvent('load');

// Parse the bound port out of the chat log.
const portLine = chats.find((m) => m.includes('listening on'));
const port = Number(portLine?.match(/127\.0\.0\.1:(\d+)/)?.[1]);
assert.ok(port, 'server did not report a bound port');
console.log('server on port', port);

// ---------- drive frames + HTTP ----------

const frame = () => fireEvent('prerender');
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function step(n = 3) {
  for (let i = 0; i < n; i++) {
    frame();
    await tick();
  }
}

const base = `http://127.0.0.1:${port}`;

await step(5);

// /api/status
{
  const p = fetch(`${base}/api/status`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.addon, 'gearswapui');
  assert.equal(j.port, port);
  console.log('PASS /api/status');
}

// /api/state
{
  const p = fetch(`${base}/api/state`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.ok(j.player && j.player.name === 'Tester');
  assert.equal(j.player.main_job, 'WAR');
  const inv = j.bags.find((b) => b.key === 'inventory');
  const ward = j.bags.find((b) => b.key === 'wardrobe');
  assert.ok(inv && ward, 'inventory + wardrobe missing');
  assert.equal(inv.items.length, 2);
  const helm = inv.items.find((i) => i.id === 12345);
  if (!j.catalog['12345']) console.log('catalog dump:', JSON.stringify(j.catalog).slice(0, 500));
  const meta = j.catalog['12345'];
  assert.equal(meta.name, 'Test Helm');
  assert.equal(meta.ilvl, 119);
  assert.equal(meta.rare, true);
  assert.equal(meta.ex, true);
  assert.deepEqual(meta.slots, ['Head']);
  const sword = inv.items.find((i) => i.id === 22222);
  assert.equal(sword.equipped, true);
  console.log('PASS /api/state');
}

// static index + SPA fallback
{
  const p = fetch(`${base}/`).then((r) => r.text());
  await step(5);
  const html = await p;
  assert.ok(html.includes('<div id="app">'), 'index.html not served');
  const p2 = fetch(`${base}/files`).then((r) => r.text());
  await step(5);
  const html2 = await p2;
  assert.ok(html2.includes('<div id="app">'), 'SPA fallback broken');
  console.log('PASS static index + SPA fallback');
}

// static asset content type
{
  const p0 = fetch(`${base}/`).then((r) => r.text());
  await step(5);
  const html = await p0;
  const js = html.match(/assets\/[^"]+\.js/)?.[0];
  const p = fetch(`${base}/${js}`).then((r) => [r.status, r.headers.get('content-type')]);
  await step(5);
  const [status, ct] = await p;
  assert.equal(status, 200);
  assert.match(ct, /javascript/);
  console.log('PASS static asset');
}

// gearswap files list
{
  const p = fetch(`${base}/api/gearswap/files`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.found, true);
  const paths = j.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['DUMMY.lua', 'Tester/WAR.lua']);
  console.log('PASS /api/gearswap/files');
}

// file read + write roundtrip
{
  const p = fetch(`${base}/api/gearswap/file?path=Tester/WAR.lua`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.content, WAR_LUA);

  const p2 = fetch(`${base}/api/gearswap/file?path=Tester/BLM.lua`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: '-- blm test\nsets = {}\n',
  }).then((r) => r.json());
  await step(5);
  assert.equal((await p2).ok, true);

  const p3 = fetch(`${base}/api/gearswap/file?path=Tester/BLM.lua`).then((r) => r.json());
  await step(5);
  assert.equal((await p3).content, '-- blm test\nsets = {}\n');
  console.log('PASS file read/write');
}

// path traversal rejected
{
  const p = fetch(`${base}/api/gearswap/file?path=../evil.lua`).then((r) => r.status);
  await step(5);
  assert.equal(await p, 404);
  const p2 = fetch(`${base}/api/gearswap/file?path=evil.txt`).then((r) => r.status);
  await step(5);
  assert.equal(await p2, 404);
  console.log('PASS traversal rejected');
}

// reload command
{
  const p = fetch(`${base}/api/gearswap/reload`, { method: 'POST' }).then((r) => r.json());
  await step(5);
  assert.equal((await p).ok, true);
  assert.ok(commands.includes('gs reload'));
  console.log('PASS /api/gearswap/reload');
}

// macro files: GET parses mcr.dat/mcr.ttl, PUT writes valid images
{
  const p = fetch(`${base}/api/macros`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.logged_in, false);
  assert.equal(j.characters.length, 1);
  const ch = j.characters[0];
  assert.equal(ch.id, 'deadbee');
  assert.equal(ch.titles[1], 'RDM');
  assert.equal(ch.palettes.length, 2);
  const pal0 = ch.palettes.find((x) => x.index === 0);
  assert.equal(pal0.book, 1);
  assert.equal(pal0.palette, 1);
  assert.equal(pal0.macros.length, 20);
  assert.equal(pal0.macros[0].name, 'TestMcr');
  assert.equal(pal0.macros[0].lines[0], '/say hello');
  // raw 0xFD auto-translate bytes decode to the editable token form
  assert.equal(pal0.macros[1].lines[0], '[AT:02021234] rest');
  const pal10 = ch.palettes.find((x) => x.index === 10);
  assert.equal(pal10.book, 2);
  assert.equal(pal10.palette, 1);
  console.log('PASS GET /api/macros');

  // PUT a rewritten palette back to mcr10.dat
  const out = Array.from({ length: 20 }, () => ({ name: '', lines: ['', '', '', '', '', ''] }));
  out[0] = { name: 'New', lines: ['/ja Provoke <t>', '', '', '', '', ''] };
  out[19] = { name: 'Last', lines: ['/p end', '', '', '', '', ''] };
  const p2 = fetch(`${base}/api/macros/palette`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', index: 10, macros: out }),
  }).then((r) => r.json());
  await step(5);
  const j2 = await p2;
  assert.equal(j2.ok, true);
  assert.equal(j2.file, 'mcr10.dat');
  // validate the written image: correct md5 + record layout
  const img = readFileSync(join(macroDir, 'mcr10.dat'));
  assert.equal(img.length, 7624);
  const body = img.subarray(MD5_OFF);
  assert.equal(
    crypto.createHash('md5').update(body).digest('hex'),
    img.subarray(8, 24).toString('hex'),
    'written file md5 mismatch',
  );
  // record 0: lines at 28.., name after 6*61
  assert.equal(img.subarray(28, 28 + 16).toString('latin1').replace(/\0+$/, ''), '/ja Provoke <t>');
  const nameOff = 28 + 6 * 61;
  assert.equal(img.subarray(nameOff, nameOff + 8).toString('latin1').replace(/\0+$/, ''), 'New');
  // record 19 name sits at 28 + 19*380 + 366
  const last = 28 + 19 * 380 + 366;
  assert.equal(img.subarray(last, last + 8).toString('latin1').replace(/\0+$/, ''), 'Last');
  assert.ok(existsSync(join(macroDir, 'mcr10.dat.gsui-bak')), 'no backup written');
  console.log('PASS PUT /api/macros/palette');

  // PUT to a brand-new palette index creates mcr20.dat
  const p3 = fetch(`${base}/api/macros/palette`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      char: 'deadbee', index: 20,
      macros: Array.from({ length: 20 }, () => ({ name: '', lines: [] })),
    }),
  }).then((r) => r.json());
  await step(5);
  assert.equal((await p3).ok, true);
  const img20 = readFileSync(join(macroDir, 'mcr20.dat'));
  assert.equal(img20.length, 7624);
  assert.equal(
    crypto.createHash('md5').update(img20.subarray(MD5_OFF)).digest('hex'),
    img20.subarray(8, 24).toString('hex'),
  );
  console.log('PASS create new palette file');

  // PUT a book title rewrites mcr.ttl with a fresh md5
  const p4 = fetch(`${base}/api/macros/title`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', book: 2, title: 'MNK' }),
  }).then((r) => r.json());
  await step(5);
  assert.equal((await p4).ok, true);
  const ttl = readFileSync(join(macroDir, 'mcr.ttl'));
  assert.equal(ttl.length, 344);
  assert.equal(
    crypto.createHash('md5').update(ttl.subarray(MD5_OFF)).digest('hex'),
    ttl.subarray(8, 24).toString('hex'),
  );
  assert.equal(ttl.subarray(24 + 16, 24 + 32).toString('latin1').replace(/\0+$/, ''), 'MNK');
  console.log('PASS PUT /api/macros/title');

  // GET reflects the written title + palette
  const p5 = fetch(`${base}/api/macros`).then((r) => r.json());
  await step(5);
  const j5 = await p5;
  assert.equal(j5.characters[0].titles[1], 'MNK');
  assert.equal(j5.characters[0].palettes.length, 3);
  console.log('PASS macro round-trip');

  // apply=1 while logged in: the write is bracketed by client book
  // switches (away -> write -> back + set page). Under fengari there is
  // no coroutine.schedule, so the fallback runs the steps synchronously.
  loggedIn = true;
  const cmdsBefore = commands.length;
  const out2 = Array.from({ length: 20 }, () => ({ name: '', lines: ['', '', '', '', '', ''] }));
  out2[5] = { name: 'Live', lines: ['/ma Cure <me>', '', '', '', '', ''] };
  const p6 = fetch(`${base}/api/macros/palette?apply=1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', index: 10, macros: out2 }),
  }).then((r) => r.json());
  await step(5);
  const j6 = await p6;
  assert.equal(j6.ok, true);
  assert.equal(j6.applied, true);
  assert.equal(j6.book, 2);
  assert.equal(j6.palette, 1);
  // book 2's "away" book is book 1; sequence away -> write -> back -> set
  assert.deepEqual(commands.slice(cmdsBefore), [
    'input /macro book 1',
    'input /macro book 2',
    'input /macro set 1',
  ]);
  const imgLive = readFileSync(join(macroDir, 'mcr10.dat'));
  const rec5 = 28 + 5 * 380; // macro index 5
  assert.equal(imgLive.subarray(rec5, rec5 + 20).toString('latin1').replace(/\0+$/, ''), '/ma Cure <me>');
  assert.equal(
    crypto.createHash('md5').update(imgLive.subarray(MD5_OFF)).digest('hex'),
    imgLive.subarray(8, 24).toString('hex'),
  );
  loggedIn = false;
  console.log('PASS apply (book-switch dance)');
}

// SSE: receive the initial snapshot event
{
  const ctrl = new AbortController();
  const p0 = fetch(`${base}/api/events`, { signal: ctrl.signal });
  await step(3);
  const r = await p0;
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body.getReader();
  const chunks = [];
  const readLoop = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString('utf8'));
      if (chunks.join('').includes('\n\n')) break;
    }
  })();
  await step(8);
  ctrl.abort();
  await readLoop.catch(() => {});
  const text = chunks.join('');
  assert.ok(text.includes('event: state'), 'no SSE state event');
  assert.ok(text.includes('"player"'), 'SSE payload missing state');
  console.log('PASS SSE /api/events');
}

// //gsui open command fires open_url
function addonCmd(...args) {
  const refs = events.get('addon command') ?? [];
  assert.ok(refs.length > 0);
  const base = lua.lua_gettop(L);
  lua.lua_rawgeti(L, LUA_REGISTRYINDEX, refs[0]);
  for (const a of args) lua.lua_pushstring(L, to_luastring(a));
  const rc = lua.lua_pcall(L, args.length, 0, 0);
  if (rc !== LUA_OK || lua.lua_gettop(L) > base) {
    const msg = to_jsstring(lauxlib.luaL_tolstring(L, -1, null));
    lua.lua_settop(L, base);
    throw new Error('addon command failed: ' + msg);
  }
}
{
  addonCmd('open');
  console.log('PASS addon command');
}

// swapui headless scanner: set scan + equip command
{
  addonCmd('swap', 'scan');
  assert.ok(
    chats.some((m) => m.includes('6 set(s) found')),
    'expected 6 scanned sets, chats: ' + JSON.stringify(chats.slice(-5)),
  );
  addonCmd('swap', 'list');
  const listing = chats.join('\n');
  for (const want of ['idle', 'idle.Town', 'engaged', 'precast', 'precast.FC', 'precast["Utsusemi: Ichi"]']) {
    assert.ok(listing.includes(want), 'missing set in list: ' + want);
  }
  assert.ok(!listing.includes('commented'), 'commented-out set leaked into list');
  addonCmd('equip', 'idle.Town');
  assert.ok(commands.includes('gs equip sets.idle.Town'));
  addonCmd('equip', 'sets.engaged');
  assert.ok(commands.includes('gs equip sets.engaged'));
  addonCmd('swap', 'add', 'defense.MDT');
  addonCmd('swap', 'list');
  assert.ok(chats.join('\n').includes('defense.MDT *'), 'custom set not listed');
  addonCmd('swap');
  assert.ok(chats.join('\n').includes('usage: //gsui swap'), 'bare swap did not print usage');
  console.log('PASS swap scanner + commands');
}

console.log('\nAll smoke tests passed.');
process.exit(0);
