import { useEffect, useRef, useState } from 'react';
import { sameTarget, questionKey, type AgentControl, type AgentTarget, type TargetHandle } from '../utils/agentTarget';
export function useAgentDetail(target: AgentTarget) {
  const [control,setControl]=useState<AgentControl>(),[message,setMessage]=useState('Inspecting target…'),[ready,setReady]=useState(false),[pending,setPending]=useState(false),[version,setVersion]=useState(0);
  const owner=useRef<TargetHandle>(),alive=useRef(true),inspection=useRef(0),busy=useRef(false),revision=useRef(0);
  const opening=useRef<Promise<TargetHandle>>();
  const abort=useRef<AbortController>();
  const inspecting=useRef(false);
  const observe = (event: Record<string,unknown>) => {
    if (['interaction','interaction_resolved','thinking_start','done','clear','sessionId'].includes(String(event.type))) {
      revision.current++; setVersion(v=>v+1); void inspect(false);
    }
  };
  async function inspect(unlock=true): Promise<AgentControl | undefined> {
    const serial=++inspection.current;
    const controller=abort.current ??=new AbortController();
    let attempt:Promise<TargetHandle>|undefined;
    if(unlock){inspecting.current=true;setReady(false);setMessage('Inspecting target…');}
    try {
      if(!owner.current&&!opening.current)opening.current=window.argusAgents?.open(target,observe,()=>{
        owner.current=undefined;inspecting.current=false;revision.current++;if(alive.current){setReady(false);setVersion(v=>v+1);setMessage(busy.current?'Outcome unknown; inspect before another action':'Disconnected; inspect target again');}
      },controller.signal);
      attempt=opening.current;
      const handle=owner.current ?? await attempt;if(opening.current===attempt)opening.current=undefined;
      if(!handle)throw Error('Target controls unavailable');
      if(!alive.current||controller!==abort.current||controller.signal.aborted){handle.close();return;}
      owner.current=handle;
      const snapshot=await handle.inspect();
      if(!sameTarget(snapshot,target)) {handle.close();throw Error('Target identity changed');}
      if(!alive.current||serial!==inspection.current)return;
      setControl(snapshot);if(inspecting.current&&!busy.current){inspecting.current=false;setReady(true);setMessage('Target inspected');}return snapshot;
    }catch(error){if(opening.current===attempt)opening.current=undefined;if(alive.current&&serial===inspection.current){inspecting.current=false;setReady(false);setMessage((error as Error).message);}return;}
  }
  useEffect(()=>{alive.current=true;void inspect();return()=>{alive.current=false;inspection.current++;abort.current?.abort();abort.current=undefined;opening.current=undefined;owner.current?.close();owner.current=undefined;};},[]);
  async function effect(kind:'answer'|'async-answer'|'steer'|'stop',payload:object,expected:AgentControl) {
    if(!ready||busy.current)return;
    busy.current=true;setPending(true);setReady(false);
    const before=revision.current;
    try {
      const fresh=await inspect(false);
      if(!fresh||before!==revision.current||questionKey(fresh.pendingInteraction)!==questionKey(expected.pendingInteraction)||fresh.active!==expected.active)throw Error('Target changed; inspect before another action');
      const handle=owner.current;if(!handle)throw Error('Disconnected');
      setMessage(kind==='stop'?'Stop requested':kind==='steer'?'Steer requested':'Answer requested');
      await handle.effect(kind,payload);
      if(alive.current)setMessage('Response recorded; inspect before another action');
    }catch(error){if(alive.current)setMessage((error as Error).message);}
    finally{busy.current=false;if(alive.current){setPending(false);setReady(false);}}
  }
  return {control,message,ready,pending,version,inspect,effect};
}
