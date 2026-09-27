// DOM-free helpers for exporting chat conversations and code snippets.

import type { Message } from './types.js';

export function conversationMarkdown({
  title,
  agentName,
  messages,
}: {
  title: string;
  agentName: string;
  messages: Message[];
}): string {
  const sections = [`# ${title}`];
  for (const message of messages) {
    const speaker = message.role === 'user' ? 'You' : agentName;
    const lines = [`## ${speaker}`, '', message.text];
    if (message.failure) lines.push('', `Error: ${message.failure}`);
    const files = message.role === 'user'
      ? message.attachments?.map(({ name }) => name)
      : message.artifactRefs?.map(({ fileName }) => fileName);
    if (files?.length) lines.push('', ...files.map((name) => `File: ${name}`));
    if (message.role === 'assistant' && message.stopped) lines.push('', '(Stopped)');
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

export function exportFileName(title: string): string {
  const safe = title
    .replace(/[^A-Za-z0-9 ._-]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return safe ? `${safe}.md` : 'chat.md';
}

const CODE_EXTENSIONS: Record<string, string> = {
  ts: 'ts', typescript: 'ts', tsx: 'tsx', js: 'js', javascript: 'js', jsx: 'jsx',
  py: 'py', python: 'py', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  json: 'json', html: 'html', css: 'css', sql: 'sql', yaml: 'yaml', yml: 'yaml',
  md: 'md', markdown: 'md', go: 'go', rs: 'rs', rust: 'rs', java: 'java',
  rb: 'rb', ruby: 'rb', php: 'php', c: 'c', cpp: 'cpp', cs: 'cs', csharp: 'cs',
  swift: 'swift', kt: 'kt', kotlin: 'kt', xml: 'xml', toml: 'toml',
};

export function codeFileName(language: string): string {
  const extension = CODE_EXTENSIONS[(language ?? '').trim().toLowerCase()];
  return extension ? `snippet.${extension}` : 'snippet.txt';
}
