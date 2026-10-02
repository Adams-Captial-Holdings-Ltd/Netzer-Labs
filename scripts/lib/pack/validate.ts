import { lstatSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, sep } from 'node:path';
import { inspectDirectory, stringsIn } from './text-scan.js';
import {
  agentDefinitionSchema, configSchemaSchema, connectorsSchema, packManifestSchema,
  policiesSchema, uiSchema, type AgentDefinition, type ConfigSchema,
  type Connectors, type PackManifest, type Policies, type PackUi,
} from '../../../src/lib/packs/schema.js';

export type PackFinding = { code: string; file: string; pointer?: string; message: string };
type Routine = { title: string; concurrencyPolicy?: string; [key: string]: unknown };
type Stage = { key: string; [key: string]: unknown };
type Pipeline = {
  key: string;
  stages: Stage[];
  transitions?: Array<{ fromStageKey: string; toStageKey: string }>;
  [key: string]: unknown;
};
type Add = (code: string, file: string, message: string, pointer?: string) => void;
function resourcePaths(pack: PackManifest): string[] {
  const r = pack.resources;
  return [r.bundle, ...r.pipelines, ...r.routines.map((item) => item.path), ...r.skills,
    r.connectors, r.policies, r.ui, ...[r.studioLayout].filter((item): item is string => !!item)];
}

function checkResourcePaths(dir: string, pack: PackManifest, add: Add): void {
  const seen = new Set<string>();
  const resources = resourcePaths(pack);
  const otherPaths = [pack.requires.config, ...pack.agents.map((item) => item.definition), pack.checksums]
    .filter((item): item is string => !!item);
  for (const [index, file] of [...resources, ...otherPaths].entries()) {
    if (index < resources.length) {
      if (seen.has(file)) add('PV-SCHEMA', 'pack.json', `Duplicate resource path ${file}`);
      seen.add(file);
    }
    try {
      if (!file || isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) throw new Error();
      const root = realpathSync(dir);
      const target = realpathSync(join(dir, file));
      if (!target.startsWith(root + sep)) throw new Error();
      const stat = lstatSync(join(dir, file));
      const wrongType = file === pack.resources.bundle ? !stat.isDirectory() : !stat.isFile();
      if (stat.isSymbolicLink() || wrongType) throw new Error();
    } catch { add('PV-SCHEMA', 'pack.json', `Invalid resource path ${file}`); }
  }
}

type Shape<T> = { safeParse: (value: unknown) => {
  success: boolean; data?: T; error?: { issues: Array<{ path: PropertyKey[] }> };
} };

function parseShape<T>(file: string, schema: Shape<T>,
  parsed: Map<string, unknown>, add: Add, invalid: Set<string>): T | undefined {
  if (invalid.has(file)) return undefined;
  const result = schema.safeParse(parsed.get(file));
  if (result.success) return result.data;
  const pointer = result.error?.issues[0]?.path.map(String).join('.');
  add('PV-SCHEMA', file, 'Invalid file shape', pointer);
  invalid.add(file);
  return undefined;
}

function bodyShape(value: unknown, kind: 'routine' | 'pipeline'): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (kind === 'routine') return typeof body.title === 'string' && !!body.title;
  if (typeof body.key !== 'string' || !Array.isArray(body.stages) || !body.stages.length) return false;
  if (!body.stages.every((stage) => stage && typeof stage === 'object' && typeof stage.key === 'string')) return false;
  return body.transitions === undefined || (Array.isArray(body.transitions) && body.transitions.every((t) =>
    t && typeof t.fromStageKey === 'string' && typeof t.toStageKey === 'string'));
}

function uniqueNames(pack: PackManifest, pipelines: Map<string, Pipeline>, add: Add): void {
  const check = (items: string[], file: string, label: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item)) add('PV-SCHEMA', file, `Duplicate ${label} ${item}`);
      seen.add(item);
    }
  };
  check(pack.agents.map((a) => a.role), 'pack.json', 'agent role');
  check(pack.decisionClasses.map((c) => c.id), 'pack.json', 'decision class');
  check(pack.resources.routines.map((r) => basename(r.path, '.json')), 'pack.json', 'routine name');
  check([...pipelines.values()].map((p) => p.key), 'pack.json', 'pipeline key');
  for (const [file, pipeline] of pipelines) check(pipeline.stages.map((stage) => stage.key), file, 'stage key');
}

function readBodies(pack: PackManifest, parsed: Map<string, unknown>, invalid: Set<string>, add: Add) {
  const routines = new Map<string, Routine>();
  const pipelines = new Map<string, Pipeline>();
  for (const routine of pack.resources.routines) {
    const value = parsed.get(routine.path);
    if (invalid.has(routine.path)) continue;
    if (bodyShape(value, 'routine')) routines.set(routine.path, value as Routine);
    else { add('PV-SCHEMA', routine.path, 'Invalid routine body'); invalid.add(routine.path); }
  }
  for (const file of pack.resources.pipelines) {
    const value = parsed.get(file);
    if (invalid.has(file)) continue;
    if (bodyShape(value, 'pipeline')) pipelines.set(file, value as Pipeline);
    else { add('PV-SCHEMA', file, 'Invalid pipeline body'); invalid.add(file); }
  }
  if (pack.resources.studioLayout && !invalid.has(pack.resources.studioLayout)) {
    const layout = parsed.get(pack.resources.studioLayout);
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
      add('PV-SCHEMA', pack.resources.studioLayout, 'Invalid Studio layout');
      invalid.add(pack.resources.studioLayout);
    }
  }
  return { routines, pipelines };
}

export function validatePack(dir: string, opts: { denylist?: string[] } = {}): PackFinding[] {
  const findings: PackFinding[] = [];
  const add: Add = (code, file, message, pointer) => {
    findings.push({ code, file, message, ...(pointer === undefined ? {} : { pointer }) });
  };
  try { if (!lstatSync(dir).isDirectory()) throw new Error(); }
  catch { return [{ code: 'PV-SCHEMA', file: 'pack.json', message: 'Pack directory cannot be read' }]; }
  let inspected: ReturnType<typeof inspectDirectory>;
  try { inspected = inspectDirectory(dir, add, opts.denylist ?? []); }
  catch { return [...findings, { code: 'PV-SCHEMA', file: 'pack.json', message: 'Pack directory cannot be read' }]; }
  const { parsed, scans, invalid } = inspected;
  try {
    const pack = parseShape('pack.json', packManifestSchema, parsed, add, invalid);
    if (pack) {
      checkResourcePaths(dir, pack, add);
      const config = parseShape(pack.requires.config, configSchemaSchema, parsed, add, invalid);
      const connectors = parseShape(pack.resources.connectors, connectorsSchema, parsed, add, invalid);
      const policies = parseShape(pack.resources.policies, policiesSchema, parsed, add, invalid);
      const ui = parseShape(pack.resources.ui, uiSchema, parsed, add, invalid);
      const agents = new Map<string, AgentDefinition>();
      for (const agent of pack.agents) {
        const value = parseShape(agent.definition, agentDefinitionSchema, parsed, add, invalid);
        if (value && value.tools === undefined) {
          add('PV-SCHEMA', agent.definition, 'Pack agent needs tools');
          invalid.add(agent.definition);
        }
        else if (value) agents.set(agent.role, value);
      }
      const { routines, pipelines } = readBodies(pack, parsed, invalid, add);
      uniqueNames(pack, pipelines, add);
      if (!findings.some((f) => f.code === 'PV-SCHEMA') && config && connectors && policies && ui) {
        checkRefs(pack, config, connectors, policies, ui, agents, pipelines, add);
        checkBodies(pack, config, policies, routines, pipelines, add);
      }
    }
  } catch { add('PV-SCHEMA', 'pack.json', 'Internal validator error'); }
  const seen = new Set<string>();
  for (const finding of scans) {
    const key = `${finding.code}\0${finding.file}`;
    if (!invalid.has(finding.file) && !seen.has(key)) { findings.push(finding); seen.add(key); }
  }
  return findings;
}

function checkAgentRefs(pack: PackManifest, agents: Map<string, AgentDefinition>,
  aliases: Set<string>, add: Add): void {
  for (const a of pack.agents) {
    const agent = agents.get(a.role);
    if (!agent) continue;
    if (agent.id !== a.role) add('PV-REF', a.definition, `Agent role ${a.role} differs from id ${agent.id}`);
    for (const skill of agent.skills ?? []) {
      if (!pack.resources.skills.includes(skill)) add('PV-REF', a.definition, `Unknown skill ${skill}`);
    }
    const ownTools = new Set(Object.hasOwn(pack.requires.permissions.tools, a.role)
      ? pack.requires.permissions.tools[a.role] : []);
    for (const tool of agent.tools ?? []) {
      if (!aliases.has(tool) && !ownTools.has(tool)) add('PV-REF', a.definition, `Unknown tool ${tool}`);
    }
  }
}

function checkRefs(pack: PackManifest, config: ConfigSchema, connectors: Connectors, policies: Policies,
  ui: PackUi, agents: Map<string, AgentDefinition>, pipelines: Map<string, Pipeline>, add: Add): void {
  const roles = new Set(pack.agents.map((a) => a.role));
  const keys = new Set([...pipelines.values()].map((p) => p.key));
  const aliases = new Set(Object.values(connectors.capabilities).flatMap((c) => Object.keys(c.aliases)));
  const allowedTools = new Set(Object.values(pack.requires.permissions.tools).flat());
  checkAgentRefs(pack, agents, aliases, add);
  for (const role of Object.keys(pack.requires.permissions.tools)) {
    if (!roles.has(role)) add('PV-REF', 'pack.json', `Unknown permission role ${role}`);
  }
  for (const capability of pack.requires.connectors) {
    if (!Object.hasOwn(connectors.capabilities, capability)) {
      add('PV-REF', 'pack.json', `Unknown capability ${capability}`);
    }
  }
  for (const [name, field] of Object.entries(config.properties)) {
    if (field.type === 'secretRef' && !pack.requires.secrets.some((s) => s.name === field.secret)) {
      add('PV-REF', pack.requires.config, `Unknown secret for ${name}`);
    }
    if (field.type === 'connectorRef'
      && (!field.capability || !Object.hasOwn(connectors.capabilities, field.capability))) {
      add('PV-REF', pack.requires.config, `Unknown capability for ${name}`);
    }
  }
  for (const tool of Object.keys(policies.toolRisk)) {
    if (!aliases.has(tool) && !allowedTools.has(tool)) {
      add('PV-REF', pack.resources.policies, `Unknown tool risk target ${tool}`);
    }
  }
  for (const gate of policies.approvalGates) {
    if (!keys.has(gate.pipeline)) add('PV-REF', pack.resources.policies, `Unknown gate pipeline ${gate.pipeline}`);
    else if (![...pipelines.values()].some((p) =>
      p.key === gate.pipeline && p.stages.some((s) => s.key === gate.stage))) {
      add('PV-REF', pack.resources.policies, `Unknown gate stage ${gate.stage}`);
    }
  }
  for (const key of Object.keys(ui.pipelines)) {
    if (!keys.has(key)) add('PV-REF', pack.resources.ui, `Unknown UI pipeline ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(ui.pipelines, key)) add('PV-REF', pack.resources.ui, `Missing UI pipeline ${key}`);
  }
  for (const r of pack.resources.routines) {
    if (!keys.has(r.pipeline)) add('PV-REF', 'pack.json', `Unknown routine pipeline ${r.pipeline}`);
  }
  for (const [file, p] of pipelines) for (const t of p.transitions ?? []) {
    if (!p.stages.some((s) => s.key === t.fromStageKey)) {
      add('PV-REF', file, `Unknown transition stage ${t.fromStageKey}`);
    }
    if (!p.stages.some((s) => s.key === t.toStageKey)) {
      add('PV-REF', file, `Unknown transition stage ${t.toStageKey}`);
    }
  }
}

function placeholderTokens(body: unknown): string[] {
  return stringsIn(body).flatMap((value) => [...value.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1] ?? ''));
}

function checkBodies(pack: PackManifest, config: ConfigSchema, policies: Policies,
  routines: Map<string, Routine>, pipelines: Map<string, Pipeline>, add: Add): void {
  const roles = new Set(pack.agents.map((a) => a.role));
  const routineKeys = new Set(pack.resources.routines.map((r) => basename(r.path, '.json')));
  const checkPlaceholders = (file: string, body: unknown) => {
    for (const token of placeholderTokens(body)) {
      if ((token.startsWith('config.') && Object.hasOwn(config.properties, token.slice(7)))
        || (token.startsWith('agent:') && roles.has(token.slice(6)))
        || (token.startsWith('routine:') && routineKeys.has(token.slice(8)))) continue;
      add('PV-PLACEHOLDER', file, `Unknown placeholder ${token}`);
    }
  };
  for (const [file, body] of routines) checkPlaceholders(file, body);
  for (const [file, body] of pipelines) checkPlaceholders(file, body);
  for (const r of pack.resources.routines) {
    if (r.kind === 'ingest' && routines.get(r.path)?.concurrencyPolicy !== 'always_enqueue') {
      add('PV-ENQUEUE', r.path, `Ingest routine ${basename(r.path)} must always enqueue`);
    }
  }
  for (const [file, p] of pipelines) {
    if (!pack.resources.routines.some((r) => r.kind === 'ingest' && r.pipeline === p.key)) {
      add('PV-ENQUEUE', file, `Pipeline ${p.key} needs an ingest routine`);
    }
  }
  checkGateFields(pack, config, policies, routines, pipelines, add);
  checkDecisions(pack, policies, add);
}

function checkGateFields(pack: PackManifest, config: ConfigSchema, policies: Policies,
  routines: Map<string, Routine>, pipelines: Map<string, Pipeline>, add: Add): void {
  const gated = new Set<string>();
  for (const gate of policies.approvalGates) {
    const pipeline = [...pipelines.values()].find((p) => p.key === gate.pipeline);
    if (!pipeline) continue;
    const stage = pipeline.stages.find((s) => s.key === gate.stage);
    const level = Object.fromEntries(Object.entries(pipeline).filter(([key]) => key !== 'stages'));
    for (const token of [...placeholderTokens(stage), ...placeholderTokens(level)]) {
      if (token.startsWith('config.')) gated.add(token.slice(7));
    }
    for (const token of placeholderTokens(stage)) {
      if (token.startsWith('routine:')) {
        const routine = pack.resources.routines.find((r) => basename(r.path, '.json') === token.slice(8));
        for (const nested of placeholderTokens(routine && routines.get(routine.path))) {
          if (nested.startsWith('config.')) gated.add(nested.slice(7));
        }
      }
    }
  }
  for (const [name, field] of Object.entries(config.properties)) {
    if (field.customerEditable && (field.controlsApproval || gated.has(name)
      || field.type === 'secretRef' || field.type === 'connectorRef')) {
      add('PV-GATE', pack.requires.config, `Approval or reference field ${name} is customer editable`, name);
    }
  }
}

function checkDecisions(pack: PackManifest, policies: Policies, add: Add): void {
  const classes = new Set(pack.decisionClasses.map((c) => c.id));
  const used = new Set(policies.approvalGates.map((g) => g.decisionClass));
  for (const c of pack.decisionClasses) {
    if (c.impact === 'high' && c.default !== 'human_required') {
      add('PV-DECISION', 'pack.json', `High impact class ${c.id} must require a human`);
    }
    if (!used.has(c.id)) add('PV-DECISION', 'pack.json', `Unused decision class ${c.id}`);
  }
  for (const c of used) {
    if (!classes.has(c)) add('PV-DECISION', pack.resources.policies, `Undeclared decision class ${c}`);
  }
}
