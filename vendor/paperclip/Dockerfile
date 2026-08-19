# Netzar-patched Paperclip: the pinned immutable release plus one committed
# patch (updatedSince watermark filtering on the issues list, required by the
# missions reconciler's durable feed; absent upstream as of v2026.722.0 — see
# updated-since.patch). tsc re-emits over the shipped dist, so the runtime
# entrypoint is unchanged. Re-pin by bumping the digest and re-checking whether
# the patch is still needed upstream.
FROM ghcr.io/paperclipai/paperclip:2026.722.0@sha256:6b9daa3c7b0659cce1ddb1f35454162342bc48bb5682123043fcd4d44aea237c

COPY updated-since.patch /tmp/updated-since.patch
RUN apt-get update \
 && apt-get install -y --no-install-recommends patch \
 && cd /app \
 && patch -p1 < /tmp/updated-since.patch \
 && cd server \
 && node_modules/.bin/tsc \
 && apt-get purge -y patch \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /tmp/updated-since.patch
