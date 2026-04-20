export const ENCODINGS = [
  { label: 'Original', value: '' },
  { label: 'CP866 (DOS Cyrillic)', value: 'ibm866' },
  { label: 'Windows-1251', value: 'windows-1251' },
  { label: 'KOI8-R', value: 'koi8-r' },
  { label: 'ISO-8859-1 (Latin-1)', value: 'iso-8859-1' },
  { label: 'Windows-1252', value: 'windows-1252' },
  { label: 'Shift_JIS', value: 'shift_jis' },
  { label: 'GBK (Chinese)', value: 'gbk' },
];

export function tryDecode(text: string, encoding: string): string {
  if (!encoding) return text;
  try {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i) & 0xff;
    }
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return text;
  }
}
