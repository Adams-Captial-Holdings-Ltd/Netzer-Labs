"""
Assemble the eight generated system-flow PNGs into a single Excalidraw canvas
with arrows between the seven step cards.

Output: docs/diagrams/system-flow.excalidraw
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "docs" / "diagrams" / "system-flow"
OUT_PATH = ROOT / "docs" / "diagrams" / "system-flow.excalidraw"

NOW_MS = int(time.time() * 1000)


def new_id() -> str:
    return secrets.token_urlsafe(15)


def nonce() -> int:
    return secrets.randbits(31)


def encode_image(path: Path) -> tuple[str, str]:
    """Return (fileId, dataURL) for an image, using sha1 of bytes as the id."""
    data = path.read_bytes()
    file_id = hashlib.sha1(data).hexdigest()
    b64 = base64.b64encode(data).decode("ascii")
    data_url = f"data:image/png;base64,{b64}"
    return file_id, data_url


def image_element(
    *, file_id: str, x: float, y: float, width: float, height: float
) -> dict:
    return {
        "type": "image",
        "version": 1,
        "versionNonce": nonce(),
        "isDeleted": False,
        "id": new_id(),
        "fillStyle": "solid",
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "roughness": 0,
        "opacity": 100,
        "angle": 0,
        "x": x,
        "y": y,
        "strokeColor": "transparent",
        "backgroundColor": "transparent",
        "width": width,
        "height": height,
        "seed": nonce(),
        "groupIds": [],
        "frameId": None,
        "roundness": None,
        "boundElements": [],
        "updated": NOW_MS,
        "link": None,
        "locked": False,
        "status": "saved",
        "fileId": file_id,
        "scale": [1, 1],
    }


def arrow_element(
    *,
    x: float,
    y: float,
    dx: float,
    dy: float,
    start_id: str,
    end_id: str,
) -> dict:
    return {
        "type": "arrow",
        "version": 1,
        "versionNonce": nonce(),
        "isDeleted": False,
        "id": new_id(),
        "fillStyle": "solid",
        "strokeWidth": 3,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "angle": 0,
        "x": x,
        "y": y,
        "strokeColor": "#f08a3a",
        "backgroundColor": "transparent",
        "width": abs(dx),
        "height": abs(dy) if dy else 1,
        "seed": nonce(),
        "groupIds": [],
        "frameId": None,
        "roundness": {"type": 2},
        "boundElements": [],
        "updated": NOW_MS,
        "link": None,
        "locked": False,
        "startBinding": {"elementId": start_id, "focus": 0, "gap": 8},
        "endBinding": {"elementId": end_id, "focus": 0, "gap": 8},
        "lastCommittedPoint": None,
        "startArrowhead": None,
        "endArrowhead": "arrow",
        "points": [[0, 0], [dx, dy]],
        "elbowed": False,
    }


def text_element(
    *, x: float, y: float, text: str, font_size: int, width: float, height: float
) -> dict:
    return {
        "type": "text",
        "version": 1,
        "versionNonce": nonce(),
        "isDeleted": False,
        "id": new_id(),
        "fillStyle": "solid",
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "angle": 0,
        "x": x,
        "y": y,
        "strokeColor": "#1a2540",
        "backgroundColor": "transparent",
        "width": width,
        "height": height,
        "seed": nonce(),
        "groupIds": [],
        "frameId": None,
        "roundness": None,
        "boundElements": [],
        "updated": NOW_MS,
        "link": None,
        "locked": False,
        "fontSize": font_size,
        "fontFamily": 3,
        "text": text,
        "textAlign": "center",
        "verticalAlign": "top",
        "containerId": None,
        "originalText": text,
        "lineHeight": 1.25,
        "baseline": int(font_size * 0.85),
    }


def main() -> None:
    # Master image (16:9, native 1376x768) at the top.
    master_w = 2400
    master_h = master_w * 768 / 1376  # ~1339
    master_x = 0
    master_y = 0

    # Card row below the master.
    card_native_w, card_native_h = 1200, 896
    card_w = 460
    card_h = card_w * card_native_h / card_native_w  # ~343
    card_gap = 90
    row_count = 7
    row_total_w = row_count * card_w + (row_count - 1) * card_gap
    row_x_start = master_x + (master_w - row_total_w) / 2
    row_y = master_y + master_h + 240  # gap below master

    files: dict[str, dict] = {}
    elements: list[dict] = []

    # Title across the very top.
    title_w = 1600
    elements.append(
        text_element(
            x=master_x + (master_w - title_w) / 2,
            y=-220,
            text="Netzar OS Enterprise — Message to Reply",
            font_size=64,
            width=title_w,
            height=80,
        )
    )
    elements.append(
        text_element(
            x=master_x + (master_w - title_w) / 2,
            y=-130,
            text="Left-to-right: what happens between you sending a message on Slack/Telegram and the bot answering.",
            font_size=28,
            width=title_w,
            height=40,
        )
    )

    # Master overview image.
    master_path = IMG_DIR / "00_master_flow.png"
    file_id, data_url = encode_image(master_path)
    files[file_id] = {
        "mimeType": "image/png",
        "id": file_id,
        "dataURL": data_url,
        "created": NOW_MS,
    }
    master_elem = image_element(
        file_id=file_id, x=master_x, y=master_y, width=master_w, height=master_h
    )
    elements.append(master_elem)

    # Caption between master and row.
    caption_w = 1600
    elements.append(
        text_element(
            x=master_x + (master_w - caption_w) / 2,
            y=master_y + master_h + 60,
            text="Zoomed in on each microservice below.",
            font_size=28,
            width=caption_w,
            height=40,
        )
    )

    # Seven step cards in a row, with file labels in same order as master.
    card_files = [
        "01_slack_telegram.png",
        "02_alb_waf.png",
        "03_fargate_orchestrator.png",
        "04_agent_picker.png",
        "05_context_builder.png",
        "06_bedrock_tools.png",
        "07_reply_dispatcher.png",
    ]

    card_elements: list[dict] = []
    for i, fname in enumerate(card_files):
        path = IMG_DIR / fname
        file_id, data_url = encode_image(path)
        if file_id not in files:
            files[file_id] = {
                "mimeType": "image/png",
                "id": file_id,
                "dataURL": data_url,
                "created": NOW_MS,
            }
        x = row_x_start + i * (card_w + card_gap)
        y = row_y
        elem = image_element(
            file_id=file_id, x=x, y=y, width=card_w, height=card_h
        )
        elements.append(elem)
        card_elements.append(elem)

    # Arrows between consecutive cards (orange).
    for i in range(len(card_elements) - 1):
        a = card_elements[i]
        b = card_elements[i + 1]
        start_x = a["x"] + a["width"]
        start_y = a["y"] + a["height"] / 2
        end_x = b["x"]
        end_y = b["y"] + b["height"] / 2
        arrow = arrow_element(
            x=start_x,
            y=start_y,
            dx=end_x - start_x,
            dy=end_y - start_y,
            start_id=a["id"],
            end_id=b["id"],
        )
        # Register arrow on the bound elements' boundElements lists.
        a["boundElements"].append({"id": arrow["id"], "type": "arrow"})
        b["boundElements"].append({"id": arrow["id"], "type": "arrow"})
        elements.append(arrow)

    # Loopback arrow (reply) from last card back under to first card.
    first = card_elements[0]
    last = card_elements[-1]
    loop_y = last["y"] + last["height"] + 140
    # We draw a long horizontal arrow under the row, right-to-left, free
    # (not bound), labeled by a separate text element. To keep it simple
    # we use a plain arrow element without bindings.
    loop_arrow = {
        "type": "arrow",
        "version": 1,
        "versionNonce": nonce(),
        "isDeleted": False,
        "id": new_id(),
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "dashed",
        "roughness": 1,
        "opacity": 100,
        "angle": 0,
        "x": last["x"] + last["width"] / 2,
        "y": loop_y,
        "strokeColor": "#5a6675",
        "backgroundColor": "transparent",
        "width": (last["x"] + last["width"] / 2) - (first["x"] + first["width"] / 2),
        "height": 1,
        "seed": nonce(),
        "groupIds": [],
        "frameId": None,
        "roundness": {"type": 2},
        "boundElements": [],
        "updated": NOW_MS,
        "link": None,
        "locked": False,
        "startBinding": None,
        "endBinding": None,
        "lastCommittedPoint": None,
        "startArrowhead": None,
        "endArrowhead": "arrow",
        "points": [
            [0, 0],
            [0, 60],
            [
                -((last["x"] + last["width"] / 2) - (first["x"] + first["width"] / 2)),
                60,
            ],
            [
                -((last["x"] + last["width"] / 2) - (first["x"] + first["width"] / 2)),
                0,
            ],
        ],
        "elbowed": False,
    }
    elements.append(loop_arrow)

    elements.append(
        text_element(
            x=row_x_start + row_total_w / 2 - 200,
            y=loop_y + 70,
            text="reply",
            font_size=28,
            width=400,
            height=40,
        )
    )

    doc = {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": elements,
        "appState": {
            "gridSize": None,
            "viewBackgroundColor": "#ffffff",
        },
        "files": files,
    }

    OUT_PATH.write_text(json.dumps(doc, indent=2))
    size_mb = OUT_PATH.stat().st_size / (1024 * 1024)
    print(f"Wrote {OUT_PATH}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
