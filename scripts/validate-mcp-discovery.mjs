/**
 * Validate the site's two MCP discovery documents against their specs, and against this site.
 *
 * Two documents, two conventions, one endpoint. `public/.well-known/mcp-server` is the IETF
 * draft's document; `public/mcp/server-card` is SEP-2127's Server Card, at the location that SEP
 * reserves. They describe the same `/mcp` route in two vocabularies that share not one field name,
 * which is the whole reason both are published: whichever one a client fetches is the answer to
 * "which convention did anything actually implement", and the agent-surface log records it.
 *
 * Runs in the `build` chain beside validate-a2a-card.mjs, and exists for the same reason: both are
 * hand-written static files that no build step generates, so they are among the artifacts here that
 * can silently rot. The failure it prevents is the worst kind a discovery document has — an agent
 * that finds it, reads an endpoint that has moved or a name that no longer matches what the server
 * says after `initialize`, and gives up. Nothing else in the repo would notice.
 *
 * ## Why the checks are these checks: /.well-known/mcp-server
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
 *
 * **No rate-limit numbers live in this document, and none should be added.** The caps come from the
 * environment through readLimits/readDeepLimits, so the only surface that can state them without
 * drifting is /steward, which renders the resolved values at build. A number copied into a static
 * file agrees with the code until somebody sets the variable: `MCP_DEEP_RATE_PER_CALLER` was 4 on
 * production while both this document's neighbours in agents.md and the code default said 2, and
 * nothing noticed for a deploy. This cannot be asserted here — the build resolves the deployment's
 * own environment, so an equality check would pass on Vercel and fail locally for the same correct
 * file — so the rule is the docblock and the fix is to point at /steward instead.
 *
 * ## Why the checks are these checks: /mcp/server-card
 *
 * Shape conformance comes from scripts/lib/mcp-server-card.schema.json, a transcription of the
 * schema published in github.com/modelcontextprotocol/ext-server-card. That file's own `$comment`
 * records where it came from and what was narrowed. The transcription was checked against the
 * upstream file with ajv on 2026-08-27, verbatim and with five mutations of the card: a wrong
 * `$schema` URL, a description over 100 characters, a `name` with no slash, an unlisted transport,
 * and a missing `version`. Both schemas rejected all five. Re-run that comparison after any
 * re-vendoring; a transcription is only as good as the last time somebody diffed it.
 *
 * The cross-checks are again the ones a schema cannot make:
 *
 * 1. `remotes[0].url` is the site's own `/mcp` route, the same assertion the draft document's
 *    `endpoint` gets and for the same reason.
 * 2. The `name`'s server segment is `SERVER_NAME`, under the registry namespace in
 *    docs/reference/mcp-registry-publishing.md. The card's name is fully qualified and the
 *    runtime's is bare, so this is a two-part check rather than an equality one. What it guards is
 *    the SEP's "Consistency with Runtime Behavior" requirement: the card is read before a client
 *    connects, so an identity here that contradicts `initialize` is a downgrade vector rather than
 *    a typo.
 * 3. `version` is `AUDIT_VERSION`, read out of the Steward workspace's source rather than imported.
 *    A build script runs under plain node and that entry is TypeScript, so the import resolves to a
 *    `.js` file that does not exist. The regex is the pin the AUDIT_VERSION docblock asks for,
 *    "anything that cannot import this is pinned against it by a test rather than left to agree by
 *    hand", and if the declaration's shape ever changes this fails loudly instead of skipping.
 * 4. `remotes[0].supportedProtocolVersions` is the SDK's `SUPPORTED_PROTOCOL_VERSIONS`, exactly and
 *    in order. This is the field that drifts on its own: the endpoint negotiates whatever the SDK
 *    it is built against supports, so an SDK upgrade silently makes the card understate or
 *    overstate the endpoint. Measured against production on 2026-08-27, an `initialize` for each of
 *    the five was echoed back and an unsupported version fell back to the newest.
 * 5. The fast-tier-only rule, carried over from the draft document above. It costs more here: the
 *    schema caps `description` at 100 characters, so naming the fast tool and staying silent about
 *    the deep one has to fit in one sentence. The same no-cap-numbers rule applies, and there is no
 *    room to point at /steward either, so the card says nothing at all about caps.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import {
  SERVER_NAME,
  TOOL_NAME,
  DEEP_TOOL_NAME,
  GET_AUDIT_TOOL_NAME,
} from '../src/lib/mcp-audit-server.mjs';
import { validate } from './lib/json-schema.mjs';

const DOCUMENT = fileURLToPath(new URL('../public/.well-known/mcp-server', import.meta.url));
const CARD = fileURLToPath(new URL('../public/mcp/server-card', import.meta.url));
const CARD_SCHEMA = fileURLToPath(new URL('./lib/mcp-server-card.schema.json', import.meta.url));
const SAFE_FETCH = fileURLToPath(
  new URL('../agents/steward/src/lib/agent-audit/safe-fetch.ts', import.meta.url)
);
const EXPECTED_ENDPOINT = 'https://www.mattpyle.com/mcp';
const EXPECTED_CARD_NAMESPACE = 'com.mattpyle';
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

// ---------------------------------------------------------------------------
// /mcp/server-card
// ---------------------------------------------------------------------------

const cardFailures = [];

let card;
try {
  card = JSON.parse(readFileSync(CARD, 'utf8'));
} catch (error) {
  console.error(`✗ /mcp/server-card is not valid JSON: ${error.message}`);
  process.exit(1);
}

const cardSchema = JSON.parse(readFileSync(CARD_SCHEMA, 'utf8'));
cardFailures.push(...validate(card, cardSchema, cardSchema, '', []));

// Everything below is a cross-check against this site, so it only runs on a document that already
// has the shape the assertions assume. A malformed card would otherwise report the same fault
// several times over in several vocabularies.
if (cardFailures.length === 0) {
  const remote = card.remotes?.[0];

  if (remote?.url !== EXPECTED_ENDPOINT) {
    cardFailures.push(
      `remotes[0].url must be ${EXPECTED_ENDPOINT}; found ${JSON.stringify(remote?.url)}`
    );
  }

  const expectedName = `${EXPECTED_CARD_NAMESPACE}/${SERVER_NAME}`;
  if (card.name !== expectedName) {
    cardFailures.push(
      `name must be ${expectedName}: the registry namespace, then SERVER_NAME from ` +
        `src/lib/mcp-audit-server.mjs. Found ${JSON.stringify(card.name)}`
    );
  }

  // The pin the AUDIT_VERSION docblock asks for. No match at all is a failure rather than a skip:
  // a validator that quietly stops asserting when a declaration moves is worse than no validator.
  const auditVersion = readFileSync(SAFE_FETCH, 'utf8').match(
    /export const AUDIT_VERSION = '([^']+)'/
  );
  if (!auditVersion) {
    cardFailures.push(
      'AUDIT_VERSION could not be read from agents/steward/src/lib/agent-audit/safe-fetch.ts; ' +
        'the declaration moved or changed shape, and the card is no longer pinned to it'
    );
  } else if (card.version !== auditVersion[1]) {
    cardFailures.push(
      `version must match AUDIT_VERSION (${auditVersion[1]}), the version the endpoint announces ` +
        `after initialize; found ${JSON.stringify(card.version)}`
    );
  }

  const declared = remote?.supportedProtocolVersions ?? [];
  if (declared.join(',') !== SUPPORTED_PROTOCOL_VERSIONS.join(',')) {
    cardFailures.push(
      `remotes[0].supportedProtocolVersions must be the SDK's SUPPORTED_PROTOCOL_VERSIONS ` +
        `(${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}); found ${declared.join(', ') || 'nothing'}`
    );
  }

  if (!card.description.includes(TOOL_NAME)) {
    cardFailures.push(`description must name the fast tool ${TOOL_NAME}`);
  }
  for (const tool of [DEEP_TOOL_NAME, GET_AUDIT_TOOL_NAME]) {
    if (card.description.includes(tool)) {
      cardFailures.push(
        `description must not advertise the deep tier; found ${tool}. Clients find it through tools/list`
      );
    }
  }
}

if (cardFailures.length > 0) {
  console.error('✗ /mcp/server-card is invalid:');
  for (const failure of cardFailures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ /mcp/server-card names ${card.name} at ${card.remotes[0].url}, fast tier only`);
