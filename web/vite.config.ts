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
      // @preact/preset-vite ALREADY aliases react/react-dom/react-jsx-runtime
      // to preact/compat by default (reactAliasesEnabled defaults to true).
      // Its aliases are merged ahead of this config's `resolve.alias`, so they
      // win — disable them to take control of the mapping.
      preact({ reactAliasesEnabled: false }),
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
    // SPIKE (spike/preact-compat): alias React -> preact/compat so donor
    // LibreChat component source can be compiled unmodified.
    //
    // ORDER IS LOAD-BEARING. Vite/@rollup-plugin-alias matches a string `find`
    // against `id === find || id.startsWith(find + '/')`, first match wins and
    // object key order is the array order. With `react` listed first,
    // `react/jsx-runtime` would rewrite to `preact/compat/jsx-runtime`, which
    // does not exist. Deep specifiers must precede their bare package.
    resolve: {
      alias: {
        'react/jsx-runtime': 'preact/jsx-runtime',
        'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
        'react-dom/test-utils': 'preact/test-utils',
        'react-dom/client': 'preact/compat/client',
        'react-dom': fileURLToPath(new URL('./src/spike/react-compat-shim.ts', import.meta.url)),
        react: fileURLToPath(new URL('./src/spike/react-compat-shim.ts', import.meta.url)),
        // Donor LibreChat source imports its own app root as `~/...`. Pointing
        // `~` at the shim tree lets donor files be copied byte-for-byte.
        '~': fileURLToPath(new URL('./src/spike/lc', import.meta.url)),
        // Donor workspace packages, stubbed. Aliased (not vendored) so the
        // donor files that import them stay byte-for-byte.
        recoil: fileURLToPath(new URL('./src/spike/lc/shims/recoil.ts', import.meta.url)),
        '@librechat/client': fileURLToPath(
          new URL('./src/spike/lc/shims/librechat-client.tsx', import.meta.url),
        ),
        'librechat-data-provider': fileURLToPath(
          new URL('./src/spike/lc/shims/librechat-data-provider.ts', import.meta.url),
        ),
      },
    },

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
