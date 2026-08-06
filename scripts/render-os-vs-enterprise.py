"""
Render comparison diagrams between claudeclaw-os and claudeclaw-enterprise
using Gemini 3 Pro Image Preview. Also generates a mascot for each build
and a head-to-head versus card.

Outputs to docs/diagrams/os-vs-enterprise/
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from google import genai
from google.genai import types

MODEL = "gemini-3-pro-image-preview"

OUT_DIR = (
    Path(__file__).resolve().parent.parent
    / "docs"
    / "diagrams"
    / "os-vs-enterprise"
)
OUT_DIR.mkdir(parents=True, exist_ok=True)

STYLE_DIAGRAM = (
    "Clean modern technical diagram, flat vector look, generous white background, "
    "thin dark navy strokes (#1a2540), one warm orange accent (#f08a3a). "
    "Sans-serif labels (looks like Inter), crisp readable text, no photoreal textures, "
    "no gradients, no 3D, no drop shadows. Spelling must be exact."
)

STYLE_MASCOT = (
    "Friendly mascot illustration, flat color style with thick clean outlines, "
    "expressive cartoon character, bright but limited palette (navy #1a2540, white, "
    "warm orange #f08a3a accents), pure white background, no gradients, no 3D, "
    "no photoreal textures. The character is a stylized crab (a nod to the 'claw' in "
    "the project name): two big front claws, four small legs, big expressive eyes. "
    "Centered composition, full body visible, leaves margin around the character."
)

JOBS: list[dict] = [
    # 1. The big side-by-side comparison card.
    {
        "name": "01_comparison_table",
        "aspect": "16:9",
        "prompt": f"""
{STYLE_DIAGRAM}

Render a single horizontal side-by-side comparison card with TWO columns
of equal width separated by a thin vertical divider down the middle.

Above the columns, a title spans the full width:
"CLAUDECLAW  OS  vs.  ENTERPRISE"

A short subtitle directly below the title:
"Same brain, very different bodies."

LEFT COLUMN HEADER (large, bold):
"ClaudeClaw OS"

LEFT COLUMN SUBHEADER (smaller):
"Local-first. Scrappy. Lives on your Mac."

Then on the LEFT column, a vertical list of six labeled rows. Each row is
a small icon on the left with two lines of text on the right: a row name
in bold, then the value in regular weight. Render text EXACTLY:

Row 1 NAME "Runs on"          VALUE "Your Mac, via launchd"
Row 2 NAME "Model"            VALUE "Anthropic API direct"
Row 3 NAME "Surfaces"         VALUE "Telegram, Slack, WhatsApp, Dashboard"
Row 4 NAME "State"            VALUE "Local SQLite, AES-256 encrypted"
Row 5 NAME "Deploy"           VALUE "./setup wizard, one command"
Row 6 NAME "Shape"            VALUE "Monolith, 6 launchd agents"

RIGHT COLUMN HEADER (large, bold):
"ClaudeClaw Enterprise"

RIGHT COLUMN SUBHEADER (smaller):
"Cloud-native. Reduced. Lives on AWS."

Then on the RIGHT column, the same six-row layout. Render text EXACTLY:

Row 1 NAME "Runs on"          VALUE "AWS Fargate, 2 AZs"
Row 2 NAME "Model"            VALUE "Amazon Bedrock (Claude + Nova)"
Row 3 NAME "Surfaces"         VALUE "Slack, Telegram, Dashboard SPA"
Row 4 NAME "State"            VALUE "DynamoDB + S3, CloudTrail audit"
Row 5 NAME "Deploy"           VALUE "15 CDK stacks, two commands"
Row 6 NAME "Shape"            VALUE "Single Fargate service, many agents"

No other text anywhere in the image.
""",
    },
    # 2. Mascot for OS.
    {
        "name": "02_mascot_os",
        "aspect": "1:1",
        "prompt": f"""
{STYLE_MASCOT}

The mascot for ClaudeClaw OS: a scrappy crab with a friendly grin, sitting
cross-legged on top of a small open MacBook laptop that is glowing softly.
The crab wears a small dark hoodie with the hood down. In one claw it holds
a tiny wrench. In the other claw it holds a small floppy disk labeled
"SQLite". A tiny pet plant in a pot sits next to the laptop. The crab is
small, plucky, curious, slightly mischievous, very DIY-coded.

Below the character, a single line of text reads EXACTLY:
"OS  ·  scrappy, local, hands-on"

The crab's color is the warm orange (#f08a3a). Outlines and the laptop are
the dark navy (#1a2540). Pure white background. No other text in the image.
""",
    },
    # 3. Mascot for Enterprise.
    {
        "name": "03_mascot_enterprise",
        "aspect": "1:1",
        "prompt": f"""
{STYLE_MASCOT}

The mascot for ClaudeClaw Enterprise: the same stylized crab but presented
as a calm, dignified architect. The crab stands upright, posture composed,
wearing a small clean blazer with a single orange pocket square. In one
claw it holds a neat blueprint scroll labeled "CDK". In the other claw it
holds a single small cloud icon with three tiny dots representing AWS
availability zones. Behind the crab, three identical small cloud shapes
float in a tidy row, suggesting calm cloud infrastructure. The crab looks
deliberate, minimal, confident, reduction-maximalist.

Below the character, a single line of text reads EXACTLY:
"ENTERPRISE  ·  reduced, cloud-native, calm"

The crab's color is the dark navy (#1a2540). The blazer is white with the
orange (#f08a3a) pocket square. Outlines are navy. Pure white background.
No other text in the image.
""",
    },
    # 4. Versus poster.
    {
        "name": "04_versus",
        "aspect": "16:9",
        "prompt": f"""
{STYLE_MASCOT}

A clean horizontal "versus" poster.

ON THE LEFT half: the scrappy crab in a small dark hoodie sits on top of a
glowing small MacBook laptop, holding a tiny wrench in one claw and a
"SQLite" floppy disk in the other. Color of this crab body: warm orange
(#f08a3a).

ON THE RIGHT half: the architect crab stands upright in a white blazer
with an orange pocket square, holding a "CDK" scroll in one claw and a
small cloud icon in the other, with three tidy cloud shapes floating
behind it. Color of this crab body: dark navy (#1a2540).

IN THE CENTER, between them, large bold text reads EXACTLY:
"VS"

ACROSS THE TOP, smaller text reads EXACTLY:
"CLAUDECLAW  OS         CLAUDECLAW  ENTERPRISE"

ACROSS THE BOTTOM, smaller text reads EXACTLY:
"local · scrappy · hands-on         cloud · reduced · calm"

Pure white background. No other text in the image.
""",
    },
]


def main() -> int:
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("ERROR: GOOGLE_API_KEY not set in environment.", file=sys.stderr)
        return 1

    only = sys.argv[1:]
    jobs = [j for j in JOBS if not only or any(o in j["name"] for o in only)]

    client = genai.Client(api_key=api_key)

    for job in jobs:
        out_path = OUT_DIR / f"{job['name']}.png"
        print(f"  - generating {out_path.name} ({job['aspect']})")
        resp = client.models.generate_content(
            model=MODEL,
            contents=job["prompt"],
            config=types.GenerateContentConfig(
                image_config=types.ImageConfig(aspect_ratio=job["aspect"]),
            ),
        )
        wrote = False
        for cand in resp.candidates or []:
            for part in cand.content.parts or []:
                inline = getattr(part, "inline_data", None)
                if inline and getattr(inline, "data", None):
                    out_path.write_bytes(inline.data)
                    wrote = True
                    break
            if wrote:
                break
        if not wrote:
            print(f"    !! no image returned for {job['name']}", file=sys.stderr)

    print(f"\nDone. Wrote to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
