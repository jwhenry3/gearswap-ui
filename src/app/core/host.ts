// Host-shell abstraction: the UI runs inside either the Wails v3 overlay
// (distributed build) or the Electron overlay (dev) / a plain browser.
//
// The app page is a *foreign* document to Wails (loaded from the addon's
// own HTTP server), but Wails v3 routes window-chrome messages from any
// main-frame origin — so the page speaks to the shell directly through
// WebView2's chrome.webview.postMessage with raw strings:
//
//   "wails:drag"                → native caption move loop
//   "wails:resize:<cursor>"     → native size loop (se-resize, nw-resize…)
//   "gsui:hide" / "gsui:quit"   → app-level, handled by RawMessageHandler
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

export const host = {
  /** true when running inside a native WebView2 shell */
  inShell: inWebView,

  /** Esc — hide the window (re-shown by //gsui overlay) */
  hide() {
    if (inWebView()) tell('gsui:hide');
    else window.close();
  },

  /** header × button — quit the overlay process entirely */
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

// Wires the frameless chrome affordances for the wails shell:
//  - edges: mousemove shows the resize cursor; mousedown starts a native
//    size loop via "wails:resize:<cursor>"
//  - drag: mousedown on a --wails-draggable:drag element (honoring
//    no-drag) starts a native caption move via "wails:drag"
export function installWindowChrome() {
  if (!inWebView()) return;

  document.addEventListener('mousemove', (e) => {
    if (e.buttons !== 0) return; // don't churn cursors mid-drag
    const cursor = edgeAt(e.clientX, e.clientY) ?? '';
    if (document.documentElement.style.cursor !== cursor) {
      document.documentElement.style.cursor = cursor;
    }
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
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
