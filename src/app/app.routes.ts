import { h } from 'preact';
import type { Route } from '@preact-mvc/core';
import { InventoryView } from './inventory/inventory.view';
import { MacrosView } from './macros/macros.view';
import { ProfileView } from './profile.view';
import { SetsView } from './sets/sets.view';
import { BindingsView } from './bindings/bindings.view';

export const routes: Route[] = [
  { path: '/', component: InventoryView },
  { path: '/macros', component: MacrosView },
  {
    path: '/profile',
    component: ProfileView,
    children: [
      { path: '', component: SetsView },
      { path: 'sets', component: SetsView },
      { path: 'bindings', component: BindingsView },
    ],
  },
  { path: '*', component: () => h('p', null, 'Not found.') },
];
