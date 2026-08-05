import type { APIRoute } from 'astro';
import index from '../../../data/agent-skills-index.json';

/**
 * The Agent Skills discovery index, prerendered to /.well-known/agent-skills/index.json.
 *
 * Agent Skills Discovery RFC v0.2.0. Publishers MUST serve the index at exactly this path, which
 * is why this route lives in a dot-directory under src/pages. Astro routes those and the Vercel
 * adapter copies them into the static output; verified by building, because it is the kind of
 * thing that is easy to assume either way.
 *
 * Serves the committed src/data/agent-skills-index.json rather than rebuilding the index here, so
 * what deploys is what a reviewer read in the diff. scripts/generate-agent-skills-index.mjs writes
 * that file in prebuild, and scripts/validate-agent-skills-index.mjs re-derives every digest from
 * the built output before the build passes.
 *
 * Parsed and re-serialised rather than imported with `?raw`, deliberately. core.autocrlf is on
 * with no .gitattributes, so a Windows checkout holds this file with CRLF and CI holds it with LF;
 * relaying the raw text would make the local audit and production disagree byte for byte for no
 * reason. Round-tripping through JSON pins the output to LF on every machine. Nothing is at risk
 * either way, since the digests inside describe the skill artifacts rather than this file, but the
 * two should still be the same document.
 *
 * The Content-Type below is what the RFC requires, but a prerendered route becomes a static file
 * and this header does not survive that: the platform serves it by extension. vercel.json pins
 * `application/json; charset=utf-8` on the path for the deployed answer. The header stays here so
 * the local `npx serve dist/client` audit and the dev server agree with production.
 */

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(index, null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
