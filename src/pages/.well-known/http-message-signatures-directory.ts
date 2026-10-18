import type { APIRoute } from 'astro';
import { DIRECTORY_MEDIA_TYPE, buildDirectory } from '../../lib/steward-identity.mjs';

/**
 * Steward's Web Bot Auth key directory, prerendered to /.well-known/http-message-signatures-directory.
 *
 * The keys a verifier checks a `steward-audit` signature against; src/lib/steward-identity.mjs
 * says how the directory and the Signature Agent Card fit together. The draft requires this exact
 * path and the media type below (draft-ietf-webbotauth-httpsig-protocol-00, sections 5.5.1 and 8).
 *
 * A prerendered route becomes an extension-less static file, which the platform would serve as
 * application/octet-stream, so vercel.json sets the media type on the path for production and
 * scripts/serve-built-site.mjs mirrors it locally. The header here keeps the dev server in step.
 */

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildDirectory(), null, 2)}\n`, {
    headers: { 'Content-Type': DIRECTORY_MEDIA_TYPE },
  });
