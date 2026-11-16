import type { SessionState } from '../sessionState';
import type { ProviderInteraction } from '../../shared/provider';
import { object, array, string } from './rpc';

export function questionDefinitions(input: unknown): NonNullable<ProviderInteraction['questions']> {
  let raw = object(input).questions;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
  return array(raw).map((value, index) => {
    const q = object(value), options = array(q.options).map(object);
    return { id: String(index), question: string(q.question), options: options.map(o => string(o.label)),
      optionDescriptions: options.map(o => string(o.description)), multiSelect: q.multiSelect === true };
  });
}

export function showClaudeQuestion(s: SessionState): void {
  const id = s.pendingAskTools.values().next().value as string | undefined;
  if (s.interaction?.id === id || !id && !s.interaction) return;
  s.interaction = id ? { id, sourceToolId: id, kind: 'question', title: 'Your input is needed',
    questions: questionDefinitions(s.toolMap.get(id)?.input).map(q => ({ ...q, id: `${id}:${q.id}` })) } : null;
  s.broadcast(JSON.stringify({ type: 'interaction', request: s.interaction }));
}

export function resolveClaudeQuestion(s: SessionState, id: string, reason: 'answered' | 'cancelled' | 'superseded' | 'provider-resolved'): void {
  s.pendingAskTools.delete(id);
  s.broadcast(JSON.stringify({ type: 'interaction_resolved', id, reason }));
  showClaudeQuestion(s);
}

export function clearClaudeQuestions(s: SessionState, reason: 'cancelled' | 'superseded' | 'provider-resolved', finalizeTools = true): void {
  for (const id of [...s.pendingAskTools]) {
    if (finalizeTools) {
      const tool = s.toolMap.get(id);
      s.broadcast(JSON.stringify({ type: 'tool_end', call: { id, name: tool?.name ?? 'AskUserQuestion', input: tool?.input ?? {}, result: JSON.stringify({ cancelled: true }) } }));
    }
    resolveClaudeQuestion(s, id, reason);
  }
}

export function nativeQuestionAnswers(s: SessionState, id: string, value: unknown): Record<string, string> {
  if (!s.pendingAskTools.has(id)) throw new Error('This request is no longer pending');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid question response');
  const response = object(value);
  if (response.cancelled === true) {
    if (Object.keys(response).length !== 1) throw new Error('Invalid question response');
    return {};
  }
  const definitions = questionDefinitions(s.toolMap.get(id)?.input);
  const flatAnswer = typeof response.answers === 'string' && definitions.some(q => q.question === 'answers');
  const normalized = response.answers !== undefined && !flatAnswer;
  if (normalized && (!response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers))) throw new Error('Invalid question response');
  const answers = normalized ? object(response.answers) : response;
  const known = new Set(definitions.map((q, index) => normalized ? `${id}:${index}` : q.question));
  if (Object.keys(answers).some(key => !known.has(key))) throw new Error('Unknown question');
  if (!normalized && Object.keys(answers).length === 0) return {};
  const result: Record<string, string> = {};
  for (const [index, q] of definitions.entries()) {
    const answer = answers[normalized ? `${id}:${index}` : q.question];
    if (typeof answer === 'string' && answer.trim()) result[q.question] = answer;
    else if (q.multiSelect && Array.isArray(answer) && answer.length && answer.every(a => typeof a === 'string' && a.trim())) result[q.question] = answer.join(', ');
    else throw new Error('Answer every question');
  }
  return result;
}
