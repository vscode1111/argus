const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function host(html, initial='http://127.0.0.1:4999/?dir=D%3A%2Finventory&session=parent&view=agents') {
  const listeners={},posts=[],location=new URL(initial),window={location};
  window.history={replaceState(_a,_b,url){Object.assign(location,new URL(url,location));location.href=new URL(url,location).href;}};
  window.addEventListener=(kind,fn)=>(listeners[kind]??=[]).push(fn);
  window.createArgusAuth=()=>({token:()=>'',setRequired(){},login:async()=>({ok:true})});
  window.createArgusBridge=()=>({post:m=>posts.push(m),reconnectNow(){},reconnectIfIdle(){}});
  const context={window,URL,URLSearchParams,console,acquireVsCodeApi:()=>({postMessage(){}}),document:{getElementById:()=>null},XMLHttpRequest:class{open(){}send(){this.status=200;this.responseText='fixture-nonce';}}};
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(m=>!m[1].includes('src='));
  for(const script of scripts)vm.runInNewContext(script[2],context);
  const api=window.acquireVsCodeApi();return {window,api,posts,dispatch:(kind,data)=>(listeners[kind]??[]).forEach(fn=>fn({data})),location};
}
for(const file of ['webview/index.html','media/browser.html'])test(file+' retains view and latest identity through host query reconstruction',()=>{
  const {api,dispatch,location}=host(fs.readFileSync(path.join(root,file),'utf8'));
  api.postMessage({type:'resumeSession',id:'child'});assert.equal(location.searchParams.get('view'),'agents');
  dispatch('message',{type:'sessionId',id:'assigned'});assert.equal(location.searchParams.get('view'),'agents');
  api.postMessage({type:'switchWorkspace',dir:'D:/dispatch'});assert.equal(location.searchParams.get('view'),'agents');
  api.postMessage({type:'resumeSession',id:'codex:dispatch'});
  location.search='?view=agents&session=stale';dispatch('popstate');
  assert.equal(location.searchParams.get('session'),'codex:dispatch');assert.equal(location.searchParams.get('dir'),'D:/dispatch');
});
test('VS Code ChatPanel explicitly bootstraps a dedicated dashboard panel and keeps panel identity',()=>{
  const ts=require('typescript'),exports={};let panel;
  const uri=p=>({fsPath:p,toString:()=>p});
  const vscode={Uri:{joinPath:(base,...parts)=>uri(path.join(base.fsPath,...parts))},workspace:{workspaceFolders:[{uri:uri('D:/inventory')}]},ViewColumn:{Beside:2},window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),createWebviewPanel(_type,title,_column,options){panel={title,options,visible:true,webview:{html:'',cspSource:'fixture',asWebviewUri:u=>u,onDidReceiveMessage(){}},onDidDispose(){},onDidChangeViewState(){}};return panel;}}};
  const requireStub=name=>name==='vscode'?vscode:name==='../extension'?{readDaemon:()=>({port:4999,nonce:'fixture-nonce'}),ensureDaemon:async()=>{},FOCUS_PROTOCOL:'fixture'}:name.includes('win32')?{captureForegroundWindow(){}}:name.startsWith('../../backend/')?{}:require(name);
  const js=process.env.ARGUS_DASHBOARD_COMPILED==='1'?fs.readFileSync(path.join(root,'out/frontend/chat/ChatPanel.js'),'utf8'):ts.transpileModule(fs.readFileSync(path.join(root,'src/frontend/chat/ChatPanel.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js,{exports,require:requireStub,URLSearchParams,setInterval,clearInterval});
  exports.ChatPanel.createNew(uri(root),'agents');
  assert.match(panel.webview.html,/argusInitialView\s*=\s*['"]agents['"]/);assert.match(panel.webview.html,/panel=/);assert.equal(panel.title,'Argus Agents');
  const rendered=host(panel.webview.html);assert.equal(rendered.window.argusInitialView,'agents');
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));assert(pkg.contributes.commands.some(c=>c.command==='argus.openAgents'));
  assert.match(fs.readFileSync(path.join(root,'src/frontend/extension.ts'),'utf8'),/registerCommand\('argus\.openAgents'/);
});
