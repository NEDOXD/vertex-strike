// Vertex Strike Online server. No dependencies: node server.js  (PORT env supported)
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const PORT=process.env.PORT||3000,HTML=path.join(__dirname,'index.html'),MODES=['comp','tdm','dm','gg','horde','prac'],MAXP=10,LADN=7;
let nid=1,gz=null;const rooms=new Map();

const srv=http.createServer((q,s)=>{const u=q.url.split('?')[0];
 if(u=='/health'){s.end('ok');return}
 if(u=='/'||u=='/index.html'){try{if(!gz)gz=zlib.gzipSync(fs.readFileSync(HTML));const z=/gzip/.test(q.headers['accept-encoding']||'');
  s.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Encoding':z?'gzip':'identity'});s.end(z?gz:zlib.gunzipSync(gz))}catch(e){s.writeHead(500);s.end('index.html missing next to server.js')}return}
 s.writeHead(404);s.end('not found')});

/* ---- minimal WebSocket (RFC 6455, text frames) ---- */
function frame(op,p){const n=p.length;let h;if(n<126)h=Buffer.from([128|op,n]);else if(n<65536){h=Buffer.alloc(4);h[0]=128|op;h[1]=126;h.writeUInt16BE(n,2)}else{h=Buffer.alloc(10);h[0]=128|op;h[1]=127;h.writeBigUInt64BE(BigInt(n),2)}return Buffer.concat([h,p])}
function onData(c,d){c.buf=Buffer.concat([c.buf,d]);
 for(;;){const b=c.buf;if(b.length<2)return;let len=b[1]&127,off=2;const mk=b[1]&128,op=b[0]&15,fin=b[0]&128;
  if(len==126){if(b.length<4)return;len=b.readUInt16BE(2);off=4}else if(len==127){if(b.length<10)return;len=Number(b.readBigUInt64BE(2));off=10}
  if(len>65536){c.sock.destroy();return}
  const end=off+(mk?4:0)+len;if(b.length<end)return;
  let p=Buffer.from(b.subarray(off+(mk?4:0),end));if(mk){const m=b.subarray(off,off+4);for(let i=0;i<p.length;i++)p[i]^=m[i&3]}
  c.buf=b.subarray(end);
  if(op==8){c.sock.end();return}if(op==9){c.sock.write(frame(10,p));continue}if(op==10){c.live=1;continue}
  if(op==1||op==0){c.fr=op==1?[p]:(c.fr||[]).concat([p]);if(fin){const s=Buffer.concat(c.fr).toString();c.fr=null;try{handle(c,JSON.parse(s))}catch(e){}}}}}
srv.on('upgrade',(req,sock)=>{const key=req.headers['sec-websocket-key'];if(!key){sock.destroy();return}
 sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\r\n\r\n');
 const c={id:'p'+(nid++),sock,buf:Buffer.alloc(0),name:'Player',room:null,live:1,tm:0,k:0,d:0,lv:0,al:0};sock.setNoDelay(true);
 c.send=o=>{if(!sock.destroyed)sock.write(frame(1,Buffer.from(JSON.stringify(o))))};
 sock.on('data',d=>onData(c,d));sock.on('close',()=>leave(c));sock.on('error',()=>{});c.send({t:'hi',id:c.id})});
setInterval(()=>{});/* keep alive */
setInterval(()=>{for(const r of rooms.values())for(const p of r.pl.values()){if(!p.live){p.sock.destroy();continue}p.live=0;if(!p.sock.destroyed)p.sock.write(frame(9,Buffer.alloc(0)))}},25000);

/* ---- rooms ---- */
const code=()=>{let s;do{s=Array.from({length:4},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random()*24|0]).join('')}while(rooms.has(s));return s};
const snap=r=>({t:'room',code:r.code,name:r.name,mode:r.mode,map:r.map,host:r.host,bots:r.bots,botN:r.botN,st:r.st,pl:[...r.pl.values()].map(p=>({id:p.id,nm:p.name,tm:p.tm}))});
const bc=(r,o,ex)=>{for(const p of r.pl.values())if(p!==ex)p.send(o)};
const sendRoom=r=>bc(r,snap(r));
const scMsg=r=>({t:'sc',tk:r.tk,pl:[...r.pl.values()].map(p=>({id:p.id,k:p.k,d:p.d,lv:p.lv}))});
const anyAlive=r=>[...r.pl.values()].some(p=>p.al);

function join(c,r){if(r.pl.size>=MAXP)return c.send({t:'err',m:'Room is full'});
 if(r.st=='play'&&r.mode=='comp')return c.send({t:'err',m:'Competitive round in progress — try again after the match'});
 leave(c);c.room=r;const n=[0,0];r.pl.forEach(p=>n[p.tm]++);c.tm=n[0]<=n[1]?0:1;c.k=c.d=c.lv=0;c.al=r.st=='play'?1:0;r.pl.set(c.id,c);sendRoom(r);
 if(r.st=='play'){c.send(Object.assign(snap(r),{t:'start',map:r.curMap}));c.send(scMsg(r))}}
function leave(c){const r=c.room;if(!r)return;c.room=null;r.pl.delete(c.id);
 if(!r.pl.size){clearInterval(r.iv);if(r.rd){clearTimeout(r.rd.t1);clearTimeout(r.rd.t2)}rooms.delete(r.code);return}
 if(r.host===c.id)r.host=r.pl.keys().next().value;sendRoom(r);
 if(r.st=='play'){if(r.mode=='comp')elim(r);if(r.mode=='horde'&&!anyAlive(r))endGame(r,{w:-1,sub:'Reached wave '+(r.wave||1)})}}
function startGame(r){r.st='play';r.tk=[0,0];r.rd=null;r.wave=1;if(r.mode=='horde')r.bots=1;r.curMap=r.map<0?(Math.random()*5|0):r.map;
 r.pl.forEach(p=>{p.k=p.d=p.lv=0;p.al=1});bc(r,Object.assign(snap(r),{t:'start',map:r.curMap}));bc(r,scMsg(r));if(r.mode=='comp')rdStart(r,1,1)}
function endGame(r,o){if(r.st!='play')return;r.st='lobby';if(r.rd){clearTimeout(r.rd.t1);clearTimeout(r.rd.t2)}clearInterval(r.iv);r.iv=0;r.rd=null;bc(r,Object.assign({t:'end'},o));sendRoom(r)}
function award(r,killer,vname,hs,kn){
 if(killer){killer.k++;if(r.mode=='gg')killer.lv++;if(r.mode=='tdm')r.tk[killer.tm]++}
 bc(r,{t:'feed',k:killer&&killer.id,x:(killer?killer.name:kn||'Bot')+' ▸ '+vname+(hs?'  ⌖':'')});bc(r,scMsg(r));
 if(!killer)return;
 if(r.mode=='dm'&&killer.k>=15)endGame(r,{w:killer.id,sub:killer.name+' won Deathmatch · '+killer.k+' kills'});
 else if(r.mode=='gg'&&killer.lv>=LADN)endGame(r,{w:killer.id,sub:killer.name+' completed Arms Race'});
 else if(r.mode=='tdm'&&r.tk[killer.tm]>=25)endGame(r,{w:killer.tm,sub:'Team Deathmatch '+r.tk[0]+' – '+r.tk[1]})}
/* competitive rounds: team 0 attacks (plants), team 1 defends */
function rdStart(r,n,first){const d=r.rd=r.rd||{score:[0,0]};d.round=n;d.phase='buy';d.planted=0;d.cnt=[0,0];r.pl.forEach(p=>{p.al=1;d.cnt[p.tm]++});
 if(!first)bc(r,{t:'rs',round:n,score:d.score});clearTimeout(d.t1);
 d.t1=setTimeout(()=>{if(r.rd===d&&r.st=='play'){d.phase='live';d.end=Date.now()+100000}},6000);
 if(!r.iv)r.iv=setInterval(()=>{const d=r.rd;if(!d||d.phase!='live')return;const n=Date.now();if(d.planted){if(n>d.bombAt)roundEnd(r,0)}else if(n>d.end)roundEnd(r,1)},250)}
function roundEnd(r,win){const d=r.rd;if(!d||d.phase!='live')return;d.phase='end';d.score[win]++;bc(r,{t:'re',win,score:d.score});
 d.t2=setTimeout(()=>{if(r.st!='play'||r.rd!==d)return;if(d.score[win]>=4)endGame(r,{w:win,sub:d.score[0]+' – '+d.score[1]});else rdStart(r,d.round+1)},3500)}
function elim(r){const d=r.rd;if(!d||d.phase!='live')return;const a=[0,0];r.pl.forEach(p=>{if(p.al)a[p.tm]++});
 if(d.cnt[1]>0&&!a[1])roundEnd(r,0);else if(d.cnt[0]>0&&!a[0]&&!d.planted)roundEnd(r,1)}

function handle(c,m){const r=c.room,host=r&&r.host===c.id;
 switch(m.t){
 case'name':c.name=String(m.n||'Player').replace(/[<>&"]/g,'').slice(0,14)||'Player';break;
 case'list':c.send({t:'rooms',rooms:[...rooms.values()].map(r=>({code:r.code,name:r.name,mode:r.mode,map:r.map,n:r.pl.size,bots:r.bots,st:r.st}))});break;
 case'create':{if(!MODES.includes(m.mode))break;leave(c);const r=rooms.size<200&&{code:code(),name:String(m.name||'Room').replace(/[<>&"]/g,'').slice(0,24),mode:m.mode,map:+m.map||0,host:c.id,bots:m.mode=='horde'?1:0,botN:6,st:'lobby',pl:new Map(),tk:[0,0]};if(!r)break;rooms.set(r.code,r);join(c,r);break}
 case'join':{const x=rooms.get(String(m.code||'').toUpperCase());if(!x)c.send({t:'err',m:'Room not found'});else join(c,x);break}
 case'cfg':if(host&&r.st=='lobby'){r.map=Math.max(-1,Math.min(4,+m.map|0));r.bots=r.mode=='horde'?1:m.bots?1:0;r.botN=Math.max(1,Math.min(14,+m.botN|0||6));sendRoom(r)}break;
 case'team':if(r&&r.st=='lobby'){c.tm=m.tm?1:0;sendRoom(r)}break;
 case'start':if(host&&r.st=='lobby')startGame(r);break;
 case's':if(r&&r.st=='play'){m.id=c.id;bc(r,m,c)}break;
 case'f':if(r&&r.st=='play')bc(r,{t:'f',id:c.id},c);break;
 case'bots':if(host&&r.st=='play'){r.wave=m.w||r.wave;bc(r,m,c)}break;
 case'hit':{if(!r||r.st!='play')break;const d=+m.d;if(!(d>0&&d<=150))break;const by=host&&String(m.by||'')[0]=='b'?String(m.by):c.id;
  if(String(m.to)[0]=='b'){const h=r.pl.get(r.host);if(h&&h!==c)h.send({t:'hit',to:m.to,d,hs:m.hs?1:0,by})}
  else{const v=r.pl.get(m.to);if(v&&v.al)v.send({t:'hit',d,hs:m.hs?1:0,by})}break}
 case'died':{if(!r||r.st!='play'||!c.al)break;c.al=0;c.d++;award(r,r.pl.get(m.by)||null,c.name,0,String(m.bn||'').slice(0,14));
  if(r.st=='play'){if(r.mode=='horde'&&!anyAlive(r))endGame(r,{w:-1,sub:'Reached wave '+(r.wave||1)});if(r.mode=='comp')elim(r)}break}
 case'bk':{if(!r||r.st!='play')break;const k=m.by?r.pl.get(m.by):null;if(m.by&&!k)break;if(!host&&c!==k)break;award(r,k,String(m.v||'Bot').slice(0,14),m.hs,String(m.kn||'').slice(0,14));break}
 case'al':if(r&&r.st=='play'&&r.mode!='comp')c.al=1;break;
 case'plant':{const d=r&&r.rd;if(d&&r.mode=='comp'&&d.phase=='live'&&!d.planted&&c.tm==0&&c.al){d.planted=1;d.bombAt=Date.now()+25000;bc(r,{t:'plant',s:m.s|0})}break}
 case'defuse':{const d=r&&r.rd;if(d&&r.mode=='comp'&&d.phase=='live'&&d.planted&&c.tm==1&&c.al)roundEnd(r,1);break}
 case'leave':leave(c);break}}

srv.listen(PORT,()=>console.log('Vertex Strike Online on http://localhost:'+PORT));
