import {useEffect,useState} from 'react';
import type {AgentTarget,WatchPage} from '../utils/agentTarget';
export interface TailRecord { key: string; text: string }
const encoder=new TextEncoder(),decoder=new TextDecoder();
export function appendAgentTail(previous:TailRecord[],page:WatchPage) {
  const next=page.reset?[]:[...previous];
  for(const event of page.events??[]) {
    const data=event.data as Record<string,unknown>|undefined,output=event.output as {text?:string;truncated?:boolean}|undefined;
    const raw=String(output?.text??data?.text??event.summary??''),bytes=encoder.encode(raw),clipped=bytes.length>2048;
    const time=typeof event.time==='number'?new Date(event.time).toLocaleTimeString():'Unknown time';
    next.push({key:`${JSON.stringify(page.next)}-${event.seq}`,text:`${time} · ${event.kind}: ${decoder.decode(bytes.subarray(0,2048))}${clipped||output?.truncated?' [truncated]':''}`});
  }
  let bytes=next.reduce((n,r)=>n+encoder.encode(r.text).length,0);
  while(next.length>100||bytes>65536){bytes-=encoder.encode(next.shift()!.text).length;}
  return next;
}
export function useAgentWatch(target:AgentTarget) {
  const [records,setRecords]=useState<TailRecord[]>([]),[notice,setNotice]=useState('Loading live tail…'),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let retired=false,timer:number|undefined,cursor:object|undefined,pages=0,gap='';
    setRecords([]);setNotice('Loading live tail…');
    async function read(){
      try{
        if(document.hidden){timer=window.setTimeout(read,1000);return;}
        const page=await window.argusAgents?.watch(target,cursor,()=>!retired);
        if(retired)return;if(!page)throw Error('Observation unavailable');
        if(!page.ok)throw Error(page.error?.code??'Observation unavailable');
        if(page.reset==='unavailable'||page.unavailable)throw Error('Live tail unavailable');
        cursor=page.next;setRecords(rows=>appendAgentTail(rows,page));
        if(page.reset)gap=page.reset==='overflow'?'Older live events are no longer available.':'Live tail restarted; earlier events may be unavailable.';
        setNotice(gap || 'Live text and tool tail (bounded)');
        pages++;timer=window.setTimeout(read,page.hasMore&&pages<4?0:20);if(pages>=4||!page.hasMore)pages=0;
      }catch(error){if(!retired)setNotice((error as Error).message);}
    }
    void read();return()=>{retired=true;clearTimeout(timer);};
  },[target.sessionId,target.workspace,target.providerId,attempt]);
  return {records,notice,retry:()=>setAttempt(n=>n+1)};
}
