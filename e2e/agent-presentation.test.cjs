const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),{test}=require('node:test'),path=require('node:path');
const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../webview/src/utils/agentPresentation.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({})});
test('source times remain truthful at zero, missing, future, invalid and age boundaries',()=>{
 assert.equal(api.ageText(null,5000),'Unknown');assert.equal(api.ageText(NaN,5000),'Unknown');assert.equal(api.ageText(6000,5000),'Unknown');assert.equal(api.ageText(0,5000),'5s ago');assert.equal(api.ageText(1,86400001),'1d ago');assert(api.eventTime(0,5000).startsWith('1970-01-01'));assert(api.eventTime(6000,5000).includes('Unknown'));
});
test('freshness follows source time, not render or awaiting-state changes',()=>{
 const edge={forward:{summary:'Inspect shelves',time:1000,awaitingReply:true}};let s=api.exchangeState(edge,'forward',5000);assert(s.recent);assert(s.waiting);assert(s.opacity<1&&s.opacity>0);
 s=api.exchangeState(edge,'forward',13000);assert(!s.recent);assert(s.waiting);assert.equal(s.opacity,0);
 assert(!api.exchangeState({...edge,forward:{...edge.forward,awaitingReply:false}},'forward',13000).recent);assert(!api.exchangeState(edge,'reverse',5000).recent);assert(!api.exchangeState(edge,'forward',500).recent);
});
