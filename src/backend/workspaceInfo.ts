import { readConfig } from './config';
import type { ProviderSelection } from '../shared/provider';

// The daemon supplies the conversation selection. The optional fallback keeps
// extension-only callers compatible before a conversation has connected.
export function buildWorkspaceInfo(path: string, version: string, fallbackModel = '', selection?: ProviderSelection) {
  const cfg = readConfig();
  return {
    type: 'workspaceInfo' as const,
    path,
    version,
    model: selection?.model ?? (cfg.model || fallbackModel),
    effort: selection?.effort ?? cfg.effort,
    thinking: selection?.thinking ?? cfg.thinking,
  };
}
