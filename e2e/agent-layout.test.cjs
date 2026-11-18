const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const modulePath=require('node:path').resolve(__dirname,'../webview/src/utils/agentLayout.ts');
const exportsObject={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(modulePath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:exportsObject});
const {layoutGraph,displayHierarchy,expandedNodes,connector,hiddenDescendantCounts}=exportsObject;
test('R8 central Super with orphan roots and incompatible root vacancy',()=>{
 const ns=[node('Hub','super'),node('Orphan','coordinator')],v=layoutGraph(ns,[]);assert.equal(v.placements.Hub.x,v.centres.Harbor.x);assert.equal(v.placements.Hub.y,v.centres.Harbor.y);
 const solo=layoutGraph([node('Hub','super')],[]),empty=layoutGraph([],[],solo),next=layoutGraph([node('Manager','coordinator')],[],empty);assert(Math.hypot(next.placements.Manager.x,next.placements.Manager.y)>100);
 const mixed=layoutGraph([...ns,node('Second','super')],[]);assert.notEqual(JSON.stringify(mixed.placements.Hub),JSON.stringify(mixed.placements.Second));
});
test('R8 cross-company parent dependency in both company orders',()=>{
 for(const [parentCompany,childCompany]of [['zeta','alpha'],['alpha','zeta']]){
 const ns=[node('Root','super',parentCompany),node('Parent','coordinator',parentCompany),node('Child','work',childCompany)],es=[edge('Root','Parent'),edge('Parent','Child')],v=layoutGraph(ns,es),p=v.placements.Parent,ch=v.placements.Child,c=v.centres[parentCompany];
 assert((ch.x-p.x)*(p.x-c.x)+(ch.y-p.y)*(p.y-c.y)>0);same(v,layoutGraph([...ns].reverse(),[...es].reverse()));
 const updated=layoutGraph([...ns,node('Arrival','work',childCompany)],[...es,edge('Parent','Arrival')],v);for(const n of ns)same(updated.placements[n.id],v.placements[n.id]);assert(connector(p,ch,'coordinator','work').length>24);
 }
});
test('R8 collapsed badges count unique unreachable descendants, not parallel edges or reachable shared paths',()=>{
 const ns=[node('A','coordinator'),node('B','coordinator'),node('Exclusive'),node('Shared'),node('Deep')],es=[edge('A','Exclusive'),edge('A','Exclusive','reviews'),edge('A','Shared'),edge('B','Shared'),edge('Shared','Deep')];
 assert.equal(hiddenDescendantCounts(ns,es,new Set(['A'])).get('A'),1);const both=hiddenDescendantCounts(ns,es,new Set(['A','B']));assert.equal(both.get('A'),3);assert.equal(both.get('B'),2);assert.equal(hiddenDescendantCounts(ns,es,new Set(['B'])).get('B'),0);
});
const node=(id,role='work',company='Harbor')=>({id,title:id,role,company});
const edge=(from,to,kind='delegates')=>({from,to,kind});
const nodes=[node('Hub','super'),node('Inventory','coordinator'),node('Quality','coordinator'),node('Audit'),node('Shared','review'),node('Deep'),node('Route','coordinator','Meadow'),node('Manifest','work','Meadow')];
const edges=[edge('Hub','Inventory'),edge('Hub','Quality'),edge('Inventory','Audit'),edge('Inventory','Shared','reviews'),edge('Quality','Shared','reviews'),edge('Audit','Deep'),edge('Route','Manifest')];
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
test('fresh deterministic hierarchy, peer independence, every real supervisory connector positive and outward anchors',()=>{
 const state=layoutGraph(nodes,edges);same(state,layoutGraph([...nodes].reverse(),[...edges].reverse()));same(state,layoutGraph(nodes,[...edges,edge('Audit','Manifest','peer')]));
 const h=displayHierarchy(nodes,edges);assert.equal(h.parents.get('Shared').size,2);
 for(const e of edges){const a=state.placements[e.from],b=state.placements[e.to],line=connector(a,b,nodes.find(n=>n.id===e.from).role,nodes.find(n=>n.id===e.to).role);assert(line.length>24,e.from+'->'+e.to);assert((line.b.x-line.a.x)*(b.x-a.x)+(line.b.y-line.a.y)*(b.y-a.y)>0);}
 assert(connector(state.placements.Inventory,state.placements.Audit,'coordinator','work',42).path.includes('Q'));
 assert(connector({x:0,y:0},{x:120,y:0},'super','coordinator').length<0,'crowded old geometry is rejected');
 for(const n of nodes){const p=state.placements[n.id],parent=state.placements[p.anchor];if(!parent)continue;const c=state.centres[parent.company];assert((p.x-parent.x)*(parent.x-c.x)+(p.y-parent.y)*(parent.y-c.y)>=-1e-6,n.id);}
});
test('survivors keep exact slots on reordered titles, arrivals, reparent and removal; previous immutable; vacancies reused',()=>{
 const initial=layoutGraph(nodes,edges),frozen=JSON.stringify(initial);
 const changed=nodes.map(n=>({...n,title:n.id==='Inventory'?'Zebra inventory':'A '+n.id,status:'error'})),arrival=node('Ahead','work');
 const next=layoutGraph([arrival,...changed], [...edges,edge('Inventory','Ahead')],initial);
 for(const n of nodes)same(next.placements[n.id],initial.placements[n.id]);assert.equal(JSON.stringify(initial),frozen);
 const reparent=layoutGraph(changed,edges.map(e=>e.to==='Deep'?edge('Quality','Deep'):e),next);same(reparent.placements.Deep,initial.placements.Deep);
 const removed=layoutGraph(nodes.filter(n=>n.id!=='Audit'),edges.filter(e=>e.from!=='Audit'&&e.to!=='Audit'),initial);
 assert(!removed.placements.Audit);for(const n of nodes.filter(n=>n.id!=='Audit'))same(removed.placements[n.id],initial.placements[n.id]);
 const replacement=layoutGraph([...nodes.filter(n=>n.id!=='Audit'),node('Replacement')],[...edges.filter(e=>e.from!=='Audit'&&e.to!=='Audit'),edge('Inventory','Replacement')],removed);
 assert.equal(replacement.placements.Replacement.x,initial.placements.Audit.x);assert.equal(replacement.placements.Replacement.y,initial.placements.Audit.y);
});
test('capacity growth and multiple supers keep every survivor and all bodies apart',()=>{
 const baseNodes=[node('First','super'),node('Second','super'),node('Manager','coordinator')],baseEdges=[edge('First','Manager')];let state=layoutGraph(baseNodes,baseEdges),initial=JSON.stringify(state.placements);
 const many=Array.from({length:150},(_,i)=>node('Stock '+i));state=layoutGraph([...baseNodes,...many],[...baseEdges,...many.map(n=>edge('Manager',n.id))],state);
 assert.equal(JSON.stringify(Object.fromEntries(baseNodes.map(n=>[n.id,state.placements[n.id]]))),initial);
 const slots=Object.values(state.placements);for(let i=0;i<slots.length;i++)for(let j=i+1;j<slots.length;j++)assert(Math.abs(slots[i].x-slots[j].x)>=264||Math.abs(slots[i].y-slots[j].y)>=184);
});
test('shared collapse uses all expanded paths, deduplicates parallel relations and survives filter-independent input',()=>{
 const visible=expandedNodes(nodes,edges,new Set(['Inventory']));assert(!visible.has('Audit'));assert(!visible.has('Deep'));assert(visible.has('Shared'));assert(visible.has('Manifest'));
 assert(!expandedNodes(nodes,edges,new Set(['Inventory','Quality'])).has('Shared'));
 same([...expandedNodes(nodes,[...edges,edge('Inventory','Shared')],new Set())].sort(),nodes.map(n=>n.id).sort());
});
test('company names that match object properties still have finite deterministic positions',()=>{
 const value=layoutGraph([node('Parcel','coordinator','constructor')],[]);assert(Number.isFinite(value.placements.Parcel.x));assert(Number.isFinite(value.centres.constructor.y));
});
