import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { parseAllDocuments, isAlias, isMap, isSeq, type Node } from 'yaml';
import { scanText } from '../../ci/secret-scan.mjs';
import {
  agentDefinitionSchema, configSchemaSchema, connectorsSchema, packManifestSchema,
  policiesSchema, uiSchema, type AgentDefinition, type ConfigSchema,
  type Connectors, type PackManifest, type Policies, type PackUi,
} from '../../../src/lib/packs/schema.js';

export type PackFinding = { code: string; file: string; pointer?: string; message: string };
type Routine = { title: string; description?: string; concurrencyPolicy?: string; [key: string]: unknown };
type Stage = { key: string; config?: Record<string, unknown>; [key: string]: unknown };
type Pipeline = { key: string; stages: Stage[]; transitions?: Array<{ fromStageKey: string; toStageKey: string }> };

function yamlUnsafe(node: Node | null | undefined): boolean {
  if (!node) return false;
  if (isAlias(node) || node.anchor || node.tag?.startsWith('!')) return true;
  if (isMap(node)) return node.items.some((item) => yamlUnsafe(item.key as Node) || yamlUnsafe(item.value as Node));
  if (isSeq(node)) return node.items.some((item) => yamlUnsafe(item as Node));
  return false;
}

function allFiles(dir: string, root = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not pack files');
    if (entry.isDirectory()) files.push(...allFiles(path, root));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
  }
  return files;
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
}

function readAgent(dir: string, file: string): unknown {
  const docs = parseAllDocuments(readFileSync(join(dir, file), 'utf8'), { uniqueKeys: true });
  if (docs.length !== 1 || docs[0]!.errors.length || yamlUnsafe(docs[0]!.contents)) throw new Error('Invalid agent YAML');
  return docs[0]!.toJS();
}

function resourcePaths(pack: PackManifest): string[] {
  const r = pack.resources;
  return [r.bundle, ...r.pipelines, ...r.routines.map((x) => x.path), ...r.skills,
    r.connectors, r.policies, r.ui, pack.requires.config,
    ...pack.agents.map((x) => x.definition), ...[r.studioLayout, pack.checksums].filter((x): x is string => !!x)];
}

function validPath(dir: string, file: string): boolean {
  if (isAbsolute(file) || file.includes('\\') || file.split('/').includes('..') || !file) return false;
  const path = join(dir, file);
  if (!existsSync(path)) return false;
  const root = realpathSync(dir);
  const target = realpathSync(path);
  return target === root || target.startsWith(root + sep);
}

function bodyShape(value: unknown, kind: 'routine' | 'pipeline'): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (kind === 'routine') return typeof v.title === 'string' && !!v.title;
  return typeof v.key === 'string' && Array.isArray(v.stages) && v.stages.length > 0
    && v.stages.every((s) => !!s && typeof s === 'object' && typeof (s as Stage).key === 'string')
    && (v.transitions === undefined || (Array.isArray(v.transitions) && v.transitions.every((t) =>
      !!t && typeof t.fromStageKey === 'string' && typeof t.toStageKey === 'string')));
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

function identifiers(text: string, denylist: string[]): boolean {
  if (/(^|\D)\d{12}(?!\d)/m.test(text)) return true;
  if (denylist.some((x) => x && text.toLowerCase().includes(x.toLowerCase()))) return true;
  const allowed = (host: string) => ['example.com', 'example.org', 'example.net', 'localhost'].includes(host)
    || /\.(?:example\.com|example\.org|example\.net|example|test|invalid)$/.test(host)
    || /^(?:example|test|invalid)$/.test(host);
  for (const match of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) if (!allowed(match[1]!.toLowerCase())) return true;
  for (const match of text.matchAll(/https?:\/\/([^\s/:'"<>]+)/gi)) if (!allowed(match[1]!.toLowerCase())) return true;
  return false;
}

function scanFiles(dir: string, files: string[], denylist: string[], findings: PackFinding[], invalid = new Set<string>()): void {
  for (const file of files) {
    if (invalid.has(file)) continue;
    try {
      const bytes = readFileSync(join(dir, file));
      if (bytes.subarray(0, 8192).includes(0)) continue;
      const body = bytes.toString('utf8');
      if (scanText(body, file).length) findings.push({ code: 'PV-SECRET', file, message: 'Secret-like value found' });
      else if (identifiers(body, denylist)) findings.push({ code: 'PV-IDENTIFIER', file, message: 'Customer identifier found' });
    } catch {
      findings.push({ code: 'PV-SCHEMA', file, message: 'Cannot read file' });
    }
  }
}

function readPackFiles(dir: string, pack: PackManifest, findings: PackFinding[], invalid: Set<string>) {
  const add = (file: string, message: string) => { findings.push({ code: 'PV-SCHEMA', file, message }); invalid.add(file); };
  const parse = <T>(file: string, schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, yaml = false): T | undefined => {
    try {
      const result = schema.safeParse(yaml ? readAgent(dir, file) : readJson(dir, file));
      if (result.success) return result.data;
    } catch { /* reported below */ }
    add(file, 'Invalid file shape or syntax');
    return undefined;
  };
  const config = parse<ConfigSchema>(pack.requires.config, configSchemaSchema);
  const connectors = parse<Connectors>(pack.resources.connectors, connectorsSchema);
  const policies = parse<Policies>(pack.resources.policies, policiesSchema);
  const ui = parse<PackUi>(pack.resources.ui, uiSchema);
  const agents = new Map<string, AgentDefinition>();
  for (const a of pack.agents) {
    const agent = parse<AgentDefinition>(a.definition, agentDefinitionSchema, true);
    if (agent && agent.tools === undefined) add(a.definition, 'Pack agent needs tools');
    else if (agent) agents.set(a.role, agent);
  }
  const routines = new Map<string, Routine>();
  const pipelines = new Map<string, Pipeline>();
  for (const r of pack.resources.routines) {
    try { const body = readJson(dir, r.path); if (!bodyShape(body, 'routine')) throw new Error(); routines.set(r.path, body as Routine); }
    catch { add(r.path, 'Invalid routine body'); }
  }
  for (const file of pack.resources.pipelines) {
    try { const body = readJson(dir, file); if (!bodyShape(body, 'pipeline')) throw new Error(); pipelines.set(file, body as Pipeline); }
    catch { add(file, 'Invalid pipeline body'); }
  }
  if (pack.resources.studioLayout) {
    try { const body = readJson(dir, pack.resources.studioLayout); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
    catch { add(pack.resources.studioLayout, 'Invalid Studio layout'); }
  }
  return { config, connectors, policies, ui, agents, routines, pipelines };
}

export function validatePack(dir: string, opts: { denylist?: string[] } = {}): PackFinding[] {
  const findings: PackFinding[] = [];
  const invalid = new Set<string>();
  const add = (code: string, file: string, message: string) => findings.push({ code, file, message });
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error('Not a directory');
    const files = allFiles(dir);
    const manifest = packManifestSchema.safeParse(readJson(dir, 'pack.json'));
    if (!manifest.success) {
      add('PV-SCHEMA', 'pack.json', 'Invalid pack manifest');
      scanFiles(dir, files, opts.denylist ?? [], findings, new Set(['pack.json']));
      return findings;
    }
    const pack = manifest.data;
    for (const file of resourcePaths(pack)) if (!validPath(dir, file)) add('PV-SCHEMA', 'pack.json', 'Invalid resource path');
    if (findings.length) {
      scanFiles(dir, files, opts.denylist ?? [], findings, new Set(['pack.json']));
      return findings;
    }
    const { config, connectors, policies, ui, agents, routines, pipelines } = readPackFiles(dir, pack, findings, invalid);
    if (findings.length) {
      scanFiles(dir, files, opts.denylist ?? [], findings, invalid);
      return findings;
    }
    checkRefs(pack, config!, connectors!, policies!, ui!, agents, pipelines, add);
    checkBodies(pack, config!, policies!, routines, pipelines, add);
    scanFiles(dir, files, opts.denylist ?? [], findings);
  } catch {
    add('PV-SCHEMA', 'pack.json', 'Pack directory cannot be read');
  }
  return findings;
}

type Add = (code: string, file: string, message: string) => void;
function checkRefs(pack: PackManifest, config: ConfigSchema, connectors: Connectors, policies: Policies,
  ui: PackUi, agents: Map<string, AgentDefinition>, pipelines: Map<string, Pipeline>, add: Add): void {
  const roles = new Set(pack.agents.map((a) => a.role));
  const keys = new Set([...pipelines.values()].map((p) => p.key));
  const aliases = new Set(Object.values(connectors.capabilities).flatMap((c) => Object.keys(c.aliases)));
  const allowedTools = new Set(Object.values(pack.requires.permissions.tools).flat());
  for (const a of pack.agents) {
    const agent = agents.get(a.role)!;
    if (agent.id !== a.role) add('PV-REF', a.definition, 'Agent role differs from its id');
    for (const skill of agent.skills ?? []) if (!pack.resources.skills.includes(skill)) add('PV-REF', a.definition, 'Unknown skill');
    for (const tool of agent.tools ?? []) if (!aliases.has(tool) && !allowedTools.has(tool)) add('PV-REF', a.definition, 'Unknown tool');
  }
  for (const role of Object.keys(pack.requires.permissions.tools)) if (!roles.has(role)) add('PV-REF', 'pack.json', 'Unknown permission role');
  for (const capability of pack.requires.connectors) if (!(capability in connectors.capabilities)) add('PV-REF', 'pack.json', 'Unknown capability');
  for (const [name, field] of Object.entries(config.properties)) {
    if (field.type === 'secretRef' && !pack.requires.secrets.some((s) => s.name === field.secret)) add('PV-REF', pack.requires.config, `Unknown secret for ${name}`);
    if (field.type === 'connectorRef' && !(field.capability! in connectors.capabilities)) add('PV-REF', pack.requires.config, `Unknown capability for ${name}`);
  }
  for (const tool of Object.keys(policies.toolRisk)) if (!aliases.has(tool) && !allowedTools.has(tool)) add('PV-REF', pack.resources.policies, 'Unknown tool risk target');
  for (const gate of policies.approvalGates) {
    if (!keys.has(gate.pipeline)) add('PV-REF', pack.resources.policies, 'Unknown gate pipeline');
    else if (![...pipelines.values()].some((p) => p.key === gate.pipeline && p.stages.some((s) => s.key === gate.stage))) add('PV-REF', pack.resources.policies, 'Unknown gate stage');
  }
  for (const key of Object.keys(ui.pipelines)) if (!keys.has(key)) add('PV-REF', pack.resources.ui, 'Unknown UI pipeline');
  for (const key of keys) if (!(key in ui.pipelines)) add('PV-REF', pack.resources.ui, 'Missing UI pipeline');
  for (const r of pack.resources.routines) if (!keys.has(r.pipeline)) add('PV-REF', 'pack.json', 'Unknown routine pipeline');
  for (const [file, p] of pipelines) for (const t of p.transitions ?? []) {
    if (!p.stages.some((s) => s.key === t.fromStageKey) || !p.stages.some((s) => s.key === t.toStageKey)) add('PV-REF', file, 'Unknown transition stage');
  }
}

function checkBodies(pack: PackManifest, config: ConfigSchema, policies: Policies,
  routines: Map<string, Routine>, pipelines: Map<string, Pipeline>, add: Add): void {
  const roles = new Set(pack.agents.map((a) => a.role));
  const routineKeys = new Set(pack.resources.routines.map((r) => basename(r.path, '.json')));
  const checkPlaceholders = (file: string, body: unknown) => {
    for (const value of stringsIn(body)) for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
      const token = match[1]!;
      if ((token.startsWith('config.') && token.slice(7) in config.properties)
        || (token.startsWith('agent:') && roles.has(token.slice(6)))
        || (token.startsWith('routine:') && routineKeys.has(token.slice(8)))) continue;
      add('PV-PLACEHOLDER', file, 'Unknown placeholder');
    }
  };
  for (const [file, body] of routines) checkPlaceholders(file, body);
  for (const [file, body] of pipelines) checkPlaceholders(file, body);
  for (const r of pack.resources.routines) if (r.kind === 'ingest' && routines.get(r.path)?.concurrencyPolicy !== 'always_enqueue') add('PV-ENQUEUE', r.path, 'Ingest routine must always enqueue');
  for (const [file, p] of pipelines) if (!pack.resources.routines.some((r) => r.kind === 'ingest' && r.pipeline === p.key)) add('PV-ENQUEUE', file, 'Pipeline needs an ingest routine');
  const gated = new Set<string>();
  for (const gate of policies.approvalGates) {
    const stage = [...pipelines.values()].find((p) => p.key === gate.pipeline)?.stages.find((s) => s.key === gate.stage);
    for (const value of stringsIn(stage)) for (const match of value.matchAll(/\$\{config\.([^}]+)\}/g)) gated.add(match[1]!);
  }
  for (const [name, field] of Object.entries(config.properties)) if (field.customerEditable
    && (field.controlsApproval || gated.has(name) || field.type === 'secretRef' || field.type === 'connectorRef')) add('PV-GATE', pack.requires.config, 'Approval or reference field is customer editable');
  const classes = new Set(pack.decisionClasses.map((c) => c.id));
  const used = new Set(policies.approvalGates.map((g) => g.decisionClass));
  for (const c of pack.decisionClasses) {
    if (c.impact === 'high' && c.default !== 'human_required') add('PV-DECISION', 'pack.json', 'High impact class must require a human');
    if (!used.has(c.id)) add('PV-DECISION', 'pack.json', 'Unused decision class');
  }
  for (const c of used) if (!classes.has(c)) add('PV-DECISION', pack.resources.policies, 'Undeclared decision class');
}
