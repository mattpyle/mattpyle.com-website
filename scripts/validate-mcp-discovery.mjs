/**
 * Validate public/.well-known/mcp-server against the discovery draft, and against this site.
 *
 * Runs in the `build` chain beside validate-a2a-card.mjs, and exists for the same reason: the
 * document is a hand-written static file that no build step generates, so it is one of the two
 * artifacts here that can silently rot. The failure it prevents is the worst kind a discovery
 * document has — an agent that finds it, reads an endpoint that has moved or a name that no longer
 * matches what the server says after `initialize`, and gives up. Nothing else in the repo would
 * notice.
 *
 * ## Why the checks are these checks
 *
 * The four required fields come from draft-serra-mcp-discovery-uri-04 §6: `mcp_version`, `name`,
 * `endpoint`, `transport`. Everything else in the document is SHOULD or MAY, so it is not asserted
 * here — a validator that pins optional fields turns an editorial change into a red build.
 *
 * The two cross-checks are the ones the draft cannot make, because they are about this site:
 *
 * 1. `endpoint` is the site's own `/mcp` route on the canonical origin. A document naming an
 *    endpoint the site does not serve is worse than no document.
 * 2. `name` is `SERVER_NAME` from src/lib/mcp-audit-server.mjs, the name a client is told after
 *    `initialize`. A client that finds the server here under one name and connects to another has
 *    to decide which to trust; keeping them equal means it never has to.
 *
 * `transport: "http"` is asserted against the draft's own vocabulary rather than against the MCP
 * spec's: the draft's three values are http, sse and stdio, and this endpoint's streamable HTTP is
 * the first of them.
 *
 * The third cross-check is a decision rather than a specification. **The document describes the
 * fast tier only**, and a client finds `deep_audit` and `get_audit` through `tools/list`: a
 * well-known document is read by every agent that goes looking for a server, and advertising a
 * capped, minutes-long tool to all of them invites a traffic shape the one worker behind it cannot
 * serve. So the description has to name the fast tool and must not name either deep one. Written as
 * an assertion because the decision is invisible in the document itself — a later edit that adds a
 * sentence about `deep_audit` would look like an improvement and read as one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SERVER_NAME,
  TOOL_NAME,
  DEEP_TOOL_NAME,
  GET_AUDIT_TOOL_NAME,
} from '../src/lib/mcp-audit-server.mjs';

const DOCUMENT = fileURLToPath(new URL('../public/.well-known/mcp-server', import.meta.url));
const EXPECTED_ENDPOINT = 'https://www.mattpyle.com/mcp';
const REQUIRED_FIELDS = ['mcp_version', 'name', 'endpoint', 'transport'];
const TRANSPORTS = ['http', 'sse', 'stdio'];

const failures = [];

let manifest;
try {
  manifest = JSON.parse(readFileSync(DOCUMENT, 'utf8'));
} catch (error) {
  console.error(`✗ /.well-known/mcp-server is not valid JSON: ${error.message}`);
  process.exit(1);
}

for (const field of REQUIRED_FIELDS) {
  if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
    failures.push(`${field} is required and must be a non-empty string (draft §6)`);
  }
}

if (!TRANSPORTS.includes(manifest.transport)) {
  failures.push(`transport must be one of ${TRANSPORTS.join(', ')}; found ${JSON.stringify(manifest.transport)}`);
}

if (manifest.endpoint !== EXPECTED_ENDPOINT) {
  failures.push(`endpoint must be ${EXPECTED_ENDPOINT}; found ${JSON.stringify(manifest.endpoint)}`);
}

if (manifest.name !== SERVER_NAME) {
  failures.push(
    `name must match SERVER_NAME in src/lib/mcp-audit-server.mjs (${SERVER_NAME}); found ${JSON.stringify(manifest.name)}`
  );
}

const description = typeof manifest.description === 'string' ? manifest.description : '';
if (!description.includes(TOOL_NAME)) {
  failures.push(`description must name the fast tool ${TOOL_NAME}`);
}
for (const tool of [DEEP_TOOL_NAME, GET_AUDIT_TOOL_NAME]) {
  if (description.includes(tool)) {
    failures.push(`description must not advertise the deep tier; found ${tool}. Clients find it through tools/list`);
  }
}

if (failures.length > 0) {
  console.error('✗ /.well-known/mcp-server is invalid:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ /.well-known/mcp-server names ${SERVER_NAME} at ${manifest.endpoint}, fast tier only`);
