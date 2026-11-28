const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function host(html, initial='http://127.0.0.1:4999/?dir=D%3A%2Finventory&session=parent&view=agents') {
  const listeners={},posts=[],location=new URL(initial),window={location};
  let bridgeOptions, nonceUrl, authOrigin;
  const daemonPort=html.match(/<meta name="argus-backend-port" content="(\d+)"/)?.[1];
  window.history={replaceState(_a,_b,url){Object.assign(location,new URL(url,location));location.href=new URL(url,location).href;}};
  window.addEventListener=(kind,fn)=>(listeners[kind]??=[]).push(fn);
  window.createArgusAuth=origin=>{authOrigin=origin;return {token:()=>'',setRequired(){},login:async()=>({ok:true})};};
  window.createArgusBridge=options=>{bridgeOptions=options;return {post:m=>posts.push(m),reconnectNow(){},reconnectIfIdle(){}};};
  const context={window,URL,URLSearchParams,console,acquireVsCodeApi:()=>({postMessage(){}}),
    document:{getElementById:()=>null,querySelector:selector=>selector==='meta[name="argus-backend-port"]'&&daemonPort?{content:daemonPort}:null},
    XMLHttpRequest:class{open(_method,url){nonceUrl=url;}send(){this.status=200;this.responseText='fixture-nonce';}}};
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(m=>!m[1].includes('src=')&&!m[1].includes('type="module"'));
  for(const script of scripts)vm.runInNewContext(script[2],context);
  const api=window.acquireVsCodeApi();return {window,api,posts,dispatch:(kind,data)=>(listeners[kind]??[]).forEach(fn=>fn({data})),location,
    backend(){const socket=new URL(bridgeOptions.nextUrl());return {socket,nonceUrl,authOrigin};}};
}

test('Vite modes reserve distinct ports and route auth, nonce and chat to the selected backend', async t => {
  const http = require('node:http');
  const os = require('node:os');
  const fixture = http.createServer((req, res) => {
    assert.equal(req.url, '/health');
    res.end(JSON.stringify({ pid: process.pid }));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const daemonPort = fixture.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-vite-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.ARGUS_DAEMON_FILE;
  process.env.ARGUS_DAEMON_FILE = path.join(dir, 'daemon.json');
  t.after(() => {
    if (previous === undefined) delete process.env.ARGUS_DAEMON_FILE;
    else process.env.ARGUS_DAEMON_FILE = previous;
  });
  fs.writeFileSync(process.env.ARGUS_DAEMON_FILE, JSON.stringify({ port: daemonPort, pid: process.pid, nonce: 'fixture-discovery' }));

  const { createServer } = await import('vite');
  const html = fs.readFileSync(path.join(root, 'webview/index.html'), 'utf8');
  const rendered = {};
  for (const [mode, frontendPort] of [['development', 5173], ['daemon', 5174]]) {
    const frontend = await createServer({
      configFile: path.join(root, 'webview/vite.dev.config.ts'),
      cacheDir: path.join(dir, mode),
      mode,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, ws: false, watch: null },
    });
    try {
      assert.equal(frontend.config.server.port, frontendPort);
      assert.equal(frontend.config.server.strictPort, true);
      rendered[mode] = await frontend.transformIndexHtml('/', html);
    } finally {
      await frontend.close();
    }
  }

  for (const [mode, frontendPort, backendPort] of [['daemon', 5174, daemonPort], ['development', 5173, 3001]]) {
    assert.doesNotMatch(rendered[mode], /fixture-discovery/);
    const page = host(rendered[mode], `http://localhost:${frontendPort}/?session=inventory`);
    const { socket, nonceUrl, authOrigin } = page.backend();
    assert.equal(socket.origin, `ws://localhost:${backendPort}`);
    assert.equal(socket.searchParams.get('session'), 'inventory');
    assert.equal(nonceUrl, `http://localhost:${backendPort}/nonce`);
    assert.equal(authOrigin, `http://localhost:${backendPort}`);
  }

  const explicit = host(rendered.development, `http://localhost:5173/?session=inventory&backendPort=${daemonPort}`);
  explicit.api.postMessage({ type: 'resumeSession', id: 'dispatch' });
  assert.equal(explicit.location.searchParams.get('backendPort'), String(daemonPort));
  assert.equal(explicit.backend().socket.port, String(daemonPort));
  const mock = host(rendered.daemon, `http://localhost:5174/?mock=1&backendPort=${daemonPort}`);
  assert.equal(mock.backend().socket.port, '3001');
});
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
