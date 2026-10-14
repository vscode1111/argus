export function isOrchestratorPrompt(text: string): boolean {
  return /^🤖(?:\s|$)/u.test(text) || /^[/$][^\s]+\s+🤖(?:\s|$)/u.test(text);
}
