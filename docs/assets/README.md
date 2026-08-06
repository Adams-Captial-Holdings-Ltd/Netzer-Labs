# docs/assets — the asset contract

> Plain English: everything in this folder is presentation art — screenshots,
> hero images, diagram posters. This page is the contract every committed
> asset must satisfy: where it came from, what license covers it, and the
> budgets CI enforces. Nothing in the public repo depends on the private
> tooling that generated any image; anyone can replace the art.

This is IaC readiness item 32 (Tier 2 visuals) and item 37 (screenshots).
CODEOWNERS covers `docs/assets/**`; at launch a repository ruleset makes that
code-owner review BINDING (bare CODEOWNERS is advisory) — see
[docs/launch-checklist.md](../launch-checklist.md).

## License

Committed art in this folder is covered by the repository's [members-only license](../../LICENSE)
unless a sidecar file next to the asset says otherwise. Do not commit art you
do not have the right to license that way — no stock photos with seat
licenses, no copied marketing imagery.

## Provenance (required for every generated asset)

Generative pipelines are nondeterministic, so generated images are
**checked-in artifacts, not reproducible build outputs**. Every generated
asset MUST be committed alongside a provenance sidecar
`<asset-name>.provenance.json`:

```json
{
  "prompt": "the full prompt text used",
  "generator": "tool/model name and version",
  "date": "2026-06-11",
  "author": "@github-handle",
  "postProcessing": "optional: crops, annotations, compression applied"
}
```

Screenshots need the same sidecar with `generator` set to the capture
mechanism and the app version (e.g.
`"generator": "macOS screencapture from the prod dashboard, v0.x, owner-reviewed"`).
For **v0**, screenshots may be captured from the maintainer's own
single-tenant install, provided a `docs/assets/**` code owner reviews every
pixel before commit and the "no account-identifying data or secrets" rule
below is met. A synthetic demo deployment is still preferred once one exists,
and stays required for any third-party or customer-facing capture.

## Hard rules

- **No third-party trademarks** — no AWS/Slack/Telegram logos baked into art,
  no marks implying endorsement. Product names in plain text labels are fine.
- **Alt text is required** at every use site: any `![...]()` or `<img>`
  referencing an asset must carry meaningful alt text describing what the
  image shows (not "screenshot").
- **GIFs need a static PNG fallback** committed next to them
  (`demo.gif` + `demo.png`), and the doc must link the PNG for readers on
  low-bandwidth or reduced-motion setups.
- **No videos in-repo** — link out instead. CI fails video extensions under
  `docs/`.
- **No account-identifying data or secrets in pixels.** Text-based secret
  scanning cannot see images, so CI runs OCR + metadata scans over changed
  images at launch (item 37) and a human code-owner review is the backstop.
  Never commit secrets, tokens, full AWS account IDs, ARNs, or any customer
  or third-party data in a shot. For v0, the maintainer's own agent names,
  innocuous chat snippets, and spend figures from their single-tenant install
  are acceptable once a code owner has reviewed the image.

## Size budgets (enforced by docs CI)

`scripts/ci/docs-assets.mjs`, run per PR by `.github/workflows/docs-ci.yml`:

- any single file under `docs/` — **2 MB max**;
- `docs/assets/` in total — **15 MB max**.

Budgets exist because every asset lives in clone history forever and GitHub
renders heavy pages badly. Compress screenshots (pngquant/oxipng), keep GIFs
short, and prefer SVG for diagrams.

## Replacing assets

Anyone can replace the art; **nothing in the public contract depends on the
private generation tooling**. To replace an asset:

1. Produce the new image with any tool you like.
2. Write its `*.provenance.json` sidecar (prompt/tool/date/author).
3. Keep the same filename if docs reference it, or update every reference
   (the docs-links CI job catches dangling references).
4. Stay inside the size budgets.
5. Open a PR — code-owner review on `docs/assets/**` applies.
