// Static catalog of tool integrations reachable through AWS. Tiles deep-link
// to the AWS console in a new tab; the actual connection is configured there,
// so nothing here touches our backend or stores credentials.
//
// The provider list below is GROUND TRUTH, not docs marketing: it mirrors the
// "Integrations" target-type provider dropdown in the AgentCore create-gateway
// wizard, read from the live console (us-east-1, 2026-06-10). If AWS adds
// providers, re-check that dropdown and extend this list.
import amazon from '../assets/integrations/amazon.svg';
import asana from '../assets/integrations/asana.svg';
import brave from '../assets/integrations/brave.svg';
import canva from '../assets/integrations/canva.svg';
import coinbase from '../assets/integrations/coinbase.svg';
import confluence from '../assets/integrations/confluence.svg';
import hubspot from '../assets/integrations/hubspot.svg';
import jira from '../assets/integrations/jira.svg';
import linear from '../assets/integrations/linear.svg';
import microsoft from '../assets/integrations/microsoft.svg';
import notion from '../assets/integrations/notion.svg';
import pagerduty from '../assets/integrations/pagerduty.svg';
import salesforce from '../assets/integrations/salesforce.svg';
import servicenow from '../assets/integrations/servicenow.svg';
import slack from '../assets/integrations/slack.svg';
import smartsheet from '../assets/integrations/smartsheet.svg';
import tavily from '../assets/integrations/tavily.svg';
import zapier from '../assets/integrations/zapier.svg';
import zendesk from '../assets/integrations/zendesk.svg';
import zoom from '../assets/integrations/zoom.svg';

// us-east-1 is pinned deliberately: the prod stack lives there and the gateway
// must be created in the same region the agents run in. Path-based console
// URLs survive the signed-in region redirect; "#/fragment" URLs do NOT (the
// redirect drops the fragment and strands the user on the AgentCore Overview).
const AGENTCORE_BASE = 'https://us-east-1.console.aws.amazon.com/bedrock-agentcore';
export const GATEWAYS_CONSOLE_URL = `${AGENTCORE_BASE}/toolsAndGateways?region=us-east-1`;
export const GATEWAY_WIZARD_URL = `${AGENTCORE_BASE}/toolsAndGateways/createwizard?region=us-east-1`;
export const QUICK_SUITE_URL = 'https://quick.aws.com';
export const MARKETPLACE_MCP_URL = 'https://aws.amazon.com/marketplace/search/results?searchTerms=MCP+server';

export interface CatalogTool {
  id: string;
  name: string;
  description: string;
  /** Bundled brand mark; tools without a clean vector asset render a monogram chip. */
  logo?: string;
  href: string;
}

/**
 * Integration providers offered by the AgentCore create-gateway wizard
 * (target type "Integrations"). Every tile lands in that wizard: pick the
 * provider, attach its OAuth client, and the vendor's API becomes MCP tools
 * agents can call. Tokens live in AWS's token vault, not in this product.
 */
export const GATEWAY_TOOLS: CatalogTool[] = [
  { id: 'slack', name: 'Slack', description: 'Post messages and read channels from agents.', logo: slack, href: GATEWAY_WIZARD_URL },
  { id: 'salesforce', name: 'Salesforce', description: 'CRM records, leads, and cases as agent tools.', logo: salesforce, href: GATEWAY_WIZARD_URL },
  { id: 'jira', name: 'Jira', description: 'Create and triage issues from agent workflows.', logo: jira, href: GATEWAY_WIZARD_URL },
  { id: 'confluence', name: 'Confluence', description: 'Search and update pages and spaces.', logo: confluence, href: GATEWAY_WIZARD_URL },
  { id: 'asana', name: 'Asana', description: 'Let agents create and update tasks and projects.', logo: asana, href: GATEWAY_WIZARD_URL },
  { id: 'zendesk', name: 'Zendesk', description: 'Tickets and support workflows, agent-driven.', logo: zendesk, href: GATEWAY_WIZARD_URL },
  { id: 'microsoft', name: 'Microsoft', description: 'Microsoft 365 data via Graph as agent tools.', logo: microsoft, href: GATEWAY_WIZARD_URL },
  { id: 'servicenow', name: 'ServiceNow', description: 'ITSM incidents and requests from agents.', logo: servicenow, href: GATEWAY_WIZARD_URL },
  { id: 'pagerduty', name: 'PagerDuty', description: 'Incidents and on-call as agent tools.', logo: pagerduty, href: GATEWAY_WIZARD_URL },
  { id: 'zoom', name: 'Zoom', description: 'Meetings and recordings as agent tools.', logo: zoom, href: GATEWAY_WIZARD_URL },
  { id: 'smartsheet', name: 'Smartsheet', description: 'Sheets and project plans as agent tools.', logo: smartsheet, href: GATEWAY_WIZARD_URL },
  { id: 'bamboohr', name: 'BambooHR', description: 'HR records and time-off as agent tools.', href: GATEWAY_WIZARD_URL },
  { id: 'tavily', name: 'Tavily', description: 'AI-grade web search and extraction for agents.', logo: tavily, href: GATEWAY_WIZARD_URL },
  { id: 'brave', name: 'Brave', description: 'Private web search for agents.', logo: brave, href: GATEWAY_WIZARD_URL },
  { id: 'amazon', name: 'Amazon', description: 'Amazon services as pre-configured agent tools.', logo: amazon, href: GATEWAY_WIZARD_URL },
  { id: 'coinbase', name: 'Coinbase x402 Bazaar', description: 'Agent-to-agent payments via x402.', logo: coinbase, href: GATEWAY_WIZARD_URL },
];

/**
 * Shown as small marks on the single informational Quick Suite card. Those
 * connectors live inside Amazon Quick Suite (a separate AWS product with its
 * own sign-up), so they deliberately do NOT get connect-style tiles.
 */
export const QUICK_SUITE_SAMPLE_LOGOS: { name: string; logo: string }[] = [
  { name: 'Notion', logo: notion },
  { name: 'Linear', logo: linear },
  { name: 'HubSpot', logo: hubspot },
  { name: 'Zapier', logo: zapier },
  { name: 'Canva', logo: canva },
];

export const QUICK_SUITE_EXTRA_COUNT = 9;
