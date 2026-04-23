# Install & setup

## Prerequisites

- Node.js `^20.19.0 || >=22.12.0` (the `engines` in `package.json`; matches `@vitejs/plugin-react` 5.x)
- npm
- Git

## Clone & install

```bash
git clone <repo>
cd newshacker
npm install
```

## Run the checks

```bash
npm test         # Vitest (run mode)
npm run lint     # ESLint
npm run typecheck
npm run build    # vite build
```

## Local development

Two options, depending on whether you need the `/api/*` serverless functions to run:

| Command | What runs | Use when |
|---|---|---|
| `npm run dev` | Vite dev server only | Iterating on UI/components. Any `fetch('/api/…')` call will 404. |
| `npx vercel dev` | Vite + `/api/*` serverless functions | You need `/api/summary` (or any future API route) to work. |

`npx vercel dev` will prompt you to link a Vercel project on first run. Accept the defaults.

## Environment variables

Put local values in `.env.local` at the repo root (git-ignored). On Vercel, set them in **Project → Settings → Environment Variables** and redeploy after any change.

| Name | Required | Applies to | What it's for |
|---|---|---|---|
| `GOOGLE_API_KEY` | Yes, for `/api/summary` and `/api/comments-summary` | Production + Preview (and locally if you use `vercel dev` and want live summaries) | Google AI Studio key used to call Gemini 2.5 Flash-Lite. Without it, the endpoints return `503 { "error": "Summary is not configured" }` and the UI shows "Could not summarize." |
| `JINA_API_KEY` | **Yes**, for `/api/summary` and the warm-summaries cron | Production + Preview | Jina Reader (`r.jina.ai`) key. `/api/summary` hits Jina to fetch article text before summarising; there is no server-side fallback. Without this, `/api/summary` returns `503 not_configured` and the cron's article track logs `skipped_unreachable`. (The raw-HTML fallback was removed — see TODO.md § "Article-fetch fallback" for rationale.) |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` *or* `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Yes for the shared summary cache | Production + Preview | Upstash Redis credentials. Vercel's Storage Marketplace auto-injects the `KV_REST_*` pair; a direct Upstash project uses `UPSTASH_REDIS_REST_*`. Either pair works; the handlers accept either. Without it, every request regenerates via Gemini (handler fails open for correctness, but you pay per-request). |
| `CRON_SECRET` | Yes for the warm-summaries cron | Production | Bearer token Vercel Cron sends with scheduled requests. **You set this yourself** — Vercel does not auto-generate it. Any long random string works (e.g. `openssl rand -hex 32`); save the value locally because Vercel's UI won't let you read it back. If unset, Vercel Cron fires with no `Authorization` header and the handler's fail-closed check returns 403 on every tick. See `CRON.md` for the full setup walkthrough. |
| `SUMMARY_REFERER_ALLOWLIST` | No | Production + Preview | Comma-separated list of hostnames allowed to call `/api/summary`. Overrides the default (`newshacker.app,hnews.app`). `localhost`, `127.0.0.1`, and any `*.vercel.app` subdomain are always allowed. |
| `SUMMARY_RATE_LIMIT_BURST` | No | Production + Preview | Cache-miss calls allowed per IP in a 10-minute window, shared across `/api/summary` and `/api/comments-summary`. Default `20`. Set to `0` or `off` to disable just the burst tier. Cached responses never count against this. |
| `SUMMARY_RATE_LIMIT_DAILY` | No | Production + Preview | Cache-miss calls allowed per IP in a 24-hour window, shared across the two summary endpoints. Default `200`. Set to `0` or `off` to disable just the daily tier. |

Operating the scheduled cache warmer (`/api/warm-summaries`) — enabling it, verifying it, tuning the backoff knobs, disabling it — lives in its own playbook at `CRON.md`. Start there the first time you deploy.

### Getting a Google API key

1. Visit `aistudio.google.com/app/apikey` and sign in.
2. Click **Create API key**, pick or create a Google Cloud project.
3. Copy the key — you won't see it again.
4. Set a spend cap in Google Cloud Console → Billing → Budgets & alerts. Start low while you test.

### Sanity-check a key

```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GOOGLE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"contents":[{"parts":[{"text":"Say hi in three words."}]}]}'
```

A successful response contains `candidates[].content.parts[].text`. `API_KEY_INVALID` means the key is wrong; `PERMISSION_DENIED` means the Generative Language API isn't enabled for the key's project.

### Getting a Jina API key

1. Visit `jina.ai/reader` and sign in.
2. Copy the API key from the dashboard. The free tier covers ~10M tokens/month, which is plenty for this project.
3. Set it as `JINA_API_KEY` in Vercel (Production + Preview) and in `.env.local` for `vercel dev`.

### Sanity-check a Jina key

```bash
curl -s "https://r.jina.ai/https://example.com/" \
  -H "Authorization: Bearer $JINA_API_KEY" \
  -H "X-Return-Format: markdown" | head
```

A successful response returns the article as markdown. `401` means the key is wrong or missing.

## Deploy

Pushing to the main branch (or opening a PR) deploys via Vercel's GitHub integration. After adding or changing any environment variable in the Vercel dashboard you must **redeploy** — existing deployments keep their original env snapshot.

## Troubleshooting

- **"Could not summarize. Summary is not configured."** — either `GOOGLE_API_KEY` or `JINA_API_KEY` is unset for the environment serving the request. Check the correct environment is ticked in Vercel, then redeploy.
- **`/api/summary` returns 403 `Forbidden`.** — The `Referer` header isn't on the allowlist. For local dev this means you're calling the function from somewhere other than `localhost`, a `*.vercel.app` preview, or a host in `SUMMARY_REFERER_ALLOWLIST`.
- **`npm run dev` returns 404 on `/api/summary`.** — Vite alone doesn't run serverless functions. Use `npx vercel dev` instead.
- **Cron-specific symptoms (no `warm-run` logs, unexpected Gemini spend, etc.).** — see `CRON.md` § "Troubleshooting".
