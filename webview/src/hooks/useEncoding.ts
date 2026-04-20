import { useState, useMemo } from 'react';
import { tryDecode } from '../utils/encoding';

export function useEncoding(text: string) {
  const [encoding, setEncoding] = useState('');
  const decoded = useMemo(() => tryDecode(text, encoding), [text, encoding]);
  return { encoding, setEncoding, decoded } as const;
}
