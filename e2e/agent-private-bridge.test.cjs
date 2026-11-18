const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){let now=0,id=0;const timers=new Map(),sockets=[],messages=[];
 class Socket{static OPEN=1;readyState=0;sent=[];constructor(url){this.url=url;sockets.push(this);}send(raw){this.sent.push(JSON.parse(raw));}open(){this.readyState=1;this.onopen?.();}frame(value){this.onmessage?.({data:JSON.stringify(value)});}close(){this.readyState=3;this.onclose?.({code:1000});}}
 const window={dispatchEvent:e=>messages.push(e.data),addEventListener(){}},document={hidden:false,addEventListener(){}};
 vm.runInNewContext(fs.readFileSync('webview/public/ws-bridge.js','utf8'),{window,document,WebSocket:Socket,URL,Set,Map,Promise,Error,console:{warn(){},error(){}},MessageEvent:class{constructor(_,o){this.data=o.data;}},setTimeout:(fn,delay)=>{timers.set(++id,{fn,time:now+delay});return id;},clearTimeout:id=>timers.delete(id)});
 const bridge=window.createArgusBridge({nextUrl:()=> 'ws://localhost:4999/agent?nonce=private-placeholder&auth=operator-placeholder&dir=/inventory&session=main&panel=main-panel'});sockets[0].open();
 const advance=ms=>{now+=ms;for(const [id,t]of [...timers])if(t.time<=now){timers.delete(id);t.fn();}};
 return {api:window.argusAgents,sockets,messages,bridge,advance};}
const target={sessionId:'selected',workspace:'/inventory/dispatch',providerId:'claude'};
test('private strict handle strips main routing, excludes raw frames and never infers causal result',async()=>{
 const f=fixture(),observed=[],promise=f.api.open(target,e=>observed.push(e),()=>{}),socket=f.sockets[1],url=new URL(socket.url);assert.equal(url.searchParams.get('purpose'),'dashboard-target');assert.equal(url.searchParams.get('panel'),null);assert.equal(url.searchParams.get('session'),target.sessionId);assert.equal(url.searchParams.get('nonce'),'private-placeholder');assert.equal(url.searchParams.get('auth'),'operator-placeholder');
 socket.open();socket.frame({type:'targetReady',sessionId:target.sessionId,providerId:target.providerId,workspace:target.workspace});const handle=await promise;
 let completed=false;const effect=handle.effect('steer',{text:'Inspect receiving'}).then(()=>{completed=true;},error=>{assert.match(error.message,/Outcome unknown/);completed=true;});
 const request=socket.sent.at(-1);assert.equal(request.expectedSessionId,target.sessionId);assert.equal(request.expectedWorkspace,target.workspace);
 socket.frame({type:'user_inject',text:'Inspect receiving'});socket.frame({type:'providerNotice',error:true,message:'Another request failed'});socket.frame({type:'done'});await Promise.resolve();assert.equal(completed,false);assert.equal(observed.length,3);assert(!f.messages.some(m=>['user_inject','providerNotice','done'].includes(m.type)));
 f.advance(10000);await effect;assert.equal(completed,true);socket.frame({type:'providerResponseAccepted',requestId:request.requestId});assert.equal(socket.sent.filter(m=>m.type==='steer').length,1);handle.close();
});
test('retired main watch drains before replacement and interception survives retirement',async()=>{
 const f=fixture(),main=f.sockets[0],first=f.api.watch(target),request=main.sent.at(-1);let current=true;const next=f.api.watch({...target,sessionId:'later'},undefined,()=>current);current=false;const retired=next.catch(e=>e.message);
 assert.equal(main.sent.filter(m=>m.type==='watchSession').length,1);main.frame({type:'sessionEvents',requestId:request.requestId,ok:true,events:[],next:{seq:0}});await first;assert.match(await retired,/retired/);assert.equal(main.sent.filter(m=>m.type==='watchSession').length,1);assert(!f.messages.some(m=>m.type==='sessionEvents'));
});
test('disconnect rejects reads/effects, closes target and sends no queued mutation on reconnect',async()=>{
 const f=fixture(),p=f.api.open(target,()=>{},()=>{}),socket=f.sockets[1];socket.open();socket.frame({type:'targetReady',sessionId:target.sessionId,providerId:target.providerId,workspace:target.workspace});const h=await p;
 const effect=h.effect('stop',{}).catch(e=>e.message),read=f.api.watch(target).catch(e=>e.message);f.sockets[0].close();assert.match(await effect,/Outcome unknown/);assert.match(await read,/Disconnected/);f.bridge.reconnectNow();f.sockets.at(-1).open();assert.equal(f.sockets.at(-1).sent.filter(m=>m.type==='stop').length,0);
});
test('selection retirement closes a target socket even before strict readiness',async()=>{const f=fixture(),abort=new AbortController(),promise=f.api.open(target,()=>{},()=>{},abort.signal).catch(e=>e.message),socket=f.sockets[1];abort.abort();assert.match(await promise,/Target unavailable/);assert.equal(socket.readyState,3);assert.equal(socket.sent.length,0);});
test('inspection binds actual server workspace while retaining the requested alias, never a client path guess',async()=>{
 const f=fixture(),alias={...target,workspace:'/inventory/dispatch/../orders'},promise=f.api.open(alias,()=>{},()=>{}),socket=f.sockets[1];socket.open();socket.frame({type:'targetReady',sessionId:target.sessionId,providerId:target.providerId,workspace:'/inventory/orders'});const h=await promise;
 const read=h.inspect(),id=socket.sent.at(-1).requestId;socket.frame({type:'sessionControl',requestId:id,sessionId:target.sessionId,selection:{providerId:target.providerId},workspace:'/inventory/orders'});const result=await read;assert.equal(result.workspace,'/inventory/orders');assert.equal(result.target.workspace,alias.workspace);
 const wrong=h.inspect();socket.frame({type:'sessionControl',requestId:socket.sent.at(-1).requestId,sessionId:target.sessionId,selection:{providerId:target.providerId},workspace:'/inventory/wrong'});await assert.rejects(wrong,/identity changed/);
});
