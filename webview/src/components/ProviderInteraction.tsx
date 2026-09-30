import React, { useEffect, useRef, useState } from 'react';
import type { ProviderInteraction as Interaction } from '../../../src/shared/provider';
import { postMessage } from '../vscode';
import { savedMode } from '../utils/permissionMode';
import styles from './ProviderSelector.module.css';

function AsyncQuestionDialog({ request }: { request: Interaction }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  const questions = request.questions ?? [];
  const complete = questions.length > 0 && questions.every(q => answers[q.id] === 'other' ? !!custom[q.id]?.trim() : !!answers[q.id]);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!complete || submitted) return;
    const text = questions.map(q => `${q.question}\n${answers[q.id] === 'other' ? custom[q.id].trim() : answers[q.id]}`).join('\n\n');
    setSubmitted(true);
    postMessage({ type: 'send', text, mode: savedMode('codex') });
  }
  return <dialog ref={dialog} className={styles.questionDialog} onCancel={event => event.preventDefault()} aria-labelledby="provider-question-title">
    <form onSubmit={submit}>
      <h2 id="provider-question-title">{request.title}</h2>
      {questions.map(q => <fieldset key={q.id} className={styles.questionField}>
        <legend>{q.question}</legend>
        {q.options.map(option => <label key={option} className={styles.questionOption}>
          <input type="radio" name={`question-${q.id}`} checked={answers[q.id] === option} onChange={() => setAnswers(previous => ({ ...previous, [q.id]: option }))} />
          <span>{option}</span>
        </label>)}
        {q.options.length > 0 && <label className={styles.questionOption}>
          <input type="radio" name={`question-${q.id}`} checked={answers[q.id] === 'other'} onChange={() => setAnswers(previous => ({ ...previous, [q.id]: 'other' }))} />
          <span>Other</span>
        </label>}
        {(answers[q.id] === 'other' || q.options.length === 0) && <input className={styles.customAnswer} aria-label={`Answer to ${q.question}`} value={custom[q.id] ?? ''}
          onChange={event => { setCustom(previous => ({ ...previous, [q.id]: event.target.value })); if (!q.options.length) setAnswers(previous => ({ ...previous, [q.id]: 'other' })); }} />}
      </fieldset>)}
      <button type="submit" disabled={!complete || submitted}>Submit answers</button>
    </form>
  </dialog>;
}

export function ProviderInteraction({ request }: { request: Interaction }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const respond = (response: object) => postMessage({ type: 'providerResponse', id: request.id, response });
  if (request.async) return <AsyncQuestionDialog request={request} />;
  return <section className={styles.row} aria-label="Provider request" aria-live="polite">
    <strong>{request.title}</strong>
    {request.detail && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{request.detail}</pre>}
    {request.kind === 'question' ? <form onSubmit={e => { e.preventDefault(); respond({ answers }); }}>
      {request.questions?.map(q => <label key={q.id}>{q.question}
        <input required value={answers[q.id] || ''} list={`answers-${q.id}`} onChange={e => setAnswers(previous => ({ ...previous, [q.id]: e.target.value }))} />
        <datalist id={`answers-${q.id}`}>{q.options.map(option => <option key={option} value={option} />)}</datalist>
      </label>)}
      <button type="submit">Submit answers</button>
    </form> : <div>
      {(request.options || ['accept', 'decline']).map(decision => <button key={decision} type="button" onClick={() => respond({ decision })}>{decision === 'accept' ? 'Allow once' : 'Decline'}</button>)}
    </div>}
  </section>;
}
