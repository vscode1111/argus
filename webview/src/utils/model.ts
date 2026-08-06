// Shared model picker helpers for AccountUsageModal and InputArea.

export interface ModelEntry {
  id: string;
  displayName: string;
  description?: string;
}

type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku';

// Family-based fallback wording (mirrors the CLI's own substring classifier), used
// when the server sends no description - e.g. an older daemon build. Kept in sync
// with FAMILY_DESCRIPTIONS in src/backend/modelData.ts (no shared imports across
// the webview/backend tsconfig boundary, same as plural()).
const FAMILY_DESCRIPTIONS: Record<ModelFamily, string> = {
  fable: 'Most capable for your hardest and longest-running tasks',
  opus: 'Best for everyday, complex tasks',
  sonnet: 'Efficient for routine tasks',
  haiku: 'Fastest for quick answers',
};

const FAMILIES = Object.keys(FAMILY_DESCRIPTIONS) as ModelFamily[];

export function describeModel(id: string, serverDescription?: string): string | undefined {
  if (serverDescription) return serverDescription;
  const t = id.toLowerCase();
  const family = FAMILIES.find(f => t.includes(f));
  return family ? FAMILY_DESCRIPTIONS[family] : undefined;
}

// A trailing snapshot date, e.g. claude-haiku-4-5-20251001.
const DATE_SUFFIX_RE = /-20\d{6}$/;

// The active-model check ignores a snapshot date suffix on either side, so a dated
// API id still highlights when the stored model is the dateless alias (and vice versa).
export function sameModel(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  return a.replace(DATE_SUFFIX_RE, '') === b.replace(DATE_SUFFIX_RE, '');
}

// Shown while the model fetch is in flight or has failed with no server-side cache.
export const FALLBACK_MODELS: ModelEntry[] = [
  { id: 'claude-haiku-4-5',  displayName: 'Claude Haiku 4.5',  description: FAMILY_DESCRIPTIONS.haiku  },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', description: FAMILY_DESCRIPTIONS.sonnet },
  { id: 'claude-opus-4-8',   displayName: 'Claude Opus 4.8',   description: FAMILY_DESCRIPTIONS.opus   },
];

// Built at render time so runtimeDefaultModel can be injected into the description.
// The value auto-refreshes daily via the daemon (manually: yarn update-models).
export function makeDefaultEntry(runtimeModel: string): ModelEntry {
  return {
    id: '',
    displayName: 'Default (CLI)',
    description: runtimeModel ? `Currently ${runtimeModel}` : 'Defers to the Claude CLI default',
  };
}

// Maps a raw modelList payload entry, preferring the server-resolved description.
export function toModelEntry(m: { id: string; displayName: string; description?: string }): ModelEntry {
  return { id: m.id, displayName: m.displayName, description: describeModel(m.id, m.description) };
}
