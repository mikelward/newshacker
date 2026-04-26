import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// `process.env.VITEST` is set when vitest boots; we skip the PWA plugin
// in tests because it adds noticeable startup cost per worker and has
// no behavior the unit tests exercise.
const isTest = process.env.VITEST === 'true';

// Captured at config-load time so /debug can show "what commit is this
// bundle from, and how old is it?" without needing a runtime endpoint.
// Vercel checks the repo out via git during the build, so `git log`
// works there. If the command fails (shallow checkout, no git, etc.)
// we fall back to an empty string and the UI hides the row.
function readCommitTime(): string {
  try {
    return execSync('git log -1 --format=%cI', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// Pin a deterministic ISO string under Vitest so the `/debug` "Built"
// row tests don't depend on whether the checkout has git metadata
// (shallow clones, tarballs, sandboxed CI runners without git all
// return '' from `readCommitTime()`, which would silently flip the
// UI to "unknown" and break the happy-path assertion). The fallback
// branch itself is covered by a separate test that mocks the value.
const TEST_BUILD_COMMIT_TIME = '2026-01-01T00:00:00.000Z';
const buildCommitTime = isTest ? TEST_BUILD_COMMIT_TIME : readCommitTime();

// Captured at config-load time and inlined into the client bundle so
// the threshold-tuning telemetry (see `src/lib/telemetry.ts`) knows
// which Vercel environment it's running in. `production` and `preview`
// are the two states we care about — the telemetry endpoint accepts
// admin-authed events from `production` and anonymous events from
// `preview` (so the Vercel preview URL collects from any visitor while
// production stays gated). Falls back to `'development'` for `npm run
// dev`, and is pinned to `'test'` under Vitest so unit tests don't
// accidentally pick up a stray VERCEL_ENV from a CI shell.
const deployEnv = isTest
  ? 'test'
  : process.env.VERCEL_ENV ?? 'development';

export default defineConfig({
  define: {
    __BUILD_COMMIT_TIME__: JSON.stringify(buildCommitTime),
    __DEPLOY_ENV__: JSON.stringify(deployEnv),
  },
  plugins: [
    react(),
    !isTest && VitePWA({
      // autoUpdate silently activates a new service worker on the next
      // navigation (no prompt, no toast). Previously 'prompt' required an
      // explicit user acceptance to pick up a new bundle, which stranded
      // telemetry fixes (and other updates) on devices whose users hadn't
      // seen or dismissed the prompt — the symptom that forced incognito
      // testing while debugging /api/telemetry wiring. A reader app has
      // no in-progress state to lose on refresh, so the simpler behavior
      // wins.
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'newshacker',
        short_name: 'newshacker',
        description: 'A mobile-friendly, unofficial reader for Hacker News.',
        theme_color: '#ef5f00',
        background_color: '#f6f6ef',
        display: 'standalone',
        // SPEC.md *Routes* designates `/` as the home (it renders
        // Top inline; the brand/header link points there too).
        // Launching the installed PWA on `/top` paints the same
        // feed but parks the URL bar on the secondary path,
        // diverging from every other entry into the app. Keep
        // them aligned by starting on `/`.
        start_url: '/',
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
  test: {
    globals: true,
    // Default to happy-dom for component/hook/page tests — it's the
    // same DOM contract testing-library needs but spins up noticeably
    // faster per file than jsdom, which was ~95% of `npm test` cost.
    // Pure-logic tests under src/lib and api/ opt into the node
    // environment via a `// @vitest-environment node` docblock at the
    // top of each file. Vitest 4 removed `environmentMatchGlobs`, and
    // the per-file directive has the nice property that a new test
    // file can't silently inherit the wrong env.
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    // Threads are cheaper to spawn than forks and we don't use any
    // native modules that require process isolation.
    pool: 'threads',
    css: false,
    // Auto-restore `vi.stubGlobal` between tests so confirm/scrollTo/etc.
    // don't leak from one test to the next.
    unstubGlobals: true,
  },
});
