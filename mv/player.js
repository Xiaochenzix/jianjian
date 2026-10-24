(() => {
  'use strict';
  const film=window.JianjianFilm,canvas=document.querySelector('#film'),audio=document.querySelector('#score');
  const play=document.querySelector('#play'),start=document.querySelector('#start'),seek=document.querySelector('#seek'),time=document.querySelector('#time'),mute=document.querySelector('#mute'),status=document.querySelector('#status');
  const chapters=[...document.querySelectorAll('[data-time]')];
  let raf=0,started=false,busy=false;
  audio.volume=.8;
  const clock=n=>`00:${String(Math.floor(n)).padStart(2,'0')}`;
  function draw(){
    const t=Math.min(film.duration,audio.currentTime||0);
    film.render(canvas,started?t:3);seek.value=t;seek.setAttribute('aria-valuetext',`${t.toFixed(1)} 秒，共 48 秒`);time.textContent=`${clock(t)} / 00:48`;
    const chapter=Math.min(5,Math.floor(t/8));chapters.forEach((el,i)=>{if(i===chapter)el.setAttribute('aria-current','true');else el.removeAttribute('aria-current');});
    canvas.setAttribute('aria-label',`剪剪品牌短片：${film.chapters[chapter]}`);
  }
  function loop(){draw();if(!audio.paused&&!audio.ended)raf=requestAnimationFrame(loop);}
  function sync(){
    const playing=!audio.paused&&!audio.ended;
    play.innerHTML=playing?'Ⅱ<span>暂停</span>':audio.ended?'↻<span>重播</span>':'▶<span>播放</span>';
    play.setAttribute('aria-label',playing?'暂停':audio.ended?'重新播放':'播放');start.hidden=started;
    cancelAnimationFrame(raf);draw();if(playing)raf=requestAnimationFrame(loop);
  }
  async function toggle(){
    if(busy)return;
    if(!audio.paused){audio.pause();return;}
    busy=true;
    try{if(audio.ended||audio.currentTime>=47.99)audio.currentTime=0;await audio.play();started=true;status.textContent='原创电子配乐 · 空格暂停 / 继续，方向键跳转 5 秒。';sync();}
    catch{status.textContent='音乐暂时无法播放，请确认预览服务运行后重试。';}
    finally{busy=false;}
  }
  function jump(t){started=true;audio.currentTime=Math.max(0,Math.min(48,t));sync();}
  play.addEventListener('click',toggle);start.addEventListener('click',toggle);
  seek.addEventListener('input',()=>jump(Number(seek.value)));
  chapters.forEach(el=>el.addEventListener('click',()=>{jump(Number(el.dataset.time));if(audio.paused)toggle();}));
  for(const event of ['play','pause','ended','seeked','loadedmetadata'])audio.addEventListener(event,sync);
  audio.addEventListener('ended',()=>{status.textContent='短片已结束。点击重播，再让灵感流动一次。';});
  audio.addEventListener('error',()=>{status.textContent='配乐加载失败，请重新启动 npm run mv 后刷新页面。';});
  mute.addEventListener('click',()=>{audio.muted=!audio.muted;mute.textContent=audio.muted?'音乐 关':'音乐 开';mute.setAttribute('aria-pressed',String(audio.muted));mute.setAttribute('aria-label',audio.muted?'开启音乐':'静音');});
  document.querySelector('#full').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.querySelector('.player').requestFullscreen();}catch{status.textContent='当前浏览器不支持全屏，可放大窗口观看。';}});
  document.addEventListener('keydown',event=>{if(/INPUT|BUTTON|A|TEXTAREA/.test(event.target.tagName))return;if(event.code==='Space'){event.preventDefault();toggle();}if(event.code==='ArrowRight'){event.preventDefault();jump(audio.currentTime+5);}if(event.code==='ArrowLeft'){event.preventDefault();jump(audio.currentTime-5);}});
  fetch('/download/jianjian-mv.mp4',{method:'HEAD'}).then(r=>{if(!r.ok){const a=document.querySelector('#download');a.removeAttribute('href');a.removeAttribute('download');a.textContent='导出命令：npm run mv:render';}}).catch(()=>{});
  draw();
})();
