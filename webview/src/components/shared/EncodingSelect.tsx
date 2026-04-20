import React from 'react';
import { ENCODINGS } from '../../utils/encoding';
import styles from './encoding.module.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export function EncodingSelect({ value, onChange }: Props) {
  return (
    <select
      className={styles.encodingSelect}
      value={value}
      onChange={e => onChange(e.target.value)}
      title="Re-decode content with a different character encoding"
    >
      {ENCODINGS.map(enc => (
        <option key={enc.value} value={enc.value}>{enc.label}</option>
      ))}
    </select>
  );
}
