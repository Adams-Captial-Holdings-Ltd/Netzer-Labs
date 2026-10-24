---
feature: netzar-studio
document_role: evidence
status: current
observed_at: 2026-10-23
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

> **Imported owner PRD (v1.1), unchanged below this note.** Imported 2026-10-23 for the Netzar Studio rebuild so stories can cite its
> IDs (OBJ-, FR-, NFR-, AC-). Where this PRD and the [blueprint v2](../blueprint.md) disagree, the blueprint's owner decisions win
> (for example: MVP scope, Paperclip retirement date, knowledge storage is JSONL in S3 rather than "S3 Vectors"). Scope status of every
> ID: [stories README](../stories/README.md#requirements-traceability).

# NETZAR ENTERPRISEOS
## Master Product Requirements Document
### An AI-Native Enterprise Agent, Team & Workflow Platform

**Version:** 1.1  
**Date:** October 20, 2026  
**Status:** Consolidated Product Requirements Document  
**Product:** Netzar EnterpriseOS  
**Organization:** Netzer Labs  
**Repository:** https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs  
**Product scope:** Netzar itself — not development-team infrastructure

---

# Executive Summary

## Product vision

Netzar EnterpriseOS is an AI-native enterprise platform that allows ordinary business users to create AI agents, assemble specialized AI teams, connect their business applications, and automate complex workflows through natural-language conversations.

Netzar must provide the accessibility of a conversational AI assistant, the flexibility of an advanced engineering platform, and the reliability and security expected from enterprise software.

**The central product promise:**

**Tell Netzar what you want done. Netzar helps you build it, understand it, test it, and run it.**

The system must be simple enough for a 60–70-year-old first-time AI user with limited technical experience to build a useful automation independently.

At the same time, an experienced software engineer must be able to configure advanced logic, create custom integrations, use Python where appropriate, and inspect precisely how workflows execute.

These experiences must coexist within one product.

## The six foundational capabilities

1. **AI Chat** — Converse with specialized agents and have them perform authorized tasks.
2. **Agent Studio** — Create, customize, test, and manage reusable AI agents.
3. **AI Team Builder** — Create collaborative teams of specialized agents.
4. **Workflow Studio** — Build sophisticated business workflows conversationally, visually, or programmatically.
5. **Unified Enterprise Memory** — Allow authorized agents and workflows to use shared company knowledge and project context.
6. **Enterprise Execution & Governance** — Run workflows reliably with appropriate permissions, approvals, audit trails, and recovery.

The product should feel like a single integrated workspace rather than six disconnected tools.

## The primary product experience

A business user enters Netzar and types:

"When we receive an insurance policy, have our insurance agent review it, identify potential gaps, prepare a report, and send it to me for approval."

Netzar responds with an understandable draft process:

**1. Receive the insurance policy**  
**2. Insurance Agent reviews the document**  
**3. Identify potential coverage gaps**  
**4. Generate a report**  
**5. Send the report for your approval**

The user can:

- Talk to Netzar to refine the process.
- Select another agent or an entire AI team.
- Examine the steps visually.
- Test the workflow with a sample document.
- Understand its required permissions.
- Approve and activate it.

The user must not be required to write code, JSON, Python, prompts, or technical configuration.

The standard lifecycle is:

**Describe → Generate → Preview → Test → Approve → Activate**

## Nonnegotiable product decisions

1. **Paperclip will be replaced.** Netzar must become the sole product-level authority for workflow definitions, execution contracts, governance, monitoring, and recovery. Paperclip may remain only during a controlled migration and must be retired after Netzar-native execution is independently verified.
2. **Existing knowledge uploads will be preserved.** Shared, default, and agent-specific knowledge behavior must continue to use the existing S3, Titan embedding, and S3 Vectors foundation unless measured testing proves a specific part unfit. New memory capabilities extend this system; they do not replace it.
3. **The product will prove business results.** A technically successful run is not complete until its configured business outcome is verified, disputed, expired, or explicitly marked unverifiable.
4. **Governance claims must match real enforcement.** Netzar may govern native execution and supported connector actions. For third-party systems it cannot technically control, it must label the boundary, monitor available evidence, and never claim prevention it cannot enforce.

---

# 1. SYSTEM OVERVIEW & STRATEGIC OBJECTIVE

## 1.1 Business problem

Existing enterprise automation and AI platforms often expose technical concepts to business users before those users can accomplish their goals.

A user who wants to automate invoice approval may be required to understand webhooks, condition expressions, API authentication, database queries, execution states, and error handling.

These technical details are necessary for implementing reliable automation, but should not be prerequisites for describing a business process.

Netzar will translate business intent into structured, validated, and governed execution.

## 1.2 Strategic positioning

Netzar is not intended to become another generic clone of n8n, Dify, or an enterprise automation dashboard.

Its proposed differentiation is:

**A business-first workflow operating system that combines reusable AI employees, conversational process creation, transparent testing, and customer-controlled execution.**

Users should understand what a workflow accomplishes before needing to understand its internal mechanics.

The architecture must remain industry-agnostic.

Illustrative industries include:

- Insurance and risk management.
- Supply chain and procurement.
- Financial services and accounting.
- Healthcare operations.
- Legal services.
- Human resources.
- Manufacturing.
- Government.
- Professional consulting.

Industry-specific capabilities must be packaged as templates, agent configurations, integrations, and domain-specific business rules—not hardcoded into the universal workflow engine.

## 1.3 User personas

### Persona A — First-time AI user

A business professional with limited technical or AI experience.

**Needs:** Plain language, readable interfaces, guided setup, obvious next steps, simple explanations, and confidence that the system will do what was requested.

**Primary measure of success:** Can create, test, and understand a useful workflow without developer assistance.

### Persona B — Business process owner

A department manager, insurance broker, consultant, or operations leader.

**Needs:** Build repeatable business processes, select specialists, configure approvals, and monitor work.

**Primary measure of success:** Automates an actual business outcome without writing code.

### Persona C — Power user

An experienced analyst or technically confident employee.

**Needs:** Visual editing, conditional logic, reusable actions, advanced integrations, and precise controls.

**Primary measure of success:** Can build complex workflows efficiently using primarily no-code tools.

### Persona D — Developer

A software engineer or integration specialist.

**Needs:** Typed workflow contracts, SDKs, advanced debugging, version control, custom actions, Python/TypeScript support, and deployment controls.

**Primary measure of success:** Can extend Netzar without modifying its foundational engine for every customer requirement.

### Persona E — Enterprise administrator

Responsible for authentication, permissions, approved AI models, API connections, security, and compliance.

**Primary measure of success:** Enables employees to automate work without losing governance or customer control over infrastructure and data.

## 1.4 Business objectives

| ID | Objective |
|---|---|
| OBJ-001 | Make workflow creation accessible to nontechnical users |
| OBJ-002 | Make reusable AI agents and teams central to the product |
| OBJ-003 | Provide three complementary creation modes |
| OBJ-004 | Ensure all modes use the same workflow semantics |
| OBJ-005 | Create a dependable execution system for real business processes |
| OBJ-006 | Preserve customer-owned infrastructure and enterprise controls |
| OBJ-007 | Extend existing Netzar investments instead of unnecessary rewrites |
| OBJ-008 | Establish a commercially defensible user experience |

## 1.5 Proposed success measures

The following are proposed validation targets, not established service guarantees.

| Metric | Initial proposed target |
|---|---|
| First-time workflow drafting | At least 80% of novice test users successfully create a valid draft without assistance |
| Workflow comprehension | At least 80% can accurately explain the trigger, actions, and approval points |
| Beginner workflow testing | Users can complete a guided test without entering code |
| Editor consistency | No loss of execution semantics when moving between supported editor modes |
| Agent reusability | The same published agent definition operates in chat and workflow execution |
| Workflow side-effect safety | No duplicate consequential writes in defined retry and fault-injection tests |
| Industry flexibility | Insurance, finance, and supply-chain examples operate on the same foundational workflow services |

Product research must establish baselines before these become release commitments.

---

# 2. CORE ARCHITECTURAL PRINCIPLES & SYSTEM TOPOLOGY

## 2.1 Preserve Netzar's existing foundation

Netzar already has a meaningful technical foundation.

Repository documentation identifies:

- A TypeScript/Node.js backend.
- A Preact/Vite frontend.
- AWS CDK infrastructure.
- ECS/Fargate deployment.
- An AI agent runtime integrated with Amazon Bedrock.
- Agent definitions and templates.
- Chat and collaborative agent features.
- Knowledge ingestion and retrieval.
- DynamoDB and S3 storage.
- S3 Vectors and Titan embeddings.
- Existing authentication, auditing, cost controls, and security tooling.

These are assets to evaluate for reuse.

**Do not rewrite the application simply because another framework is popular.**

Every foundational subsystem must be categorized:

| Classification | Meaning |
|---|---|
| Preserve | Meets requirements and has suitable evidence |
| Extend | Useful foundation with missing capabilities |
| Refactor | Valuable behavior but problematic structure |
| Replace | Cannot meet requirements economically or safely |
| Retire | No longer needed after an approved migration |

Current implementation status must be verified from code, tests, and deployed behavior rather than the README alone.

## 2.2 Netzar-native workflow execution

Netzar must own its product-facing workflow experience, definitions, policy model, and integration contracts.

Netzar must not require n8n, Dify, or Paperclip to provide its customer-facing workflow functionality or serve as the authoritative business workflow engine.

An open-source library or execution framework may be used internally if it fits the architecture and licensing requirements.

The objective is **product and architectural control**, not writing every low-level component from scratch.

This replacement is a **Must** requirement, not an optional future direction. Netzar must own:

- Canonical workflow definitions and versions.
- Workflow publication and activation state.
- Business execution contracts.
- Human approvals.
- Policy decisions and audit evidence.
- Run, step, recovery, and outcome state.
- User-facing monitoring and recovery controls.

Lower-level durable orchestration technology may be used internally, but it must remain replaceable behind Netzar-owned contracts and may not become a second product authority.

## 2.3 Existing architectural conflict

The current repository includes an accepted decision assigning canonical business workflow state to Paperclip.

The approved product direction requires a Netzar-owned workflow system instead.

This is a material architectural change.

Before retiring Paperclip:

- Inventory its active responsibilities.
- Determine which functionality is already implemented.
- Identify active cases and durable state.
- Inspect unmerged implementation work.
- Identify schema and migration requirements.
- Compare cost, reliability, operational complexity, and developer experience.
- Define a safe cutover.
- Supersede the relevant existing architecture decisions through an explicit approved change.
- Prove workflow durability, approval integrity, retry safety, recovery, and audit continuity.
- Reconcile record counts, active state, and audit history before and after migration.
- Maintain a tested rollback path until final cutover acceptance.

Do not run two workflow systems as independent authorities over the same business process.

During migration, every workflow must have one explicit authority marker: `paperclip` or `netzar`. Dual writes may be used only for comparison when one side is declared non-authoritative and cannot trigger business effects.

### Paperclip replacement acceptance criteria

- **PR-AC-001:** Given a new workflow, when a user creates, tests, publishes, runs, pauses, resumes, and retires it, then every authoritative state change is stored and controlled by Netzar without Paperclip.
- **PR-AC-002:** Given a retry after an uncertain external write, when recovery runs, then Netzar reconciles the prior effect before any repeat and does not create a duplicate consequential action.
- **PR-AC-003:** Given an approval wait lasting longer than a compute session, when the approver acts, then the exact approved payload resumes from durable Netzar state.
- **PR-AC-004:** Given migrated Paperclip records, when reconciliation completes, then all required workflow definitions, active runs, approvals, business records, and audit history match the approved migration ledger.
- **PR-AC-005:** Given final cutover approval, when Paperclip is unavailable, then Netzar's create-to-recovery workflow lifecycle continues to pass production-readiness tests.
- **PR-AC-006:** Paperclip is retired only after PR-AC-001 through PR-AC-005 pass and the superseding architecture decision is approved.

## 2.4 Proposed architecture

### Layer 1 — Netzar Experience

Customer-facing application:

- AI Chat.
- Agent Studio.
- AI Team Builder.
- Workflow Studio.
- My Work.
- Knowledge Library.
- Administration.

### Layer 2 — Netzar Application Services

- Conversational workflow architect.
- Agent and team registry.
- Canonical workflow definitions.
- Workflow validation.
- Version management.
- Workflow testing.
- Authorization and policy enforcement.
- Execution control APIs.

### Layer 3 — Execution

- Durable workflow orchestration.
- Existing or improved Netzar agent runtime.
- Deterministic external-action execution.
- Human approval handling.
- Execution recovery.
- Scheduling and event handling.

### Layer 4 — Shared Enterprise Services

- Unified Memory API.
- Connector abstraction.
- Credential broker.
- Model gateway.
- Audit logging.
- Cost tracking.
- Data classification and permissions.

### Layer 5 — Customer Infrastructure

Existing customer-controlled AWS environment, with approved compute, storage, identity, model, and security services.

## 2.5 LangChain and LangGraph strategy

Evaluate LangChain and LangGraph as **implementation libraries**, not as the Netzar product.

### LangChain.js

Potential uses:

- Common AI model interfaces.
- Structured model outputs.
- Tool abstraction.
- Retrieval integration.
- Agent capabilities.

### LangGraph.js

Potential uses:

- Stateful agent execution.
- Specialized agent-team collaboration.
- Task delegation.
- Intermediate reasoning checkpoints.
- Human interruption and resumption of agent tasks.

### Durable workflow execution

Evaluate whether AWS Step Functions Standard or another durable orchestration technology best supports:

- Customer-authored workflows.
- Dynamic workflow definitions.
- Long-running executions.
- Human approvals.
- Timers and schedules.
- Retry safety.
- Operational debugging.
- Versioned execution.
- Cost-effective deployments.

LangGraph's agent orchestration and the business workflow engine must have separate, documented responsibilities.

**Do not introduce multiple overlapping execution authorities.**

## 2.6 Python support

The platform should support professional engineering workflows without requiring Python for everyday automation.

Python must be an optional, advanced capability.

The proposed model is:

- Ordinary workflows use typed, declarative steps.
- Advanced users can register approved Python or TypeScript actions.
- Custom actions expose validated inputs and outputs.
- Custom code runs in a controlled execution environment.
- External writes remain subject to authorization and idempotency controls.
- Model-generated code is never executed automatically without appropriate validation and approval.

A Python dependency must not force rewriting Netzar's TypeScript frontend or backend.

---

# 3. HIGH-LEVEL SYSTEM COMPONENTS & PRODUCT EXPERIENCE

## 3.1 Simplified product navigation

Reduce the cognitive burden of the current Mission Control experience.

Proposed primary areas:

| Area | User purpose |
|---|---|
| Home | Ask Netzar and continue recent work |
| Agents | Talk to agents, create agents, build AI teams |
| Workflows | Create and manage automations |
| My Work | View active work, cases, and approvals |
| Library | Manage knowledge, templates, and generated files |
| Administration | Manage connections, permissions, models, security, and costs |

Advanced administrative tools should not overwhelm ordinary employees.

Existing security functionality must remain available to authorized administrators.

## 3.2 Workflow Studio — Core product requirement

Workflow Studio is the central new experience.

It must support three modes.

### MODE A — CONVERSATIONAL BUILDER

**Default for every new user.**

The initial interface asks:

**What would you like to automate?**

A user can describe a workflow in everyday language.

Example:

"Every time we receive a new invoice, compare it to the purchase order. If everything matches, send it to our finance manager for approval. If something doesn't match, tell the purchasing department."

Netzar must:

1. Understand the desired business outcome.
2. Identify what starts the process.
3. Identify necessary information.
4. Discover available agents and teams.
5. Discover available integrations.
6. Generate a workflow draft.
7. Explain the steps in everyday language.
8. Identify unresolved requirements.
9. Preview the process.
10. Generate sample tests.
11. Request appropriate approval before activation.

#### Conversational revisions

The user must be able to say:

"Add another approval before the invoice is submitted."

"Have my Finance Agent handle the reconciliation."

"Only notify the department if the difference exceeds $500."

"Make this run every Friday instead."

Netzar updates the workflow draft while preserving its version history and relevant configurations.

#### Clarification rules

Ask only necessary questions.

Ask:

"Who should approve the invoice?"

Do not ask:

"What should the approval callback token ARN be?"

When an important detail is missing, explain why the answer matters.

#### Intelligent reuse

Before creating components, Netzar should discover:

- Existing agents.
- Existing AI teams.
- Existing workflows.
- Existing connectors.
- Existing approved templates.
- Relevant authorized knowledge.

Prefer reuse over generating redundant agents and workflow steps.

#### Safety and honesty

The system must distinguish:

- A successfully generated draft.
- A validated workflow.
- A successful test.
- A published workflow.
- A live successful execution.

It must not describe a draft as an activated automation.

---

### MODE B — VISUAL BUILDER

**Optional visual control for users who prefer to see the process.**

The visual builder must provide a drag-and-drop representation of the same workflow.

Supported elements:

- Manual triggers.
- Scheduled triggers.
- Events and webhooks.
- AI agent steps.
- AI team steps.
- Document extraction.
- Data retrieval.
- Application actions.
- Conditions and branches.
- Parallel execution.
- Bounded loops.
- Human approval.
- Delays and timers.
- Subworkflows.
- Error and recovery paths.
- Final outputs.

#### Usability requirements

- Display clear step names.
- Avoid overwhelming users with all technical settings.
- Group related functionality.
- Allow users to move and connect steps.
- Explain what information a step receives.
- Explain what result a step produces.
- Show incomplete configuration.
- Show validation errors in plain language.
- Provide undo and change history.
- Keep the conversational assistant available alongside the workflow.

For example, a user selecting an agent step should see:

**Which agent should do this?**

Not a raw agent configuration payload.

#### Canvas technology

Evaluate visual graph libraries for compatibility with Netzar's existing Preact frontend.

React Flow is an option, not a mandatory reason to migrate the entire application to React.

---

### MODE C — DEVELOPER STUDIO

**Advanced tools for software engineers and approved technical users.**

Developer Studio must support:

- Typed workflow definitions.
- Schema inspection and validation.
- Custom connectors.
- Versioned Python actions.
- Versioned TypeScript actions.
- Custom agent configuration.
- Test suites.
- Runtime debugging.
- Execution traces.
- Workflow diffs.
- Environment configuration.
- Version control.
- Deployment and rollback controls.
- CLI/SDK integration where justified.

#### Critical rule

Developer Studio must not use a different workflow engine or incompatible workflow representation.

All three modes use the same underlying definition and execution contract.

Advanced code-based actions must remain identifiable in the visual editor even when their implementation cannot be expressed as ordinary no-code blocks.

---

## 3.3 Agent Studio

Agent Studio must be a major standalone product capability.

Users should be able to create specialized agents by describing the job they need done.

Example:

"Create an AI agent who understands commercial property insurance and can identify potential coverage gaps."

Netzar proposes:

- Agent name.
- Specialty.
- Responsibilities.
- Instructions.
- Required knowledge.
- Suggested tools.
- Approved model.
- Permissions.
- Test scenarios.

The agent is a reusable, versioned organizational resource.

### Required agent configuration

| Capability | Description |
|---|---|
| Role | Agent expertise and responsibilities |
| Instructions | Behavioral and task guidance |
| Knowledge | Authorized information sources |
| Model | Approved model selection |
| Tools | Allowed actions and integrations |
| Permissions | Read, recommend, and execute boundaries |
| Memory | Authorized persistent context |
| Evaluations | Test scenarios and quality checks |
| Versioning | Published configuration history |
| Ownership | Responsible organization/user |

### Agent reuse

The same agent must function within:

- Chat.
- Agent teams.
- Workflows.
- Scheduled authorized activities.

Do not create different agent definitions for each product surface.

A running workflow should reference a pinned published agent version unless an explicit, governed update mechanism applies.

---

## 3.4 AI Team Builder

Users must be able to describe an entire business function and receive a proposed team.

Example:

"Build an AI team for vendor risk assessments."

Netzar may propose:

**Vendor Analyst** — Reviews supplier information.

**Compliance Specialist** — Assesses applicable controls.

**Financial Analyst** — Reviews financial information.

**Risk Manager** — Consolidates findings and prepares a recommendation.

The user can review the team, modify responsibilities, select existing agents, and test collaboration.

### Team requirements

- Reuse existing agents.
- Allow multiple specialties.
- Define communication and delegation.
- Define knowledge-sharing boundaries.
- Track shared tasks.
- Limit recursive delegation.
- Define execution budgets and timeouts.
- Retain attributable agent actions.
- Permit team use as a workflow step.

Agents on the same team must not automatically gain unrestricted access to one another's data.

---

## 3.5 My Work and execution experience

A user should never have to inspect internal execution infrastructure merely to understand a business process.

The My Work area must show:

- Active workflows.
- Tasks requiring attention.
- Pending approvals.
- Failed or blocked work.
- Completed work.
- Generated deliverables.

Supported status labels:

- Draft.
- Ready to test.
- Needs setup.
- Ready to activate.
- Running.
- Waiting for approval.
- Blocked.
- Completed.
- Failed.
- Paused.

Clicking a workflow run should show a simple timeline:

**Document received → Agent reviewed → Report prepared → Approval requested**

Technical execution traces may be expanded by authorized advanced users.

---

## 3.6 Unified Enterprise Memory

Netzar must provide a shared, permission-aware memory system used by agents, teams, and workflows.

### Preservation requirement

The existing knowledge-upload and retrieval experience is a **Must — preserve existing functionality** requirement.

Netzar must preserve:

1. **Shared Knowledge** — Documents uploaded for access by authorized agents across the organization.
2. **Default Knowledge** — Existing default knowledge behavior, after its current scope and access rules are verified.
3. **Agent-Specific Knowledge** — Documents and reference material authorized for one agent.
4. **Knowledge Uploads** — Existing upload, ingestion, embedding, indexing, and retrieval behavior.
5. **Knowledge Management** — Authorized viewing, replacement, reprocessing, and removal of sources.

Continue using existing S3 object storage, Titan embeddings, and S3 Vectors unless a repeatable test demonstrates a specific deficiency against an approved requirement. Any replacement proposal must include measured evidence, migration, rollback, cost, security, and retrieval-quality comparisons.

Memory categories:

### Organization Memory

Company policies, procedures, approved standards, and institutional knowledge.

### Project Memory

Customer engagements, project requirements, decisions, working context, and relevant shared information.

### Workflow Memory

Inputs, outputs, progress, state references, decisions, and execution history.

### Agent Memory

Agent-specific context and preferences within authorized boundaries.

### Conversation Memory

Relevant conversational context and summaries.

### Agent Studio knowledge controls

When creating or editing an agent, an authorized user must be able to:

- Upload knowledge only for that agent.
- Select approved shared and default knowledge.
- See every source and scope the agent may retrieve.
- Update, remove, or reprocess authorized sources.
- Test retrieval against named sources before publishing.
- See the source and scope used in a test answer.

### AI Team Builder knowledge controls

When creating or running an AI team:

- Each member keeps its individual knowledge configuration.
- Authorized shared and default knowledge remains available according to policy.
- Team members may exchange only explicitly permitted task context.
- One agent's private knowledge does not become searchable or visible to another agent merely because both are on the same team.
- Access is checked at retrieval and tool-execution time, not only in the user interface.
- Any future team-level knowledge scope requires explicit owners, permissions, provenance, retention, and deletion rules.

### Existing technology

Preserve S3 Vectors and Titan embeddings initially for semantic knowledge retrieval.

Extend existing storage with structured memory records where needed.

Use DynamoDB for appropriate structured context, S3 for original documents and artifacts, and the selected execution engine for authoritative execution state.

### Required controls

Every memory operation must enforce:

- Deployment isolation.
- User authorization.
- Project or engagement boundaries.
- Document-level permissions.
- Data classification.
- Provenance.
- Retention.
- Correction and deletion.
- Auditability.

**Unified memory means one consistent access service, not one database that exposes everything to every agent.**

Temporary user uploads must not automatically become broadly shared organizational knowledge without an authorized retention and visibility policy.

### Knowledge preservation acceptance criteria

- **KN-AC-001:** Existing shared, default, and agent-specific uploads remain discoverable by their authorized users after the EnterpriseOS upgrade.
- **KN-AC-002:** A newly uploaded source is stored in S3, embedded with the approved Titan model, indexed in S3 Vectors, and becomes retrievable within the defined ingestion service level or shows an actionable failure state.
- **KN-AC-003:** An agent retrieves only sources allowed by the intersection of deployment, user, organization, project, agent, and document permissions.
- **KN-AC-004:** In a team test, Agent B cannot retrieve Agent A's private source unless an explicit policy grants access.
- **KN-AC-005:** Chat, team, and workflow execution use the same permission-aware retrieval service and return source provenance.
- **KN-AC-006:** Removing a source blocks new retrieval after the documented deletion window and records an attributable audit event.
- **KN-AC-007:** Migration testing compares representative pre-change and post-change queries for access correctness and retrieval relevance; unauthorized access is a release blocker.

---

## 3.7 Integrations and API Keys

Netzar should allow authorized users to connect external applications without learning API programming.

Initial connection categories:

- OAuth.
- API keys.
- REST APIs.
- Webhooks.
- Email.
- Cloud storage.
- Databases.
- CRM.
- ERP.
- Accounting systems.
- Procurement systems.
- Custom business applications.

### Bring Your Own API Key

An authorized administrator should be able to:

1. Choose an application.
2. Enter credentials securely.
3. Test the connection.
4. Select allowed capabilities.
5. Make the connection available to approved agents/workflows.
6. Rotate or revoke access.

The interface should explain:

**What application is connected, what it can do, and who may use it.**

Credentials must not be embedded in model prompts or workflow definitions.

Approved connections must be represented by secure references rather than raw secret values.

---

# 4. DEEP TECHNICAL REQUIREMENTS & DATA FLOW

## 4.1 Functional requirements

### Essential platform requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-001 | Users can describe and generate workflow drafts in natural language | Must |
| FR-002 | Netzar can reuse existing agents in workflows | Must |
| FR-003 | Netzar can reuse existing teams as workflow steps | Must |
| FR-004 | Users can preview workflows in business language | Must |
| FR-005 | Users can test workflows without executing unintended real-world actions | Must |
| FR-006 | Conversational and visual editing maintain identical workflow semantics | Must |
| FR-007 | Developer Studio accesses the same underlying workflow definition | Must |
| FR-008 | Published workflows are versioned | Must |
| FR-009 | Workflows support durable execution and recovery | Must |
| FR-010 | High-impact actions use enforceable approvals | Must |
| FR-011 | External actions use authorization and retry-safety controls | Must |
| FR-012 | Memory retrieval respects permissions | Must |
| FR-013 | Users can configure authorized integrations and API keys | Must |
| FR-014 | Users can inspect progress, failures, and outcomes | Must |
| FR-015 | Existing valuable agent/chat/governance capabilities remain functional | Must |
| FR-016 | Advanced users can register approved custom actions | Should |
| FR-017 | Agents can be created conversationally | Must |
| FR-018 | Agent teams can be created conversationally | Must |
| FR-019 | Templates can be created and reused across industries | Should |
| FR-020 | Workflow errors can be repaired conversationally | Should |
| FR-021 | Netzar verifies configured business outcomes after task execution | Must |
| FR-022 | Netzar recovers safely from business-level failures without duplicate consequential actions | Must |
| FR-023 | Netzar enforces one policy and audit model across native execution and supported integration control points | Must |
| FR-024 | Netzar clearly labels governance it can observe but cannot enforce | Must |
| FR-025 | Authorized users can opt in to automation discovery using approved metadata and process signals | Should |
| FR-026 | Discovery recommendations show assumptions, confidence, expected value, cost, and risk | Should |
| FR-027 | Published workflows run continuous business-oriented regression tests | Must |
| FR-028 | Industry outcome packs bundle workflows, agents, integrations, tests, metrics, and operating guidance | Should |
| FR-029 | Existing shared, default, and agent-specific S3/Titan/S3 Vectors knowledge remains functional | Must |
| FR-030 | Netzar replaces Paperclip as the authoritative workflow system through a verified migration | Must |

## 4.2 Canonical workflow contract

Netzar must establish one versioned workflow definition format independent of its editing mode.

Required concepts:

- Workflow identity.
- Immutable published version.
- Trigger.
- Typed steps.
- Input/output mappings.
- Conditional transitions.
- Parallel branches.
- Loop bounds.
- Agent/team references.
- Connector references.
- Human approval requirements.
- Error handlers.
- Timeouts.
- Retry policies.
- Execution budgets.
- Security policies.

An illustrative workflow:

```json
{
  "id": "invoice-review",
  "version": "1.0.0",
  "name": "Invoice Review",
  "trigger": {
    "type": "document.received"
  },
  "steps": [
    {
      "id": "extract",
      "type": "document.extract"
    },
    {
      "id": "analyze",
      "type": "agent.run",
      "agentRef": "finance-agent",
      "agentVersion": "1.0.0"
    },
    {
      "id": "approve",
      "type": "human.approval",
      "decisionClass": "financial-review"
    }
  ]
}
```

This is a proposed illustrative structure, not a verified implementation schema.

## 4.3 Workflow creation pipeline

The Conversational Builder must follow a controlled generation process.

**Step 1 — Interpret**

Identify the user's intended business outcome, trigger, information, responsible actors, and restrictions.

**Step 2 — Discover**

Find available agents, teams, templates, integrations, and authorized knowledge.

**Step 3 — Plan**

Generate a proposed sequence of business operations.

**Step 4 — Compile**

Translate the plan into a typed workflow definition.

**Step 5 — Validate**

Verify schema, data flow, permissions, integrations, and structural correctness.

**Step 6 — Preview**

Show the user a clear description of what will happen.

**Step 7 — Test**

Execute approved test scenarios without unintended live side effects.

**Step 8 — Activate**

Require the applicable user or administrator authorization.

Natural-language generation must never directly execute unvalidated model output.

## 4.4 Workflow validation

Before activation, validate:

- Required steps exist.
- Branches are connected.
- Input/output types are compatible.
- Loops are bounded.
- Referenced agents and teams exist.
- Required connectors are available.
- Required credentials are valid.
- Required permissions are granted.
- Approval gates are properly configured.
- Data classification restrictions are respected.
- Execution resource limits are acceptable.

Validation errors must appear in plain language.

Example:

"Your workflow needs access to the accounting system before it can be turned on."

## 4.5 Workflow execution requirements

The engine must support:

- Manual execution.
- Event triggers.
- Scheduled execution.
- Webhooks.
- Sequential steps.
- Conditional branches.
- Parallel processing.
- Agent and team execution.
- Human approval pauses.
- Long-running waits.
- Bounded loops.
- Subworkflows.
- Retries.
- Failure recovery.
- Version-pinned execution.
- Execution history.
- Cancellation and pausing where safely supported.

Business writes must be performed through authorized deterministic operations.

A retry must not create a second financial transaction, duplicate customer record, or other unintended duplicate side effect.

## 4.6 Human approvals

A workflow must be able to pause and request approval from an authorized person.

Approval records must identify:

- Workflow and step.
- Proposed action.
- Exact action payload or immutable reference.
- Approver.
- Decision.
- Timestamp.
- Comment where required.
- Integrity binding between approved and executed action.

Supported decisions:

- Approve.
- Reject.
- Request Changes.

An AI agent must not approve its own restricted action.

## 4.7 Data contracts

Core conceptual entities include:

| Entity | Responsibility |
|---|---|
| Agent Definition | Reusable AI specialist |
| Agent Version | Immutable published configuration |
| Team Definition | Collaborative agent membership and rules |
| Workflow Definition | Canonical business process |
| Workflow Version | Published executable contract |
| Workflow Draft | Editable unpublished process |
| Workflow Run | One execution instance |
| Step Execution | Step-level attempt and outcome |
| Approval | Attributable authorization |
| Connector | External application capabilities |
| Connection | Authorized configured access |
| Memory Record | Shared structured context |
| Knowledge Source | Authorized source content with provenance |
| Artifact | File or document produced by a process |
| Audit Event | Traceable non-sensitive execution evidence |
| External Effect | Recorded side effect and idempotency state |

Reuse or adapt existing entities where feasible.

Do not introduce redundant sources of truth.

## 4.8 Differentiated product capabilities

The following six capabilities turn Netzar from a workflow builder into a business-outcome operating system. They share the canonical workflow, policy, evidence, and audit models defined above.

### 4.8.1 Business Outcome Verification

**Priority:** Must  
**Purpose:** Prove the result the business wanted, not merely that automation steps ran.

#### Requirements

- **BOV-001:** Every published workflow must declare one or more measurable outcome contracts, or explicitly state that it is an operational workflow with no outcome verification.
- **BOV-002:** An outcome contract must define the target event or state, evidence source, correlation key, verification window, owner, value method, and terminal states.
- **BOV-003:** Supported terminal states are `verified`, `partially_verified`, `failed`, `expired`, `disputed`, and `unverifiable`.
- **BOV-004:** Step completion and outcome verification must be stored separately. A run may be technically complete while its business outcome remains pending or fails.
- **BOV-005:** Netzar must correlate downstream evidence such as a booking, deposit, payment, attendance record, avoided charge, closed ticket, or approved record back to the initiating workflow run.
- **BOV-006:** Claimed revenue recovered, expense prevented, or hours saved must show the formula, source data, assumptions, and confidence. Estimated value must never be presented as verified value.
- **BOV-007:** My Work and reporting must show verified value, estimated value, pending outcomes, failed outcomes, and evidence provenance separately.
- **BOV-008:** Late or contradictory evidence must update the outcome ledger without rewriting the historical execution audit.

#### Boundaries

- Netzar does not claim causation when it can prove only correlation.
- Netzar does not invent monetary value or labor savings when required source data is absent.
- Outcome evidence is limited to authorized connected systems, approved human attestations, and imported records with provenance.
- Industry packs may define default outcome contracts, but customers must confirm their data sources and value assumptions.

#### Acceptance criteria

- **BOV-AC-001:** Given a restaurant follow-up workflow with a booking outcome contract, when the message sends but no booking arrives before the verification window closes, then the run shows `execution: completed` and `outcome: failed`, not business success.
- **BOV-AC-002:** Given a linked booking and deposit, when both evidence records match the correlation key, then Netzar marks the outcome `verified` and displays the evidence references and verified amount.
- **BOV-AC-003:** Given an hours-saved estimate, when a user opens the result, then the baseline, frequency, calculation, assumptions, owner, and confidence are visible.
- **BOV-AC-004:** Given missing or conflicting evidence, when verification ends, then Netzar uses `unverifiable` or `disputed` and does not count the value as verified.

### 4.8.2 Intelligent Safe Failure Recovery

**Priority:** Must  
**Purpose:** Diagnose and recover business processes across systems without hiding risk or repeating consequential actions.

#### Requirements

- **SFR-001:** Failures must be classified as validation, authorization, authentication, rate limit, transient dependency, permanent dependency, data quality, policy denial, human timeout, uncertain external effect, or unknown.
- **SFR-002:** Each step type must declare its retry class, idempotency strategy, reconciliation method, compensation support, timeout, and escalation owner.
- **SFR-003:** Automatic recovery is allowed only when the registered recovery policy says the action is safe for the observed failure class.
- **SFR-004:** Before retrying an external write with an unknown result, Netzar must reconcile the target system using an idempotency key or business correlation key.
- **SFR-005:** Recovery may refresh credentials, retry with bounded backoff, request corrected input, resume from a safe checkpoint, run an approved compensation, or escalate with a recommended action.
- **SFR-006:** AI may explain, classify, and propose recovery, but it may not invent success, bypass policy, broaden permissions, or repeat a high-impact action without deterministic safety checks.
- **SFR-007:** Every recovery attempt must record the cause, evidence, decision, actor, action, and result.
- **SFR-008:** Users must see a plain-language state: what failed, what Netzar tried, whether business effects may have occurred, and what action is required.

#### Boundaries

- No blind retry of payments, bookings, record creation, messages, deletions, or other consequential writes.
- Compensation is not assumed to be a true rollback; its business meaning must be defined per connector action.
- Netzar does not automatically repair workflow logic and publish the change to production. Fixes require tests and the normal approval path.
- Unknown external state defaults to reconciliation or human review, not success.

#### Acceptance criteria

- **SFR-AC-001:** Given a timeout after a payment request, when the provider later shows the payment exists, then Netzar records the prior effect and does not send a second payment.
- **SFR-AC-002:** Given a transient read failure, when bounded retries succeed, then the workflow resumes from the failed step without rerunning completed consequential steps.
- **SFR-AC-003:** Given expired credentials, when automated refresh is not authorized or fails, then Netzar pauses, names the connection owner, and provides a safe reconnect action.
- **SFR-AC-004:** Given an unclassified failure, when no registered safe recovery applies, then Netzar escalates with evidence and performs no additional external write.

### 4.8.3 Cross-Platform Governance

**Priority:** Must for Netzar-native execution and supported control points; Should for expanded third-party coverage  
**Purpose:** Apply one understandable policy, approval, and audit model wherever Netzar can technically enforce it.

#### Requirements

- **CPG-001:** Netzar must define a vendor-neutral policy model covering actor, action, resource, data class, environment, risk class, approval, time, and customer boundary.
- **CPG-002:** Policy must be evaluated at workflow activation and again immediately before protected tool or connector execution.
- **CPG-003:** Native workflows, agents, teams, connectors, custom actions, and supported external workflow adapters must emit normalized audit events.
- **CPG-004:** Each integration must publish a capability manifest stating whether Netzar can `enforce`, `approve`, `observe`, or has `no_visibility` for each action class.
- **CPG-005:** The interface and reports must distinguish enforced controls from advisory or observed controls.
- **CPG-006:** Unsupported or bypassed external actions must never be described as governed by Netzar.
- **CPG-007:** Policy changes must be versioned, attributable, testable before activation, and bound to subsequent decisions.
- **CPG-008:** High-risk policy denials and attempted bypasses must produce an alert and immutable audit evidence.

#### Boundaries

- Netzar cannot prevent an action performed directly in a third-party product unless that product exposes and honors an enforceable control point routed through Netzar.
- Read-only logs do not equal preventive control.
- Netzar will not market universal control over Zapier, Make, n8n, AWS, or other platforms when only partial visibility exists.
- Third-party policy adapters may normalize evidence but may not overwrite source audit records.

#### Acceptance criteria

- **CPG-AC-001:** Given a denied customer-data export through a supported connector, when execution reaches the action, then Netzar blocks it before transmission and records the exact policy version and reason.
- **CPG-AC-002:** Given an external platform that supplies logs but no pre-execution hook, when its run appears in Netzar, then the control is labeled `observe`, not `enforce`.
- **CPG-AC-003:** Given the same protected action from chat, a team, and a workflow, when policy evaluates it, then all three surfaces return the same decision for the same actor and context.
- **CPG-AC-004:** Given a policy update, when an administrator runs impact preview, then Netzar lists affected workflows and sample decisions before activation.

### 4.8.4 Opt-In Automation Discovery and ROI Estimates

**Priority:** Should  
**Purpose:** Find repetitive work and rank opportunities without covert employee surveillance or false precision.

#### Requirements

- **ADR-001:** Discovery is off by default and requires explicit organization-level enablement plus clear participant notice where user activity is involved.
- **ADR-002:** Administrators must select approved sources, fields, retention, participants, exclusions, and analysis window before collection begins.
- **ADR-003:** Discovery should prefer process metadata such as timestamps, event types, counts, handoffs, queues, and error states over message or document bodies.
- **ADR-004:** Recommendations must identify the observed pattern, current volume, estimated manual effort, delay, error rate where known, proposed automation, required integrations, risk, confidence, and evidence window.
- **ADR-005:** ROI must separate verified inputs from user-provided assumptions and show the formula for savings, implementation cost, operating cost, payback, and confidence range.
- **ADR-006:** Users must be able to correct assumptions, reject a recommendation, exclude a process, and delete discovery data under policy.
- **ADR-007:** No recommendation may activate a workflow or grant permissions automatically.
- **ADR-008:** Employee ranking, hidden productivity scoring, emotion inference, and disciplinary use are out of scope.

#### Boundaries

- Discovery is advisory and opt-in.
- Netzar does not install screen, keystroke, or clipboard capture as a default product behavior.
- Private content, credentials, health data, and legally privileged data are excluded unless a separately approved use case and policy permit them.
- ROI estimates are planning aids until verified by post-launch outcome evidence.

#### Acceptance criteria

- **ADR-AC-001:** Given discovery is disabled, when users operate Netzar, then no discovery telemetry beyond normal approved operational logs is collected.
- **ADR-AC-002:** Given 30 days of approved invoice metadata, when Netzar recommends an approval automation, then the recommendation shows event counts, median handling time, assumptions, estimated range, confidence, and required systems.
- **ADR-AC-003:** Given a user changes labor cost or handling time, when ROI recalculates, then the new value and its source are visible and the original recommendation evidence remains intact.
- **ADR-AC-004:** Given a rejected recommendation, when the same evidence is analyzed again, then the rejection and reason are considered and the workflow is not created automatically.

### 4.8.5 Continuous Business-Oriented Quality Assurance

**Priority:** Must  
**Purpose:** Detect when a technically running workflow stops producing correct, safe business results.

#### Requirements

- **BQA-001:** Every production workflow must have an owner, criticality, expected outcome, representative test cases, and a test schedule based on risk.
- **BQA-002:** Test suites must cover schema and contract validity, connector compatibility, permissions, policy, deterministic actions, AI quality, outcome rules, and regression against approved examples.
- **BQA-003:** Netzar must support safe simulations, mocks, shadow reads, synthetic records, and controlled canaries without unintended production writes.
- **BQA-004:** AI steps must use task-specific scoring rubrics and required evidence, not a single generic model-quality score.
- **BQA-005:** Material changes to prompts, models, tools, connectors, policies, schemas, or workflow definitions must run affected tests before activation.
- **BQA-006:** Failed release gates must block activation. Failed post-release checks must alert, and may pause the affected workflow when an approved policy defines the failure as critical.
- **BQA-007:** Suggested fixes must show the failing case, expected behavior, proposed change, affected versions, and rollback path; they do not publish themselves.
- **BQA-008:** Production outcome drift must be measured separately from test pass rate.

#### Boundaries

- Tests must not expose private production data to unauthorized models or environments.
- Automated judges cannot be the sole gate for high-impact legal, medical, financial, safety, or employment decisions.
- A passing technical test does not override a failed business outcome metric.
- Netzar does not silently change a published workflow to make a test pass.

#### Acceptance criteria

- **BQA-AC-001:** Given a connector removes or changes a required field, when the scheduled contract test runs, then Netzar identifies the affected workflows and blocks unsafe new activations.
- **BQA-AC-002:** Given an AI extraction model falls below the approved accuracy threshold on the reference set, when evaluation completes, then the release gate fails with the mismatched fields and examples.
- **BQA-AC-003:** Given a critical production canary fails, when the pause policy applies, then new runs stop, active safe states are preserved, and owners receive an actionable alert.
- **BQA-AC-004:** Given an approved fix and successful regression suite, when activation occurs, then Netzar records the tested artifact versions and retains a rollback target.

### 4.8.6 Industry-Specific Outcome Packs

**Priority:** Should; Must for each selected launch industry before commercial release  
**Purpose:** Deliver a working business result instead of a bag of generic components.

#### Requirements

- **IOP-001:** An outcome pack must include versioned workflows, agent or team configurations, shared-knowledge guidance, connector mappings, outcome contracts, failure policies, approval policies, QA cases, dashboards, setup steps, and operating guidance.
- **IOP-002:** Every pack must state its intended industry, job-to-be-done, supported systems, prerequisites, excluded decisions, risks, owner, and support boundary.
- **IOP-003:** Packs must compile to the same canonical Netzar contracts used by custom workflows; industry rules may not be hardcoded into the core engine.
- **IOP-004:** Installation must begin in preview or sandbox mode, show every requested permission, and require explicit activation.
- **IOP-005:** Customer changes must create a derived version so vendor updates cannot silently overwrite local policy or logic.
- **IOP-006:** Pack updates must include migration notes, compatibility checks, tests, and rollback.
- **IOP-007:** Pack reporting must center on its named business outcome and verified evidence.
- **IOP-008:** Launch candidates should be chosen by validated customer demand, available integrations, measurable outcomes, risk, and support cost—not by template count.

#### Boundaries

- Packs are operational accelerators, not legal, medical, financial, or regulatory advice.
- A pack may automate collection, analysis, routing, and reporting, but regulated final decisions require the defined qualified human role where applicable.
- Unsupported connector variants or jurisdiction rules must be shown before activation.
- Netzar will not claim a pack is compliant merely because its workflow ran.

#### Acceptance criteria

- **IOP-AC-001:** Given a supported restaurant booking-recovery pack, when installed, then the user sees required systems, permissions, workflow, verified-booking outcome rule, recovery behavior, tests, and dashboard before activation.
- **IOP-AC-002:** Given a dental missed-appointment pack with unsupported practice software, when setup runs, then activation is blocked or the unsupported boundary is explicitly accepted with a manual step; Netzar does not pretend the integration exists.
- **IOP-AC-003:** Given a customer customizes an insurance-review approval rule, when the base pack updates, then Netzar preserves the customer version and presents a reviewed merge instead of overwriting it.
- **IOP-AC-004:** Given a pack's reference test set, when all required tests and connector checks pass in the customer's environment, then the pack may be activated by an authorized user.

### 4.8.7 Shared capability data contracts

Add or extend the following canonical entities without creating duplicate sources of truth:

| Entity | Minimum responsibility |
|---|---|
| Outcome Contract | Target state, evidence, correlation, window, value method, owner |
| Outcome Evidence | Source, event, timestamp, correlation, provenance, integrity |
| Outcome Result | Status, verified value, estimated value, confidence, dispute state |
| Recovery Policy | Failure classes, safe actions, retry, reconciliation, escalation |
| Recovery Attempt | Cause, decision, action, actor, evidence, result |
| Policy Definition | Vendor-neutral rule, version, owner, activation state |
| Integration Capability Manifest | Per-action enforce/approve/observe/no-visibility declaration |
| Discovery Consent | Scope, sources, participants, retention, exclusions, status |
| Automation Opportunity | Evidence, recommendation, assumptions, ROI range, risk, disposition |
| QA Suite | Reference cases, rubrics, thresholds, schedule, release gate |
| QA Result | Tested versions, case results, drift, decision, evidence |
| Outcome Pack | Industry package, versions, dependencies, boundaries, tests, owner |

---

# 5. SCALABILITY, PERFORMANCE & RESOURCE LIMITS

## 5.1 Usability before infrastructure complexity

The highest-priority product objective is to make workflow creation understandable and reliable.

Do not prematurely add infrastructure designed for hypothetical workloads.

Unknowns requiring measurement:

- Number of users per customer.
- Concurrent workflow executions.
- Typical workflow duration.
- Largest expected documents.
- Number of agents per team.
- Number of connectors.
- Memory and storage growth.
- Customer spending constraints.

## 5.2 Proposed nonfunctional targets

The following require validation and approval.

| ID | Measurement | Proposed target |
|---|---|---|
| NFR-001 | Initial Home screen usability | Interactive within 3 seconds at p95 under an agreed reference workload |
| NFR-002 | Conversation feedback | Visible acknowledgment or progress within 3 seconds at p95 |
| NFR-003 | Basic workflow generation | Valid draft or actionable explanation within 45 seconds at p95 for representative examples |
| NFR-004 | Visual editing responsiveness | Typical editing action response within 150 ms at p95 on agreed reference hardware |
| NFR-005 | Accessibility | WCAG 2.2 AA target for primary user journeys |
| NFR-006 | Workflow integrity | No semantic change when switching supported editor modes |
| NFR-007 | Unauthorized actions | Zero successful unauthorized actions in defined security tests |
| NFR-008 | Duplicate external effects | Zero unintended duplicate writes in fault-injection tests |
| NFR-009 | Cost control | Enforce configured model and execution spending limits |
| NFR-010 | Data isolation | No unauthorized cross-customer or cross-project retrieval in permission tests |

Actual operating targets must be finalized after workload and usability validation.

---

# 6. RESILIENCE, FAILURE DOMAINS & DISASTER RECOVERY

## 6.1 Recovery principles

Workflows must not lose committed progress during ordinary interruptions.

The system should preserve durable state and recover safely after:

- Service restarts.
- Model failures.
- Network interruptions.
- Connector outages.
- Human approval delays.
- Expired credentials.
- Duplicate incoming events.
- Retries.
- External-action timeouts.

## 6.2 Failure behavior

| Scenario | Required behavior |
|---|---|
| AI model unavailable | Preserve state and retry or offer approved fallback |
| API connection missing | Block affected step and show setup guidance |
| Connector unavailable | Use bounded retries; do not corrupt state |
| Workflow interrupted | Resume from a durable checkpoint |
| Duplicate webhook | Prevent duplicate business effects |
| Approval missing | Wait without executing the restricted action |
| Invalid approval | Fail closed |
| External write outcome unknown | Require reconciliation rather than blind retry |
| Memory access denied | Exclude unauthorized records |
| Invalid workflow | Reject activation and explain the problem |
| Updated published agent | Existing runs remain pinned unless explicitly migrated |

## 6.3 Backup and recovery

Protect the authoritative records for:

- Agent definitions.
- Team definitions.
- Workflows.
- Published versions.
- Execution state.
- Approvals.
- Business action outcomes.
- Memory and knowledge provenance.
- Relevant artifacts.

Recovery objectives and customer-specific retention requirements remain to be determined.

Before production activation, verify restoration and post-restore reconciliation in a controlled environment.

---

# 7. OBSERVABILITY, TELEMETRY & OPERATIONS

## 7.1 Business-facing execution history

Users should see understandable progress.

Example:

**Invoice received → Finance Agent reviewing → Discrepancy found → Manager approval needed**

Do not display raw infrastructure exceptions as the primary explanation.

Each execution should answer:

- What happened?
- Why did it happen?
- Which agent performed the work?
- What information was used?
- Was an external action executed?
- Is approval needed?
- What can I do next?

## 7.2 Technical observability

Capture appropriate:

- Workflow ID and version.
- Execution ID.
- Step ID.
- Agent/team ID and version.
- Model and request metadata.
- Tool/connector reference.
- Retry and failure information.
- Approval identifiers.
- External-effect identifiers.
- Execution latency.
- Resource and model costs.

Use correlation identifiers across components.

Do not write secrets or protected business content into immutable operational audit records.

## 7.3 Operational controls

Authorized administrators should be able to:

- Inspect failed runs.
- Find blocked steps.
- View connection health.
- Review approval backlogs.
- Pause or disable workflows.
- Inspect execution costs.
- Manage version rollbacks.
- Investigate incidents.

These capabilities should remain separate from the beginner-facing builder experience.

---

# 8. SECURITY, COMPLIANCE & NETWORK ARCHITECTURE

## 8.1 Customer-controlled infrastructure

Preserve Netzar's customer-owned AWS deployment philosophy.

The customer retains control of:

- Infrastructure.
- Business data.
- Credentials.
- Approved models.
- Agent permissions.
- Workflow permissions.
- Storage.
- Audit records.

Netzar must not require centralized vendor custody of customer business data.

## 8.2 Identity and authorization

Support role-based and, where required, context-aware controls for:

- Employees.
- Workflow authors.
- Agent administrators.
- Organization administrators.
- Approvers.
- Auditors.
- Restricted support operators.

Permissions must be enforced server-side, not only by hiding UI controls.

## 8.3 AI safety and execution boundaries

- Models may propose actions but cannot bypass the action executor.
- Tool permissions must be explicit.
- Sensitive data access is authorization-scoped.
- Prompt injection is treated as untrusted input.
- Team delegation must be bounded.
- Consequential actions require applicable approval.
- Custom Python/TypeScript actions run in restricted environments.
- Generated workflow definitions are validated before execution.
- External model routing must honor approved data boundaries.

## 8.4 Compliance

The platform should support regulated workloads through suitable controls, but no compliance certification is assumed.

Relevant obligations must be identified from the actual customer, use case, data classification, contracts, and applicable regulations.

AWS deployment alone is not evidence of HIPAA, SOC 2, or other certification.

---

# 9. DEPLOYMENT LIFECYCLE & CI/CD PIPELINE

## 9.1 Modernization strategy

The Netzar transformation must be incremental and evidence-driven.

**Do not rebuild from zero unless an architectural assessment demonstrates that retaining the current foundation creates greater risk or cost.**

The migration must preserve:

- Existing users and permissions.
- Approved agent configurations.
- Knowledge and source data.
- Relevant conversations and artifacts.
- Security controls.
- Audit records.
- Existing operational capabilities.
- In-flight workflow state where applicable.

## 9.2 Implementation phases

### Phase 0 — Architecture and product inventory

Identify existing working capabilities, migration risks, incompatible decisions, and proposed target boundaries.

Deliver a reuse/extend/replace decision matrix.

Audit Paperclip responsibilities, state, integrations, audit history, and cutover dependencies. Verify current shared, default, and agent-specific knowledge behavior and create regression fixtures for S3, Titan, and S3 Vectors retrieval before changing those paths.

### Phase 1 — Conversational Workflow Studio

Build the simplest functional experience:

- Describe a workflow.
- Generate a valid draft.
- Select an existing agent.
- Preview the steps.
- Test with sample data.
- Display understandable results.

No unintended live external actions.

### Phase 2 — Durable Execution Foundation

Add:

- Published workflow versions.
- Durable execution.
- Retry and recovery.
- Human approvals.
- External effect safety.
- Execution monitoring.
- Business outcome contracts and evidence correlation.
- The Netzar-owned authoritative state required to replace Paperclip.

Complete the controlled Paperclip migration only after the replacement acceptance criteria pass.

### Phase 3 — Agent Studio and Unified Memory

Extend existing agents with conversational creation, versioned configuration, evaluations, and permission-aware memory. Preserve and prove shared, default, and agent-specific knowledge uploads on S3, Titan, and S3 Vectors.

### Phase 4 — AI Team Builder

Create teams from reusable agents and make those teams available as workflow steps.

### Phase 5 — Visual Workflow Builder

Add graphical editing, node configuration, conditions, branches, parallel execution, and synchronized conversational editing.

### Phase 6 — Developer Studio and Integrations

Add approved custom-code actions, advanced connector development, typed SDK capabilities, and deep execution debugging.

### Phase 7 — Outcome, Governance, and Continuous QA

Add verified business outcomes, normalized cross-platform policy enforcement where supported, capability-boundary labels, business regression suites, canaries, drift monitoring, and safe fix review.

### Phase 8 — Opt-In Discovery

Add consent-controlled process discovery, evidence-backed automation recommendations, transparent ROI ranges, and user correction and deletion controls.

### Phase 9 — Industry Outcome Packs and Commercial Validation

Package and validate selected industry outcomes using the same underlying platform. Initial candidates include insurance, supply chain, finance, restaurants, dental practices, contractors, and logistics, but launch packs must be chosen from validated demand and supported integrations.

Conduct beginner usability studies, security tests, recovery tests, and customer acceptance testing.

## 9.3 Release controls

Before shipping a release:

- Run affected unit and integration tests.
- Validate the full application build.
- Review security-sensitive changes.
- Verify workflow contracts.
- Run mode-consistency tests.
- Test permission enforcement.
- Test retry and idempotency behavior.
- Document schema migration.
- Validate deployment and rollback.
- Record unresolved risks.

Migration of any existing production workflow engine requires a documented cutover and recovery plan.

---

# 10. USER JOURNEYS & ACCEPTANCE CRITERIA

## Journey A — First-time user builds a workflow

**Scenario**

A 67-year-old insurance professional wants new insurance policies reviewed automatically.

### User experience

1. Opens Netzar.
2. Clicks "Build a Workflow."
3. Describes the process in plain English.
4. Netzar proposes five understandable steps.
5. User selects an existing Insurance Agent.
6. Netzar explains which connection or documents are needed.
7. User reviews the process.
8. User tests it with a sample document.
9. Netzar explains the test result.
10. User requests any corrections.
11. Authorized activation is offered after validation.

### Acceptance criteria

**AC-001:** The user can reach the builder without navigating developer settings.

**AC-002:** The user can generate a valid draft without writing code.

**AC-003:** The user can identify the workflow trigger and intended result.

**AC-004:** The user can select an existing agent.

**AC-005:** The user can test the workflow without unintentionally executing a live external action.

**AC-006:** The system communicates missing configuration clearly.

**AC-007:** The user can revise the workflow conversationally.

---

## Journey B — User builds an agent

**Scenario**

"Create an agent who is an expert in commercial insurance policies."

### Acceptance criteria

**AC-008:** Netzar proposes a usable agent draft.

**AC-009:** The user can inspect the agent's expertise and limitations.

**AC-010:** Suggested tools do not receive automatic permission.

**AC-011:** The agent can be tested before publication.

**AC-012:** The published agent can be used in chat and in a workflow.

---

## Journey C — User builds an AI team

**Scenario**

"Build a team of agents for vendor risk management."

### Acceptance criteria

**AC-013:** Netzar proposes specialized, nonredundant team roles.

**AC-014:** Existing agents can be reused.

**AC-015:** Team member permissions remain enforced.

**AC-016:** Collaboration can be tested with sample work.

**AC-017:** The team can be selected as part of a workflow.

---

## Journey D — User switches builder modes

**Scenario**

A user creates a workflow conversationally, then opens the visual builder and eventually Developer Studio.

### Acceptance criteria

**AC-018:** All modes reference the same draft/version.

**AC-019:** Supported edits remain consistent across modes.

**AC-020:** No workflow step silently disappears during conversion.

**AC-021:** Unsupported advanced constructs are represented clearly instead of being discarded.

**AC-022:** Published executions use the approved immutable version.

---

## Journey E — Workflow handles a real business process

**Scenario**

A finance workflow detects a discrepancy and requests approval.

### Acceptance criteria

**AC-023:** The workflow retains its state while awaiting approval.

**AC-024:** The user sees the exact proposed action.

**AC-025:** Only the authorized approver can release the action.

**AC-026:** A repeated trigger or retry does not duplicate the resulting business write.

**AC-027:** The action and decision can be traced after completion.

---

# 11. RISKS, ASSUMPTIONS & OPEN DECISIONS

## 11.1 Core product decisions

| ID | Decision | Status |
|---|---|---|
| DEC-001 | Build Netzar as a unified AI agent and workflow platform | User-stated direction |
| DEC-002 | Keep and improve the existing Netzar foundation | User-stated preference |
| DEC-003 | Use Conversational, Visual, and Developer modes | User-stated requirement |
| DEC-004 | Reuse published agents and teams in workflows | User-stated requirement |
| DEC-005 | Optimize for users with minimal technical experience | User-stated requirement |
| DEC-006 | Preserve customer-controlled AWS infrastructure | User-stated direction |
| DEC-007 | Own the workflow product rather than depending permanently on competing workflow builders | User-stated direction |
| DEC-008 | Evaluate LangChain/LangGraph internally | Proposed |
| DEC-009 | Evaluate Step Functions or another durable workflow runtime | Proposed |
| DEC-010 | Preserve existing shared, default, and agent-specific knowledge uploads on S3, S3 Vectors, and Titan unless measured testing proves a specific deficiency | Nonnegotiable product requirement |
| DEC-011 | Support advanced isolated Python actions | Proposed |
| DEC-012 | Replace Paperclip with Netzar-native authoritative workflow execution through controlled, verified migration | Nonnegotiable product requirement; superseding architecture decision required |
| DEC-013 | Separate technical execution success from verified business outcome success | Nonnegotiable product requirement |
| DEC-014 | Claim cross-platform governance only at enforceable or explicitly labeled observable boundaries | Nonnegotiable product requirement |
| DEC-015 | Make automation discovery opt-in and prohibit hidden employee surveillance or scoring | Nonnegotiable product requirement |
| DEC-016 | Require continuous business-oriented QA for production workflows | Nonnegotiable product requirement |
| DEC-017 | Package industry value as versioned outcome packs on the common Netzar engine | User-stated direction |

## 11.2 Open technical questions

**Q-001:** Which durable execution engine best supports customer-authored workflows without excessive operational complexity?

**Q-002:** What existing Paperclip business state or deployment dependencies must be migrated?

**Q-003:** Can the current frontend support the desired visual builder without a major framework migration?

**Q-004:** Which connector capabilities are required for the first commercial workflows?

**Q-005:** How should external OAuth connections and existing credentials migrate safely?

**Q-006:** Which specific customers and workloads define the initial performance and compliance requirements?

**Q-007:** What sandbox model is required for approved Python and TypeScript actions?

These do not prevent this PRD from defining the product vision. They must be resolved before the affected architectural components are implemented.

## 11.3 Principal risks

| Risk | Mitigation |
|---|---|
| Rewriting useful code unnecessarily | Evidence-based component inventory |
| Building competing execution engines | Select one durable execution authority |
| Overwhelming users | Beginner testing and progressive disclosure |
| Agent hallucination causes invalid workflows | Typed definitions and deterministic validation |
| Duplicate external actions | Idempotency and reconciliation |
| Sensitive information leaks across memory scopes | Fine-grained authorization and provenance |
| Imported API keys are exposed | Secure storage and brokered access |
| Custom Python code is unsafe | Isolation, approval, and resource restrictions |
| Migration disrupts existing installations | Staged migration and rollback validation |
| Product lacks a compelling commercial wedge | Validate real customer use cases and willingness to pay |
| A task succeeds but the business outcome fails | Separate execution and outcome state; require evidence contracts |
| Automated recovery duplicates a business action | Reconcile uncertain effects before retry and require action-level idempotency |
| Governance claims exceed technical control | Publish per-integration enforce/approve/observe/no-visibility manifests |
| Discovery becomes employee surveillance | Default off, minimize data, prohibit employee ranking, audit consent and deletion |
| Workflows decay as systems and models change | Risk-based continuous tests, canaries, drift measures, and release gates |
| Industry packs become brittle forks | Compile packs to common contracts and preserve customer-derived versions |

---

# 12. DEFINITION OF DONE & PRODUCT END STATE

Netzar is successful when a business user with minimal technical experience can describe a complex process, understand the resulting automation, test it, and activate it safely without relying on a software engineer.

Consider this end-state example:

"Build me an AI team that reviews commercial insurance policies. Have one agent extract the important information, another identify potential coverage gaps, and a third prepare a professional client report. Send the final report to me for approval, and then save it in our customer folder."

Netzar must be capable of:

1. Understanding the objective.
2. Discovering existing suitable agents.
3. Creating missing agent drafts when needed.
4. Proposing a reusable AI team.
5. Creating a typed workflow.
6. Identifying the necessary documents and integrations.
7. Explaining every step in plain language.
8. Displaying the workflow visually.
9. Allowing a developer to inspect advanced configuration.
10. Testing the workflow safely.
11. Showing missing permissions and connections.
12. Applying human approval requirements.
13. Executing approved actions reliably.
14. Preventing duplicate external operations.
15. Preserving execution and memory state.
16. Producing professional deliverables.
17. Explaining results and failures.
18. Recording the necessary audit evidence.
19. Verifying whether the intended business outcome occurred.
20. Separating verified value from estimated value.
21. Recovering safely without duplicating consequential actions.
22. Enforcing common policy at every supported execution boundary and labeling unsupported boundaries honestly.
23. Discovering automation opportunities only after explicit opt-in and showing transparent ROI assumptions.
24. Continuously testing business behavior as workflows, models, APIs, and policies change.
25. Installing versioned industry outcome packs without forking the core platform.
26. Operating the full workflow lifecycle without Paperclip.
27. Preserving authorized shared, default, and agent-specific knowledge retrieval on the existing S3, Titan, and S3 Vectors foundation.

The user must not need to understand the underlying programming languages, model APIs, database architecture, workflow engine, or cloud infrastructure to achieve this.

**Netzar should make sophisticated automation feel as natural as explaining a task to a capable colleague.**

---

# PRD IMPLEMENTATION BOUNDARY

**Document readiness:** Consolidated build-ready product requirements; named technical decisions still require implementation design and approval.

The user experience, key functional capabilities, and architectural constraints are defined.

The precise lower-level execution runtime, detailed Paperclip migration runbook, production performance targets, and initial commercial integration requirements require implementation validation. These open implementation choices do not make Paperclip replacement or knowledge preservation optional.

**First recommended product deliverable:** An end-to-end Conversational Workflow Studio prototype that reuses an existing Netzar agent, generates one valid workflow draft, displays an understandable preview, and executes a safe sample-data test.

Do not begin by rewriting the entire application.

Do not begin by building a generic automation node catalog.

Begin by proving the central product promise:

**A person with no coding knowledge can describe a business process and turn it into a correct, understandable, testable workflow.**

Once that works, build the advanced capabilities around the same canonical workflow system.

---

# FINAL PRODUCT PRINCIPLE

**Netzar is not an AI chatbot with an automation feature.**

**Netzar is not a workflow canvas with AI added afterward.**

**Netzar is an AI-native business operating platform where conversations, agents, teams, organizational memory, and workflows work together as one coherent system.**

**Make the interface exceptionally simple. Make the underlying engineering exceptionally dependable. Preserve what already works. Build only what creates real value.**
