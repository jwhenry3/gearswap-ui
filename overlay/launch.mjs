// Launches the Electron overlay, stripping env vars that force the
// electron binary into plain-node mode (ELECTRON_RUN_AS_NODE leaks in
// from some shells/IDEs and breaks require('electron')).
//
// The child is spawned detached with its stdio going to overlay.log and
// this process exits immediately — no console window stays attached to
// the overlay (a lingering node console hides the overlay when minimized).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bin = require('electron');
const here = path.dirname(fileURLToPath(import.meta.url));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const log = openSync(path.join(here, 'overlay.log'), 'a');
const child = spawn(bin, [path.join(here, 'main.cjs')], {
    env,
    stdio: ['ignore', log, log],
    detached: true,
    windowsHide: true,
});
child.unref();
process.exit(0);
