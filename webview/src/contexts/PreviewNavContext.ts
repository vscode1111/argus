import { createContext, useContext } from 'react';

/**
 * Set by FileViewerModal so markdown rendered inside the preview can navigate to
 * a sibling document instead of rendering an inert link. Null everywhere else
 * (chat messages keep their existing linkified-path behaviour).
 */
export const PreviewNavContext = createContext<((href: string) => void) | null>(null);

export function usePreviewNav() {
  return useContext(PreviewNavContext);
}
