import { useCallback, useRef, useState } from 'react';

/**
 * Copy-to-clipboard with transient "copied" feedback. `copied` holds the key of
 * the last copied item (so a component with several copy buttons can show the
 * checkmark on the right one) and resets after `timeout` ms.
 */
export function useCopyFeedback(timeout = 1500) {
  const [copied, setCopied] = useState<string | false>(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback((text: string, key = 'default') => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), timeout);
    });
  }, [timeout]);

  return { copied, copy };
}
