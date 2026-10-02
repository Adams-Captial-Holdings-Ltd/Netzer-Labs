export function scanText(text: string, file: string, denylist?: string[]): Array<{ file: string; line: number; id: string; excerpt: string }>;
export function parseDenylist(text: string): string[];
