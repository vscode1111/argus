import { readConfig } from './config';

// Single builder for the `workspaceInfo` reply to `getInfo`, shared by both responders:
// the WS server (session.ts) and the extension host (ChatPanel.ts, where getInfo is
// VS_ONLY-routed and never reaches the server). model/effort/thinking are config-global
// and must be read fresh from argus.json on every reply - when the two responders built
// the message independently, the extension's copy lacked these fields and a reloaded
// webview fell back to "Default (CLI)"/high while the daemon spawned the configured model.
export function buildWorkspaceInfo(path: string, version: string, fallbackModel = '') {
  const cfg = readConfig();
  return {
    type: 'workspaceInfo' as const,
    path,
    version,
    model: cfg.model || fallbackModel,
    effort: cfg.effort,
    thinking: cfg.thinking,
  };
}
