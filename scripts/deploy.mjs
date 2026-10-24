// Sync the shippable addon tree (addon/gearswapui) into the live
// Windower install at ../addons/gearswapui. The live dir's data/ folder
// (settings + icon cache) is never touched.
//   node scripts/deploy.mjs [target-dir]
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
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

cpSync(src, dst, {
  recursive: true,
  filter: (s) => s !== path.join(src, 'data'),
});
console.log(`deployed addon/gearswapui -> ${dst}`);
