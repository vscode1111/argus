import { createContext } from 'react';

// Whether a single newline in the conversation's Markdown renders as a line break.
// Set per provider (ProviderDescriptor.hardLineBreaks): Codex writes one statement per
// line, which CommonMark folds into a single paragraph. A view never mixes providers,
// because switching provider starts a fresh session entry.
export const MarkdownBreaksContext = createContext(false);
