/* SPIKE: bundle-attribution entry — the composer textarea alone. */
import { useState } from 'react';
import { TextareaAutosize } from '@librechat/client';

export default function SpikeComposerOnly() {
  const [text, setText] = useState('');
  return (
    <TextareaAutosize
      aria-label="Message input"
      value={text}
      onChange={(e) => setText((e.target as HTMLTextAreaElement).value)}
    />
  );
}
