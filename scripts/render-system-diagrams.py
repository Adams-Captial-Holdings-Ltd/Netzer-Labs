"""
Render system-flow diagrams for ClaudeClaw Enterprise using Gemini 3 Pro Image Preview.

Generates a master left-to-right overview plus one card per microservice stage.
Each card shows the microservice NAME (top) and a single short sentence (bottom)
that explains what it does.

Run:
    GOOGLE_API_KEY=... python3 scripts/render-system-diagrams.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from google import genai
from google.genai import types

MODEL = "gemini-3-pro-image-preview"

OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "diagrams" / "system-flow"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Shared visual language so every image looks like part of the same set.
STYLE = (
    "Clean modern technical system diagram, flat vector look, generous white background, "
    "thin dark navy strokes (#1a2540), one warm orange accent (#f08a3a) reserved for the "
    "active flow arrow, sans-serif labels (looks like Inter or IBM Plex Sans), labels are "
    "crisp and readable, no photoreal textures, no gradients, no 3D, no drop shadows. "
    "Composition is strictly left-to-right reading order. Spelling must be exact."
)

# Each entry below is one image. The "prompt" carries the literal text that
# should appear inside the image so Gemini renders the microservice names and
# one-line descriptions verbatim.
JOBS: list[dict] = [
    {
        "name": "00_master_flow",
        "aspect": "16:9",
        "prompt": f"""
{STYLE}

Render a single horizontal "happy path" system diagram for ClaudeClaw
Enterprise, reading strictly LEFT to RIGHT. Seven boxes on one horizontal
rail, connected by a thick orange arrow that flows left to right through
all of them. The arrow loops back on a thin gray line at the bottom from
the rightmost box to the leftmost box, labeled "reply".

Each of the seven boxes has TWO lines of text inside it: the microservice
NAME on top in bold, and one short sentence directly under it in regular
weight. Render the text EXACTLY as written here, no paraphrasing, no extra
words, no emojis:

Box 1 NAME: "Slack / Telegram"
Box 1 SUB: "User types a message in chat."

Box 2 NAME: "ALB + WAF"
Box 2 SUB: "TLS termination and rate limiting at the edge."

Box 3 NAME: "Fargate Orchestrator"
Box 3 SUB: "Verifies signature and acks in under 3 seconds."

Box 4 NAME: "Agent Picker"
Box 4 SUB: "Chooses which agent policy handles this turn."

Box 5 NAME: "Context Builder"
Box 5 SUB: "Loads CLAUDE.md, memories, inbox, and history."

Box 6 NAME: "Bedrock + Tools"
Box 6 SUB: "Claude calls tools and streams the answer."

Box 7 NAME: "Reply Dispatcher"
Box 7 SUB: "Sends the reply back to Slack or Telegram."

Title across the top in small caps: "CLAUDECLAW ENTERPRISE  ·  MESSAGE TO REPLY"
No other text anywhere in the image.
""",
    },
    {
        "name": "01_slack_telegram",
        "aspect": "4:3",
        "prompt": f"""
{STYLE}

A single labeled card on a wide canvas. Left side shows two stacked
phone-style chat bubbles, one labeled "Slack" and one labeled "Telegram",
each containing a tiny chat icon. From both bubbles, one orange arrow exits
the right edge of the card.

Big bold title at the top of the card: "Slack / Telegram Adapters"

One sentence centered under the title, exact wording:
"Receive the user's message and forward it as a signed webhook."

No other text.
""",
    },
    {
        "name": "02_alb_waf",
        "aspect": "4:3",
        "prompt": f"""
{STYLE}

A single labeled card. In the middle, a shield icon labeled "WAFv2" sits in
front of a horizontal pill labeled "Application Load Balancer". An orange
arrow enters from the left edge and exits from the right edge, passing
through both. A small lock icon near the entry indicates TLS.

Big bold title at the top: "ALB + WAFv2"

One sentence centered under the title, exact wording:
"Terminate TLS, block bad traffic, then route to Fargate."

No other text.
""",
    },
    {
        "name": "03_fargate_orchestrator",
        "aspect": "4:3",
        "prompt": f"""
{STYLE}

A single labeled card. A large rounded rectangle in the middle labeled
"Fargate Service" contains two small server icons side by side, each
labeled "task". A tiny key icon at the top-left of the rectangle is
labeled "HMAC verify". Orange arrow enters left, exits right.

Big bold title at the top: "Fargate Orchestrator"

One sentence centered under the title, exact wording:
"One service hosts every agent, verifies the signature, and acks fast."

No other text.
""",
    },
    {
        "name": "04_agent_picker",
        "aspect": "4:3",
        "prompt": f"""
{STYLE}

A single labeled card. In the middle, a diamond decision shape labeled
"Agent Picker" has four short branches fanning out to four small folder
icons labeled, top to bottom: "slash command", "@mention", "sticky", and
"default". Orange arrow enters from the left into the diamond and exits
right from the selected folder.

Big bold title at the top: "Agent Picker"

One sentence centered under the title, exact wording:
"Picks the agent policy for this turn from command, mention, or stickiness."

No other text.
""",
    },
    {
        "name": "05_context_builder",
        "aspect": "4:3",
        "prompt": f"""
{STYLE}

A single labeled card. In the middle, a stack of four labeled rectangles
stacked vertically like trays feeding into a funnel on the right. From
top to bottom the trays read: "CLAUDE.md", "Top 10 Memories",
"5 Inbox Items", "Recent Turns". The funnel on the right pours into an
orange arrow exiting the card to the right.

Big bold title at the top: "Context Builder"

One sentence centered under the title, exact wording:
"Assembles the system prompt from agent file, memories, inbox, and history."

No other text.
""",
    },
    {
        "name": "06_bedrock_tools",
        "aspect": "4:3",
        "prompt": f"""
{STYLE}

A single labeled card. In the center, a large rectangle labeled "Bedrock
Converse" with a small Claude-like sparkle icon. A thin loop arrow on the
left side of the rectangle is labeled "tool loop". To the right of the
rectangle, five small icons in a vertical column are labeled top to
bottom: "S3 Vectors", "DynamoDB", "Web Search", "Nova Canvas", "Polly".
Orange arrow enters from the left of the rectangle and exits the right
edge of the card.

Big bold title at the top: "Bedrock + Tools"

One sentence centered under the title, exact wording:
"Claude streams the reply and calls tools until the answer is ready."

No other text.
""",
    },
    {
        "name": "07_reply_dispatcher",
        "aspect": "4:3",
        "prompt": f"""
{STYLE}

A single labeled card. In the middle, a rectangle labeled "Reply
Dispatcher" has two arrows exiting its right edge to two destinations: a
"Slack" chat bubble on top and a "Telegram" chat bubble on bottom. Orange
arrow enters the dispatcher from the left.

Big bold title at the top: "Reply Dispatcher"

One sentence centered under the title, exact wording:
"Formats the answer and sends it back to the right chat surface."

No other text.
""",
    },
]


def main() -> int:
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("ERROR: GOOGLE_API_KEY not set in environment.", file=sys.stderr)
        return 1

    client = genai.Client(api_key=api_key)

    for job in JOBS:
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
