const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inventory-handler-'));
Object.assign(process.env,{ARGUS_CONFIG:path.join(dir,'settings.json'),ARGUS_GRAPH_DB:path.join(dir,'graph.sqlite'),ARGUS_STATS_DB:path.join(dir,'stats.sqlite'),ARGUS_STATS_FILE:path.join(dir,'stats.jsonl'),ARGUS_ENTRY_GRACE_MS:'10',ARGUS_USAGE_POLL:'0',ARGUS_MODEL_REFRESH:'0'});
fs.writeFileSync(process.env.ARGUS_CONFIG,JSON.stringify({watchdogEnabled:false}));
const channels=require('../out/backend/channel'),{attachClientHandlers}=require('../out/backend/session');
const ch=channels.getOrCreateChannel(dir),ws=new EventEmitter(),frames=[],effects=[];ws.readyState=1;ws.send=raw=>frames.push(JSON.parse(raw));attachClientHandlers(ws,ch,'',{fresh:true});const state=ch.getClientState(ws);state.sessionId='inventory-before';state.runtime={active:true,stop(){effects.push(state.sessionId);},respond(id){effects.push(id);},dispose(){}};
const send=async value=>{ws.emit('message',Buffer.from(JSON.stringify(value)));await new Promise(r=>setTimeout(r,10));};
after(()=>{ws.emit('close');channels.destroyChannel(dir);require('../out/backend/agentGraphRequests').agentGraphService().dispose();require('../out/backend/sessionStats').closeStatsDatabase();fs.rmSync(dir,{recursive:true,force:true});});
test('atomic correlated workspace snapshot and rebinding refusal before stop/respond effects',async()=>{
 await send({type:'getSessionControl',requestId:'inspect'});assert.equal(frames.find(m=>m.requestId==='inspect').workspace,dir);
 state.sessionId='inventory-after';
 for(const type of ['stop','providerResponse']){await send({type,requestId:type,id:'stale-question',expectedSessionId:'inventory-before',expectedWorkspace:dir});assert(frames.some(m=>m.requestId===type&&m.error));}
 assert.deepEqual(effects,[]);
 await send({type:'stop',expectedSessionId:'inventory-after',requestId:'half'});assert.deepEqual(effects,[]);
 await send({type:'stop',expectedSessionId:'inventory-after',expectedWorkspace:path.join(dir,'wrong'),requestId:'wrong'});assert.deepEqual(effects,[]);
 await send({type:'stop',expectedSessionId:'inventory-after',expectedWorkspace:dir,requestId:'correct'});assert.deepEqual(effects,['inventory-after']);
});
test('expected target is rechecked through native admission after async preparation',async()=>{
 state.sessionId='inventory-admission';let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let admitted=false;
 state.runtime.send=async(_input,admission)=>{enter();await gate;admitted=admission.valid();};
 ws.emit('message',Buffer.from(JSON.stringify({type:'steer',text:'Inspect receiving',expectedSessionId:'inventory-admission',expectedWorkspace:dir,requestId:'async-race'})));
 await entered;state.sessionId='inventory-rebound';release();await new Promise(r=>setTimeout(r,20));assert.equal(admitted,false);
});
const {noteClientConnect}=require('../out/backend/clients'),{checkAdmission}=require('../out/backend/providers/types'),deliveryModule=require('../out/backend/agentDelivery');
let humanCase=0;
for(const kind of ['ordinary','targeted-send','targeted-async','targeted-steer','wrong','stale-target','stale-question','disconnected','token','ui-token'])test(`human admission ${kind} composes bookkeeping only at native commit`,async t=>{
 const workspace=path.join(dir,'human-'+(++humanCase)),channel=channels.getOrCreateChannel(workspace),socket=new EventEmitter(),messages=[];socket.readyState=1;socket.send=raw=>messages.push(JSON.parse(raw));
 noteClientConnect(socket,{headers:kind==='token'?{}:{origin:'http://127.0.0.1'},socket:{remoteAddress:'127.0.0.1'}},{browser:kind!=='token'});
 attachClientHandlers(socket,channel,'',{fresh:true});const target=channel.getClientState(socket);target.sessionId='receiving-'+humanCase;target.selection={...target.selection,providerId:'claude'};target.runtime={active:false,dispose(){}};
 const childSocket=new EventEmitter();childSocket.readyState=1;childSocket.send=()=>{};channel.addClient(childSocket,true);const child=channel.getClientState(childSocket);child.sessionId='report-'+humanCase;child.cliDone=true;
 const store=require('../out/backend/agentGraphRequests').agentGraphService().store,node=(s,role)=>({id:s.sessionId,workspace,providerId:'claude',role,title:'Receiving',company:'inventory',goal:'receiving',createdAt:1,updatedAt:1});store.link(target.sessionId,child.sessionId,'delegates',[node(target,'coordinator'),node(child,'work')]);
 let automatic=0;const delivery=new deliveryModule.AgentDelivery(store,{states:channels.listAgentStates,acquire:n=>channels.acquireSessionEntry(n.workspace,n.id,0),async send(_s,_input,admission){assert.equal(admission.automatic,true);checkAdmission(admission,true);automatic++;}},{coalesce:0,interval:0});deliveryModule.installAgentDelivery(delivery);
 t.after(()=>{delivery.dispose();deliveryModule.installAgentDelivery(undefined);socket.readyState=1;socket.emit('close');channel.removeClient(childSocket);channels.destroyChannel(workspace);});
 delivery.observe(child,{type:'done'});await delivery.flush();assert.equal(automatic,1);assert.equal(delivery.metadata(target,{type:'tool_start'}).notificationOrigin,'graph');delivery.stop(target);
 const originalId=target.sessionId,stopped=()=>store.snapshot().nodes.find(n=>n.id===originalId).userStopped;
 let entered,release,completed,admissions=0;const preparing=new Promise(r=>entered=r),gate=new Promise(r=>release=r),finished=new Promise(r=>completed=r);
 target.runtime.active=kind!=='targeted-async'&&kind!=='stale-question';
 if(['targeted-async','stale-question'].includes(kind))target.interaction={id:'section',kind:'question',async:true,title:'Receiving',questions:[{id:'section',question:'Which section?',options:['North']}]};
 target.runtime.send=async(_input,admission)=>{entered();await gate;try{checkAdmission(admission,true);admissions++;}finally{completed();}};
 const input={type:kind==='targeted-steer'?'steer':'send',text:'Receiving section North',...(kind==='ordinary'?{}:{expectedSessionId:kind==='wrong'?'missing-receiving':originalId,expectedWorkspace:workspace}),...(['targeted-async','stale-question'].includes(kind)?{expectedInteractionId:'section'}:{})};
 if(['token','ui-token'].includes(kind)){store.link('caller-'+humanCase,target.sessionId,'delegates',[{...node(child,'coordinator'),id:'caller-'+humanCase}]);const owner=new EventEmitter();owner.readyState=1;owner.send=()=>{};channel.addClient(owner,true);const caller=channel.getClientState(owner);caller.sessionId='caller-'+humanCase;input.agentToken=caller.agentToken;t.after(()=>channel.removeClient(owner));}
 socket.emit('message',Buffer.from(JSON.stringify(input)));
 if(kind==='wrong'){await new Promise(r=>setTimeout(r,20));assert.equal(admissions,0);assert.equal(stopped(),true);assert.equal(delivery.metadata(target,{type:'tool_start'}).notificationOrigin,'graph');return;}
 await Promise.race([preparing,new Promise((_,reject)=>setTimeout(()=>reject(Error('native preparation not reached: '+JSON.stringify(messages.map(m=>({type:m.type,code:m.code,message:m.message}))))),1000))]);assert.equal(stopped(),true);assert.equal(delivery.metadata(target,{type:'tool_start'}).notificationOrigin,'graph');
 if(kind==='stale-target')target.sessionId='changed-receiving';if(kind==='stale-question')target.interaction={...target.interaction,id:'replacement-section'};if(kind==='disconnected')socket.readyState=3;
 release();await finished;const accepted=!['stale-target','stale-question','disconnected'].includes(kind);assert.equal(admissions,accepted?1:0);const human=accepted&&kind!=='token';assert.equal(stopped(),!human);assert.equal(delivery.metadata(target,{type:'tool_start'}).notificationOrigin,human?null:'graph');
 if(['token','ui-token'].includes(kind))assert.equal(store.snapshot().edges.find(e=>e.from==='caller-'+humanCase&&e.to===originalId).forward.summary,'Parent input');
});
