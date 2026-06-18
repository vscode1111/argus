const { execFile } = require("child_process");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 9334;
const URL = "http://localhost:5173/";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "argus-policy-"));

const child = execFile(CHROME, [
  `--user-data-dir=${TMP}`,
  "--no-first-run", "--no-default-browser-check",
  "--headless=new", "--disable-gpu",
  `--remote-debugging-port=${PORT}`,
  URL,
], { detached: false });

const get = (p) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (r) => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>res(d)); }).on("error", rej);
});

(async () => {
  for (let i=0;i<40;i++){ try { await get("/json/version"); break; } catch { await new Promise(r=>setTimeout(r,250)); } }
  const targets = JSON.parse(await get("/json"));
  const page = targets.find(t => t.type==="page" && t.url.includes("localhost:5173")) || targets.find(t=>t.type==="page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pend=new Map();
  const send=(m,p={})=>new Promise(r=>{const n=++id;pend.set(n,r);ws.send(JSON.stringify({id:n,method:m,params:p}));});
  ws.on("message",raw=>{const m=JSON.parse(raw);if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}});
  await new Promise(r=>ws.on("open",r));
  await send("Page.enable");
  await send("Page.navigate",{url:URL});
  await new Promise(r=>setTimeout(r,1500));
  const ev = await send("Runtime.evaluate",{expression:"Notification.permission",returnByValue:true});
  console.log("Notification.permission =", JSON.stringify(ev?.result?.value));
  ws.close(); child.kill();
  try { fs.rmSync(TMP,{recursive:true,force:true}); } catch {}
  process.exit(0);
})().catch(e=>{console.error(e);try{child.kill();}catch{};process.exit(1);});
