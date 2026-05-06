import {defineConfig} from 'vite';
import {resolve} from 'node:path';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// Source maps in production: per Ronnie, debuggable stack traces > ~30% map size.
// Default dev port (5173) intentional: avoid 3000-style squatting collisions and
// keep this a "boring standard Vite" project for handoff.
//
// Multi-page entries (2026-05-06 PWA install hotfix):
//   - index.html      — default; links /manifest.webmanifest (start_url /dailys).
//   - equipment.html  — links /manifest-equipment.webmanifest (start_url /equipment).
// Netlify _redirects routes /equipment* and /fueling* to /equipment.html
// before the SPA fallback so the install banner reads the right manifest at
// HTML parse time, before any JS runs. Both HTMLs boot the same React app
// from /src/main.jsx — only the install manifest differs.
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        equipment: resolve(__dirname, 'equipment.html'),
      },
    },
  },
});
