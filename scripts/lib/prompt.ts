/**
 * Readline-based prompt helpers and inline spinner.
 */

import { createInterface, type Interface } from 'node:readline';
import { dim, gray } from './ansi.js';

let rl: Interface | null = null;

function rli(): Interface {
  if (rl) return rl;
  rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` ${dim(`[${defaultValue}]`)}` : '';
  return new Promise((resolve) => {
    rli().question(`${question}${hint} `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

export async function confirm(question: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = await ask(`${question} ${dim(`[${hint}]`)}`);
  if (!answer) return defaultValue;
  return /^y(es)?$/i.test(answer);
}

export function closePrompt(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/**
 * Inline spinner. Returns a `stop(finalMessage?)` function. The spinner
 * frame is rewritten on the same TTY line so it doesn't pollute logs.
 */
export function spinner(message: string): (final?: string) => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let stopped = false;
  const isTty = process.stdout.isTTY;
  if (!isTty) {
    // eslint-disable-next-line no-console
    console.log(`${gray('…')} ${message}`);
  }
  const tick = (): void => {
    if (stopped || !isTty) return;
    process.stdout.write(`\r${frames[i % frames.length]} ${message}`);
    i++;
  };
  const handle = isTty ? setInterval(tick, 80) : null;
  tick();
  return (final?: string): void => {
    stopped = true;
    if (handle) clearInterval(handle);
    if (isTty) process.stdout.write('\r\x1b[K');
    if (final) {
      // eslint-disable-next-line no-console
      console.log(final);
    }
  };
}
