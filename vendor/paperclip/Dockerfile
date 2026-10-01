# Immutable upstream Paperclip v2026.916.1, pinned by its index digest.
# The image has no Netzer source patch: upstream now provides the native
# updatedSince filter that replaced the former Netzer patch.
#
# The server resolves ../ui-dist (server/src/app.ts near line 951), while
# the image ships the built UI at /app/ui/dist. This symlink bridges those
# paths so the server can find the UI.
# This is a path convention, not a supported contract. Re-verify after every
# re-pin with SERVE_UI=true and GET / returning status 200 and text/html.
#
# Changing this file changes the image CONTENT, so contentImageTag() yields a
# new tag and the pipeline rebuilds once; that is expected.
# The release source and immutable digest are the upstream artifact.
# The single RUN below adds only the UI path bridge.
# Keep the FROM citation on line 20 for the contract fixtures.
# No source files are copied or modified by this image definition.
#
# Upstream image reference:
#
FROM ghcr.io/paperclipai/paperclip:2026.916.1@sha256:a02ac35ac41df911af477422ea0e781cf41d2b2c600c66f0a5ac9d8c63f52c2c

RUN ln -s /app/ui/dist /app/server/ui-dist
