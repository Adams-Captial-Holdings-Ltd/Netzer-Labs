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
# Install full deps (including TypeScript), compile src/ to dist/.
# ─────────────────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./

# The build-stage npm install ran 259 s in green run 33783021194; two attempts
# in the 2026-09-03 session died here with `read ETIMEDOUT` at ~266-274 s. npm's
# default fetch-timeout is 300000 ms (proved with `npm config get fetch-timeout`
# on npm 11.17.0 locally; the image runs npm 10.x, same option name).
# 600000 doubles that bound - slack for a slow arm64/QEMU read, still finite.
ENV npm_config_fetch_timeout=600000
RUN --mount=type=cache,target=/root/.npm \
    npm install --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npx tsc -p tsconfig.build.json
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
