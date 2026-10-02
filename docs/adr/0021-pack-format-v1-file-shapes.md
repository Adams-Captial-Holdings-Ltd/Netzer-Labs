# ADR 0021 — Pack format v1: the exact file shapes and what `pack validate` enforces

**Status:** Accepted (owner sign-off 2026-10-02, Work Platform step 3; state-file decision 37). Extends [ADR 0018](0018-managed-solution-packs-v1.md); it does not supersede it.

## Context

[ADR 0018](0018-managed-solution-packs-v1.md) fixed the pack layout and the `pack.json` field list, and left the exact shape of each file open. The installer (step 8), the Workflow Studio (step 9) and the customer settings screen (step 10) all read these files, so the shapes are a public contract. Roadmap v2 added two requirements: a `customerEditable` flag per config field that can never reach an approval gate or a decision class, and a reserved Studio layout block the installer ignores. The repository had no YAML reader (today's `agent.yaml` is flat text read by a line scanner in `src/lib/config/agent-loader.ts`), and Paperclip's create-routine body has no field that marks an ingest routine.

## Decision

The shapes and rules are in [pack format v1](../features/paperclip/pack-format.md); that page is the contract. The choices that were open:

1. **`pack.json` carries `packFormat: 1`**, the one field added to ADR 0018's list, so a later reader can refuse a format it does not know.
2. **Agent files stay YAML** (`agents/*.yaml`), read with the `yaml` package and checked by one zod schema that the built-in templates also satisfy. Anchors, aliases, custom tags and multi-document files are rejected.
3. **Decision classes are declared in `pack.json` and bound to stages in `policies.json`.** Every class a gate uses must be declared, and every declared class must be used. A high-impact class defaults to `human_required`.
4. **A gate field is derived, with an explicit mark as a second net.** A config field is a gate field when a pipeline stage listed under `approvalGates` names it, or when it carries `controlsApproval: true`. A gate field, a `secretRef` or a `connectorRef` marked `customerEditable` fails validation.
5. **`pack.json` marks each routine `ingest` or `timer`.** An ingest routine must be `always_enqueue`, and every pipeline needs one.
6. **The Studio layout is its own file** (`studio/layout.json`), and the Work UI key fields are their own file (`ui.json`), so `pack.json` stays the identity file.
7. **`config/schema.json` is JSON-Schema shaped** (`properties` plus a `required` list) with the six pack types.
8. **`pack validate` is offline and declarative**: schema, cross-references, placeholders, the repository's secret scanner, `always_enqueue`, customer identifiers, gate fields and decision classes. It never calls AWS or Paperclip.

**Decided by.** Jev: format version field 0.90, JSON-Schema shape 0.93. Jev was unsure on items 2 to 6; an Opus advisor picked them. Owner: yes to the shapes and to the `yaml` dependency (2026-10-02).

## Consequences

Good: steps 5 to 12 build on one fixed shape, and a pack cannot ship a secret, a customer identifier or a customer-editable approval gate without failing a check.

Bad:

- One new runtime dependency (`yaml`).
- Decision classes are named in two files; the validator keeps them in step.
- The derived gate rule only sees a field named inside a gated stage. A field that controls a gate some other way needs the `controlsApproval` mark, which an author can forget; step 10 must not treat `customerEditable` as proof on its own.
- The identifier check is pattern-based (account ids, ARNs, emails, URLs, a denylist). It cannot recognise a customer's name unless the denylist holds it.

- **Reversibility:** one-way. Packs written against these shapes, the Studio export and the installer all depend on them. A change is a new `packFormat` number and a new ADR.
- **Revisit trigger:** the Studio (step 9) cannot round-trip a pack losslessly; the installer (step 8) needs a field these shapes lack; upstream pipeline portability replaces the interim bodies (step 17).

## Alternatives considered

- **Agent files as JSON, or a hand-written YAML subset reader.** Rejected: the first re-decides ADR 0018's `agents/*.yaml`; the second is a parser to own forever.
- **Decision classes in one file only.** Rejected: ADR 0018's field list names them in `pack.json`, and the bindings belong with the other policies.
- **An author-only gate mark.** Rejected: a mark an author must remember is not a safety rule on its own.
- **Inferring ingest routines from a webhook trigger, or forcing `always_enqueue` on every routine.** Rejected: triggers are created by a separate call and are not in the routine body; queueing every timer piles up overlapping runs.
- **The Studio layout and key fields inside `pack.json`.** Rejected: the layout changes on every drag and would churn the identity file.
- **Validating customer config values, full Paperclip body schemas and checksums here.** Deferred to step 8 (trusted install).
