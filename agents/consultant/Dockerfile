# The audit consultant's worker: one process on its own task queue. No browser,
# no checkout of the site, no credential that signs or pushes.
#
# THE BUILD CONTEXT IS THE REPO ROOT, as for Steward's image: `agents/consultant`
# is an npm workspace, resolved from the root `package.json` and lockfile.
#
#   docker build -f agents/consultant/Dockerfile -t audit-consultant .
#
# The environment it needs, by name (src/config.ts reads them):
#   TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE  required; no default. The deployed
#                                         service has a namespace of its own.
#   TEMPORAL_API_KEY                      for Temporal Cloud; TLS follows it
#   ANTHROPIC_API_KEY                     required
#   CONSULTANT_TASK_QUEUE                 default audit-consultant
#   CONSULTANT_MODEL                      default claude-sonnet-5-5
#   CONSULTANT_MCP_URL                    default https://www.mattpyle.com/mcp; https only
#   CONSULTANT_CAP_*                      overrides for src/caps.ts
# With a required value missing, the worker starts nothing and exits non-zero.

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/agents/consultant \
  && chown node:node /app /app/agents /app/agents/consultant

WORKDIR /app
USER node

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node agents/consultant/package.json ./agents/consultant/

# Only this workspace's tree; the site's and Steward's dependencies stay out.
# No install script is needed: the native binaries arrive as platform packages.
RUN npm ci --workspace @mattpyle/consultant --include-workspace-root=false --ignore-scripts

COPY --chown=node:node agents/consultant/ ./agents/consultant/

WORKDIR /app/agents/consultant
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--import", "tsx", "--import", "./src/sdk-compat.ts", "src/worker.ts"]
