import { bootstrap } from '@preact-mvc/core';
import { AppModule } from './app/app.module';
import { host, installWindowChrome } from './app/core/host';
import './styles.css';

// Esc hides the overlay — in Electron the shell intercepts the key before
// the page; under Wails we handle it here. Capture phase so it behaves the
// same either way (re-shown via //gsui overlay).
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && host.inShell()) host.hide();
  },
  true,
);
installWindowChrome();

bootstrap(AppModule, document.getElementById('app')!);
