// The browser consumes descriptors, never provider-specific protocol objects.
export interface ProviderSelection {
  providerId: string;
  model: string;
  effort: string;
  thinking: boolean;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  description?: string;
  efforts?: string[];
  inputKinds?: string[];
  isDefault?: boolean;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  thinkingToggle: boolean;
  /** Render a single newline in this provider's replies as a line break. Codex writes
   *  one statement per line with no blank line between them, which CommonMark folds
   *  into one paragraph. Optional so an older daemon's descriptors still parse. */
  hardLineBreaks?: boolean;
  efforts: string[];
  inputKinds: string[];
}

export interface ProviderInteraction {
  id: string;
  title: string;
  detail?: string;
  kind: 'approval' | 'question';
  async?: boolean;
  options?: string[];
  questions?: Array<{ id: string; question: string; options: string[] }>;
}
