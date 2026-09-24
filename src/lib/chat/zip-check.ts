import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = {
  maxEntries: 1000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

export class ZipCheckError extends Error {
  constructor(public readonly code: 'not_zip' | 'too_many_entries' | 'entry_too_large' | 'too_large' | 'unsupported') {
    super(`ZIP check failed: ${code}`);
    this.name = 'ZipCheckError';
  }
}

export function checkZip(bytes: Uint8Array, limits: Partial<typeof ZIP_LIMITS> = {}): void {
  const { maxEntries, maxEntryBytes, maxTotalBytes } = { ...ZIP_LIMITS, ...limits };
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (code: ZipCheckError['code']): never => { throw new ZipCheckError(code); };
  const fits = (at: number, length: number): boolean =>
    Number.isSafeInteger(at) && at >= 0 && length >= 0 && at + length <= data.length;
  const checkExtra = (start: number, length: number): void => {
    let offset = start;
    while (offset < start + length) {
      if (!fits(offset, 4) || offset + 4 > start + length) fail('not_zip');
      const id = data.readUInt16LE(offset);
      const size = data.readUInt16LE(offset + 2);
      offset += 4 + size;
      if (offset > start + length) fail('not_zip');
      if (id === 0x0001) fail('unsupported');
    }
  };

  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65535); at--) {
    if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) {
      end = at;
      break;
    }
  }
  if (end < 0) fail('not_zip');
  if (data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0) fail('unsupported');
  const entries = data.readUInt16LE(end + 10);
  const directorySize = data.readUInt32LE(end + 12);
  const directoryAt = data.readUInt32LE(end + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) fail('unsupported');
  if (entries !== data.readUInt16LE(end + 8)) fail('not_zip');
  if (entries > maxEntries) fail('too_many_entries');
  if (!fits(directoryAt, directorySize) || directoryAt + directorySize > end) fail('not_zip');

  let at = directoryAt;
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (!fits(at, 46) || data.readUInt32LE(at) !== 0x02014b50) fail('not_zip');
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const declared = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const localAt = data.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (!fits(at, next - at) || next > directoryAt + directorySize) fail('not_zip');
    if (flags & 0x41 || method !== 0 && method !== 8 || compressed === 0xffffffff || declared === 0xffffffff || localAt === 0xffffffff || data.readUInt16LE(at + 34) !== 0) fail('unsupported');
    checkExtra(at + 46 + nameLength, extraLength);
    if (!fits(localAt, 30) || data.readUInt32LE(localAt) !== 0x04034b50) fail('not_zip');
    if (data.readUInt16LE(localAt + 6) & 0x41 || data.readUInt16LE(localAt + 8) !== method ||
      data.readUInt32LE(localAt + 18) === 0xffffffff || data.readUInt32LE(localAt + 22) === 0xffffffff) fail('unsupported');
    const localNameLength = data.readUInt16LE(localAt + 26);
    const localExtraLength = data.readUInt16LE(localAt + 28);
    if (!fits(localAt + 30, localNameLength + localExtraLength)) fail('not_zip');
    checkExtra(localAt + 30 + localNameLength, localExtraLength);
    const contentAt = localAt + 30 + localNameLength + localExtraLength;
    if (!fits(contentAt, compressed) || contentAt + compressed > directoryAt) fail('not_zip');
    const isDirectory = nameLength > 0 && data[at + 46 + nameLength - 1] === 0x2f;
    if (!isDirectory) {
      let length = 0;
      if (method === 0) {
        length = compressed;
      } else {
        const cap = Math.min(maxEntryBytes, maxTotalBytes - total) + 1;
        try {
          length = inflateRawSync(data.subarray(contentAt, contentAt + compressed), { maxOutputLength: Math.max(1, cap) }).length;
        } catch (err) {
          if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
            fail(maxEntryBytes <= maxTotalBytes - total ? 'entry_too_large' : 'too_large');
          }
          fail('not_zip');
        }
      }
      if (length > maxEntryBytes) fail('entry_too_large');
      total += length;
      if (total > maxTotalBytes) fail('too_large');
    }
    at = next;
  }
  if (at !== directoryAt + directorySize) fail('not_zip');
}
