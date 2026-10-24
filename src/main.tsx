import { bootstrap } from '@preact-mvc/core';
import { AppModule } from './app/app.module';
import { host, fabMode, installWindowChrome } from './app/core/host';
import './styles.css';

// Esc collapses the overlay back to the floating button — in Electron the
// shell intercepts the key before the page; under Wails we handle it here.
// Capture phase so it behaves the same either way (expand via //gsui
// overlay or clicking the fab).
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && host.inShell() && !fabMode.value) host.collapse();
  },
  true,
);
installWindowChrome();

bootstrap(AppModule, document.getElementById('app')!);
