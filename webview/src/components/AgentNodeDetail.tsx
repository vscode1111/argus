import {useEffect,useMemo,useRef,useState} from 'react';
import type {GraphNode} from '../hooks/useAgentGraph';
import {useAgentDetail} from '../hooks/useAgentDetail';
import {useAgentWatch} from '../hooks/useAgentWatch';
import {QuestionForm,type QuestionAnswers} from './QuestionForm';
import {questionKey,type AgentControl} from '../utils/agentTarget';
import {settingsText,statusText,ageText,eventTime,roleText} from '../utils/agentPresentation';
import {savedMode} from '../utils/permissionMode';
import styles from './AgentDashboard.module.css';
interface Props { node:GraphNode; parents:GraphNode[]; children:GraphNode[]; onOpen():void; onClose():void; onFocus?():void }
function Confirmation({title,text,onConfirm,onCancel}:{title:string;text:string;onConfirm():void;onCancel():void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
  return <dialog ref={dialog} className={styles.confirmation} aria-label="Confirm agent action" onCancel={e=>{e.preventDefault();onCancel();}}><h2>{title}</h2><pre>{text}</pre><div className={styles.actions}><button type="button" onClick={onCancel} autoFocus>Cancel</button><button type="button" onClick={onConfirm}>Confirm</button></div></dialog>;
}
export function AgentNodeDetail({node,parents,children,onOpen,onClose,onFocus}:Props) {
  const target=useMemo(()=>({sessionId:node.id,workspace:node.workspace,providerId:node.providerId}),[node.id,node.workspace,node.providerId]);
  const detail=useAgentDetail(target),tail=useAgentWatch(target);
  const [steer,setSteer]=useState(''),[confirm,setConfirm]=useState<{kind:'steer'|'stop';text:string;target:string;control:AgentControl}>();
  const submitting=useRef(false);
  useEffect(()=>{setConfirm(undefined);},[detail.version]);
  const request=detail.control?.pendingInteraction;
  function confirmAction(kind:'steer'|'stop') {
    if(!detail.ready||!detail.control)return;
    setConfirm({kind,text:kind==='steer'?steer:'',target:`${node.title || 'Untitled session'}\n${node.id}\n${node.workspace}\n${node.providerId}`,control:detail.control});
  }
  function perform(){
    if(!confirm||submitting.current)return;
    const action=confirm;submitting.current=true;setConfirm(undefined);
    void detail.effect(action.kind,{text:action.text},action.control).finally(()=>{submitting.current=false;});
  }
  function answer(answers:QuestionAnswers){
    if(!detail.control||!request)return;
    if(request.async){const text=request.questions?.map(q=>`${q.question}\n${Array.isArray(answers[q.id])?(answers[q.id] as string[]).join(', '):answers[q.id]}`).join('\n\n');void detail.effect('async-answer',{id:request.id,text,mode:savedMode(node.providerId)},detail.control);}
    else void detail.effect('answer',{id:request.id,response:{answers}},detail.control);
  }
  return <section className={styles.details} aria-label="Session details"><h2>{node.title || 'Untitled session'}</h2><p>{roleText(node.role)} · {statusText(node)} · {node.providerId}</p><p>{settingsText(node)}</p><p>Configured model: {node.selected?.model || 'Unknown'} · Effort: {node.selected?.effort || 'Unknown'}</p><p>Active model: {node.activeSelection?.model || 'Unknown'} · Effort: {node.activeSelection?.effort || 'Unknown'}</p><p title={eventTime(node.lastEventAt,Date.now())}>Last event: {ageText(node.lastEventAt,Date.now())} · {node.lastEventSummary || 'Unknown'}</p><p>{node.company} · {node.goal}</p><p>{node.id}</p><p>{node.workspace}</p>
    <p>Parents: {parents.map(n=>`${n.title || 'Untitled session'} (${statusText(n)})`).join(', ') || 'None'}</p><p>Children: {children.map(n=>`${n.title || 'Untitled session'} (${statusText(n)})`).join(', ') || 'None'}</p>
    <div className={styles.actions}>{onFocus&&<button type="button" onClick={onFocus}>Focus in diagram</button>}<button type="button" onClick={onOpen}>Open session</button><button type="button" onClick={onClose}>Close details</button><button type="button" disabled={detail.pending} onClick={()=>void detail.inspect()}>Inspect target</button></div>
    <p role="status">{detail.message}</p>
    {request&&<section aria-label="Current question"><h3>{request.title}</h3>{request.detail&&<pre>{request.detail}</pre>}{request.kind==='question'&&request.questions?.length?<QuestionForm key={questionKey(request)} questions={request.questions} disabled={!detail.ready||detail.pending} onSubmit={answer}/>:<p>This request is available in the conversation. Open the session to respond.</p>}</section>}
    <label>Steer text<textarea value={steer} onChange={e=>{setSteer(e.target.value);setConfirm(undefined);}} disabled={detail.pending}/></label>
    <div className={styles.actions}><button type="button" disabled={!detail.ready||detail.pending||!steer.trim()||!detail.control?.active||!!request} onClick={()=>confirmAction('steer')}>Steer agent</button><button type="button" disabled={!detail.ready||detail.pending} onClick={()=>confirmAction('stop')}>Stop agent</button></div>
    <section aria-label="Live tail"><h3>Live tail</h3><p role="status">{tail.notice}</p><button type="button" onClick={tail.retry}>Retry live tail</button><ol className={styles.tail}>{tail.records.map(r=><li key={r.key}><pre>{r.text}</pre></li>)}</ol></section>
    {confirm&&<Confirmation title={confirm.kind==='stop'?'Stop agent?':'Steer agent?'} text={`${confirm.target}${confirm.kind==='steer'?`\n\n${confirm.text}`:''}`} onConfirm={perform} onCancel={()=>setConfirm(undefined)}/>}
  </section>;
}
