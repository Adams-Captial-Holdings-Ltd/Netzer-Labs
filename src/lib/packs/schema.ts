import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9-]+$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const path = z.string().min(1);
const strings = z.array(z.string());

export const agentDefinitionSchema = z.object({
  id: slug, name: z.string().min(1), description: z.string(), model: z.string().min(1),
  persona: z.string().min(1), tools: strings.optional(), skills: strings.optional(),
  knowledgeScope: z.string().optional(),
}).strict();
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

const configField = z.object({
  type: z.enum(['string', 'number', 'boolean', 'enum', 'secretRef', 'connectorRef']),
  title: z.string().optional(), description: z.string().optional(), default: z.unknown().optional(),
  enum: strings.optional(), secret: z.string().optional(), capability: z.string().optional(),
  customerEditable: z.boolean().default(false), controlsApproval: z.boolean().default(false),
}).strict().superRefine((field, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (field.type === 'enum' && (!field.enum?.length || (field.default !== undefined && !field.enum.includes(field.default as string)))) bad('Invalid enum or default');
  if (field.type === 'string' && field.default !== undefined && typeof field.default !== 'string') bad('Invalid string default');
  if (field.type === 'number' && field.default !== undefined && typeof field.default !== 'number') bad('Invalid number default');
  if (field.type === 'boolean' && field.default !== undefined && typeof field.default !== 'boolean') bad('Invalid boolean default');
  if (field.type === 'secretRef' && (!field.secret || field.default !== undefined)) bad('Invalid secret reference');
  if (field.type === 'connectorRef' && (!field.capability || field.default !== undefined)) bad('Invalid connector reference');
});

export const configSchemaSchema = z.object({
  type: z.literal('object'), properties: z.record(configField), required: strings.default([]),
}).strict().superRefine((config, ctx) => {
  for (const name of config.required) if (!(name in config.properties)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['required'], message: 'Unknown required field' });
  }
});
export type ConfigSchema = z.infer<typeof configSchemaSchema>;

export const connectorsSchema = z.object({ capabilities: z.record(z.object({
  description: z.string(), mandatory: z.boolean(), scopes: strings,
  aliases: z.record(z.object({ defaultTool: z.string() }).strict()),
}).strict()) }).strict();
export type Connectors = z.infer<typeof connectorsSchema>;

export const policiesSchema = z.object({
  toolRisk: z.record(z.enum(['low', 'medium', 'high'])),
  approvalGates: z.array(z.object({ pipeline: z.string(), stage: z.string(), decisionClass: z.string() }).strict()),
}).strict();
export type Policies = z.infer<typeof policiesSchema>;

export const uiSchema = z.object({ pipelines: z.record(z.object({
  keyFields: z.array(z.object({ field: z.string(), label: z.string() }).strict()),
}).strict()) }).strict();
export type PackUi = z.infer<typeof uiSchema>;

const routineResource = z.object({ path, kind: z.enum(['ingest', 'timer']), pipeline: z.string() }).strict();
export const packManifestSchema = z.object({
  packFormat: z.literal(1), id: slug, name: z.string().min(1), version: semver,
  description: z.string(), industry: z.string(),
  compatibility: z.object({
    netzer: z.object({ min: z.string() }).strict(),
    paperclip: z.object({ min: z.string(), tested: strings }).strict(),
  }).strict(),
  resources: z.object({
    bundle: path, pipelines: z.array(path).min(1), routines: z.array(routineResource).default([]),
    skills: z.array(path).default([]), connectors: path, policies: path, ui: path,
    studioLayout: path.optional(),
  }).strict(),
  agents: z.array(z.object({ role: slug, definition: path, mappable: z.boolean() }).strict()).min(1),
  requires: z.object({
    connectors: strings, permissions: z.object({ capabilities: strings, tools: z.record(strings) }).strict(),
    config: path, secrets: z.array(z.object({ name: z.string(), store: z.enum(['secrets-manager', 'agentcore-identity']) }).strict()),
  }).strict(),
  decisionClasses: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]*$/), impact: z.enum(['high', 'standard']), default: z.enum(['human_required', 'automated_allowed']) }).strict()),
  dataClasses: strings, supportOwner: z.string(), checksums: path.optional(),
}).strict();
export type PackManifest = z.infer<typeof packManifestSchema>;
