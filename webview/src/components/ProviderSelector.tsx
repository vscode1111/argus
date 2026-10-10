import React, { useEffect, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import { useWebviewMessage } from '../hooks/useWebviewMessage';
import type { ProviderDescriptor } from '../../../src/shared/provider';
import { ProviderIcon } from './shared/ProviderIcon';
import styles from './ProviderSelector.module.css';

export function ProviderSelector({ providerId }: { providerId: string }) {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useWebviewMessage(e => {
    if (e.data?.type === 'providers' && Array.isArray(e.data.providers)) setProviders(e.data.providers);
  }, () => postMessage({ type: 'getProviders' }));
  useEffect(() => {
    if (!open) return;
    const options = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    (Array.from(options ?? []).find(option => option.getAttribute('aria-selected') === 'true') ?? options?.[0])?.focus();
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [open]);
  const choices = providers.length ? providers : [{ id: providerId, label: providerId }];
  const selected = choices.find(provider => provider.id === providerId);
  const moveFocus = (direction: number) => {
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    options[(index + direction + options.length) % options.length]?.focus();
  };
  return <div className={styles.row}>
    <div className={styles.pickerRow}>
      <span>Provider</span>
      <div className={styles.selectWrap} ref={pickerRef} onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}>
        <button
          type="button"
          ref={triggerRef}
          className={styles.trigger}
          aria-label="Provider"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
          }}
        >
          <ProviderIcon providerId={providerId} />
          <span>{selected?.label ?? providerId}</span>
          <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true"><path d="m2 4 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        {open && <div
          ref={menuRef}
          className={styles.menu}
          role="listbox"
          aria-label="Providers"
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveFocus(e.key === 'ArrowDown' ? 1 : -1); }
          }}
        >
          {choices.map(provider => <button
            key={provider.id}
            type="button"
            role="option"
            aria-selected={provider.id === providerId}
            className={styles.option}
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
              if (provider.id !== providerId) postMessage({ type: 'switchProvider', providerId: provider.id });
            }}
          >
            <ProviderIcon providerId={provider.id} />
            <span>{provider.label}</span>
          </button>)}
        </div>}
      </div>
    </div>
    <span className={styles.hint}>Switching provider opens a new conversation. Your selection is saved for future conversations.</span>
  </div>;
}
