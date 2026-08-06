import { describe, it, expect } from 'vitest';
import {
  TranscribeUnsupportedFormatError,
  transcribeAudio,
} from './transcriber.js';

describe('transcribeAudio format guard', () => {
  it('throws TranscribeUnsupportedFormatError for unknown MIME', async () => {
    await expect(
      transcribeAudio({
        s3Uri: 's3://bucket/key.bin',
        mimeType: 'application/octet-stream' as never,
      }),
    ).rejects.toBeInstanceOf(TranscribeUnsupportedFormatError);
  });

  it('throws TranscribeUnsupportedFormatError when mimeType missing', async () => {
    await expect(
      transcribeAudio({ s3Uri: 's3://bucket/key.bin' }),
    ).rejects.toBeInstanceOf(TranscribeUnsupportedFormatError);
  });
});
