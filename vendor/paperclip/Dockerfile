# Pinned, immutable upstream Paperclip release v2026.916.1.
# It has no Netzer source patch and this file adds no instruction; upstream's
# native updatedSince filter replaced the old Netzer source patch.
#
# The UI needs no bridge. At this tag, server/src/app.ts lines 949 to 955
# tries ../ui-dist, then ../../ui/dist; the image ships its built UI at
# /app/ui/dist. Verified live at this pin on 2026-10-01 with SERVE_UI=true:
# GET / returned 200 text/html from the unmodified image.
# This is a path convention, not a supported contract. Re-verify on every
# re-pin with SERVE_UI=true and GET / (status 200, text/html).
#
# Changing this file changes the image CONTENT, so contentImageTag() yields a
# new tag and the pipeline rebuilds once; that is expected.
# Keep the FROM citation on line 20 for the contract fixtures.
#
# The digest below is the multi-architecture image INDEX digest, so each
# platform resolves to this one release.
#
# Upstream image reference:
FROM ghcr.io/paperclipai/paperclip:2026.916.1@sha256:a02ac35ac41df911af477422ea0e781cf41d2b2c600c66f0a5ac9d8c63f52c2c
