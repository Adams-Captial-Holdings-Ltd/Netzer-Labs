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
      ...(process.env.CCE_WORK_MOCK === '1'
        ? [(await import('./dev/mock-work-plugin')).mockWorkPlugin()]
        : []),
      ...(process.env.CCE_CHAT_MOCK === '1'
        ? [(await import('./dev/mock-stream-plugin')).mockStreamPlugin()]
        : []),
    ],
    base: '/dashboard/',

    // ── THE ENABLER (donor harvest) ──────────────────────────────────────
    // Mirrors web/tsconfig.json `paths`. Both halves are required and neither
    // covers the other: tsconfig makes `tsc` resolve these specifiers, this
    // makes the BUNDLER resolve them. A donor file that typechecks and then
    // fails at build time is the failure this pairing exists to prevent.
    //
    // react/react-dom are deliberately ABSENT: @preact/preset-vite already
    // aliases them by default and its aliases are merged AHEAD of
    // `resolve.alias`, so an entry here would be dead code that reads as
    // configuration (the spike branch documented that trap).
    resolve: {
      alias: {
        // Donor source imports its own app root as `~/...`.
        '~': fileURLToPath(new URL('./src/components/chat/lc', import.meta.url)),
        // The donor's UI primitive package (@librechat/client), mapped onto the
        // primitives this app already has. Aliased rather than vendored so the
        // donor files that import it stay byte-for-byte.
        '@librechat/client': fileURLToPath(
          new URL('./src/lib/chat/librechat-client-shim.tsx', import.meta.url),
        ),
        // The eight date-fns functions utils/convos.ts needs.
        'date-fns': fileURLToPath(new URL('./src/lib/chat/date-fns-shim.ts', import.meta.url)),
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
