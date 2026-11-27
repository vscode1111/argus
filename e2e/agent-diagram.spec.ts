import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { node, setup, sync, snapshot, emit, requests } from './fixtures/agent-graph-ui';

export function drawing() {
  const value = snapshot();
  value.nodes.push(node('super', 'Harbor hub', 'super'), node('deep', 'Shelf audit'), node('meadow', 'Meadow coordinator', 'coordinator'), node('route', 'Dispatch route'), {...node('review','Inventory review with a complete descriptive title','review'),live:false,status:null} as any);
  value.nodes.find(n => n.id === 'meadow')!.company = 'meadow'; value.nodes.find(n => n.id === 'route')!.company = 'meadow';
  value.edges.push({ id:'hub-parent', from:'super',to:'parent',kind:'delegates' },{id:'hub-second',from:'super',to:'second',kind:'delegates'},{id:'deep',from:'child',to:'deep',kind:'delegates'},{id:'route',from:'meadow',to:'route',kind:'delegates'},{id:'peer',from:'deep',to:'route',kind:'peer'});
  value.edges.push({id:'review',from:'second',to:'review',kind:'reviews'});
  value.edges.push({id:'parallel-parent',from:'second',to:'child',kind:'delegates'});
  return value;
}
async function open(page: Page, value = drawing()) { await setup(page); await sync(page,value); await page.getByRole('button',{name:'Agent dashboard',exact:true}).click(); await page.getByRole('button',{name:'Diagram',exact:true}).click(); }
const positions = (page: Page) => page.locator('[data-node-id]').evaluateAll(elements => Object.fromEntries(elements.map(e=>[e.getAttribute('data-node-id'),e.getAttribute('transform')])));
async function delta(page: Page, seq: number, nodes: any[] = [], edges: any[] = [], remove = {nodes:[] as string[],edges:[] as string[]}) { await emit(page,{type:'agentGraph',baseRevision:{epoch:'inventory',seq:seq-1},revision:{epoch:'inventory',seq},upsert:{nodes,edges,scopes:[]},remove:{...remove,scopes:[]}}); }

test('diagram retains open-view slots across filters, shared collapse, modes and live updates; fresh reopening resets',async({page})=>{
 await open(page); const initial=await positions(page), subscriptions=(await requests(page)).filter(m=>m.type==='getAgentGraph').length;
 await page.getByRole('button',{name:/Inspect Inventory review with a complete descriptive title, review/}).click();await expect(page.getByRole('region',{name:'Session details'})).toContainText('Unknown');
 await page.getByRole('button',{name:'Collapse Inventory coordinator',exact:true}).click(); await expect(page.locator('[data-node-id="child"]')).toBeVisible(); // still through Quality
 await page.getByRole('button',{name:'Collapse Quality coordinator',exact:true}).click(); await expect(page.locator('[data-node-id="child"]')).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Session details'})).toHaveCount(0);
 await expect(page.getByRole('status').filter({hasText:'hidden by collapse'})).toContainText('3 hidden by collapse');
 await page.getByRole('button',{name:'Table',exact:true}).click();await page.getByRole('button',{name:'Inspect Stock worker',exact:true}).click();await page.getByRole('button',{name:'Focus in diagram',exact:true}).click();await expect(page.getByRole('button',{name:/Inspect Stock worker, work/})).toBeFocused();await expect(page.getByRole('button',{name:'Collapse Inventory coordinator',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Collapse Quality coordinator',exact:true})).toBeVisible();
 await page.getByLabel('Search title').fill('Shelf'); await expect(page.locator('[data-node-id="super"]')).toBeVisible(); await page.getByLabel('Search title').clear();
 await page.getByRole('button',{name:'Table',exact:true}).click(); await expect(page.getByRole('table')).toBeVisible(); await page.getByRole('button',{name:'Diagram',exact:true}).click(); expect(await positions(page)).toEqual(initial);
 await delta(page,2,[{...node('child','Renamed shelf'),status:'error'},node('arrival','A new shelf')],[{id:'arrival-edge',from:'parent',to:'arrival',kind:'delegates'}]); await expect(page.locator('[data-node-id="arrival"]')).toBeVisible();
 const changed=await positions(page); for(const [id,position] of Object.entries(initial)) expect(changed[id]).toEqual(position);
 const oldEdge=await page.locator('[data-edge-id="deep"]').getAttribute('d');await delta(page,3,[],[{id:'deep',from:'second',to:'deep',kind:'delegates'}]);await expect(page.locator('[data-edge-id="deep"]')).not.toHaveAttribute('d',oldEdge!);expect((await positions(page)).deep).toBe(initial.deep);
 await delta(page,4,[],[],{nodes:['arrival'],edges:['arrival-edge']});await expect(page.locator('[data-node-id="arrival"]')).toHaveCount(0);
 await delta(page,5,[node('replacement','A new shelf')],[{id:'replacement-edge',from:'parent',to:'replacement',kind:'delegates'}]);await expect(page.locator('[data-node-id="replacement"]')).toHaveAttribute('transform',changed.arrival);
 expect((await requests(page)).filter(m=>m.type==='getAgentGraph')).toHaveLength(subscriptions);
 await page.getByRole('button',{name:'Back to conversation'}).click(); await page.getByRole('button',{name:'Agent dashboard',exact:true}).click(); await page.getByRole('button',{name:'Diagram',exact:true}).click(); expect((await positions(page)).replacement).not.toEqual(changed.arrival);
});

test('R8 collapsed coordinator badges count unique hidden descendants and shared paths',async({page})=>{
 await page.setViewportSize({width:1280,height:1100});
 const v=drawing();v.nodes.push(node('exclusive','Exclusive shelf'));v.edges.push({id:'exclusive-a',from:'parent',to:'exclusive',kind:'delegates'},{id:'exclusive-b',from:'parent',to:'exclusive',kind:'reviews'});
 await open(page,v);await page.getByRole('button',{name:'Collapse Inventory coordinator',exact:true}).click();await expect(page.getByLabel('1 hidden descendant of Inventory coordinator',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Collapse Quality coordinator',exact:true}).click();await expect(page.getByLabel('3 hidden descendants of Inventory coordinator',{exact:true})).toBeVisible();await expect(page.getByLabel('3 hidden descendants of Quality coordinator',{exact:true})).toBeVisible();
 await expect(page.getByRole('status').filter({hasText:'hidden by collapse'})).toContainText('4 hidden by collapse');
 await page.getByRole('button',{name:'Expand Inventory coordinator',exact:true}).click();await expect(page.getByLabel('1 hidden descendant of Quality coordinator',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:/Inspect Quality coordinator, coordinator/}).click();await page.getByRole('button',{name:'Focus selected',exact:true}).click();await page.getByRole('main',{name:'Agent dashboard'}).evaluate(e=>{e.scrollTop=0;});await page.screenshot({path:test.info().outputPath('collapse-dark.png')});
 await page.evaluate(()=>{document.documentElement.style.setProperty('--vscode-editor-background','#ffffff');document.documentElement.style.setProperty('--vscode-editor-foreground','#24292d');document.documentElement.style.setProperty('--vscode-sideBar-background','#f1f3f5');});await page.screenshot({path:test.info().outputPath('collapse-light.png')});
});

test('R8 mixed roots and cross-company branches retain company metadata in either company order',async({page})=>{
 for(const [sourceCompany,targetCompany]of [['zeta','alpha'],['alpha','zeta']]){
  const value=snapshot();value.nodes=[{...node('root','Regional hub','super'),company:sourceCompany},{...node('branch','Regional coordinator','coordinator'),company:sourceCompany},{...node('orphan','Independent coordinator','coordinator'),company:sourceCompany},{...node('cross','Cross-region shelf'),company:targetCompany}];value.edges=[{id:'root-branch',from:'root',to:'branch',kind:'delegates'},{id:'cross-edge',from:'branch',to:'cross',kind:'delegates'}];
  await open(page,value);const p=await page.locator('[data-node-id]').evaluateAll(es=>Object.fromEntries(es.map(e=>[e.getAttribute('data-node-id'),e.getAttribute('transform')!.match(/[-\d.]+/g)!.map(Number)])));
  expect(p.root).toEqual([0,0]);expect((p.cross[0]-p.branch[0])*(p.branch[0]-p.root[0])+(p.cross[1]-p.branch[1])*(p.branch[1]-p.root[1])).toBeGreaterThan(0);
  await page.getByRole('button',{name:new RegExp(`Inspect Cross-region shelf, work, Idle, ${targetCompany}`)}).click();await expect(page.getByRole('region',{name:'Session details'})).toContainText(targetCompany);expect(Number(await page.locator('[data-edge-id="cross-edge"]').getAttribute('data-edge-length'))).toBeGreaterThan(24);
 }
});

test('keyboard, mouse, wheel and touch navigation, focus and directed body-trimmed geometry',async({page})=>{
 await open(page); const canvas=page.getByRole('application',{name:'Agent diagram'}), world=page.locator('[data-diagram-world]');
 await expect(page.locator('[data-node-id="super"] ellipse')).toHaveCount(2); await expect(page.locator('[data-node-id="parent"] polygon')).toHaveCount(1); await expect(page.locator('[data-node-id="child"] rect')).toHaveCount(1);
 const geometry=await page.locator('[data-edge-length]').evaluateAll(es=>es.map(e=>Number(e.getAttribute('data-edge-length')))); expect(Math.min(...geometry)).toBeGreaterThan(24);
 expect(await page.locator('[data-edge-id="b"]').getAttribute('d')).not.toBe(await page.locator('[data-edge-id="parallel-parent"]').getAttribute('d'));
 await canvas.focus();const start=await world.getAttribute('transform');await page.keyboard.press('ArrowRight');await expect(world).not.toHaveAttribute('transform',start!);await page.keyboard.press('+');
 await page.getByRole('button',{name:'Fit all',exact:true}).click();const fit=await world.getAttribute('transform');const box=(await canvas.boundingBox())!;await page.mouse.move(box.x+12,box.y+12);await page.mouse.down();await page.mouse.move(box.x+70,box.y+50);await page.mouse.up();await expect(world).not.toHaveAttribute('transform',fit!);
 const pan=await world.getAttribute('transform');await page.mouse.wheel(0,-150);await expect(world).not.toHaveAttribute('transform',pan!);
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});const beforePinch=await world.getAttribute('transform');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+50,y:box.y+100,id:81},{x:box.x+150,y:box.y+100,id:82}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+50,y:box.y+100,id:81},{x:box.x+230,y:box.y+100,id:82}]});await expect(world).not.toHaveAttribute('transform',beforePinch!);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 await page.getByRole('button',{name:'Fit all',exact:true}).click(); const child=page.getByRole('button',{name:/Inspect Stock worker, work/}),childBox=(await child.boundingBox())!;
 await page.mouse.move(childBox.x+childBox.width/2,childBox.y+childBox.height/2);await page.mouse.down();await page.mouse.move(childBox.x+childBox.width/2+35,childBox.y+childBox.height/2+20);await page.mouse.up();await expect(page.getByRole('region',{name:'Session details'})).toHaveCount(0);
 await child.focus();await page.keyboard.press('Enter');await expect(page.getByRole('region',{name:'Session details'})).toContainText('Stock worker');await page.keyboard.press('Space');await expect(child).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Focus selected',exact:true}).click();await expect(child).toBeFocused();
 await canvas.focus();await page.keyboard.press('0');const fitted=await world.getAttribute('transform');await page.keyboard.press('-');await expect(world).not.toHaveAttribute('transform',fitted!);
 expect((await requests(page)).filter(m=>m.type==='resumeSession')).toHaveLength(0);
});

test('dark/light geometry, bounded narrow semantic alternative and computed contrast',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await open(page); const evidence:any[]=[];
 for(const theme of ['dark','light']){
  if(theme==='light')await page.evaluate(()=>{for(const[k,v]of Object.entries({'--vscode-editor-background':'#ffffff','--vscode-editor-foreground':'#24292d','--vscode-sideBar-background':'#f1f3f5','--vscode-input-background':'#e8ecef','--vscode-input-foreground':'#24292d','--vscode-panel-border':'#68737b','--vscode-focusBorder':'#005f91'}))document.documentElement.style.setProperty(k,v);});
  for(const width of [1280,768,320]){
   await page.setViewportSize({width,height:1100}); await page.emulateMedia({reducedMotion:'reduce'});
   if(width===320)await page.getByRole('button',{name:'Table',exact:true}).click();else {await page.getByRole('button',{name:'Diagram',exact:true}).click();await page.getByRole('button',{name:'Fit all',exact:true}).click();}
   await page.getByRole('main',{name:'Agent dashboard'}).evaluate(e=>{e.scrollTop=0;});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
   if(width!==320){
    const receipt=await page.locator('[data-node-id="super"]').evaluate(e=>{
     const svg=e.closest('svg')!,text=e.querySelector('text')!,body=e.querySelector('ellipse')!,line=svg.querySelector('[data-edge-length]')!,rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number),lum=(s:string)=>rgb(s).map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((a,b,i)=>a+b*[.2126,.7152,.0722][i],0),ratio=(a:string,b:string)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
     return {text:ratio(getComputedStyle(text).fill,getComputedStyle(body).fill),edge:ratio(getComputedStyle(line).stroke,getComputedStyle(svg).backgroundColor),animation:getComputedStyle(e).animationName,positive:[...svg.querySelectorAll('[data-edge-length]')].every(p=>Number(p.getAttribute('data-edge-length'))>24)};
    });expect(receipt.text).toBeGreaterThanOrEqual(4.5);expect(receipt.edge).toBeGreaterThanOrEqual(3);expect(receipt.positive).toBe(true);expect(receipt.animation).toBe('none');evidence.push({theme,width,...receipt});
    await page.screenshot({path:test.info().outputPath(`diagram-${theme}-${width}.png`)});
    await page.getByLabel('Search title').fill('Shelf');await page.getByRole('button',{name:'Fit all',exact:true}).click();await page.screenshot({path:test.info().outputPath(`filtered-${theme}-${width}.png`)});await page.getByLabel('Search title').clear();
    if(width===1280){await page.getByRole('button',{name:/Inspect Quality coordinator, coordinator/}).click();await page.getByRole('button',{name:'Focus selected',exact:true}).click();await page.getByRole('main',{name:'Agent dashboard'}).evaluate(e=>{e.scrollTop=0;});await page.screenshot({path:test.info().outputPath(`focused-${theme}-${width}.png`)});}
   }else{await page.getByRole('button',{name:'Diagram',exact:true}).click();await expect(page.getByRole('application',{name:'Agent diagram'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:test.info().outputPath(`diagram-${theme}-${width}.png`)});const table=page.getByRole('button',{name:'Table',exact:true});await table.focus();await page.keyboard.press('Enter');await expect(page.getByRole('table')).toBeVisible();await page.screenshot({path:test.info().outputPath(`table-${theme}-${width}.png`)});}
  }
 }
 expect(errors).toEqual([]);writeFileSync(test.info().outputPath('contrast.json'),JSON.stringify({evidence,errors},null,2));
});

test('300-node graph remains responsive under bounded 4x CPU throttling',async({page})=>{
 const value=drawing(),extra=Array.from({length:292},(_,i)=>node(`shelf-${i}`,`Shelf check ${String(i).padStart(3,'0')}`));value.nodes.push(...extra);value.edges.push(...extra.map(n=>({id:`link-${n.id}`,from:'parent',to:n.id,kind:'delegates'})));
 await setup(page);const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const start=Date.now();await sync(page,value);const snapshotMs=Date.now()-start;await page.getByRole('button',{name:'Agent dashboard',exact:true}).click();const dashboardMs=Date.now()-start-snapshotMs;await page.getByRole('group',{name:'Dashboard view'}).getByRole('button',{name:'Diagram',exact:true}).click();await expect(page.locator('[data-node-id]')).toHaveCount(300);const initialMs=Date.now()-start;
 const positionsBefore=await positions(page),arrivalStart=Date.now();await delta(page,2,[node('shelf-arrival','New shelf check')],[{id:'link-arrival',from:'parent',to:'shelf-arrival',kind:'delegates'}]);await expect(page.locator('[data-node-id]')).toHaveCount(301);const arrivalMs=Date.now()-arrivalStart;
 const after=await positions(page);for(const[id,position]of Object.entries(positionsBefore))expect(after[id]).toEqual(position);
 const panStart=Date.now(),canvas=page.getByRole('application',{name:'Agent diagram'});await canvas.focus();const prior=await page.locator('[data-diagram-world]').getAttribute('transform');await page.keyboard.press('ArrowRight');await expect(page.locator('[data-diagram-world]')).not.toHaveAttribute('transform',prior!);const panMs=Date.now()-panStart;
 const filterStart=Date.now();await page.getByLabel('Search title').fill('Shelf check 291');await expect(page.locator('[data-node-id]')).toHaveCount(3);const filterMs=Date.now()-filterStart;
 const receipt={nodes:300,rate:4,initialMs,snapshotMs,dashboardMs,arrivalMs,filterMs,panMs,limitMs:5000};writeFileSync(test.info().outputPath('responsiveness.json'),JSON.stringify(receipt,null,2));for(const [phase,duration] of Object.entries({initialMs,arrivalMs,filterMs,panMs}))expect(duration,phase).toBeLessThan(receipt.limitMs);await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
});
