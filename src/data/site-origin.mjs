export const PRODUCTION_ORIGIN = 'https://www.mattpyle.com';

/**
 * Keep production URLs canonical, but make preview artifacts self-contained.
 * Vercel exposes VERCEL_URL as a deployment hostname during preview builds.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveSiteOrigin(env = process.env) {
  if (env.VERCEL_ENV !== 'preview' || !env.VERCEL_URL) {
    return PRODUCTION_ORIGIN;
  }

  const candidate = env.VERCEL_URL.includes('://')
    ? env.VERCEL_URL
    : `https://${env.VERCEL_URL}`;
  const url = new URL(candidate);

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(`VERCEL_URL must be an HTTPS hostname; received ${JSON.stringify(env.VERCEL_URL)}`);
  }

  return url.origin;
}

export const SITE_ORIGIN = resolveSiteOrigin();
