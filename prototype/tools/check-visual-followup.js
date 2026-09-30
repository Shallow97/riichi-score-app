const http = require('http');
function getJson(url){return new Promise((res,rej)=>{http.get(url,(r)=>{let s='';r.on('data',d=>s+=d);r.on('end',()=>{try{res(JSON.parse(s))}catch(e){rej(e)}})}).on('error',rej)})}
(async()=>{
  const targets = await getJson('http://127.0.0.1:9333/json');
  const page = targets.find(t=>t.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws fail'))});
  let id=0;const pending=new Map();
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}};
  const call=(method,params)=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}))});
  const ev=async(expr)=>{const r=await call('Runtime.evaluate',{expression:expr,returnByValue:true});return r.result.result.value};
  // 0分色：临时挂一个 .pts.neg2 读计算样式
  const neg2 = await ev("(function(){var s=document.querySelector('.seat');var d=document.createElement('div');d.className='pts neg2';s.appendChild(d);var c=getComputedStyle(d).color;d.remove();return c})()");
  console.log('0分色 =', neg2, neg2==='rgb(143, 107, 18)'?'PASS':'FAIL');
  // you-mark 字号：临时挂一个
  const you = await ev("(function(){var s=document.querySelector('.seat');var d=document.createElement('span');d.className='you-mark';s.appendChild(d);var c=getComputedStyle(d).fontSize;d.remove();return c})()");
  console.log('you-mark 字号 =', you, you==='11px'?'PASS':'FAIL');
  const meta = await ev("(function(){var s=document.querySelector('.seat');var d=document.createElement('div');d.className='meta';s.appendChild(d);var c=getComputedStyle(d).fontSize;d.remove();return c})()");
  console.log('meta 字号 =', meta);
  ws.close();setTimeout(()=>process.exit(0),150);
})().catch(e=>{console.error('✗',e.message);process.exit(1)});
