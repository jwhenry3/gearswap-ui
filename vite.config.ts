/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
const gsApiPort = process.env.GSUI_API_PORT || '17890';

export default defineConfig({
  // Relative asset URLs so the build works when served by the addon's
  // embedded HTTP server from any mount point.
  base: './',
  plugins: [preact(), tailwindcss()],
  server: {
    // `vite dev` proxies API calls to the in-game addon server.
    proxy: {
      '/api': { target: `http://127.0.0.1:${gsApiPort}`, changeOrigin: false },
    },
  },
  resolve: {
    alias: [{ find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) }],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    // @preact-mvc/* ship .ts sources, so vitest inlines them while plain
    // JS deps externalize natively — splitting preact (and its
    // jsx-runtime) into two module realms. The view interceptor patches
    // one shared options object, so the whole preact graph must stay in
    // the vite realm during tests.
    server: {
      deps: {
        inline: [
          /@preact-mvc[/]/,
          'preact',
          'preact/jsx-runtime',
          '@preact/signals',
          '@testing-library/preact',
          'preact-router',
        ],
      },
    },
  },
});
