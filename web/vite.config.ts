import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import preact from '@preact/preset-vite';

// ESM config (package.json "type": "module") — no __dirname.
const configDir = fileURLToPath(new URL('.', import.meta.url));

const stripBrowserHeaders = (proxy: Parameters<NonNullable<ProxyOptions['configure']>>[0]) => {
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.removeHeader('cookie');
    proxyReq.removeHeader('sec-fetch-site');
    proxyReq.removeHeader('sec-fetch-mode');
    proxyReq.removeHeader('sec-fetch-dest');
    proxyReq.removeHeader('sec-ch-ua');
    proxyReq.removeHeader('sec-ch-ua-mobile');
    proxyReq.removeHeader('sec-ch-ua-platform');
  });
};

export default defineConfig(async ({ mode }) => {
  // Dev-proxy target for `npm run dev` in web/. Defaults to the local
  // orchestrator; point CCE_DEV_PROXY_TARGET at a deployed origin (e.g.
  // https://origin.<your-domain>) to develop the SPA against live data.
  // Set it in the shell or in gitignored web/.env.local.
  const fileEnv = loadEnv(mode, configDir, 'CCE_');
  const proxyTarget =
    process.env.CCE_DEV_PROXY_TARGET ?? fileEnv.CCE_DEV_PROXY_TARGET ?? 'http://localhost:3000';
  const proxySecure = proxyTarget.startsWith('https://');

  return {
    plugins: [
      preact(),
      // Dev-only mock SSE harness (`CCE_CHAT_MOCK=1 npm run dev`): answers
      // POST /api/test-turn/stream with scripted fixtures before the proxy.
      // Imported dynamically INSIDE the guard, never at module top level, so a
      // production `vite build` never loads web/dev/ at all — a static import
      // would be evaluated on every build regardless of the guard, leaving the
      // build dependent on dev-only files being present.
      ...(process.env.CCE_CHAT_MOCK === '1'
        ? [(await import('./dev/mock-stream-plugin')).mockStreamPlugin()]
        : []),
    ],
    base: '/dashboard/',
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      // Emit the AudioWorklet as a real asset file (not an inlined data URL) so
      // audioWorklet.addModule() loads it reliably across browsers.
      assetsInlineLimit: (filePath: string) => (filePath.includes('audio-worklet') ? false : undefined),
    },
    server: {
      proxy: {
        // Jarvis voice WebSocket relay (Phase 1). Listed before the generic
        // /api proxy so the upgrade is matched first; harmless at Phase 0 where
        // the WS endpoint is not yet wired.
        '/api/jarvis/voice': {
          target: proxyTarget,
          changeOrigin: true,
          secure: proxySecure,
          ws: true,
          configure: stripBrowserHeaders,
        },
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          secure: proxySecure,
          configure: stripBrowserHeaders,
        },
        '/warroom': {
          target: proxyTarget,
          changeOrigin: true,
          secure: proxySecure,
          configure: stripBrowserHeaders,
        },
      },
    },
  };
});
