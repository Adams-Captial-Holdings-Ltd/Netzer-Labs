# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Netzar OS Enterprise runs inside one customer's own AWS account. Three groups of that customer's staff use the web app:

- **Approvers and case workers.** They open the Work screens to see what needs them and to sign off actions an AI agent has prepared. They are domain staff (for example intake coordinators or billing leads), not engineers. They come in several times a day, often between other tasks, and may be on a laptop or a phone. The first customer has at most ten approvers.
- **Operators and admins.** They set up agents, integrations, members, cost limits and security controls, and they watch sessions, usage and the audit log. They are technical and use the app daily.
- **Everyone with a seat.** They chat with agents.

Netzer staff are not users of a customer's data screens: staff never see cases, records or documents in a customer account ([ADR 0017](docs/adr/0017-netzer-identity-and-work-ui.md)).

## Product Purpose

Netzar OS Enterprise lets a company build, connect, govern and operate AI agents it controls, on infrastructure it owns. Managed Solution Packs run whole workflows on it: agents do the reading, drafting and recommending; a person approves every high-impact action before it happens.

Success for the Work screens is one thing: a person can see what is waiting for them and decide it, knowing exactly what they are approving, without leaving the product.

## Positioning

The customer owns the AWS account, the data and the audit trail. An approval is bound to the exact content that was approved: if the content changes, the approval no longer counts. Every decision names a real person.

## Operating Context

- Work arrives as **cases** moving through the **stages** of an installed pack's workflow. Some stages wait for a person.
- An **approval** asks a named person, entitled to a **decision class**, to Approve, Reject or Request changes. Reject and Request changes need a comment. Approve does not.
- The same person may also use chat on Slack, Telegram or the web app. Approvals happen in the web app only.
- Cases can hold regulated content, including health information. Screens show it only to people the customer has granted access.

## Capabilities and Constraints

- Single tenant: one deployment serves one customer.
- Sign-in is by email magic link or a dashboard token. Single sign-on comes later (roadmap step 11).
- Access is by capability (`work:read`, `work:approve` and the existing dashboard capabilities). Operators and above get the Work capabilities by default. An approver who is not an operator gets a custom profile holding those two capabilities.
- The interface is Preact, wouter, Tailwind and the tokens in `web/src/index.css`. It supports light and dark themes and customer white-labelling (`web/src/lib/theme.ts`). New UI, chart or animation libraries need the owner's approval.
- Words that stay fixed in the interface: Work Inbox, Cases, Case, Stage, Approvals, Approve, Reject, Request changes, Blocked.
- Not decided yet: single sign-on details (step 11); which fields a pack marks as key fields on a case (step 8).

## Brand Commitments

Names, positioning and the brand idea are in [BRAND.md](BRAND.md): the company is Netzer Labs, the product is Netzar OS Enterprise ("Netzar OS" after first use). "Netzer" means "branch": durable systems that grow from a strong root, practical infrastructure rather than hype.

Voice: plain, exact and calm. Say what happened and what to do next. No exclamation marks, no jokes in error messages, no AI mystique.

Customers may replace the name, logo and primary colour (white-label). Nothing in the interface may depend on the default indigo to carry meaning.

## Evidence on Hand

- The running dashboard: `web/src/pages/` (Agents, Sessions, Audit Log, Usage and others) and `web/src/components/`.
- Tokens and themes: `web/src/index.css`, `web/tailwind.config.ts`, `web/src/lib/theme.ts`.
- The Work model and its decisions: `docs/features/paperclip/` and `docs/adr/0012` to `0021`.
- There are no customer logos, testimonials, usage numbers or case studies. Do not invent any. Screens and fixtures use made-up cases that are clearly not real people.

## Product Principles

1. **Show exactly what is being decided.** The content a person approves is on the screen in full, and it is the content that was hashed.
2. **The queue is the product.** "What needs me?" is answered first, on one screen, without setup.
3. **Say the true state.** An error is an error, not an empty list. Unknown is shown as unknown.
4. **A person is always accountable.** Every decision shows who made it and when.
5. **Quiet by default.** The interface gets out of the way of the case content; it never performs.

## Accessibility & Inclusion

WCAG 2.2 level AA. Every action works by keyboard, with visible focus. Touch targets are at least 24 by 24 px, and 44 px for primary actions on touch screens. Status is never carried by colour alone. Motion respects the reduced-motion setting. The interface is English only today; text must not be baked into images, so it can be translated later.
