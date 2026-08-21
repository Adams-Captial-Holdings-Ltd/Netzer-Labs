# Netzar-patched Paperclip: the pinned immutable release plus one committed
# patch (updatedSince watermark filtering on the issues list, required by the
# missions reconciler's durable feed; absent upstream as of v2026.722.0 — see
# updated-since.patch). tsc re-emits over the shipped dist, so the runtime
# entrypoint is unchanged. Re-pin by bumping the digest and re-checking whether
# the patch is still needed upstream.
#
# It also bridges ONE path so the board actually serves (Phase 4.5). Verified by
# running the pinned image on 2026-08-21: it ships the BUILT UI at /app/ui/dist
# (13 MB, with index.html), but the server resolves "../ui-dist" — i.e.
# /app/server/ui-dist — which does not exist in the image, so SERVE_UI=true
# alone returns nothing. With the symlink below and SERVE_UI=true, `GET /`
# answers 200 text/html with the genuine Paperclip document and
# /assets/index-*.js answers 200 with the 6,484,747-byte bundle. Re-verify this
# on every re-pin: it is a path convention, not a supported contract, exactly
# like the runtime branding hooks.
#
# Changing this file changes the image CONTENT, so contentImageTag() yields a
# new tag and the pipeline rebuilds once. That is expected, not a regression.
FROM ghcr.io/paperclipai/paperclip:2026.722.0@sha256:6b9daa3c7b0659cce1ddb1f35454162342bc48bb5682123043fcd4d44aea237c

COPY updated-since.patch /tmp/updated-since.patch
RUN apt-get update \
 && apt-get install -y --no-install-recommends patch \
 && cd /app \
 && patch -p1 < /tmp/updated-since.patch \
 && cd server \
 && node_modules/.bin/tsc \
 && ln -s /app/ui/dist /app/server/ui-dist \
 && apt-get purge -y patch \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /tmp/updated-since.patch
