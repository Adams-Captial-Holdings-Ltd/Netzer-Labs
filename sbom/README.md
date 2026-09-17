# Software bills of materials

> These CycloneDX 1.6 JSON files record the locked production npm graphs on
> 2026-08-28. They are useful source evidence, but they are not release SBOMs:
> they were generated on Windows and therefore do not include the built Linux
> image, Alpine/FFmpeg, native ARM64 packages, Paperclip, or sidecar images.

| File | Scope |
|---|---|
| [`netzer-os-npm.cdx.json`](netzer-os-npm.cdx.json) | Root `package-lock.json`, production dependencies only |
| [`netzer-web-npm.cdx.json`](netzer-web-npm.cdx.json) | Dashboard `web/package-lock.json`, production dependencies only |

Generated with `@cyclonedx/cyclonedx-npm` after the 2026-08-28 patch updates.
The JSON files parsed successfully after generation.

A commercial release still requires a CycloneDX or SPDX SBOM generated from
each final Linux image digest, including operating-system packages, native
modules, the browser bundle, Paperclip, and all sidecars. That release-specific
SBOM must be archived with the tag, commit, artifact manifest, signature,
provenance/attestation, and final third-party notices.
