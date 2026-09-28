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
  efforts: string[];
  inputKinds: string[];
}

export interface ProviderInteraction {
  id: string;
  title: string;
  detail?: string;
  kind: 'approval' | 'question';
  options?: string[];
  questions?: Array<{ id: string; question: string; options: string[] }>;
}
