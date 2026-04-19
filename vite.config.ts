/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA runtime caches are sized for "browse what you've recently touched
// while offline". The SW cache is additive to the React Query persister —
// RQ hydrates the UI from localStorage on cold start, and Workbox serves
// any fetches RQ decides to make.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
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
              networkTimeoutSeconds: 3,
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
            urlPattern: /\/api\/items(?:\?.*)?$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'hn-items-batch',
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
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});
