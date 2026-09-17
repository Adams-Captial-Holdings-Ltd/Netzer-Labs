# Third-party software notices

> **DRAFT — LICENSE AND ATTORNEY REVIEW REQUIRED BEFORE DISTRIBUTION.** This is
> the review inventory for the locked source tree on 2026-08-28, not yet the
> complete attribution bundle for a customer image. A release may ship only
> after a Linux image scan supplies the exact versions, copyright notices, and
> complete license texts for every component actually distributed.

Netzer OS remains proprietary. The licenses below apply only to their respective
third-party materials and do not relicense Netzer-owned code.

## Express license selections

- JSZip and the CDK-only `case` package are offered under MIT or GPL terms.
  Netzer selects the **MIT** option for distribution.
- DOMPurify is offered under MPL-2.0 or Apache-2.0. Netzer selects the
  **Apache-2.0** option for distribution.

These selections must be confirmed by counsel and preserved in release
notices so automated scanners do not infer the alternative copyleft branch.

## Direct runtime dependencies

The locked runtime trees are recorded in
[`sbom/netzer-os-npm.cdx.json`](sbom/netzer-os-npm.cdx.json) and
[`sbom/netzer-web-npm.cdx.json`](sbom/netzer-web-npm.cdx.json).

| Component | Locked version(s) | License | Distribution note |
|---|---:|---|---|
| AWS SDK for JavaScript packages, Smithy packages, `@aws-crypto/sha256-js`, `aws-xray-sdk-core`, `pdf-parse` | See SBOM | Apache-2.0 | Retain Apache license and supplied NOTICE material. |
| `@hono/node-server`, `hono`, `docx`, `exceljs`, `pdfkit`, `pino`, `ws`, `zod` | See SBOM | MIT | Retain copyright and MIT permission text. |
| `mammoth` | 1.12.0 | BSD-2-Clause | Retain notice, conditions, and disclaimer. |
| `jszip` | 3.10.1 | MIT selected from `(MIT OR GPL-3.0-or-later)` | Record the MIT selection and retain its license. |
| Preact, `@preact/signals`, Marked | See web SBOM | MIT | Browser bundle needs accompanying attribution. |
| DOMPurify | 3.4.14 | Apache-2.0 selected from `(MPL-2.0 OR Apache-2.0)` | Retain Apache license/notice obligations. |
| `lucide-preact` | 0.468.0 | ISC | Retain notice and permission text. |
| `wouter-preact` | 3.10.0 | Unlicense (metadata; no local license file found) | Confirm provenance and include authoritative text before release. |

## Material transitive and bundled components

| Component | Where used | Detected terms | Current action |
|---|---|---|---|
| `buffers@0.1.1` | `exceljs → unzipper → binary` in the runtime tree | No license field or local license file detected | **Release blocker:** establish provenance/license or replace the dependency path. |
| PDFKit AFM font data and bundled ICC profile | PDF generation | Files contain Adobe “All Rights Reserved” and International Color Consortium copyright notices; no adjacent redistribution grant was found locally | **Release blocker:** obtain authoritative grant/provenance or replace the assets/library. |
| PDF.js standard fonts | `pdf-parse → pdfjs-dist` | OFL-1.1, plus BSD-style font/cmap licenses and CC0 ICC data | Preserve all nested texts; counsel reviews font-name and standalone-sale conditions. |
| `pako` | Runtime transitive | MIT **and** Zlib materials | Include both texts. |
| `sax` / `minimatch` | Runtime/dev transitive | BlueOak-1.0.0 | Include the supplied text; confirm customer acceptance. |
| `png-js`, `chainsaw`, `traverse`, `duck` | Runtime transitive | MIT/MIT-X11/BSD variants | Normalize from authoritative local texts and include them. |
| `caniuse-lite` data | Browser build tooling | CC-BY-4.0 | Confirm whether any licensed data is incorporated into distributed output. |
| Native Canvas packages | Optional, platform-specific PDF.js dependency | MIT at package level | Verify the package actually selected by the Linux/ARM64 release image. |

## Container and non-npm components

- The main image derives from floating `node:20-alpine` and installs Alpine
  `ffmpeg`. The official Alpine package metadata identifies FFmpeg as
  `GPL-2.0-or-later AND LGPL-2.1-or-later`; the exact image build and license
  obligations have not been captured. Pin, scan, and either comply or replace
  this component before distribution.
- The Paperclip image is digest-pinned and modified by a local patch. The
  upstream source license is MIT, but the repository does not yet ship its MIT
  text, a patch notice, or an SBOM for the complete Debian-based image. These
  are release blockers.
- Optional Cloudflare and AWS X-Ray sidecars, Alpine packages, Node.js, native
  libraries, and their operating-system transitives are outside the npm SBOMs.
  The release image scan and notices bundle must cover them.

## Build-only tools

AWS CDK, `aws-cdk-lib`, constructs, and TypeScript are Apache-2.0; Vite,
Vitest, PostCSS, Tailwind, and related build tools are predominantly MIT. If a
customer distribution includes source/build tooling, also include the supplied
CDK `NOTICE`/`THIRD_PARTY_LICENSES`, constructs `NOTICE`, and TypeScript
`ThirdPartyNoticeText.txt` files.

## Release completion rule

This draft does not satisfy binary-distribution notice obligations by itself.
For each immutable release, generate notices from the built Linux images and
browser bundle, review every unknown/custom/copyleft expression, copy the final
notice bundle into the image and customer delivery package, and archive the
notice bundle beside the release SBOM and image digest.
