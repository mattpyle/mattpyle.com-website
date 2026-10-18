import type { APIRoute } from 'astro';
import { buildSignatureAgentCard } from '../../lib/steward-identity.mjs';

/**
 * Steward's Signature Agent Card and OAuth Client ID Metadata Document, one document at one URL,
 * prerendered to /.well-known/signature-agent-card.
 *
 * Every Steward signature names this URL in `Signature-Agent` with `type=cimd`. A verifier
 * fetches it, checks that `client_id` is this URL, and follows `jwks_uri` to the key directory.
 * src/lib/steward-identity.mjs builds it and says why one document carries both roles.
 *
 * Extension-less like the directory, so vercel.json and scripts/serve-built-site.mjs set the
 * media type on the path; the header here keeps the dev server in step.
 */

export const GET: APIRoute = ({ site }) =>
  new Response(`${JSON.stringify(buildSignatureAgentCard(site!.toString()), null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
