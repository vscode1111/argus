import { useState, type FormEvent } from 'react';
import type { ProviderInteraction } from '../../../src/shared/provider';
import styles from './ToolCall.module.css';
import formStyles from './QuestionForm.module.css';
export type QuestionAnswers = Record<string, string | string[]>;
type Question = NonNullable<ProviderInteraction['questions']>[number] & { header?: string };
interface Props { questions: Question[]; disabled?: boolean; onSubmit(answers: QuestionAnswers): void; onCancel?(): void }
export function QuestionForm({ questions, disabled = false, onSubmit, onCancel }: Props) {
  const [tab, setTab] = useState(0), [answers, setAnswers] = useState(new Map<string,string[]>()), [custom, setCustom] = useState(new Map<string,string>());
  const complete = questions.length > 0 && questions.every(q => answers.get(q.id)?.length && (!answers.get(q.id)!.includes('Other') || custom.get(q.id)?.trim()));
  function submit(event: FormEvent) {
    event.preventDefault(); if (!complete || disabled) return;
    const result: QuestionAnswers = Object.create(null);
    for (const q of questions) { const values = answers.get(q.id)!.map(v => v === 'Other' ? custom.get(q.id)!.trim() : v); result[q.id] = q.multiSelect ? values : values[0]; }
    onSubmit(result);
  }
  const q = questions[tab] ?? questions[0];
  return <form className={`${styles.askDialog} ${formStyles.form}`} onSubmit={submit} aria-label="Questions">
    <div className={styles.askTabBar}>{questions.map((q, index) => <button key={q.id} type="button" className={[styles.askTab,tab === index && styles.askTabActive].filter(Boolean).join(' ')} aria-pressed={tab === index} onClick={() => setTab(index)}>{q.header || `Question ${index + 1}`}</button>)}{onCancel && <button type="button" className={styles.askCloseBtn} onClick={onCancel} aria-label="Cancel">×</button>}</div>
    {q && <fieldset className={styles.askTabContent} disabled={disabled}><legend className={styles.questionText}>{q.question}</legend>
      <div className={styles.questionOptions}>{[...q.options.filter(o => o !== 'Other'), 'Other'].map(option => {
        const selected = answers.get(q.id)?.includes(option) ?? false;
        return <label key={option} className={[styles.questionOption, styles.questionOptionClickable, selected && styles.questionOptionSelected].filter(Boolean).join(' ')}>
          <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`answer-${q.id}`} checked={selected} aria-label={option} onChange={() => setAnswers(current => new Map(current).set(q.id,q.multiSelect ? selected ? (current.get(q.id) ?? []).filter(v => v !== option) : [...current.get(q.id) ?? [],option] : [option]))} />
          <span><span className={styles.questionOptionLabel}>{option}</span>{q.optionDescriptions?.[q.options.indexOf(option)] && <span className={styles.questionOptionDesc}>{q.optionDescriptions[q.options.indexOf(option)]}</span>}</span>
        </label>;
      })}</div>
      {(answers.get(q.id)?.includes('Other') || !q.options.length) && <input className={styles.otherInput} aria-label="Other answer" placeholder="Type your answer..." value={custom.get(q.id) ?? ''} onChange={e => { setCustom(c => new Map(c).set(q.id,e.target.value)); if (!q.options.length) setAnswers(a=>new Map(a).set(q.id,['Other'])); }} />}
    </fieldset>}
    <div className={styles.askFooter}><button className={styles.askSubmitBtn} type="submit" disabled={!complete || disabled}>Submit answers</button></div>
  </form>;
}
