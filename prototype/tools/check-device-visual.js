// check-device-visual.js — 真机 CDP 断言视觉优化 A~G 是否生效（须先 adb forward tcp:9222）
const http = require('http');
function getJson(url){return new Promise((res,rej)=>{http.get(url,(r)=>{let s='';r.on('data',d=>s+=d);r.on('end',()=>{try{res(JSON.parse(s))}catch(e){rej(e)}})}).on('error',rej)})}
(async()=>{
  const targets = await getJson('http://127.0.0.1:9222/json');
  const page = targets.find(t=>t.type==='page');
  if(!page) throw new Error('no page target');
  console.log('target:', page.url.slice(0,80));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws fail'))});
  let id=0;const pending=new Map();
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}};
  const call=(method,params)=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
  const ev=async(expr)=>{const r=await call('Runtime.evaluate',{expression:expr,returnByValue:true});return r.result.result.value};
  const out=[];
  out.push((await ev("!!document.querySelector('#btn-dice svg')")?'PASS':'FAIL')+' 骰子=SVG');
  out.push((await ev("!!document.querySelector('#btn-calc svg')")?'PASS':'FAIL')+' 计算器=SVG');
  out.push((await ev("getComputedStyle(document.getElementById('btn-tsumo-ron')).backgroundColor")==='rgb(30, 122, 78)'?'PASS':'FAIL')+' 和牌结算主按钮');
  out.push((await ev("document.getElementById('btn-back-main').getBoundingClientRect().height")>=44?'PASS':'FAIL')+' 返回热区≥44');
  out.push((await ev("(function(){var s=document.querySelector('.seat')||document.body;var d=document.createElement('div');d.className='pts neg2';s.appendChild(d);var c=getComputedStyle(d).color;d.remove();return c})()")==='rgb(143, 107, 18)'?'PASS':'FAIL')+' 0分色=gold');
  out.push((await ev("getComputedStyle(document.getElementById('toast')).backgroundColor")==='rgba(21, 95, 61, 0.95)'?'PASS':'FAIL')+' toast token 生效');
  console.log(out.join('\n'));
  ws.close();setTimeout(()=>process.exit(out.some(s=>s.startsWith('FAIL'))?2:0),150);
})().catch(e=>{console.error('✗',e.message);process.exit(1)});
