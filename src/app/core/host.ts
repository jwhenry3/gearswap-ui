// Host-shell abstraction: the UI runs inside either the Wails v3 overlay
// (distributed build) or the Electron overlay (dev) / a plain browser.
//
// The overlay window has two modes — a tiny floating button ("fab") and
// the full UI. The page picks which to render from the viewport size
// (fabMode signal) and talks to the shell through WebView2's
// chrome.webview.postMessage with raw strings:
//
//   "wails:drag"                → native caption move loop
//   "wails:resize:<cursor>"     → native size loop (se-resize, nw-resize…)
//   "gsui:expand"               → fab → full window
//   "gsui:collapse"             → full → fab (Esc/× both collapse now)
//   "gsui:quit"                 → exit the overlay process
import { signal } from '@preact/signals';

interface Webview2Host {
  postMessage(msg: unknown): void;
}

declare global {
  interface Window {
    chrome?: { webview?: Webview2Host };
  }
}

// window.chrome.webview is WebView2's own host object — present on every
// page inside the wails shell. That's the reliable "am I in the overlay"
// check (Electron and plain browsers don't expose it).
const inWebView = () => !!window.chrome?.webview;

const tell = (msg: string) => window.chrome?.webview?.postMessage(msg);

// A viewport this small means the shell is in fab mode — the app renders
// just the button. Gated on inWebView so shrinking a dev browser tab
// doesn't collapse the UI.
const FAB_VIEWPORT = 200;
export const fabMode = signal(false);

const updateFabMode = () => {
  fabMode.value =
    inWebView() &&
    window.innerWidth < FAB_VIEWPORT &&
    window.innerHeight < FAB_VIEWPORT;
  // body paints the opaque app background — drop it in fab mode so the
  // window's transparent backdrop shows through around the circle
  document.body.classList.toggle('fab-mode', fabMode.value);
};

export const host = {
  /** true when running inside a native WebView2 shell */
  inShell: inWebView,

  /** start the native caption-move loop (fab drag, fallback for header) */
  drag() {
    tell('wails:drag');
  },

  /** fab → full window */
  expand() {
    tell('gsui:expand');
  },

  /** full → fab. Esc and the × button both collapse — the fab is the
   *  persistent "closed" state unless the addon is unloaded. */
  collapse() {
    if (inWebView()) tell('gsui:collapse');
    else window.close();
  },

  /** quit the overlay process entirely (fab right-click) */
  quit() {
    if (inWebView()) tell('gsui:quit');
    else window.close();
  },
};

const EDGE = 8; // px of viewport edge that acts as the size border

function edgeAt(x: number, y: number): string | null {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const l = x < EDGE;
  const r = x >= w - EDGE;
  const t = y < EDGE;
  const b = y >= h - EDGE;
  if (t && l) return 'nw-resize';
  if (t && r) return 'ne-resize';
  if (b && l) return 'sw-resize';
  if (b && r) return 'se-resize';
  if (l) return 'w-resize';
  if (r) return 'e-resize';
  if (t) return 'n-resize';
  if (b) return 's-resize';
  return null;
}

// Wires the frameless chrome affordances for the wails shell (full mode
// only — the fab handles its own drag/click):
//  - edges: mousemove shows the resize cursor; mousedown starts a native
//    size loop via "wails:resize:<cursor>"
//  - drag: mousedown on a --wails-draggable:drag element (honoring
//    no-drag) starts a native caption move via "wails:drag"
export function installWindowChrome() {
  if (!inWebView()) return;
  updateFabMode();
  window.addEventListener('resize', updateFabMode);

  document.addEventListener('mousemove', (e) => {
    if (e.buttons !== 0 || fabMode.value) return; // no churn mid-drag / no edges on the fab
    const cursor = edgeAt(e.clientX, e.clientY) ?? '';
    if (document.documentElement.style.cursor !== cursor) {
      document.documentElement.style.cursor = cursor;
    }
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0 || fabMode.value) return;
      const edge = edgeAt(e.clientX, e.clientY);
      if (edge) {
        e.preventDefault();
        e.stopPropagation();
        tell(`wails:resize:${edge}`);
        return;
      }
      let el = e.target as HTMLElement | null;
      while (el && el !== document.body) {
        const v = getComputedStyle(el).getPropertyValue('--wails-draggable').trim();
        if (v === 'no-drag') return;
        if (v === 'drag') {
          e.preventDefault(); // no text selection while dragging
          e.stopPropagation();
          tell('wails:drag');
          return;
        }
        el = el.parentElement;
      }
    },
    true,
  );
}
