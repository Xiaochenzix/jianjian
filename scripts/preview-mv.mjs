import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeScore } from './mv-audio.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cache=join(root,'.tools','mv-cache');mkdirSync(cache,{recursive:true});
const score=join(cache,'score.wav');
console.log('Preparing the original 48-second score…');writeScore(score);
const routes=new Map([
  ['/',[join(root,'mv','index.html'),'text/html; charset=utf-8']],
  ['/film.js',[join(root,'mv','film.js'),'text/javascript; charset=utf-8']],
  ['/player.js',[join(root,'mv','player.js'),'text/javascript; charset=utf-8']],
  ['/player.css',[join(root,'mv','player.css'),'text/css; charset=utf-8']],
  ['/icon.svg',[join(root,'web','icon.svg'),'image/svg+xml']],
  ['/score.wav',[score,'audio/wav']],
  ['/download/jianjian-mv.mp4',[join(root,'releases','jianjian-mv.mp4'),'video/mp4']],
]);
const server=createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
  let pathname;
  try{pathname=new URL(req.url,'http://127.0.0.1').pathname;}catch{res.writeHead(400).end('Bad request');return;}
  const entry=routes.get(pathname);
  if(!entry||!existsSync(entry[0])){res.writeHead(404).end('Not found');return;}
  const [file,type]=entry,size=statSync(file).size;
  const headers={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'};
  let start=0,end=size-1,code=200;
  if(req.headers.range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}
    start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));end=m[1]&&m[2]?Math.min(Number(m[2]),size-1):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}
    code=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length']=end-start+1;res.writeHead(code,headers);
  if(req.method==='HEAD'){res.end();return;}
  const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
});
server.on('error',error=>{console.error(`MV preview failed: ${error.message}`);process.exitCode=1;});
server.listen(Number(process.env.MV_PORT||8790),'127.0.0.1',()=>console.log(`Jianjian MV: http://127.0.0.1:${server.address().port}`));
