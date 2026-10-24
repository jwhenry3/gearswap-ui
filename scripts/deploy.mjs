// Sync the shippable addon tree (addon/gearswapui) into the live
// Windower install at ../addons/gearswapui. The live dir's data/ folder
// (settings + icon cache) is never touched.
//   node scripts/deploy.mjs [target-dir]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = path.join(root, 'addon', 'gearswapui');
const dst = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, '..', 'addons', 'gearswapui');

if (!existsSync(dst)) {
  console.error(`target addon dir not found: ${dst}`);
  process.exit(1);
}

// drop stale hashed ui bundles so only the current build is live
const assets = path.join(dst, 'ui', 'assets');
if (existsSync(assets)) {
  for (const f of readdirSync(assets)) {
    if (/^index-.*\.(js|css)$/.test(f)) rmSync(path.join(assets, f));
  }
}

// copy file-by-file, skipping unchanged content — gsui-overlay.exe stays
// locked while running and must not be rewritten anyway
const skip = new Set([path.join(src, 'data')]);
let copied = 0;
let locked = 0;
function sync(s, d) {
  if (skip.has(s)) return;
  if (statSync(s).isDirectory()) {
    mkdirSync(d, { recursive: true });
    for (const f of readdirSync(s)) sync(path.join(s, f), path.join(d, f));
    return;
  }
  if (existsSync(d)) {
    try {
      const a = readFileSync(s);
      const b = readFileSync(d);
      if (a.equals(b)) return;
    } catch { /* unreadable dest — try the copy anyway */ }
  }
  try {
    copyFileSync(s, d);
    copied++;
  } catch (e) {
    // file locked (running exe) — leave the existing one in place
    locked++;
    console.warn(`skipped locked ${path.relative(src, s)}`);
  }
}
sync(src, dst);
console.log(`deployed addon/gearswapui -> ${dst} (${copied} updated${locked ? `, ${locked} locked` : ''})`);
