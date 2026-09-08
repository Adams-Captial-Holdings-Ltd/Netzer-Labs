# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────
# Stage 1 · deps
# Install dependencies in a layer separate from source so changes to
# code don't bust the dependency cache.
# ─────────────────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:20-alpine AS deps
WORKDIR /app

# Copy only manifest files first
COPY package.json package-lock.json* ./

# `npm install` is used here instead of `npm ci` because aws-cdk-lib ships
# with an internal version conflict (jsonschema 1.4.1 vs 1.5.0) that breaks
# `npm ci`'s strict lockfile validation. `npm install --omit=dev` is
# functionally equivalent for the runtime image and tolerates the conflict.
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --ignore-scripts --no-audit --no-fund

# ─────────────────────────────────────────────────────────────────────
# Stage 2a · web
# Build the Preact + Vite + Tailwind dashboard SPA.
# ─────────────────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:20-alpine AS web
WORKDIR /app/web

COPY web/package.json web/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --ignore-scripts --no-audit --no-fund

COPY web/ ./
RUN npx vite build

# ─────────────────────────────────────────────────────────────────────
# Stage 2b · build
# Inherit the deps stage tree, add just the compiler, compile src/ to dist/.
# ─────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

# This stage used to `npm install` the full dev tree, and that install is where
# the image build dies: run 34045747255 attempt 1 failed here with
# `npm error code ETIMEDOUT` at 268.6 s (the install runs 182-274 s; the ledger
# records two more deaths, and every attempt 2 passed). The ENV below was
# already set for that run and did NOT prevent it: the kernel socket timeout
# fires before npm's own fetch-timeout, and npm already retries ETIMEDOUT
# (make-fetch-happen RETRY_ERRORS, fetch-retries 2). The knob is not the fix; it
# stays only because a longer, still-finite bound costs nothing.
ENV npm_config_fetch_timeout=600000

# The fix is to stop downloading what the compile never reads. `FROM deps`
# inherits /app with the 265-package runtime tree and the manifests, so neither
# is re-fetched here. tsconfig.build.json compiles src/ only (it excludes infra,
# scripts, web and tests), and nothing under src imports aws-cdk-lib (117 MB,
# 7,847 files), constructs, vitest, tsx or pino-pretty. Beyond deps the compile
# needs exactly these three - @types/node is already a non-dev dependency.
# Versions come from package-lock.json and are asserted against it by
# scripts/lib/lifecycle/orchestrator-dockerfile.test.ts, so a lockfile bump
# fails that test instead of drifting here.
#
# THE THREE INSTALL IN AN EMPTY DIRECTORY, NOT IN /app. That isolation is the
# whole fix, and it is why `--omit=dev` is gone from this line. Installed against
# /app's manifest the three reified NOTHING, because all three are
# devDependencies: npm infers a dev edge for any name already in
# devDependencies, `--no-save` only suppresses the manifest write, and a node
# marked dev under `--omit=dev` is treated as undefined for diffing. Measured in
# the image rather than argued: the install reported `up to date in 3s` having
# added none of the three packages named on its own command line, and the `npx
# tsc` below then fetched the unrelated registry stub `tsc@2.0.4` ("This is not
# the tsc command you are looking for"), killing the stage.
# /opt/compiler carries no package.json, so npm has no dev edge to infer and the
# three install as ordinary dependencies. They are then placed beside the runtime
# tree so `tsc` and `@types` resolution find them where they expect to.
# The dev tree is still never downloaded: only these three names are named here.
# Proof: scripts/lib/lifecycle/orchestrator-dockerfile.build.integration.test.ts
RUN --mount=type=cache,target=/root/.npm \
    mkdir -p /opt/compiler && cd /opt/compiler && \
    npm install --no-save --ignore-scripts --no-audit --no-fund \
      typescript@5.9.3 @types/pdfkit@0.17.6 @types/ws@8.18.1 && \
    mkdir -p /app/node_modules/@types && \
    cp -r /opt/compiler/node_modules/typescript /app/node_modules/ && \
    cp -r /opt/compiler/node_modules/@types/pdfkit /app/node_modules/@types/ && \
    cp -r /opt/compiler/node_modules/@types/ws /app/node_modules/@types/

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Invoked through node against the package's own bin, NOT through `npx`. `npx`
# resolves a missing binary by FETCHING one from the registry: when the compiler
# was absent it silently installed the unrelated package `tsc@2.0.4`, whose bin
# prints "This is not the tsc command you are looking for" and exits 1. A build
# stage must never reach the network to find its compiler, and this form cannot.
RUN node node_modules/typescript/bin/tsc -p tsconfig.build.json
# TypeScript doesn't emit non-TS files. Copy the static SPA assets next
# to the compiled dashboard/spa.js so the runtime fs.readFile finds them.
RUN cp -r src/adapters/dashboard/public dist/adapters/dashboard/public
# Copy the Vite-built Preact dashboard from the web stage.
COPY --from=web /app/dist/web dist/web

# ─────────────────────────────────────────────────────────────────────
# Stage 3 · runtime
# Minimal image: alpine base, non-root user, just the production deps
# and the compiled JS. Health check probes /health.
# ─────────────────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:20-alpine AS runtime

# ffmpeg: transcode Polly TTS (MP3) to OGG/Opus for Telegram voice notes, which
# only play if they're Opus. Installed as root before we drop to the node user.
RUN apk add --no-cache ffmpeg

# Run as a non-root user. The node base image ships a `node` UID 1000.
USER node
WORKDIR /home/node/app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

EXPOSE 3000

# Container-native healthcheck. ECS health checks override this at the
# task definition level, but it's useful for `docker run` smoke tests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
