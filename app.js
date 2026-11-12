/* B2B Лукачёва: офлайн-сохранение в IndexedDB + подтверждаемая синхронизация */
'use strict';
const $=id=>document.getElementById(id);
const STORE='lukacheva-b2b-settings-v1';
const CACHE='lukacheva-b2b-remote-v1';
const DB_NAME='lukacheva-b2b-offline-v1';
let config=JSON.parse(localStorage.getItem(STORE)||'{}');
let remote=JSON.parse(localStorage.getItem(CACHE)||'{}');
let activeTab='office',syncing=false,jsonpSeq=0;

function message(s,warning=false){const el=$('message');el.textContent=s;el.className='notice'+(warning?' warn':'');el.hidden=false;}
function errorText(e){return (e&&e.message)||String(e||'Неизвестная ошибка');}
function role(){return String(remote.user?.role||'');}
function hasRole(r){return role()==='OWNER'||role()===r;}
function validSetup(){return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(config.endpoint||'')&&typeof config.token==='string'&&config.token.length>=40;}
function localDate(iso){try{return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Samara',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(iso));}catch(_){return iso||'';}}
function nowId(){return crypto.randomUUID();}
function num(val,what,min,max,decimal){const n=Number(String(val).trim().replace(',','.'));if(!Number.isFinite(n)||n<min||n>max||(decimal?Math.round(n*10)!==n*10:!Number.isInteger(n)))throw Error('Некорректное значение «'+what+'»');return n;}
function dbOpen(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{req.result.createObjectStore('queue',{keyPath:'opId'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function dbRun(mode,func){const db=await dbOpen();return new Promise((resolve,reject)=>{
 const tx=db.transaction('queue',mode);const st=tx.objectStore('queue');let output;
 try{output=func(st);}catch(e){db.close();reject(e);return;}
 tx.oncomplete=()=>{db.close();resolve(output);};tx.onerror=()=>{db.close();reject(tx.error);};
 });}
async function queueAll(){const db=await dbOpen();return new Promise((resolve,reject)=>{
 const tx=db.transaction('queue','readonly'),req=tx.objectStore('queue').getAll();
 req.onsuccess=()=>{const x=req.result||[];x.sort((a,b)=>String(a.at).localeCompare(String(b.at)));resolve(x);};req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close();
 });}
async function queueAdd(op){await dbRun('readwrite',st=>st.put(op));}
async function queueDelete(id){await dbRun('readwrite',st=>st.delete(id));}
async function queueMark(op,status,error){const updated={...op,localStatus:status,localError:error||''};await queueAdd(updated);}
function jsonp(action,params={}){
 return new Promise((resolve,reject)=>{
  if(!validSetup())return reject(Error('Сначала настройте URL и токен'));
  const cb='b2bcb_'+(++jsonpSeq)+'_'+Math.floor(Math.random()*10000000),tag=document.createElement('script');
  const u=new URL(config.endpoint);u.searchParams.set('action',action);u.searchParams.set('token',config.token);
  u.searchParams.set('callback',cb);u.searchParams.set('_',Date.now().toString());
  Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,String(v)));
  let timer;const finish=(err,data)=>{clearTimeout(timer);delete window[cb];tag.remove();err?reject(err):resolve(data);};
  window[cb]=data=>finish(null,data);tag.onerror=()=>finish(Error('Нет связи с Google Apps Script'));
  timer=setTimeout(()=>finish(Error('Тайм-аут ответа сервера')),12000);
  tag.src=u.toString();document.head.appendChild(tag);
 });
}
async function postOpaque(op){const payload=JSON.stringify({token:config.token,ops:[{opId:op.opId,recordId:op.recordId,type:op.type,at:op.at,data:op.data}]});
 await fetch(config.endpoint,{method:'POST',mode:'no-cors',body:new URLSearchParams({payload}),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ack(id){for(let i=0;i<3;i++){
  const r=await jsonp('status',{ids:id});if(!r.ok)throw Error(r.error||'Ошибка сервера');
  const item=(r.ops||[]).find(x=>x.id===id);
  if(item&&['APPLIED','REJECTED','ERROR'].includes(item.status))return item;
  await delay(1200);
 }return {id,status:'NOT_FOUND'};}
async function syncQueue(){if(syncing||!validSetup())return;
 syncing=true;$('syncBtn').disabled=true;$('syncBtn').textContent='Отправка…';let sent=0;
 try{
  const all=await queueAll();
  for(const op of all){
   if(op.localStatus==='REJECTED')continue;
   try{
    // Даже если POST ответил opaque, операция НЕ считается отправленной без status=APPLIED.
    await postOpaque(op);const r=await ack(op.opId);
    if(r.status==='APPLIED'){await queueDelete(op.opId);sent++;}
    else if(r.status==='REJECTED'||r.status==='ERROR'){await queueMark(op,'REJECTED',r.error||'Ошибка обработки на сервере');}
    else{await queueMark(op,'WAITING','Сервер пока не подтвердил операцию');break;}
   }catch(e){await queueMark(op,'WAITING',errorText(e));break;}
  }
  if(sent){try{await refreshRemote();}catch(e){message('Передано '+sent+' записей; обновление списка пока недоступно.',true);}}
  else if((await queueAll()).length)message('Есть неподтверждённые записи. Они остаются на телефоне до успешной синхронизации.',true);
 }catch(e){message('Синхронизация: '+errorText(e),true);}
 finally{syncing=false;$('syncBtn').disabled=false;$('syncBtn').textContent='Отправить';await renderQueue();await renderRecords();}
}
async function refreshRemote(){const r=await jsonp('bootstrap');if(!r.ok)throw Error(r.error||'Ошибка доступа');
 remote=r;localStorage.setItem(CACHE,JSON.stringify(r));renderIdentity();renderClientOptions();renderRecords();setAvailability();
}
function setAvailability(){const setup=!validSetup()||!remote.user;
 $('setup').hidden=!setup;$('nav').hidden=setup;
 document.querySelectorAll('.view').forEach(el=>el.hidden=setup||el.id!==activeTab);
 document.querySelectorAll('.tabs button').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===activeTab));
 $('settingsUser').textContent=remote.user?`${remote.user.name} (${remote.user.role})`:'';
 const cBtn=document.querySelector('[data-tab="courier"]'),oBtn=document.querySelector('[data-tab="office"]');
 cBtn.disabled=!hasRole('COURIER');oBtn.disabled=!hasRole('OFFICE');
 if(!setup&&((activeTab==='office'&&!hasRole('OFFICE'))||(activeTab==='courier'&&!hasRole('COURIER'))))switchTab(hasRole('OFFICE')?'office':'courier');
}
function renderIdentity(){const u=remote.user;$('identity').textContent=u?u.name+' · '+u.role:'Не настроено';}
function renderNetwork(){$('network').textContent=navigator.onLine?'Связь может быть доступна':'Офлайн';}
function renderClientOptions(){for(const name of ['officeClient','courierClient']){
 const el=$(name),prior=el.value;el.replaceChildren();
 for(const c of (remote.clients||[])){const opt=document.createElement('option');opt.value=c.id;opt.textContent=c.name;el.append(opt);}
 if((remote.clients||[]).some(x=>x.id===prior))el.value=prior;
 }adaptOfficeMode();}
function clientById(id){return(remote.clients||[]).find(c=>c.id===id);}
function adaptOfficeMode(){const c=clientById($('officeClient').value);$('officeMode').value=c?.mode||'BEFORE';weightVisibility();}
function weightVisibility(){$('officeWeightWrap').hidden=$('officeMode').value==='AFTER';}
function switchTab(tab){activeTab=tab;setAvailability();if(tab==='pending'){renderRecords();renderQueue();}}
function selectText(p,s){const el=document.createElement(p);el.textContent=s;return el;}
function button(text,fun){const b=document.createElement('button');b.className='outline small';b.textContent=text;b.type='button';b.addEventListener('click',fun);return b;}
const statusNames={IN_TRANSIT:'Курьер в пути',AWAITING_WEIGH:'Ожидает веса',DISCREPANCY:'Расхождение мешков',WEIGHED:'Взвешено'};
async function renderRecords(){const el=$('recordList');el.replaceChildren();const list=(remote.records||[]).filter(r=>r.status!=='WEIGHED');
 if(!list.length){el.append(selectText('div','Незавершённых записей нет.'));return;}
 for(const r of list){const card=document.createElement('div');card.className='record';card.append(selectText('strong',r.client));
  const line=`${r.pickupBags||r.receivedBags||'?'} меш. (курьер) / ${r.receivedBags||'—'} (офис) · ${localDate(r.date)}`;
  card.append(selectText('span',line));card.lastChild.className='meta';
  card.append(selectText('span',statusNames[r.status]||r.status));card.lastChild.className='tag';
  if(r.status==='IN_TRANSIT'&&hasRole('OFFICE'))card.append(button('Принять у курьера',()=>receiveRecord(r)));
  if(r.status==='AWAITING_WEIGH'&&hasRole('OFFICE'))card.append(button('Добавить вес',()=>weighRecord(r)));
  if(r.status==='DISCREPANCY'&&hasRole('OWNER'))card.append(button('Разрешить расхождение',()=>resolveRecord(r)));
  el.append(card);
 }
}
async function renderQueue(){let list=[];try{list=await queueAll();}catch(e){message('Нет доступа к локальному хранилищу. Офлайн-приёмка невозможна: '+errorText(e),true);}
 $('queueCount').textContent='Очередь: '+list.length;const el=$('localQueue');el.replaceChildren();
 if(!list.length){el.append(selectText('div','Все операции на этом телефоне подтверждены сервером.'));return;}
 for(const r of list){const card=document.createElement('div');card.className='record';card.append(selectText('strong',(clientById(r.data.clientId)?.name)||r.data.clientId||r.recordId));
  const data=r.type+' · '+(r.data.bags||'')+' меш. · '+localDate(r.at);
  card.append(selectText('span',data));card.lastChild.className='meta';
  card.append(selectText('span',r.localStatus==='REJECTED'?'Ошибка: '+r.localError:'Не подтверждено сервером. Сохранено на телефоне.'));
  card.lastChild.className=r.localStatus==='REJECTED'?'error':'meta';
  if(r.localStatus==='REJECTED')card.append(button('Удалить после проверки',async()=>{
   if(confirm('Запись отклонена сервером. Удалить её только с телефона?')){await queueDelete(r.opId);await renderQueue();}
  }));el.append(card);
 }
}
async function submitLocal(type,data,recordId){const op={opId:nowId(),recordId:recordId||nowId(),type,at:new Date().toISOString(),data,localStatus:'WAITING',localError:''};
 await queueAdd(op);await renderQueue();message('Сохранено НА ТЕЛЕФОНЕ. До подтверждения отправки не удаляйте данные приложения.');
 if(navigator.onLine)syncQueue();return op;
}
function promptBags(defaultBags){const raw=prompt('Сколько мешков фактически привезено?',String(defaultBags||1));if(raw===null)return null;return num(raw,'мешки',1,200,false);}
function promptKilos(){const raw=prompt('Общий вес, кг (например, 24,6):','');if(raw===null)return null;return num(raw,'вес',.1,1000,true);}
async function receiveRecord(r){try{
 const bags=promptBags(r.pickupBags);if(bags===null)return;
 const data={bags};if(r.mode==='BEFORE'){const weight=promptKilos();if(weight===null)return;data.weight=weight;}
 if(bags!==r.pickupBags&&!confirm(`У курьера было ${r.pickupBags} меш., принято ${bags}. Сохранить расхождение?`))return;
 await submitLocal('RECEIVE',data,r.id);
 }catch(e){message(errorText(e),true);}}
async function weighRecord(r){try{const weight=promptKilos();if(weight!==null)await submitLocal('WEIGH',{weight},r.id);}catch(e){message(errorText(e),true);}}
async function resolveRecord(r){const note=prompt('Укажите причину расхождения и решение:','');if(note===null||!note.trim())return;await submitLocal('RESOLVE',{note},r.id);}
function buildForms(){
 $('officeForm').addEventListener('submit',async e=>{e.preventDefault();try{
  if(!hasRole('OFFICE'))throw Error('Нет доступа к приёмке');
  const data={clientId:$('officeClient').value,bags:num($('officeBags').value,'мешки',1,200,false),mode:$('officeMode').value,note:$('officeNote').value};
  if(data.mode==='BEFORE')data.weight=num($('officeWeight').value,'вес',.1,1000,true);
  await submitLocal('DIRECT',data);$('officeWeight').value='';$('officeNote').value='';$('officeBags').value='1';
 }catch(e){message(errorText(e),true);}});
 $('courierForm').addEventListener('submit',async e=>{e.preventDefault();try{
  if(!hasRole('COURIER'))throw Error('Нет доступа курьера');
  const data={clientId:$('courierClient').value,bags:num($('courierBags').value,'мешки',1,200,false),note:$('courierNote').value};
  await submitLocal('PICKUP',data);$('courierNote').value='';$('courierBags').value='1';
 }catch(e){message(errorText(e),true);}});
}
async function init(){
 if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(e=>message('Не удалось включить офлайн-запуск: '+errorText(e),true));
 $('endpoint').value=config.endpoint||'';$('token').value=config.token||'';
 $('saveSetup').addEventListener('click',async()=>{
  const old={...config};config={endpoint:$('endpoint').value.trim(),token:$('token').value.trim()};
  if(!validSetup()){config=old;message('Неверный адрес /exec или короткий токен.',true);return;}
  localStorage.setItem(STORE,JSON.stringify(config));
  try{await refreshRemote();if(navigator.storage?.persist)await navigator.storage.persist();message('Подключено. Теперь добавьте приложение на главный экран телефона.');switchTab(hasRole('OFFICE')?'office':'courier');}
  catch(e){config=old;localStorage.setItem(STORE,JSON.stringify(config));message('Не удалось проверить подключение: '+errorText(e),true);}
 });
 $('syncBtn').addEventListener('click',syncQueue);$('refreshBtn').addEventListener('click',async()=>{try{await refreshRemote();message('Список обновлён.');}catch(e){message(errorText(e),true);}});
 $('recheck').addEventListener('click',async()=>{try{await refreshRemote();message('Соединение работает.');}catch(e){message(errorText(e),true);}});
 $('showSetup').addEventListener('click',()=>{$('setup').hidden=false;message('Перед заменой токена дождитесь нулевой очереди.',true);});
 document.querySelectorAll('.tabs button').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
 $('officeClient').addEventListener('change',adaptOfficeMode);$('officeMode').addEventListener('change',weightVisibility);
 window.addEventListener('online',()=>{renderNetwork();syncQueue();});window.addEventListener('offline',renderNetwork);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&navigator.onLine)syncQueue();});
 renderNetwork();renderIdentity();renderClientOptions();buildForms();setAvailability();await renderQueue();await renderRecords();
 if(validSetup()){
  try{await refreshRemote();if(navigator.onLine)syncQueue();}
  catch(e){message('Работаем с сохранённым справочником. Проверка связи: '+errorText(e),true);}
 }
}
init().catch(e=>message('Ошибка запуска: '+errorText(e),true));
