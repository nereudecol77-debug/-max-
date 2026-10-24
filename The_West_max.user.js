// ==UserScript==
// @name         The West -max- | Piloto 2.0
// @namespace    https://the-west-scripts.github.io/
// @version      2.0.0
// @description  Piloto: trabalho unico, fila, duracao, bonus diario e diagnostico.
// @match        https://*.the-west.com.br/game.php*
// @match        https://*.the-west.net/game.php*
// @match        https://*.the-west.org/game.php*
// @updateURL    https://raw.githubusercontent.com/nereudecol77-debug/-max-/main/The_West_max.meta.js
// @downloadURL  https://raw.githubusercontent.com/nereudecol77-debug/-max-/main/The_West_max.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==
(function(){
 'use strict';
 const KEY='thewest_max_piloto_v13' // Mantem configuracoes da v1.3;
 const defaults={auto:true,duration:15,job:null,bonus:true,rest:true,healthMin:20};
 let config={...defaults};
 try{config={...defaults,...JSON.parse(localStorage.getItem(KEY)||'{}')}}catch(e){}
 const save=()=>localStorage.setItem(KEY,JSON.stringify(config));
 let Character,TaskQueue,JobWindow,JobList,Ajax,GameMap;
 const $=unsafeWindow.jQuery;
 let busy=false,lastAttempt=0,lastSleep=0,loadedJobs=[],loadingJobs=false;
 let failedAttempts=0;
 let restPending=false,restRequestedAt=0;
 let restConfirmedThisSession=false;
 let chosenDestination=null;
 const LIMIT=4;let lastReport='';
 function panelEvent(detail){
  if(typeof GM_xmlhttpRequest!=='function')return;
  GM_xmlhttpRequest({method:'POST',url:'http://127.0.0.1:18743/status',
   headers:{'Content-Type':'application/json'},data:JSON.stringify({state:'event',job:String(config.job&&config.job.id||''),detail}),timeout:1500});
 }
 function reportComplete(detail){
  if(lastReport===detail)return;lastReport=detail;
  info('Concluido: '+detail);
  if(typeof GM_xmlhttpRequest==='function'){
   GM_xmlhttpRequest({method:'POST',url:'http://127.0.0.1:18743/status',
    headers:{'Content-Type':'application/json'},data:JSON.stringify({state:'complete',job:String(config.job.id),detail}),timeout:1500,
    onerror:()=>info('Concluido no jogo; painel sem comunicacao local.')});
  }
 }
 function loadJobs(){
  if(loadingJobs||loadedJobs.length||!Ajax||!JobList||!GameMap)return;
  loadingJobs=true;
  try{Ajax.get('map','get_minimap',{},function(r){
   try{
    const arr=[];const seen=new Set();
    Object.keys(r.job_groups||{}).forEach(groupId=>{
     const types=JobList.getJobsByGroupId(Number(groupId))||[];
     (r.job_groups[groupId]||[]).forEach(pt=>{
      types.forEach(model=>{
       if(!model)return;
       const job=JobList.getJobById(model.id);
       if(!job||!job.canDo())return;
       const key=String(model.id)+':'+pt[0]+':'+pt[1];
       if(seen.has(key))return;seen.add(key);
       arr.push({id:Number(model.id),x:Number(pt[0]),y:Number(pt[1]),name:job.name||('Trabalho '+model.id)});
      });
     });
    });
    loadedJobs=arr.sort((a,b)=>a.name.localeCompare(b.name));
    info('Locais de trabalhos carregados: '+loadedJobs.length);
   }catch(e){info('Falha ao ler trabalhos: '+e.message)}finally{loadingJobs=false}
  });}catch(e){loadingJobs=false;info('Falha no mapa: '+e.message)}
 }

 function info(s){console.log('[The West -max-]',s);let el=document.getElementById('twmax-status');if(el)el.textContent=s}
 function ready(){
  const w=unsafeWindow;Character=w.Character;TaskQueue=w.TaskQueue;JobWindow=w.JobWindow;JobList=w.JobList;Ajax=w.Ajax;GameMap=w.GameMap;
  return !!(Character&&TaskQueue&&JobWindow&&JobList&&Ajax&&GameMap)
 }
 // Reaproveita o destino de um trabalho existente na fila quando as coordenadas
 // estiverem expostas pela API. Caso contrario calcula a menor viagem real.
 function coordinates(task){
  if(!task||typeof task!=='object')return null;
  const candidates=[task,task.data,task.params,task.task,task.extra,task.location,task.position,task.target,task.job];
  for(const v of candidates){
   if(!v||typeof v!=='object')continue;
   const x=Number(v.x),y=Number(v.y);
   if(Number.isFinite(x)&&Number.isFinite(y))return {x,y};
  }
  return null;
 }
 function queueJobId(task){
  if(!task||typeof task!=='object')return NaN;
  for(const v of [task,task.data,task.params,task.task,task.job]){
   if(!v||typeof v!=='object')continue;
   for(const key of ['jobId','job_id','workId','work_id']){
    const n=Number(v[key]);if(Number.isFinite(n)&&n>0)return n;
   }
   if(v.job&&typeof v.job==='object'){
    const n=Number(v.job.id);if(Number.isFinite(n)&&n>0)return n;
   }
  }
  return NaN;
 }
 function chooseDestination(q){
  const id=Number(config.job.id);
  const sites=loadedJobs.filter(j=>j.id===id);
  if(!sites.length)return null;
  // Preferir local de trabalho ja presente na fila. Evita trocar de quadrante.
  for(const task of q){
   if(queueJobId(task)!==id)continue;
   const pos=coordinates(task);
   if(pos){
    const existing=sites.find(j=>j.x===pos.x&&j.y===pos.y);
    if(existing)return {job:existing,source:'fila existente'};
   }
  }
  // Se os metadados da fila nao informarem o job ID, ainda podemos aproveitar
  // um destino que coincida com um local valido do trabalho selecionado.
  for(const task of q){
   const pos=coordinates(task);
   if(!pos)continue;
   const existing=sites.find(j=>j.x===pos.x&&j.y===pos.y);
   if(existing)return {job:existing,source:'coordenadas da fila'};
  }
  if(chosenDestination){
   const previous=sites.find(j=>j.x===chosenDestination.x&&j.y===chosenDestination.y);
   if(previous)return {job:previous,source:'destino mantido nesta sessao'};
  }
  const from=Character.position;
  if(!from||typeof GameMap.calcWayTime!=='function')return null;
  const ranked=sites.map(j=>{
   try{return {job:j,travel:Number(GameMap.calcWayTime(from,{x:j.x,y:j.y}))}}catch(e){return {job:j,travel:NaN}}
  }).filter(v=>Number.isFinite(v.travel)&&v.travel>=0).sort((a,b)=>a.travel-b.travel);
  return ranked.length?{job:ranked[0].job,source:'menor deslocamento ('+Math.round(ranked[0].travel)+' unidades de tempo)'}:null;
 }
 // Descanso piloto: usa a API TaskSleep documentada no HillValey.
 // Nao cancela trabalhos nem repete um descanso ja presente na fila.
 function isSleepTask(t){
  if(!t||typeof t!=='object')return false;
  const parts=[t,t.data,t.params,t.task,t.extra].filter(v=>v&&typeof v==='object');
  return parts.some(v=>{
   const values=[v.type,v.taskType,v.name,v.action,v.task_type,v.className,v.constructor&&v.constructor.name];
   return values.some(x=>typeof x==='string'&&/sleep|dormir|descanso|fortsleep/i.test(x));
  });
 }
 function attemptRest(q,energy,cost){
  if(!config.rest){reportComplete('Sem energia ('+energy+'/'+cost+'); descanso desativado.');return}
  if(q.some(isSleepTask)||restConfirmedThisSession){
   restPending=false;
   reportComplete('Descanso ja esta na fila; energia '+energy+'/'+cost+'.');return;
  }
  if(restPending){
   if(Date.now()-restRequestedAt<15000){info('Confirmando inclusao do descanso...');return}
   restPending=false;
   info('Descanso nao confirmado na fila; sem fechamento antecipado.');
   return;
  }
  const town=Character.homeTown;
  const townId=Number(town&&town.town_id);
  const Sleep=unsafeWindow.TaskSleep;
  if(!Number.isFinite(townId)||townId<=0||typeof Sleep!=='function'||typeof TaskQueue.add!=='function'){
   info('Descanso indisponivel: cidade natal ou API TaskSleep nao reconhecida.');
   return;
  }
  if(q.length>=LIMIT){reportComplete('Fila cheia: '+q.length+'/'+LIMIT);return}
  try{
   restPending=true;restRequestedAt=Date.now();
   TaskQueue.add(new Sleep(townId,'luxurious_apartment'));
   info('Solicitado descanso de 8h na cidade natal; aguardando confirmacao.');
   setTimeout(()=>{
    const now=Array.isArray(TaskQueue.queue)?TaskQueue.queue:[];
    if(now.length>q.length || now.some(isSleepTask)){
     restPending=false;restConfirmedThisSession=true;
     panelEvent('Descanso confirmado na fila: '+now.length+'/'+LIMIT+'; hotel 5 estrelas solicitado.');
     reportComplete('Descanso solicitado e fila atualizada ('+now.length+'/'+LIMIT+').');
    }else{
     restPending=false;
     info('Descanso nao confirmado; painel aguardara o tempo limite.');
    }
   },4000);
  }catch(e){restPending=false;info('Erro ao iniciar descanso: '+e.message)}
 }
 function jobs(){
  loadJobs();const unique=new Map();
  loadedJobs.forEach(j=>{if(!unique.has(j.id))unique.set(j.id,j)});
  return [...unique.values()].sort((a,b)=>a.name.localeCompare(b.name));
 }
 function tick(){
  if(!config.auto||busy||failedAttempts>=3)return;
  if(!ready()){info('Aguardando API interna do jogo...');return}
  loadJobs();
  if(!config.job){info('Selecione um trabalho na aba Trabalhos.');return}
  if(Date.now()-lastAttempt<9000)return;
  lastAttempt=Date.now();
  try{
   const q=Array.isArray(TaskQueue.queue)?TaskQueue.queue:null;
   if(!q){info('Fila ainda nao disponivel');return}
   const slots=LIMIT-q.length;
   if(slots<=0){reportComplete('Fila cheia: '+q.length+'/'+LIMIT);return}
   const hp=Number(Character.health),maxHp=Number(Character.maxHealth);
   if(maxHp>0&&hp/maxHp*100<config.healthMin){info('Saude abaixo do minimo. Sem confirmacao de conclusao.');return}
   const energy=Number(Character.energy);
   if(!Number.isFinite(energy)){info('Energia nao disponivel');return}
   const model=JobList.getJobById(Number(config.job.id));
   if(!model||!model.canDo()){info('Trabalho selecionado indisponivel');return}
   // Custos definidos para as duas duracoes aprovadas no piloto.
   // O jogo continua sendo a autoridade: confirmar aceite e reler fila/energia.
   const cost = Number(config.duration)===15 ? 1 : Number(config.duration)===3600 ? 12 : NaN;
   if(!Number.isFinite(cost)){
    info('Duracao invalida; escolha 15 segundos ou 1 hora.');return;
   }
   if(energy<cost){
    info('Fila '+q.length+'/'+LIMIT+'; energia '+energy+' menor que custo '+cost+'.');
    // Descanso nao e iniciado sem validar o destino e a API do jogo.
    attemptRest(q,energy,cost);return;
   }
   const destination=chooseDestination(q);
   if(!destination){info('Aguardando locais e calculo de distancia; fila preservada.');return}
   chosenDestination={x:destination.job.x,y:destination.job.y};
   busy=true;
   const before=q.length;
   const energyBefore=energy;
   JobWindow.startJob(config.job.id,destination.job.x,destination.job.y,config.duration);
   info('Solicitado 1 trabalho em ('+destination.job.x+','+destination.job.y+') via '+destination.source+'. Confirmando fila...');
   setTimeout(()=>{
    busy=false;
    const after=Array.isArray(TaskQueue.queue)?TaskQueue.queue.length:before;
    if(after>before){
     failedAttempts=0;
     info('Trabalho aceito: fila '+after+'/'+LIMIT+'; energia atual '+Character.energy);
     panelEvent('Trabalho '+config.job.id+' confirmado; fila '+after+'/'+LIMIT+'; energia '+Character.energy+'; local ('+destination.job.x+','+destination.job.y+').');
     lastAttempt=0;
     // Revalidar a fila e a energia antes de qualquer nova inclusao.
     setTimeout(tick,700);
    }else{
     failedAttempts++;
     info('Trabalho nao confirmado ('+failedAttempts+'/3); fila '+after+'/'+LIMIT+'; energia '+Character.energy+'.');
     if(failedAttempts>=3)info('Falha repetida; sem confirmacao de conclusao. Painel usara tempo limite.');
    }
   },4000);
  }catch(e){busy=false;info('Erro ao enfileirar: '+e.message)}
 }
 function bonus(){
  if(!config.bonus)return;
  try{document.querySelectorAll('button,a,[role="button"]').forEach(el=>{
   const t=(el.textContent||'').trim().toLowerCase();if(!['receber','claim','collect'].includes(t))return;
   let p=el,ok=false;for(let i=0;i<9&&p;i++,p=p.parentElement){if(/b[oô]nus de login di[aá]rio|daily login bonus|daily login reward/i.test((p.textContent||'').slice(0,500))){ok=true;break}}
   if(ok&&!el.dataset.twmaxClaimed){el.dataset.twmaxClaimed='1';el.click()}
  })}catch(e){}
 }
 function render(){
  if(document.getElementById('twmax-window'))return;
  const host=document.createElement('div');host.id='twmax-window';host.style.cssText='position:fixed;top:90px;right:20px;z-index:999999;background:#f5e6c7;color:#34291c;border:3px solid #74512f;padding:12px;width:370px;max-height:75vh;overflow:auto;font:13px Arial;box-shadow:0 5px 20px #0007';
  host.innerHTML='<div style="display:flex;justify-content:space-between"><b>The West -max- | Piloto 2.0</b><button id="twmax-hide">×</button></div><div id="twmax-tabs" style="margin:12px 0"></div><div id="twmax-content"></div><hr><small id="twmax-status">Aguardando o jogo...</small>';
  document.body.appendChild(host);
  const tabs=['Trabalhos','Trabalhos selecionados','Conjuntos','Configurações','Bônus'];
  const bar=host.querySelector('#twmax-tabs'),body=host.querySelector('#twmax-content');
  function tab(n){bar.innerHTML='';tabs.forEach((t,i)=>{const b=document.createElement('button');b.textContent=t;b.style.margin='2px';b.disabled=n===i;b.onclick=()=>tab(i);bar.appendChild(b)});body.innerHTML='';
   if(n===0){const list=jobs();body.innerHTML='<p>Selecione um trabalho (um por conta).</p><input id="twmax-filter" placeholder="Filtrar trabalhos" style="width:95%"><div id="twmax-joblist" style="max-height:230px;overflow:auto"></div>';const input=body.querySelector('#twmax-filter'),target=body.querySelector('#twmax-joblist');const draw=()=>{target.innerHTML='';list.filter(j=>j.name.toLowerCase().includes(input.value.toLowerCase())).slice(0,100).forEach(j=>{const b=document.createElement('button');b.textContent=j.name+' ['+j.id+']';b.style.cssText='display:block;width:100%;text-align:left;margin:2px 0';b.onclick=()=>{config.job={id:j.id,name:j.name};chosenDestination=null;failedAttempts=0;lastReport='';save();tab(1)};target.appendChild(b)});if(!list.length)target.textContent='Trabalhos ainda nao carregados. Reabra a aba depois de entrar no mapa.'};input.oninput=draw;draw()}
   if(n===1){body.innerHTML='<p>Trabalho fixo: <b>'+(config.job?config.job.name:'Nenhum')+'</b></p><button id="twmax-remove">Remover selecao</button>';body.querySelector('button').onclick=()=>{config.job=null;chosenDestination=null;failedAttempts=0;lastReport='';save();tab(1)}}
   if(n===2)body.innerHTML='<p>Conjuntos: integracao com conjuntos do jogo ainda nao implementada neste piloto. Nao altera equipamentos automaticamente.</p>';
   if(n===3){body.innerHTML='<label>Duracao dos trabalhos: <select id="twmax-duration"><option value="15">15 segundos</option><option value="3600">1 hora</option></select></label><p><label><input type="checkbox" id="twmax-auto"> Iniciar automaticamente ao entrar no jogo</label></p><p><label><input type="checkbox" id="twmax-rest"> Tentar descanso sem consumivel de energia</label></p><p>Saude minima (%): <input type="number" min="1" max="100" id="twmax-health" style="width:60px"></p><button id="twmax-save">Aplicar</button><p><small>Descanso piloto usa a cidade natal. A busca pela cidade mais proxima ainda nao esta implementada.</small></p>';body.querySelector('#twmax-duration').value=config.duration;body.querySelector('#twmax-auto').checked=config.auto;body.querySelector('#twmax-rest').checked=config.rest;body.querySelector('#twmax-health').value=config.healthMin;body.querySelector('#twmax-save').onclick=()=>{config.duration=Number(body.querySelector('#twmax-duration').value);config.auto=body.querySelector('#twmax-auto').checked;config.rest=body.querySelector('#twmax-rest').checked;config.healthMin=Number(body.querySelector('#twmax-health').value);failedAttempts=0;lastReport='';save();info('Configuracoes salvas neste perfil e origem.');tick()}}
   if(n===4){body.innerHTML='<label><input type="checkbox" id="twmax-bonus"> Receber automaticamente o bonus diario</label><p>As demais opcoes de Bonus estao planejadas para a proxima etapa.</p>';body.querySelector('input').checked=config.bonus;body.querySelector('input').onchange=e=>{config.bonus=e.target.checked;save()}}
  }
  host.querySelector('#twmax-hide').onclick=()=>host.style.display='none';tab(3)
 }
 function showButton(){if(document.getElementById('twmax-open'))return;const b=document.createElement('button');b.id='twmax-open';b.textContent='The West -max-';b.style.cssText='position:fixed;right:10px;bottom:10px;z-index:999999;background:#a9854d;color:white;padding:9px';b.onclick=()=>{const w=document.getElementById('twmax-window');if(w)w.style.display='block';else render()};document.body.appendChild(b)}
 const init=setInterval(()=>{if(!document.body)return;showButton();if(ready()){clearInterval(init);info('Jogo carregado.');loadJobs();if(!document.getElementById('twmax-window'))render()}},1000);
 setInterval(()=>{tick();bonus()},5000);
})();
