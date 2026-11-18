const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const exportsObject={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('webview/src/hooks/useAgentWatch.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:exportsObject,require,TextEncoder,TextDecoder,Date});
test('tail clips UTF-8 tool output, bounds retained text and records, and clears on cursor reset',()=>{
 const events=Array.from({length:256},(_,seq)=>({seq,time:1800000000000,kind:'tool-end',output:{text:'庫'.repeat(2000)}}));
 const rows=exportsObject.appendAgentTail([],{ok:true,events,next:{epoch:'inventory',generation:'section',seq:256}});assert(rows.length<=100);assert(rows.reduce((n,r)=>n+Buffer.byteLength(r.text),0)<=65536);assert(rows.every(r=>r.text.endsWith('[truncated]')));
 const reset=exportsObject.appendAgentTail(rows,{ok:true,reset:'overflow',events:[],next:{seq:300}});assert.equal(reset.length,0);
});
