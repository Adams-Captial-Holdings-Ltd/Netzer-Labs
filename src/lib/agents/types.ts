export type AgentStatus = 'active' | 'inactive' | 'creating' | 'error';

export interface AgentMetadata {
  agentId: string;
  displayName: string;
  description: string;
  model: string;
  template?: string;
  status: AgentStatus;
  /**
   * Named vector corpus this agent searches by default. The vector-search
   * tool queries this scope plus the always-shared "shared" scope. Defaults
   * to "default" when unset (backward compatible with pre-scope agents).
   */
  knowledgeScope?: string;
  telegramBotToken?: string;
  telegramBotUsername?: string;
  telegramBotId?: number;
  slackBotToken?: string;
  slackSigningSecret?: string;
  slackAppId?: string;
  slackBotUsername?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface CreateAgentOpts {
  id: string;
  name: string;
  description: string;
  model?: string;
  template?: string;
  createdBy?: string;
}

export interface AgentMetadataRedacted extends Omit<AgentMetadata, 'telegramBotToken' | 'slackBotToken' | 'slackSigningSecret'> {
  telegramConnected: boolean;
  slackConnected: boolean;
}

export function redactAgent(a: AgentMetadata): AgentMetadataRedacted {
  const { telegramBotToken, slackBotToken, slackSigningSecret, ...rest } = a;
  return {
    ...rest,
    telegramConnected: Boolean(telegramBotToken),
    slackConnected: Boolean(slackBotToken),
  };
}
