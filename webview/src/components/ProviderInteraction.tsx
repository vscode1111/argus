import React, { useState } from 'react';
import type { ProviderInteraction as Interaction } from '../../../src/shared/provider';
import { postMessage } from '../vscode';
import styles from './ProviderSelector.module.css';

export function ProviderInteraction({ request }: { request: Interaction }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const respond = (response: object) => postMessage({ type: 'providerResponse', id: request.id, response });
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
