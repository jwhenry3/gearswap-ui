import { Component, View, inject, RouterOutlet, Link, Router } from '@preact-mvc/core';
import { ProfileHeader } from './profile-header';

const SUBNAV = [
  { to: '/profile/sets', match: (u: string) => u === '/profile' || u === '/profile/sets', label: 'Sets' },
  { to: '/profile/bindings', match: (u: string) => u === '/profile/bindings', label: 'Bindings' },
];

/**
 * Profile shell — the file picker applies to both subtabs since sets and
 * bindings live in the same per-profile managed block.
 */
@Component()
export class ProfileView extends View {
  private router = inject(Router);

  render() {
    const url = this.router.url.value;
    return (
      <div class="flex h-full min-h-0 flex-col">
        <ProfileHeader />
        <nav class="mb-3 flex gap-1 border-b border-slate-800">
          {SUBNAV.map((s) => (
            <Link
              to={s.to}
              class={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                s.match(url)
                  ? 'border-sky-400 text-sky-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <div class="min-h-0 flex-1">
          <RouterOutlet />
        </div>
      </div>
    );
  }
}
