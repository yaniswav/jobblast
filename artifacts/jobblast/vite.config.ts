import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Unlike the API server (started via `node --env-file-if-exists=../../.env`),
// nothing loads the repo-root .env for this plain `vite` process, so
// FRONTEND_PORT/API_PROXY_TARGET/BASE_PATH below would silently fall back to
// their defaults instead of erroring - notably pointing the /api proxy at
// port 5000 even when the API server was moved elsewhere. Load it the same
// way (silently skipped if missing).
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch {
  // .env is optional (e.g. CI, or vars already provided by the shell).
}

// The API server uses PORT too, so the frontend reads its own FRONTEND_PORT
// first to avoid a clash when both read the same .env.
const rawPort = process.env.FRONTEND_PORT ?? process.env.PORT ?? '5173';

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid FRONTEND_PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? '/';

// Where the local API server listens; dev requests to /api are proxied there.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:5000';

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
