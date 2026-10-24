/* Deterministic motion design. One time coordinate drives both preview and export. */
(() => {
  'use strict';
  const W = 1920, H = 1080, TAU = Math.PI * 2;
  const C = { paper:'#f2f3e9', ink:'#183c2f', green:'#23634b', lime:'#d0ed91', pale:'#dde5d3', muted:'#8c9e90', white:'#fffef8', peach:'#eebfa2' };
  const chapters = ['灵感，不必重来', '复制，让想法接着走', '文件，顺手就到', '设备不同，节奏相同', '自己的服务器，自己的空间', '剪剪 · 让灵感流动'];
  let c;
  const clamp = (v,a=0,b=1) => Math.max(a,Math.min(b,v));
  const ease = v => 1-Math.pow(1-clamp(v),3);
  const smooth = v => { v=clamp(v); return v*v*(3-2*v); };
  const enter = (t,d=0,length=.85) => ease((t-d)/length);
  const beat = t => Math.pow(1-((t*2)%1),5);
  const lerp = (a,b,t) => a+(b-a)*t;
  function group(fn,x=0,y=0,s=1,r=0,alpha=1) { c.save(); c.translate(x,y); c.scale(s,s); c.rotate(r); c.globalAlpha*=clamp(alpha); fn(); c.restore(); }
  function rect(x,y,w,h,r=0,fill=C.white,stroke) { c.beginPath(); c.roundRect(x,y,w,h,r); if(fill){c.fillStyle=fill;c.fill();} if(stroke){c.strokeStyle=stroke;c.lineWidth=2;c.stroke();} }
  function line(x,y,xx,yy,color=C.ink,width=2) { c.beginPath();c.moveTo(x,y);c.lineTo(xx,yy);c.strokeStyle=color;c.lineWidth=width;c.stroke(); }
  function circle(x,y,r,fill,stroke,width=2) { c.beginPath();c.arc(x,y,Math.max(.001,r),0,TAU);if(fill){c.fillStyle=fill;c.fill();}if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.stroke();} }
  function text(str,x,y,size=32,color=C.ink,weight=400,align='left') { c.font=`${weight} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;c.fillStyle=color;c.textAlign=align;c.textBaseline='alphabetic';c.fillText(str,x,y); }
  function mono(str,x,y,size=20,color=C.muted,align='left') { c.font=`${size}px Consolas, monospace`;c.fillStyle=color;c.textAlign=align;c.fillText(str,x,y); }
  function label(str,x,y,color=C.ink) { text(str,x,y,21,color,500); }
  function shadow(fn) { c.save();c.shadowColor='#0c2f2012';c.shadowBlur=45;c.shadowOffsetY=18;fn();c.restore(); }
  function logo(x,y,size=80,dark=false) {
    group(()=>{rect(0,0,64,64,19,dark?C.lime:C.green);c.strokeStyle=dark?C.ink:C.paper;c.lineWidth=3.4;c.lineCap='round';c.lineJoin='round';c.beginPath();c.moveTo(24,16);c.lineTo(18,16);c.lineTo(18,47);c.lineTo(38,47);c.lineTo(38,41);c.stroke();c.strokeRect(27,23,19,25);line(33,32,39,38,dark?C.ink:C.paper,3.4);line(39,32,33,38,dark?C.ink:C.paper,3.4);circle(45,17,4,dark?C.green:C.lime);},x,y,size/64);
  }
  function arrow(x,y,size=38,color=C.ink) { line(x-size*.5,y,x+size*.5,y,color,3);line(x+size*.5,y,x+size*.1,y-size*.4,color,3);line(x+size*.5,y,x+size*.1,y+size*.4,color,3); }
  function tick(x,y,color=C.green,s=1) { group(()=>{line(-8,0,-2,6,color,3);line(-2,6,10,-8,color,3);},x,y,s); }
  function grid(t,dark=false) {
    const bg=dark?C.ink:C.paper;
    rect(0,0,W,H,0,bg);
    c.save();c.globalAlpha=dark?.15:.22;
    for(let x=80;x<W;x+=64) for(let y=160;y<H-70;y+=64) circle(x,y,1.35,dark?C.pale:'#9caf98');
    c.restore();
    group(()=>{circle(1610,280,300+10*Math.sin(t*.7),null,dark?'#335846':'#e2e7d8',1.5);circle(1610,280,365,null,dark?'#335846':'#e2e7d8',1);},0,0);
  }
  function frame(index,t,dark=false) {
    const fg=dark?C.paper:C.ink, muted=dark?'#95ad9b':'#819180';
    logo(84,57,44,dark);text('剪剪',144,89,28,fg,600);mono('JIANJIAN / MOTION FILM',253,87,17,muted);
    mono('A LITTLE LESS DISTANCE.',W-88,87,19,muted,'right');
    line(84,126,1836,126,dark?'#42604d':'#d8dece',1);
    mono(`0${index+1} / 06`,86,1004,21,muted);label(chapters[index],251,1004,muted);
    for(let i=0;i<6;i++){rect(1370+i*76,993,60,3,1,dark?'#42604d':'#d7dfcf');if(i<index)rect(1370+i*76,993,60,3,1,dark?C.lime:C.green);if(i===index)rect(1370+i*76,993,60*clamp(t/8),3,1,dark?C.lime:C.green);}
  }
  function headline(lines,x,y,t,dark=false,size=90) {
    lines.forEach((str,i)=>{const a=enter(t,.1+i*.14);group(()=>text(str,0,0,size,dark?C.paper:C.ink,600),x,y+i*(size+24)+(1-a)*65,1,0,a);});
  }
  function pill(str,x,y,w,dark=false) { rect(x,y,w,48,24,dark?'#294c3a':'#e1e8d7');text(str,x+w/2,y+32,20,dark?C.lime:C.green,400,'center'); }
  function orbitPacket(t,cx,cy,rx,ry,phase,kind) {
    const a=t*.3+phase, x=cx+Math.cos(a)*rx, y=cy+Math.sin(a)*ry;
    group(()=>{shadow(()=>rect(-80,-49,160,98,22,C.white));if(kind===0){text('Aa',-52,18,43,C.green,600);line(15,-12,54,-12,C.muted,3);line(15,9,44,9,C.muted,3);}else if(kind===1){rect(-45,-26,37,49,6,C.lime);line(7,-13,48,-13,C.muted,3);line(7,9,35,9,C.muted,3);}else{text('↗',-48,19,50,C.green);text('LINK',4,8,18,C.green,500);}},x,y,1,Math.sin(a)*.12);
  }
  function intro(t) {
    grid(t);const a=enter(t,0,1.4);
    group(()=>{
      circle(1384,525,236,null,'#c6d4b9',2);circle(1384,525,326,null,'#d4deca',1.5);
      circle(1384,525,168+beat(t)*8,C.lime);logo(1305,446,158);
      orbitPacket(t,1384,525,310,310,3.7,0);orbitPacket(t,1384,525,310,310,1.55,1);orbitPacket(t,1384,525,310,310,-.5,2);
    },0,(1-a)*90,a*.12+.88,0,a);
    label('FOR EVERYTHING YOU WANT TO KEEP.',112,260,C.green);
    headline(['灵感，','不必重来。'],105,405,t,false,113);
    group(()=>{text('把这一刻，接到下一台设备。',113,729,32,'#657c69');pill('消息',112,791,100);pill('文件',225,791,100);pill('剪贴板',338,791,126);},0,(1-enter(t,1.1))*25,1,0,enter(t,1.1));
    frame(0,t);
  }
  function smallMessage(x,y,w,title,body,t,delay=0) {
    const a=enter(t,delay,.65);group(()=>{rect(0,0,w,122,16,C.white,'#dce4d4');circle(27,29,5,C.green);text(title,43,36,18,'#8b9d85');text(body,23,84,25,C.ink,500);tick(w-28,31,C.green);},x,y+30*(1-a),1,0,a);
  }
  function desktop(x,y,w,h,t) {
    shadow(()=>rect(x,y,w,h,24,C.white,'#b9cdb9'));
    rect(x+10,y+10,w-20,45,17,'#e8edde');for(let i=0;i<3;i++)circle(x+31+i*19,y+32,5,['#b8c9a7','#c5d4b6','#d2ddc5'][i]);
    text('剪剪 / 我的时间线',x+w/2,y+38,17,'#74866c',400,'center');
    rect(x+12,y+66,132,h-80,8,'#eef2e7');logo(x+36,y+91,39);text('我的空间',x+34,y+166,17,C.green,600);
    ['全部','消息','文件','剪贴板'].forEach((s,i)=>{if(i===0)rect(x+27,y+194+i*47,99,35,7,'#dae5cd');text(s,x+43,y+218+i*47,16,'#6f8369');});
    text('接着刚才的灵感',x+173,y+103,26,C.ink,600);
    smallMessage(x+170,y+137,w-195,'来自 Android','这个想法，值得留下。',t,1.8);
    smallMessage(x+170,y+276,w-195,'来自这台电脑','下一步，就从这里继续。',t,3.4);
    rect(x+174,y+h-59,w-201,34,8,'#eef3e7');text('把文字发给自己的设备…',x+188,y+h-36,16,'#8c9e82');
    rect(x+w*.35,y+h, w*.3,39,0,'#cfdbc5');rect(x+w*.24,y+h+31,w*.52,13,6,'#b6c9ad');
  }
  function phone(x,y,w,h,t) {
    shadow(()=>rect(x,y,w,h,32,C.ink));rect(x+8,y+8,w-16,h-16,25,C.paper);rect(x+w*.33,y+12,w*.34,14,7,C.ink);
    logo(x+23,y+48,34);text('剪剪',x+69,y+74,21,C.ink,600);line(x+21,y+99,x+w-21,y+99,'#d1dcc7',1);
    text('我的时间线',x+25,y+143,25,C.ink,600);
    const a=enter(t,.6,.65);group(()=>{
      rect(0,0,w-36,146,16,C.white,'#dce4d4');circle(23,27,4,C.green);
      text('这台手机 · 剪贴板',37,33,15,'#8b9d85');
      text('这个想法，',23,80,23,C.ink,500);text('值得留下。',23,116,23,C.ink,500);
    },x+18,y+179+30*(1-a),1,0,a);
    rect(x+20,y+h-86,w-40,43,10,C.green);text('发送',x+w/2,y+h-57,20,C.paper,500,'center');
    rect(x+w*.34,y+h-22,w*.32,4,3,'#8c9a88');
  }
  function clipboard(t) {
    grid(t);label('01 / COPY. CONNECT. CONTINUE.',111,227,C.green);
    headline(['复制，','让想法接着走。'],107,333,t,false,75);
    group(()=>{text('文字与链接，汇入同一条时间线。',112,535,27,'#74866e');pill('从手机到电脑',112,577,200);text('自动发送与写入，由每台设备独立选择。',112,793,23,'#72846b');text('Android 在前台或回到应用时读取剪贴板。',112,837,21,'#89967e');},0,0,1,0,enter(t,.5));
    const a=enter(t,.2);group(()=>desktop(910,296,840,482,t),90*(1-a),0,1,0,a);
    group(()=>phone(805,448,258,438,t),-70*(1-a),0,1,0,a);
    const p=clamp((t-1.5)/1.2);if(t>1.5&&t<3.7){group(()=>{rect(-77,-31,154,62,18,C.lime);text('已复制',0,9,25,C.ink,600,'center');},lerp(938,1270,ease(p)),lerp(674,520,ease(p))-80*Math.sin(p*Math.PI),1,-.1,1-smooth((t-3)/.7));}
    frame(1,t);
  }
  function documentCard(x,y,w,h,kind,color,angle,t) {
    group(()=>{shadow(()=>rect(-w/2,-h/2,w,h,23,C.white));rect(-w/2+25,-h/2+25,w-50,h*.49,12,color);text(kind,0,-h/2+90,41,C.ink,600,'center');line(-w/2+27,h/2-74,w/2-28,h/2-74,'#9aac92',4);line(-w/2+27,h/2-47,w/2-68,h/2-47,'#d1dcc7',4);},x,y+Math.sin(t*1.4+x)*9,1,angle);
  }
  function files(t) {
    grid(t,true);label('02 / LESS SENDING. MORE MAKING.',112,239,C.lime);
    headline(['文件，','顺手就到。'],107,368,t,true,103);
    group(()=>{text('发到自己的空间，另一台设备按需下载。',112,676,29,'#b1c4b2');pill('消息 / 文件 / 剪贴板',112,735,290,true);},0,0,1,0,enter(t,.7));
    const a=enter(t,.3);group(()=>{
      c.save();c.setLineDash([6,14]);circle(1407,521,282,null,'#6b865a',2);c.restore();
      documentCard(1282,490,224,300,'DOC',C.pale,-.18,t);documentCard(1558,402,224,300,'ZIP',C.peach,.18,t);documentCard(1465,649,237,311,'PDF',C.lime,.055,t);
      const p=(t*.27)%1;circle(1407+Math.cos(p*TAU)*282,521+Math.sin(p*TAU)*282,13,C.lime);
      group(()=>{rect(-180,-32,360,64,32,C.lime);circle(-146,0,18,C.ink);tick(-146,0,C.lime,.9);text('已加入你的时间线',-112,9,25,C.ink,500);},1395,849,1,0,enter(t,2.5));
    },0,65*(1-a),1,0,a);
    frame(2,t,true);
  }
  function miniDevice(kind,x,y,t,scale=1) {
    group(()=>{
      if(kind==='Android') {rect(-79,-121,158,242,22,C.white,'#739068');rect(-63,-101,126,195,9,C.pale);rect(-20,103,40,5,3,'#7d946f');logo(-27,-39,54);}
      else {rect(-141,-94,282,178,16,C.white,'#739068');rect(-127,-79,254,147,7,C.pale);logo(-28,-34,56);rect(-41,84,82,31,0,'#adbfa2');rect(-94,111,188,8,4,'#78936e');}
      text(kind,0,169,25,C.paper,500,'center');circle(0,-175,5+beat(t)*2,C.lime);
    },x,y,scale);
  }
  function devices(t) {
    grid(t,true);label('03 / ONE ACCOUNT. YOUR DEVICES.',112,231,C.lime);
    headline(['设备不同，节奏相同。'],107,350,t,true,85);
    group(()=>text('一个账号，连接自己的 Android、Windows、macOS 与 Linux 设备。',112,419,28,'#b1c4b2'),0,0,1,0,enter(t,.5));
    line(298,651,1604,651,'#536e46',2);
    for(let i=0;i<4;i++){
      const x=310+i*430,a=enter(t,.35+i*.17);
      group(()=>miniDevice(['Android','Windows','macOS','Linux'][i],x,693,t+i,.93),0,70*(1-a),1,0,a);
      if(i<3){const p=(t*.65+i*.3)%1;circle(x+155+p*120,652,7,C.lime);}
    }
    frame(3,t,true);
  }
  function serverUnit(x,y,t) {
    shadow(()=>rect(x,y,448,340,30,C.green));
    for(let i=0;i<3;i++){rect(x+26,y+29+i*93,396,73,14,'#315f45');circle(x+59,y+66+i*93,7,(Math.floor(t*2)+i)%3===0?C.lime:'#7c9e69');for(let j=0;j<8;j++)line(x+270+j*13,y+50+i*93,x+270+j*13,y+82+i*93,'#60845b',3);text(['MESSAGES','FILES','CLIPBOARD'][i],x+87,y+73+i*93,18,C.pale,500);}
  }
  function ownSpace(t) {
    grid(t);label('04 / YOUR OWN LITTLE CORNER.',112,236,C.green);
    headline(['自己的服务器，','自己的空间。'],107,358,t,false,88);
    group(()=>{text('把消息、文件和文字剪贴板，',112,671,30,'#74866e');text('放进由你部署的日常。',112,723,30,'#74866e');pill('账号之间相互隔离',112,786,254);},0,0,1,0,enter(t,.7));
    const a=enter(t,.35);group(()=>{
      rect(1128,286,590,563,42,null,'#bbccb0');mono('MY SPACE',1165,334,23,'#77946b');circle(1671,326,7,C.green);
      serverUnit(1199,373,t);
      text('部署在自己的服务器',1423,781,29,C.green,500,'center');
      for(let i=0;i<3;i++){let p=(t*.42+i/3)%1;circle(1091,400+p*350,5+i,C.green);}
    },(1-a)*80,0,1,0,a);
    frame(4,t);
  }
  function finale(t) {
    grid(t);const a=enter(t,0,1.1);
    group(()=>{
      const scale=1+beat(t)*.012;
      group(()=>{circle(0,0,343,null,'#d2ddc6',1.5);circle(0,0,400,null,'#dce4d3',1);},960,507,scale);
      logo(900,223,120);text('剪剪',960,503,133,C.ink,600,'center');
      text('让灵感，在你的设备之间流动。',960,633,48,C.ink,500,'center');
      mono('COPY A MOMENT. KEEP IT MOVING.',960,703,24,'#849579','center');
      const b=enter(t,1.4);group(()=>{pill('消息',718,774,140);pill('文件',890,774,140);pill('剪贴板',1062,774,140);},0,22*(1-b),1,0,b);
    },0,(1-a)*45,1,0,a);
    frame(5,t);
    // Hold a readable end card; only the music fades out.
  }
  const scenes=[intro,clipboard,files,devices,ownSpace,finale];
  function render(canvas,time) {
    if(!canvas?.getContext)throw new TypeError('A canvas is required.');
    c=canvas.getContext('2d');c.save();c.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);c.lineCap='round';c.lineJoin='round';
    const t=clamp(Number(time)||0,0,47.999999), index=Math.min(5,Math.floor(t/8)),local=t-index*8;
    scenes[index](local);
    // A short horizontal wipe on the downbeat bridges each eight-second phrase.
    if(index>0&&local<.45){const p=ease(local/.45);rect(W*p,0,W*(1-p),H,0,C.lime);}
    if(t<.35){c.globalAlpha=1-smooth(t/.35);rect(0,0,W,H,0,C.paper);}
    c.restore();
  }
  window.JianjianFilm=Object.freeze({duration:48,width:W,height:H,bpm:120,chapters,render});
})();
