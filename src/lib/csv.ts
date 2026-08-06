const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function csvField(value: string): string {
  if (!value) return '';
  let v = value;
  if (FORMULA_PREFIXES.some((p) => v.startsWith(p))) {
    v = '\t' + v;
  }
  if (v.includes('"') || v.includes(',') || v.includes('\n') || v.includes('\r')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

export function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}

export function buildCsv(headers: string[], rows: string[][]): string {
  const lines = [csvRow(headers)];
  for (const row of rows) {
    lines.push(csvRow(row));
  }
  return lines.join('\n') + '\n';
}
