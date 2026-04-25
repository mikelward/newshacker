// Thin wrapper around the Vite-injected `__DEPLOY_ENV__` global so
// callers don't have to know about the build-time inlining. Vercel
// sets `VERCEL_ENV` to `'production' | 'preview' | 'development'`
// during the build; vite.config.ts mirrors that value into
// `__DEPLOY_ENV__` and pins it to `'test'` under Vitest.
//
// The narrow `DeployEnv` type is the surface the rest of the app
// touches — anything outside the union is normalized back to
// `'development'` so a typo in the env var can't turn into an
// always-emit telemetry path.
export type DeployEnv = 'production' | 'preview' | 'development' | 'test';

const KNOWN: ReadonlySet<DeployEnv> = new Set([
  'production',
  'preview',
  'development',
  'test',
]);

export function getDeployEnv(): DeployEnv {
  const raw = __DEPLOY_ENV__;
  return (KNOWN as Set<string>).has(raw) ? (raw as DeployEnv) : 'development';
}
