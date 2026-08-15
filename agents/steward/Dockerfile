# Steward's hosted audit worker (always-on-audit-worker card, leg 2b).
#
# One process polling `steward-audit`, with a browser and no checkout of the
# site. Runs `src/worker-hosted.ts`; `src/worker.ts` — the all-three-queues
# laptop worker `steward up` starts — is deliberately not what this runs.
#
# THE BUILD CONTEXT IS THE REPO ROOT, NOT THIS DIRECTORY.
# `agents/steward` is an npm workspace, so its dependency tree is resolved from
# the root `package.json` and `package-lock.json`. Building with this directory
# as the context fails at `npm ci` with a missing lockfile, which reads as a
# corrupt image rather than a wrong `-f` flag. Build it as:
#
#   docker build -f agents/steward/Dockerfile -t steward-audit-worker .
#
# `railway.json` sets `dockerfilePath` accordingly and Railway uses the repo
# root as its context by default.
#
# HOST-AGNOSTIC ON PURPOSE (stage-3 card's decision). Nothing below names
# Railway. Everything Railway-specific lives in `railway.json`, so the
# Serverless Workers migration can reuse this image unchanged
# (audit-worker-on-serverless-workers card).

FROM node:24-bookworm-slim

# Chromium, and the font and library set Lighthouse and axe need to render a
# stranger's page faithfully.
#
# Debian's `chromium` rather than Google Chrome from the upstream .deb: it is in
# the base distribution, it is what `chrome-launcher` finds via CHROME_PATH
# below, and it tracks security updates through the same `apt upgrade` as
# everything else in the image. The audit reports Lighthouse's own category
# scores, which are computed from traces rather than from Chrome's branding, so
# the engine is what matters and it is the same engine.
#
# The fonts are not cosmetic. A page rendered without a CJK or emoji face
# reflows differently, and Lighthouse's layout-shift and paint metrics are
# measured off that render — a missing font silently changes a published number.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium \
     ca-certificates \
     fonts-liberation \
     fonts-noto-core \
     fonts-noto-cjk \
     fonts-noto-color-emoji \
     dumb-init \
  && rm -rf /var/lib/apt/lists/*

# `chrome-launcher` checks this before it goes looking, so the launch never
# depends on Debian's alternatives symlinks staying where they are.
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# The manifests first, as their own layer: dependencies change far less often
# than Steward's source, so an ordinary code deploy reuses the cached `npm ci`.
COPY package.json package-lock.json ./
COPY agents/steward/package.json ./agents/steward/

# `--workspace` so the site's own dependencies (Astro, Playwright, the OG-image
# toolchain) never enter this image; none of them is reachable from the worker.
#
# NOT `--omit=dev`. Steward has no build step and runs TypeScript through `tsx`,
# which is a devDependency — omitting dev dependencies produces an image that
# builds cleanly and then cannot start. That is the single easiest mistake to
# make here, and it fails at runtime rather than at build time.
RUN npm ci --workspace @mattpyle/steward --include-workspace-root=false

COPY agents/steward/ ./agents/steward/

# Chrome is launched with `--no-sandbox` (see `lib/audit-engine.ts`), which is
# the usual container arrangement and is why this image needs no seccomp
# profile. Running as a non-root user is what keeps that acceptable: the
# sandbox is off, so the process boundary is the boundary.
#
# The `node` user ships with the base image. It owns /app so `tsx`'s on-disk
# cache and Chrome's user-data directory are both writable.
RUN chown -R node:node /app
USER node

# `dumb-init` as PID 1, doing two jobs that both failed silently without it.
#
# **Signals.** Without an init, SIGTERM lands on `npm`, which does not forward
# it, so the worker never drains and every redeploy looks to Temporal like a
# worker that vanished mid-activity.
#
# **Reaping, which is the one that actually bit.** Chrome forks renderer and
# crashpad processes, and Lighthouse and axe each launch a browser per page.
# When those children are orphaned they are reparented to PID 1, and PID 1 has
# to `wait()` on them or they stay as zombies forever. `npm` never does. The
# first hosted deploy reached **773 zombies** in about two hours of auditing —
# 595 `chromium`, 140 `chrome_crashpad`, 36 `chromedriver` — and once the
# process table was that full, new chromedriver launches were killed on spawn.
# The symptom was `axe produced no result file (exit -1)` / `Server was killed
# with SIGTRAP`, on a container that had audited fine an hour earlier. Anything
# that gets slower or flakier the longer the container lives should be checked
# against `ps -e -o stat= | cut -c1 | sort | uniq -c` first.
#
# **DO NOT SET A START COMMAND ON THE HOST.** Railway's `deploy.startCommand`,
# and the equivalent on any other platform, replaces this ENTRYPOINT and makes
# `npm` PID 1 again — which reintroduces both failures with no error and no log
# line saying so. `railway.json` deliberately carries no `startCommand` for
# exactly this reason. The CMD below is the start command.
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "worker:hosted", "--workspace", "@mattpyle/steward"]
