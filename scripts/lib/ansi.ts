/**
 * Minimal ANSI helpers. No chalk dependency.
 */

const useColor = process.stdout.isTTY && process.env.NO_COLOR == null;

const wrap = (open: string, close: string) =>
  (text: string): string => (useColor ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export const bold = wrap('1', '22');
export const dim = wrap('2', '22');
export const red = wrap('31', '39');
export const green = wrap('32', '39');
export const yellow = wrap('33', '39');
export const blue = wrap('34', '39');
export const magenta = wrap('35', '39');
export const cyan = wrap('36', '39');
export const gray = wrap('90', '39');

export const ok = (msg: string): string => `${green('✓')}  ${msg}`;
export const warn = (msg: string): string => `${yellow('⚠')}  ${msg}`;
export const fail = (msg: string): string => `${red('✗')}  ${msg}`;
export const info = (msg: string): string => `${cyan('→')}  ${msg}`;

export const section = (title: string): void => {
  // eslint-disable-next-line no-console
  console.log('\n' + bold(title));
  // eslint-disable-next-line no-console
  console.log(gray('─'.repeat(Math.max(title.length, 32))));
};
