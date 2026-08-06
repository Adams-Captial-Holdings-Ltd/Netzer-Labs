/**
 * MCP (Model Context Protocol) server config types.
 *
 * An "MCP server" here is any Streamable-HTTP MCP endpoint the orchestrator
 * can call tools on. The flagship case is an Amazon Bedrock AgentCore Gateway
 * (auth: 'iam' — SigV4 with the task role, no token plumbing), but the same
 * client speaks to any vendor-hosted remote MCP server (auth: 'bearer' or
 * 'none').
 */

export type McpAuthMode = 'iam' | 'bearer' | 'none';

export interface McpServerConfig {
  /** Stable id, lowercase [a-z0-9_-], used to namespace tool names. */
  id: string;
  /** Display name for the dashboard. */
  name: string;
  /** Streamable-HTTP MCP endpoint, e.g. https://<gw>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp */
  url: string;
  /** How requests are authenticated. 'iam' = SigV4 (AgentCore gateways). */
  auth: McpAuthMode;
  /** Bearer token when auth === 'bearer'. Stored in runtime-config (DDB, encrypted at rest). */
  bearerToken?: string;
  /** Master switch; disabled servers contribute no tools. */
  enabled: boolean;
  /** Agent ids that get this server's tools. Empty array = every agent. */
  agents: string[];
}

/** One tool as reported by the server's tools/list. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
