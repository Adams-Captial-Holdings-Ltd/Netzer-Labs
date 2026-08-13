"""
Render architecture diagrams for Netzar OS Enterprise using Gemini 3 Pro Image
Preview. These complement the system-flow request-path set with the parts of the
system that walkthrough does not cover: the 15-stack infrastructure, the Mission
Control dashboard, the security + data model, the pricing-tier ladder, and the
two deploy paths.

Run all:
    GOOGLE_API_KEY=... python3 scripts/render-architecture-diagrams.py

Re-roll one (cost control while iterating):
    GOOGLE_API_KEY=... python3 scripts/render-architecture-diagrams.py 01_infra_stacks
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from google import genai
from google.genai import types

MODEL = "gemini-3-pro-image-preview"

OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "diagrams" / "architecture"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Same visual language as the system-flow set so the whole README looks unified.
STYLE = (
    "Clean modern technical system diagram, flat vector look, generous white background, "
    "thin dark navy strokes (#1a2540), one warm orange accent (#f08a3a) used sparingly, "
    "sans-serif labels (looks like Inter or IBM Plex Sans), labels crisp and readable, "
    "no photoreal textures, no gradients, no 3D, no drop shadows. Spelling must be exact, "
    "render every label verbatim with no paraphrasing and no extra words."
)

JOBS: list[dict] = [
    {
        "name": "01_infra_stacks",
        "aspect": "16:9",
        "prompt": f"""
{STYLE}

Render a clean infrastructure map titled in small caps at the top:
"15 CDK STACKS  ·  ONE AWS ACCOUNT".

Below the title, five horizontal bands stacked vertically. Each band has a
bold label on the far left and a row of small navy-outlined rounded
rectangle tiles to its right. Render the labels and tile text EXACTLY:

Band 1 label "Foundation"  tiles: "Network", "Storage", "Secrets", "IAM"
Band 2 label "Data"        tiles: "Dynamo", "Guardrails", "Messaging"
Band 3 label "Runtime"     tiles: "Compute", "Observability", "Security"
Band 4 label "Resilience"  tiles: "Backup", "Chaos", "Extensions"
Band 5 label "Standalone"  tiles: "CostGuardrails", "CodeBuild"

A single thin orange arrow runs vertically up the right side from the
bottom band to the top band, labeled "deploy order". White background.
No other text anywhere in the image.
""",
    },
    {
        "name": "02_dashboard_tour",
        "aspect": "16:9",
        "prompt": f"""
{STYLE}

Render a clean illustration of a web dashboard. A simple browser window
frame with a top bar, a left sidebar navigation, and a main content panel.

The top bar shows a small title, text EXACTLY: "Netzar OS Enterprise  ·  Mission Control".

The LEFT SIDEBAR lists grouped navigation. Each group has a small bold
header with menu items under it. Render text EXACTLY:

"Core": Overview, Agents, Chat, Playground, Jarvis
"Operations": Sessions, Usage, Cost, Audit
"Security": Kill Switches, DLP, Posture, Compliance, Alerting
"Knowledge": Vectors, Missions, Memories, Hive, Scheduled
"Team": Members, Settings

The "Overview" item is highlighted with the orange accent. The MAIN PANEL
on the right shows a simple bar chart and two empty stat cards (no text
inside the chart or cards). Navy outlines on white. No other text.
""",
    },
    {
        "name": "03_security_data",
        "aspect": "16:9",
        "prompt": f"""
{STYLE}

Render a clean security and data diagram. A large rounded boundary
rectangle frames everything, labeled at its top-left corner with text
EXACTLY: "Your AWS Account".

Inside the boundary, six labeled components in two rows of three. Each is a
simple line icon with a short label under it. Render labels EXACTLY:

Top row: a shield icon labeled "Bedrock Guardrail: 20 PII filters",
a panel-of-toggles icon labeled "37 Kill Switches",
a key icon labeled "3 KMS Keys".

Bottom row: a database-cylinder icon labeled "31 DynamoDB Tables",
a storage-bucket icon labeled "6 S3 Buckets",
two linked icons (a database and a padlocked archive) labeled
"Audit dual-write: DDB + S3 Object Lock".

Title in small caps across the top, EXACTLY:
"SECURITY  ·  DATA  ·  NOTHING LEAVES YOUR ACCOUNT".
Navy outlines, orange accents used sparingly, white background. No other text.
""",
    },
    {
        "name": "04_tier_ladder",
        "aspect": "16:9",
        "prompt": f"""
{STYLE}

Render a clean ascending staircase of four steps, going up from left (low)
to right (high). Each step is a labeled column, and each column is taller
than the one to its left, forming a rising staircase. A single orange arrow
runs upward along the tops of the steps from left to right.

Each step has a bold header and a few small bullet lines under it. Render
text EXACTLY:

Step 1 header "T0 Hobby": "1 task", "cap $5/day"
Step 2 header "T1 Standard": "HA 2 tasks", "Flow Logs", "canary", "daily backup", "cap $50/day"
Step 3 header "T2 Pro": "autoscale 2-10", "X-Ray", "WAF", "chaos", "cap $200/day"
Step 4 header "T3 Enterprise": "CloudFront", "GuardDuty", "AWS Config", "cap $1000/day"

Title in small caps at the top, EXACTLY:
"PRICING TIERS  ·  GROW WITHOUT REWRITING".
Navy outlines, orange accent on the upward arrow, white background. No other text.
""",
    },
    {
        "name": "05_deploy_paths",
        "aspect": "16:9",
        "prompt": f"""
{STYLE}

Render a clean diagram of two parallel deployment lanes, one above the
other. Both lanes start from a single box on the far left labeled "git main"
and both end at a single box on the far right labeled "Live Fargate service".

Each lane is a row of small boxes connected by an orange arrow flowing left
to right. Render text EXACTLY:

TOP lane, labeled on its left "npm run deploy  (full)", boxes left to right:
"Docker build", "ECR push", "cdk deploy (15 stacks)", "roll ECS".

BOTTOM lane, labeled on its left "npm run deploy:cloud  (image-only)", boxes
left to right: "CodeBuild", "image build", "ECR push", "swap image".

A small note under the bottom lane reads EXACTLY: "no cdk, cannot drift infra".

Title in small caps at the top, EXACTLY: "TWO DEPLOY PATHS".
Navy outlines, orange arrows, white background. No other text.
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
    if not jobs:
        print(f"No jobs match {only}. Available: {[j['name'] for j in JOBS]}", file=sys.stderr)
        return 1

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
