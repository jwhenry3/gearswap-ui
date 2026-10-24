import { Injectable, inject, signal, DestroyRef } from '@preact-mvc/core';
import type {
  InventoryState,
  GearswapFileList,
  GearswapFileContent,
  MacroState,
  MacroEntry,
} from './types';

// In production the addon serves this UI itself, so same-origin is correct.
// For `vite dev`, set VITE_GSUI_API or rely on the dev-server proxy for /api.
const API_BASE: string =
  (import.meta.env.VITE_GSUI_API as string | undefined) ?? '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

@Injectable({ providedIn: 'root' })
export class AddonApi {
  readonly state = signal<InventoryState | null>(null);
  readonly connected = signal(false);
  readonly files = signal<GearswapFileList | null>(null);
  readonly lastError = signal<string | null>(null);

  private es: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.disconnect());
    this.connect();
    void this.refreshFiles();
  }

  private disconnect() {
    this.es?.close();
    if (this.pollTimer != null) clearInterval(this.pollTimer);
  }

  private connect() {
    const es = new EventSource(`${API_BASE}/api/events`);
    this.es = es;
    es.addEventListener('state', (ev) => {
      try {
        this.state.value = JSON.parse((ev as MessageEvent).data);
      } catch {
        // malformed payload; ignore
      }
      this.connected.value = true;
    });
    es.onopen = () => (this.connected.value = true);
    es.onerror = () => (this.connected.value = false);

    // Fallback polling while the event stream is down.
    this.pollTimer = setInterval(async () => {
      if (this.connected.value) return;
      try {
        this.state.value = await req<InventoryState>('/api/state');
        this.connected.value = true;
        this.lastError.value = null;
      } catch (e) {
        this.connected.value = false;
        this.lastError.value = String(e);
      }
    }, 3000);
  }

  async refreshFiles() {
    this.files.value = await req<GearswapFileList>('/api/gearswap/files');
  }

  readFile(path: string) {
    return req<GearswapFileContent>(
      `/api/gearswap/file?path=${encodeURIComponent(path)}`,
    );
  }

  async saveFile(path: string, content: string) {
    await req<{ ok: boolean }>(
      `/api/gearswap/file?path=${encodeURIComponent(path)}`,
      { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content },
    );
  }

  async reloadGearswap() {
    await req<{ ok: boolean }>('/api/gearswap/reload', { method: 'POST' });
  }

  /** run a windower command, e.g. `gs equip sets.idle` */
  async sendCommand(cmd: string) {
    await req<{ ok: boolean }>('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
  }

  /** item action needing packet injection — drop / move between bags */
  async itemAction(payload: {
    action: 'drop' | 'move';
    bag: number;
    index: number;
    count?: number;
    target?: number;
  }) {
    await req<{ ok: boolean }>('/api/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** item icon (extracted bmp served by the addon); 404s until extracted */
  iconUrl(id: number): string {
    return `${API_BASE}/api/icon?id=${id}`;
  }

  // ---------- FFXI macro files ----------

  readonly macros = signal<MacroState | null>(null);

  async refreshMacros() {
    this.macros.value = await req<MacroState>('/api/macros');
  }

  /** write one palette page (20 macros) to mcr<index>.dat.
   *  apply=true asks the addon to force the client to re-read the book:
   *  it switches the client to another book, writes the file while the
   *  book is unloaded, then switches back and selects the page. */
  async savePalette(
    char: string,
    index: number,
    macros: MacroEntry[],
    apply = false,
  ) {
    const res = await req<{
      ok: boolean;
      file: string;
      applied?: boolean;
      logged_in: boolean;
    }>(`/api/macros/palette${apply ? '?apply=1' : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ char, index, macros }),
    });
    void this.refreshMacros();
    return res;
  }

  /** rename a macro book title (book 1-40) */
  async saveMacroTitle(char: string, book: number, title: string) {
    const res = await req<{ ok: boolean; logged_in: boolean }>(
      '/api/macros/title',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ char, book, title }),
      },
    );
    void this.refreshMacros();
    return res;
  }
}
