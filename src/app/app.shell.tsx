import { Component, View, inject, RouterOutlet, Link, Router } from '@preact-mvc/core';
import { APP_TITLE } from './core/tokens';
import { AddonApi } from './core/addon-api.service';
import { host, fabMode } from './core/host';
import { Fab } from './fab';

const NAV = [
  { to: '/', match: '/', label: 'Inventory' },
  { to: '/macros', match: '/macros', label: 'Macros' },
  { to: '/profile', match: '/profile', label: 'Profile' },
];

@Component()
export class AppShell extends View {
  private router = inject(Router);
  private api = inject(AddonApi);
  private title = inject(APP_TITLE);

  render() {
    // the shell is in fab mode — just the floating button
    if (fabMode.value) return <Fab />;

    const url = this.router.url.value;
    const player = this.api.state.value?.player;
    const connected = this.api.connected.value;
    return (
      <div class="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-200">
        <header class="flex h-14 items-center gap-4 border-b border-slate-800 px-5">
          <strong class="text-sm">{this.title}</strong>
          <nav class="flex gap-4">
            {NAV.map((n) => {
              const active = n.match === '/' ? url === '/' : url.startsWith(n.match);
              return (
                <Link
                  to={n.to}
                  class={active ? 'nav-link active' : 'nav-link'}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <span class="flex-1" />
          {player && (
            <span class="text-xs text-slate-400">
              {player.name} — {player.main_job}
              {player.main_job_level}
              {player.sub_job ? ` / ${player.sub_job}${player.sub_job_level}` : ''}
            </span>
          )}
          <span
            class={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-rose-500'}`}
            title={connected ? 'connected to addon' : 'disconnected'}
          />
          <button
            class="ml-1 flex h-6 w-6 items-center justify-center rounded text-sm leading-none text-slate-500 hover:bg-slate-800 hover:text-rose-300"
            title="collapse to the floating button (Esc does the same)"
            onClick={() => host.collapse()}
          >
            ×
          </button>
        </header>
        <main class="min-h-0 flex-1 overflow-hidden p-6">
          <RouterOutlet />
        </main>
      </div>
    );
  }
}
