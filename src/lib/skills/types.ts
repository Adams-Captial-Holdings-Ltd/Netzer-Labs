export interface SkillManifest {
  skillId: string;
  name: string;
  description: string;
  lambdaArn: string;
  inputSchema: Record<string, unknown>;
  idempotency: 'platform-managed';
  enabled: boolean;
}

export interface SkillInvocation {
  toolInvocationId: string;
  skillId: string;
  input: Record<string, unknown>;
  agentId: string;
  chatId: string;
}

export interface SkillResult {
  text: string;
  isError: boolean;
  cached: boolean;
}
