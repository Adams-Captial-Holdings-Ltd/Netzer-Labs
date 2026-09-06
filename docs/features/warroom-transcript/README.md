---
feature: warroom-transcript
document_role: index
status: current
observed_at: 2026-09-05
as_of_commit: f8863b0b56fa67e5e5db3c7254690814412c4c81
implemented_by:
  - web/src/pages/WarRoom.tsx
  - src/adapters/dashboard/handler.ts
  - src/lib/documents/pdf.ts
tested_by:
  - src/adapters/dashboard/warroom-transcript.test.ts
  - src/adapters/dashboard/authz-matrix.test.ts
---

# War Room transcript: sticky scroll and PDF export

## 1. Start Here

This index describes the War Room transcript pane in the dashboard SPA and the
PDF export of a room's transcript. Source code is the ultimate truth for present
behavior; the [HANDOFF](HANDOFF.md) carries the volatile branch and deployment
state; the dated files under `handoffs/` are the session logs.

## 2. What it does today

- The War Room transcript pane stays pinned to the newest message only while the reader is at the bottom. Scrolling up releases the pin: the 2.5 s history poll and newly arriving turns leave the viewport exactly where it is. Scrolling back to the bottom, or clicking the **Jump to latest** control that appears while un-pinned, re-engages the pin. A poll that adds no turn never moves the view.
- **Export PDF** in the room header downloads the whole transcript as `war-room-<title-slug>.pdf`. The PDF carries the room title, a participants/created line, then one section per turn headed by the same speaker label the screen shows (agent id for agents, speaker otherwise) with the raw turn content. Rooms longer than one DynamoDB page (100 turns) are paginated, so nothing is truncated.
- The route is `GET /api/warroom-transcripts/:id` on the dashboard router: bearer token required (401), dashboard read kill switch honoured, `warroom:read` capability required (403 with `requiredCapability`), `warroom_disabled` kill switch honoured (503), unknown room 404, otherwise `application/pdf` with a `Content-Disposition: attachment` filename. Bytes stream straight back; nothing is written to S3.

What it is **not**: the PDF renders agent replies as their raw text (Markdown is not rendered), and the standard pdfkit Helvetica has no emoji or CJK glyphs (see §7). Telegram and Slack have no transcript pane, so there is nothing to mirror there.

## 3. Current status and current source commit

Source evidence at the `as_of_commit` above, on branch `fix/warroom-scroll-and-pdf`. Behaviour was verified in a real browser against the local stack (Floci) with polling live: five checks, each run by an independent critic agent, all green — see the [session handoff](handoffs/2026-09-05-scroll-and-pdf.md) §2 and §7. Deployment state is in the [HANDOFF](HANDOFF.md).

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Transcript pane and scroll behaviour | [WarRoom.tsx](../../../web/src/pages/WarRoom.tsx) | Present SPA behavior |
| PDF route | [handler.ts](../../../src/adapters/dashboard/handler.ts) | `GET /api/warroom-transcripts/:id` |
| PDF rendering | [pdf.ts](../../../src/lib/documents/pdf.ts) | Shared `buildPdf` |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, command, and next-action state |

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Pin state | `web/src/pages/WarRoom.tsx` (`scrollRef`, `pinnedRef`, `lastTopRef`, `onTranscriptScroll`) | Pinned when within 32 px of the bottom; a scroll event that did not move the view up while pinned is ignored (it is the autoscroll settling after a new bubble) |
| Autoscroll | `WarRoom.tsx` effect keyed on `[messages, typingAgents.length]` | `scrollTop = scrollHeight` only while pinned; instant, never smooth |
| Jump to latest | `WarRoom.tsx` `jumpToLatest`, `data-testid="warroom-jump-latest"` | Rendered only while un-pinned; scrolls to bottom and re-pins |
| Export button | `WarRoom.tsx` `exportPdf`, `data-testid="warroom-export-pdf"` | Calls `downloadFile('/warroom-transcripts/<id>', 'war-room-<slug>.pdf')`; toasts the server error on failure |
| Route | `src/adapters/dashboard/handler.ts` `GET /warroom-transcripts/:id` | Auth/role middleware, `hasCapability(c, 'warroom:read')`, `warroom_disabled`, `getMeeting`, paginated `getHistory`, `buildPdf`, attachment headers |
| PDF builder | `src/lib/documents/pdf.ts` `buildPdf` | Shared pdfkit builder, unchanged |

## 6. Current business/state rules

- The history poll replaces the `messages` array every tick even when nothing changed; nothing in the page may key a side effect on that array's identity alone.
- `getHistory(meetingId, sinceSeq, limit)` returns one DynamoDB page; any caller that needs the whole transcript loops on `sinceSeq`.
- Anyone who can read the room (`warroom:read`) can export it; the export carries no more than the screen shows.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Emoji/CJK in agent replies render as missing glyphs in the PDF | pdfkit standard fonts are WinAnsi; `ponytail:` comment at the route | Embed a TTF in `buildPdf` if a real transcript needs it |
| Markdown in agent replies appears raw in the PDF | Design choice, §2 | None approved |
| The on-screen transcript still shows at most 100 turns (pre-existing `getHistory` page cap in the poll) | `src/lib/warroom/publisher.ts` | None approved; the PDF is complete regardless |

## 8. Exact focused and full validation commands

```bash
npx vitest run src/adapters/dashboard/warroom-transcript.test.ts src/adapters/dashboard/authz-matrix.test.ts
npm test
```

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
