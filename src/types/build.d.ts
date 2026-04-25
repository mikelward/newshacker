declare const __BUILD_COMMIT_TIME__: string;
// `process.env.VERCEL_ENV` baked in at build time. One of
// `'production'`, `'preview'`, `'development'`, or `'test'` (the last
// is the Vitest pin so unit tests don't depend on the host shell's
// Vercel env). Read via `getDeployEnv()` in `src/lib/deployEnv.ts`.
declare const __DEPLOY_ENV__: string;
