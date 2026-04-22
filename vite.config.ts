/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA runtime caches are sized for "browse what you've recently touched
// while offline". The SW cache is additive to the React Query persister —
// RQ hydrates the UI from localStorage on cold start, and Workbox serves
// any fetches RQ decides to make.
//
// `process.env.VITEST` is set when vitest boots; we skip the PWA plugin
// in tests because it adds noticeable startup cost per worker and has
// no behavior the unit tests exercise.
const isTest = process.env.VITEST === 'true';

export default defineConfig({
  plugins: [
    react(),
    !isTest && VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'newshacker',
        short_name: 'newshacker',
        description: 'A mobile-friendly, unofficial reader for Hacker News.',
        theme_color: '#ff6600',
        background_color: '#f6f6ef',
        display: 'standalone',
        start_url: '/top',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Workbox's default for the SPA navigation fallback is index.html,
        // which is what we want — offline navigation to /pinned, /item/:id,
        // etc. resolves to the precached shell and React Router takes over.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/hacker-news\.firebaseio\.com\/v0\/item\/.*\.json$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'hn-items',
              expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/hacker-news\.firebaseio\.com\/v0\/.*stories\.json$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'hn-feeds',
              // The feed list changes on every HN ranking pass, so we
              // wait a relatively long time for the network before
              // giving up and serving the cached copy. 3s was short
              // enough to flip to a stale list on ordinary mobile data.
              networkTimeoutSeconds: 10,
              expiration: { maxEntries: 10, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/hacker-news\.firebaseio\.com\/v0\/user\/.*\.json$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'hn-users',
              expiration: { maxEntries: 50, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Same-origin matcher; /api/summary is only ever served by our
            // Vercel functions on the current origin, so a path-anchored
            // regex is equivalent and avoids touching the SW global.
            urlPattern: /\/api\/summary(?:\?.*)?$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'ai-summaries',
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Sibling rule for comment summaries. Same strategy + TTL as
            // /api/summary so that a pinned or favorited story keeps its
            // comment summary available offline exactly as long as its
            // article summary does.
            urlPattern: /\/api\/comments-summary(?:\?.*)?$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'ai-comment-summaries',
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // NetworkFirst, not StaleWhileRevalidate: SWR returns the
            // cached batch immediately, which means a feed reload paints
            // yesterday's score and comment counts even when the network
            // is healthy. NetworkFirst still falls back to the cache when
            // the user is genuinely offline, so `/pinned` etc. keep
            // working. The Vercel function sets max-age=60, so online
            // users hit either the browser HTTP cache or the edge cache
            // anyway — no meaningful extra traffic.
            urlPattern: /\/api\/items(?:\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'hn-items-batch',
              networkTimeoutSeconds: 10,
              expiration: { maxEntries: 50, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Don't generate a SW in `npm run dev` — it caches aggressively and
        // makes iteration painful. The plugin is fully exercised by
        // `npm run build && npm run preview`.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: isTest
      ? {
          // The PWA plugin is skipped under vitest (see above), so the
          // `virtual:pwa-register` module it normally provides isn't
          // resolvable. Point it at a no-op stub so `src/lib/pwa.ts`
          // still imports cleanly — SW registration is a browser-only
          // concern anyway.
          'virtual:pwa-register': '/src/test/pwaRegisterStub.ts',
        }
      : undefined,
  },
  test: {
    globals: true,
    // Default to happy-dom for component/hook/page tests — it's the
    // same DOM contract testing-library needs but spins up noticeably
    // faster per file than jsdom, which was ~95% of `npm test` cost.
    // Pure-logic tests under src/lib and api/ still route to the node
    // environment via environmentMatchGlobs below.
    environment: 'happy-dom',
    environmentMatchGlobs: [
      ['api/**/*.test.ts', 'node'],
      ['src/lib/analytics.test.ts', 'node'],
      ['src/lib/commentPrefetch.test.ts', 'node'],
      ['src/lib/favoriteStoryPrefetch.test.ts', 'node'],
      ['src/lib/feedStoryPrefetch.test.ts', 'node'],
      ['src/lib/feeds.test.ts', 'node'],
      ['src/lib/format.test.ts', 'node'],
      ['src/lib/pinnedStoryPrefetch.test.ts', 'node'],
      ['src/lib/queryCacheSync.test.ts', 'node'],
      ['src/lib/sanitize.test.ts', 'node'],
      ['src/lib/vote.test.ts', 'node'],
    ],
    setupFiles: ['./vitest.setup.ts'],
    // Threads are cheaper to spawn than forks and we don't use any
    // native modules that require process isolation.
    pool: 'threads',
    css: false,
  },
});
