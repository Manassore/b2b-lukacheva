/* B2B Лукачёва: офлайн-сохранение в IndexedDB + подтверждаемая синхронизация */
'use strict';
const $=id=>document.getElementById(id);
const STORE='lukacheva-b2b-settings-v1';
const CACHE='lukacheva-b2b-remote-v1';
const API_VERSION=4;
const DB_NAME='lukacheva-b2b-offline-v1';
let config=JSON.parse(localStorage.getItem(STORE)||'{}');
let remote=JSON.parse(localStorage.getItem(CACHE)||'{}');
let activeTab='office',syncing=false,jsonpSeq=0;let lastOfficeOpId='';let serverProbe={state:'not_checked',error:''};let lastDirectoryCheck=0,refreshInFlight=false;

let messageTimer;
let choices=[], selectedChoice=null, pickerOpen=false, highlighted=-1;
let draftClientId='', draftItems=new Map(), savingOffice=false;

function compatible(data=remote){return Number(data.apiVersion||0)>=API_VERSION;}
function clientName(client){return client.shortName||client.name;}
function buildChoices(clients){
  return clients.flatMap(client=>{
    const objects=client.objects||[];
    return (objects.length?objects:[null]).map(object=>({
      clientId:client.id,objectId:object?.id||'',objectName:object?.name||'',address:object?.address||'',
      label:clientName(client)+(objects.length>1?' · '+object.name:''),fullName:client.name
    }));
  }).sort((a,b)=>a.label.localeCompare(b.label,'ru'));
}
function normalizeSearch(value){
  return String(value||'').toLocaleLowerCase('ru').replace(/ё/g,'е').trim().replace(/\s+/g,' ');
}
function matchingChoices(list,query){
  const q=normalizeSearch(query);
  if(!q)return list;
  const prefix=[],partial=[];
  for(const choice of list){
    const label=normalizeSearch(choice.label);
    const fields=[label,choice.fullName,choice.objectName,choice.address].map(normalizeSearch);
    if(label.startsWith(q)||(q.length>1&&fields.some(field=>field.startsWith(q))))prefix.push(choice);
    else if(q.length>1&&fields.some(field=>field.includes(q)))partial.push(choice);
  }
  return prefix.concat(partial);
}
function sameChoice(a,b){return a.clientId===b.clientId&&a.objectId===b.objectId;}

function message(s,warning=false){
  const el=$('message');clearTimeout(messageTimer);el.textContent=s;el.className='notice'+(warning?' warn':'');el.hidden=false;
  messageTimer=setTimeout(()=>{el.hidden=true;},9000);
}
function officeStatus(s,warning=false){const el=$('lastOfficeStatus');el.textContent=s;el.className='last-status'+(warning?' warn':'');el.hidden=false;}

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
async function syncQueue(manual=false){if(syncing||!validSetup())return;
 syncing=true;$('syncBtn').disabled=true;$('syncBtn').textContent='Отправка…';let sent=0;let rejected=0;
 try{
  const all=await queueAll();let checkedVersion=false;
  if(!all.length){if(manual)message('Очередь пуста — отправлять нечего.');return;}
  for(const op of all){
   if(op.localStatus==='REJECTED')continue;
   try{
    // Даже если POST ответил opaque, операция НЕ считается отправленной без status=APPLIED.
    if(Object.hasOwn(op.data,'objectId')&&!checkedVersion){
      const version=await jsonp('version');
      if(!version.ok||!compatible(version))throw Error(version.error||'Для отправки нужен сервер 1.3');
      checkedVersion=true;
    }
    await postOpaque(op);const r=await ack(op.opId);
    if(r.status==='APPLIED'){
      await queueDelete(op.opId);sent++;
      if(op.opId===lastOfficeOpId)officeStatus('Отправлено в Google Таблицу. Операция подтверждена сервером.');
    }
    else if(r.status==='REJECTED'||r.status==='ERROR'){
      rejected++;await queueMark(op,'REJECTED',r.error||'Ошибка обработки на сервере');
      if(op.opId===lastOfficeOpId)officeStatus('Ошибка отправки: '+(r.error||'Сервер отклонил запись'),true);
    }
    else{await queueMark(op,'WAITING','Сервер пока не подтвердил операцию');break;}
   }catch(e){await queueMark(op,'WAITING',errorText(e));break;}
  }
  const rest=(await queueAll()).length;
  if(sent){
    try{await refreshRemote();}catch(e){/* Отправка подтверждена сервером; список можно обновить позднее. */}
    message('Успешно отправлено в Google Таблицу: '+sent+'. В очереди осталось: '+rest+(rejected?'. Ошибок: '+rejected:'')+'.',!!rest);
  }else if(rest && (manual||rejected))message('Не отправлено. На телефоне сохранено: '+rest+'; серверных ошибок: '+rejected+'.',true);
 }catch(e){message('Синхронизация: '+errorText(e),true);}
 finally{syncing=false;$('syncBtn').disabled=false;$('syncBtn').textContent='Отправить';await renderQueue();}
}
async function refreshRemote(){
 try{
  const r=await jsonp('bootstrap');
  if(!r.ok)throw Error(r.error||'Ошибка доступа');
  serverProbe={state:'live',error:'',apiVersion:r.apiVersion??null};
  remote=r;lastDirectoryCheck=Date.now();localStorage.setItem(CACHE,JSON.stringify(r));
  renderIdentity();renderClientOptions();renderOfficeHistory();setAvailability();
 }catch(e){
  serverProbe={state:'error',error:errorText(e)};
  setAvailability();
  throw e;
 }
}
function setAvailability(){const setup=!validSetup()||!remote.user;
 $('setup').hidden=!setup;$('nav').hidden=setup;
 document.querySelectorAll('.view').forEach(el=>el.hidden=setup||el.id!==activeTab);
 document.querySelectorAll('.tabs button').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===activeTab));
 $('settingsUser').textContent=remote.user?`${remote.user.name} (${remote.user.role})`:'';
 const ready=compatible();
 updateOfficeSubmit();
 renderDirectoryStatus();
 $('apiCompatibility').hidden=setup||ready;
 if(!ready){
   const detail=serverProbe.state==='live'
    ? 'Сервер ответил, но не передал apiVersion=4 (получено: '+(serverProbe.apiVersion??'не определена')+'). Обычно это старое развёртывание /exec.'
    : serverProbe.state==='error'
    ? 'Не удалось получить свежий ответ сервера: '+serverProbe.error+'. Показаны данные, сохранённые на телефоне.'
    : 'Пока используется сохранённый справочник; свежая версия сервера ещё не проверена.';
   $('apiCompatibilityText').textContent=detail+' Нажмите «Проверить сервер».';
 }
 const oBtn=document.querySelector('[data-tab="office"]');oBtn.disabled=!hasRole('OFFICE');
 if(!setup && activeTab==='office'&&!hasRole('OFFICE'))switchTab('pending');
}
function renderIdentity(){const u=remote.user;$('identity').textContent=u?u.name+' · '+u.role:'Не настроено';}
function renderNetwork(){$('network').textContent=navigator.onLine?'Связь может быть доступна':'Офлайн';}
function captureDraftItems(){
  for(const input of document.querySelectorAll('#officeItems input[data-service]')){
    draftItems.set(input.dataset.service,input.value);
  }
}
function renderClientOptions(){
  captureDraftItems();
  choices=buildChoices(remote.clients||[]);
  if(selectedChoice){
    selectedChoice=choices.find(choice=>sameChoice(choice,selectedChoice))||null;
    if(selectedChoice){
      $('officeClient').value=selectedChoice.label;
    }else{
      $('officeClient').value='';
      message('Выбранный клиент или объект больше недоступен. Выберите из обновлённого списка.',true);
    }
  }
  highlighted=-1;
  renderPicker();
  renderOfficeFields();
}
function renderPicker(){
  const input=$('officeClient'),list=$('officeClientOptions');
  const matches=pickerOpen?matchingChoices(choices,selectedChoice?'':input.value):[];
  list.replaceChildren();
  input.removeAttribute('aria-activedescendant');
  input.setAttribute('aria-expanded',String(pickerOpen&&matches.length>0));
  list.hidden=!matches.length;
  $('officeClientEmpty').hidden=!pickerOpen||!!matches.length;
  for(const [index,choice] of matches.entries()){
    const option=button(choice.label,()=>pickChoice(choice));
    option.id='client-option-'+index;
    option.className='client-option';
    option.tabIndex=-1;
    option.setAttribute('role','option');
    option.setAttribute('aria-selected',String(index===highlighted));
    if(choice.address&&choice.label.includes(' · '))option.append(selectText('small',choice.address));
    option.addEventListener('mousedown',event=>event.preventDefault());
    list.append(option);
    if(index===highlighted)input.setAttribute('aria-activedescendant',option.id);
  }
}
function closePicker(){
  pickerOpen=false;
  highlighted=-1;
  renderPicker();
}
function pickChoice(choice){
  captureDraftItems();
  if(draftClientId&&draftClientId!==choice.clientId){
    $('officeWeight').value='';$('officeBags').value='1';$('officeNote').value='';
    draftItems.clear();
  }
  selectedChoice=choice;
  draftClientId=choice.clientId;
  $('officeClient').value=choice.label;
  closePicker();
  renderOfficeFields();
  $('officeClient').blur();
}
function bindPicker(){
  const input=$('officeClient');
  const open=()=>{pickerOpen=true;highlighted=-1;renderPicker();};
  input.addEventListener('focus',open);
  input.addEventListener('click',()=>{if(!pickerOpen)open();});
  input.addEventListener('input',()=>{
    if(selectedChoice){
      captureDraftItems();
      selectedChoice=null;
      renderOfficeFields();
    }
    open();
  });
  input.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(event.key==='Escape'){closePicker();return;}
    if(event.key==='Tab'){closePicker();return;}
    if(!['ArrowDown','ArrowUp','Enter'].includes(event.key))return;
    if(event.key==='Enter'&&!pickerOpen)return;
    event.preventDefault();
    if(!pickerOpen)open();
    const matches=matchingChoices(choices,selectedChoice?'':input.value);
    if(!matches.length)return;
    if(event.key==='Enter'){
      if(highlighted>=0)pickChoice(matches[highlighted]);
      else if(matches.length===1)pickChoice(matches[0]);
      return;
    }
    if(event.key==='ArrowDown')highlighted=Math.min(highlighted+1,matches.length-1);
    else highlighted=highlighted<0?matches.length-1:Math.max(0,highlighted-1);
    renderPicker();
    $('client-option-'+highlighted)?.scrollIntoView({block:'nearest'});
  });
  document.addEventListener('focusin',event=>{if(pickerOpen&&!$('officePicker').contains(event.target))closePicker();});
  document.addEventListener('pointerdown',event=>{if(pickerOpen&&!$('officePicker').contains(event.target))closePicker();});
}
function renderDirectoryStatus(){
  const el=$('clientDirectoryStatus');if(!el)return;
  const stamp=remote.clientDirectoryTime||remote.serverTime;
  const n=(remote.clients||[]).length;
  if(serverProbe.state==='live'){
    el.textContent='Клиентов: '+n+' · обновлено '+localDate(stamp)+' · источник: B2B-справочник';
  }else{
    el.textContent=(n?'Клиентов в сохранённом справочнике: '+n:'Клиентский справочник пока не загружен')+
      (stamp?' · данные от '+localDate(stamp):'')+' · текущая проверка недоступна';
  }
}
async function refreshOnReturn(){
  if(refreshInFlight||!validSetup()||!navigator.onLine||document.hidden)return;
  if(Date.now()-lastDirectoryCheck<12000)return;
  refreshInFlight=true;
  try{await refreshRemote();}
  catch(e){message('Не удалось обновить клиентов. Используется последний сохранённый список: '+errorText(e),true);}
  finally{refreshInFlight=false;}
}
function clientById(id){return(remote.clients||[]).find(c=>c.id===id);}
function accountType(c){return c?.accountType==='PIECE'?'PIECE':c?.accountType==='WEIGHT'?'WEIGHT':'UNKNOWN';}
function updateOfficeSubmit(){
  const client=selectedChoice&&clientById(selectedChoice.clientId);
  $('officeSubmit').disabled=savingOffice||!hasRole('OFFICE')||!compatible()||accountType(client)==='UNKNOWN';
}
function renderOfficeFields(){
  const c=selectedChoice&&clientById(selectedChoice.clientId),mode=accountType(c),piece=mode==='PIECE',unknown=!!c&&mode==='UNKNOWN';
  $('officeUnknownMode').hidden=!unknown;
  $('officeWeightFields').hidden=!c||piece||unknown;$('officePieceFields').hidden=!piece;
  $('officeBags').required=!!c&&!piece&&!unknown;$('officeWeight').required=!!c&&!piece&&!unknown;
  updateOfficeSubmit();
  const list=$('officeItems');list.replaceChildren();
  if(!piece)return;
  const services=(remote.services||[]).filter(s=>s.clientId===c.id);
  if(!services.length){list.append(selectText('p','Для клиента не настроена номенклатура. Обратитесь к руководителю.'));return;}
  for(const svc of services){
    const row=document.createElement('div');row.className='itemrow';
    const name=document.createElement('div');name.className='itemname';name.textContent=svc.name+' ('+(svc.unit||'шт')+')';row.append(name);
    const controls=document.createElement('div');controls.className='itemcontrols';
    const input=document.createElement('input');input.type='number';input.min='0';input.max='1000';input.step='1';input.value=draftItems.get(svc.code)??'0';input.inputMode='numeric';input.dataset.service=svc.code;input.setAttribute('aria-label','Количество: '+svc.name);
    const minus=button('−',()=>{input.value=String(Math.max(0,Number(input.value||0)-1));updateItemCount();});
    const plus=button('+',()=>{input.value=String(Math.min(1000,Number(input.value||0)+1));updateItemCount();});
    minus.className='itembutton';plus.className='itembutton';input.addEventListener('input',updateItemCount);
    controls.append(minus,input,plus);row.append(controls);list.append(row);
  }
  updateItemCount();
}
function updateItemCount(){
  const inputs=[...document.querySelectorAll('#officeItems input[data-service]')];
  const n=inputs.reduce((total,x)=>total+(Number.isInteger(Number(x.value))&&Number(x.value)>0?Number(x.value):0),0);
  $('officeItemCount').textContent='Всего изделий: '+n;
}
function collectItems(){
  const items=[];
  for(const input of document.querySelectorAll('#officeItems input[data-service]')){
    const qty=Number(input.value);
    if(!Number.isInteger(qty)||qty<0||qty>1000)throw Error('Количество изделий должно быть целым числом от 0 до 1000');
    if(qty>0)items.push({code:input.dataset.service,qty});
  }
  if(!items.length)throw Error('Укажите количество хотя бы одного изделия');
  return items;
}
function resetOfficeForm(){
  selectedChoice=null;draftClientId='';draftItems.clear();
  $('officeForm').reset();
  $('officeClient').value='';
  closePicker();
  renderOfficeFields();
}
function switchTab(tab){activeTab=tab;setAvailability();if(tab==='pending')renderQueue();}
function selectText(p,s){const el=document.createElement(p);el.textContent=s;return el;}
function button(text,fun){const b=document.createElement('button');b.className='outline small';b.textContent=text;b.type='button';b.addEventListener('click',fun);return b;}
async function renderQueue(){let list=[];try{list=await queueAll();}catch(e){message('Нет доступа к локальному хранилищу. Офлайн-приёмка невозможна: '+errorText(e),true);}
 $('queueCount').textContent='Очередь: '+list.length;const el=$('localQueue');el.replaceChildren();
 if(!list.length){el.append(selectText('div','Все операции на этом телефоне подтверждены сервером.'));return;}
 for(const r of list){const card=document.createElement('div');card.className='record';const client=clientById(r.data.clientId);
  const object=client?.objects?.find(o=>o.id===r.data.objectId);
  const label=(client?clientName(client):r.data.clientId)||r.recordId;
  card.append(selectText('strong',label+(r.data.objectId?' · '+(object?.name||r.data.objectName||r.data.objectId):'')));
  const qty=r.data.items?.length? r.data.items.map(i=>i.qty).reduce((a,b)=>a+b,0)+' изд.':(r.data.bags||'')+' меш.';
  const data=r.type+' · '+qty+' · '+localDate(r.at);
  card.append(selectText('span',data));card.lastChild.className='meta';
  const state=r.localStatus==='REJECTED'?'Ошибка: '+r.localError:'Сохранено на телефоне. '+(r.localError||'Ожидает подтверждения сервера.');
  card.append(selectText('span',state));
  card.lastChild.className=r.localStatus==='REJECTED'?'error':'meta';
  if(r.localStatus==='REJECTED')card.append(button('Удалить после проверки',async()=>{
   if(confirm('Запись отклонена сервером. Удалить её только с телефона?')){await queueDelete(r.opId);await renderQueue();}
  }));el.append(card);
 }
}
async function submitLocal(type,data,recordId){const op={opId:nowId(),recordId:recordId||nowId(),type,at:new Date().toISOString(),data,localStatus:'WAITING',localError:''};
 await queueAdd(op);await renderQueue();message('Сохранено на телефоне. Ожидает отправки в Google Таблицу.');
 return op;
}
function renderOfficeHistory(){
  const list=(remote.records||[]).filter(r=>r.source==='DIRECT'&&['WEIGHED','ACCEPTED_ITEMS'].includes(r.status)).slice(0,7);
  const el=$('officeHistory');el.replaceChildren();
  if(!list.length){el.append(selectText('div','Сохранённых поступлений пока нет.'));return;}
  for(const r of list){const row=document.createElement('div');row.className='record historyrow';
    const client=clientById(r.clientId);
    row.append(selectText('strong',(client?clientName(client):r.client)+(r.objectName?' · '+r.objectName:'')));
    const text=r.accountType==='PIECE'?r.itemsCount+' изд.':(r.receivedBags||0)+' меш. · '+(r.weight||0)+' кг';
    row.append(selectText('span',text+' · '+localDate(r.date)));row.lastChild.className='meta';el.append(row);
  }
}
function buildForms(){
 $('officeForm').addEventListener('submit',async e=>{
  e.preventDefault();
  if($('officeSubmit').disabled)return;
  savingOffice=true;updateOfficeSubmit();
  try{
   if(!hasRole('OFFICE'))throw Error('Нет доступа к приёмке');
   const choice=selectedChoice,c=choice&&clientById(choice.clientId);
   if(!c)throw Error('Выберите клиента');
   if(accountType(c)==='UNKNOWN')throw Error('У клиента не уточнён способ расчёта в B2B-справочнике');
   const data={clientId:choice.clientId,objectId:choice.objectId,note:$('officeNote').value};
   if(accountType(c)==='PIECE'){data.items=collectItems();}
   else {data.bags=num($('officeBags').value,'мешки',1,200,false);data.weight=num($('officeWeight').value,'вес',.1,1000,true);}
   if(choice.objectId)data.objectName=choice.objectName;
   const op=await submitLocal('DIRECT',data);lastOfficeOpId=op.opId;
   const descr=accountType(c)==='PIECE'?data.items.reduce((a,i)=>a+i.qty,0)+' изд.':data.bags+' меш., '+data.weight+' кг';
   officeStatus('Сохранено на телефоне: '+choice.label+' — '+descr+'. Ожидает подтверждения сервера.');
   resetOfficeForm();
   if(navigator.onLine)syncQueue();
  }catch(err){message(errorText(err),true);}finally{savingOffice=false;updateOfficeSubmit();}
 });

}

function bindReport(){
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Samara',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  $('reportFrom').value=today.slice(0,8)+'01';
  $('reportTo').value=today;
  $('reportForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const status=$('reportStatus'),results=$('reportResults'),submit=event.submitter;
    results.replaceChildren();
    status.textContent='Загрузка…';
    if(submit)submit.disabled=true;
    try{
      const r=await jsonp('summary',{from:$('reportFrom').value,to:$('reportTo').value});
      if(!r.ok)throw Error(r.error||'Ошибка сервера');
      status.textContent=r.clients.length?'':'За этот период подтверждённых поступлений нет.';
      for(const client of r.clients){
        const card=selectText('div','');
        card.className='record';
        card.append(selectText('strong',client.name),selectText('div',reportVolume(client)));
        const objects=document.createElement('ul');
        objects.className='report-objects';
        for(const object of client.objects)objects.append(selectText('li',object.name+' — '+reportVolume(object)));
        card.append(objects);
        results.append(card);
      }
    }catch(err){status.textContent='Сводка недоступна. '+errorText(err);}
    finally{if(submit)submit.disabled=false;}
  });
}
function reportVolume(volume){
  const localized=new Intl.NumberFormat('ru-RU');
  return localized.format(volume.weightKg)+' кг · '+localized.format(volume.items)+' изд. · '+volume.receipts+' пост.';
}

async function init(){
 if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(e=>message('Не удалось включить офлайн-запуск: '+errorText(e),true));
 $('endpoint').value=config.endpoint||'';$('token').value=config.token||'';
 $('saveSetup').addEventListener('click',async()=>{
  const old={...config};config={endpoint:$('endpoint').value.trim(),token:$('token').value.trim()};
  if(!validSetup()){config=old;message('Неверный адрес /exec или короткий токен.',true);return;}
  localStorage.setItem(STORE,JSON.stringify(config));
  try{await refreshRemote();if(navigator.storage?.persist)await navigator.storage.persist();message('Подключено. Справочник загружен.');switchTab(hasRole('OFFICE')?'office':'pending');}
  catch(e){config=old;localStorage.setItem(STORE,JSON.stringify(config));message('Не удалось проверить подключение: '+errorText(e),true);}
 });
 $('syncBtn').addEventListener('click',()=>syncQueue(true));$('refreshBtn').addEventListener('click',async()=>{try{await refreshRemote();message('Справочник и очередь обновлены.');}catch(e){message(errorText(e),true);}});
 $('refreshClientsBtn').addEventListener('click',async()=>{const btn=$('refreshClientsBtn');btn.disabled=true;try{await refreshRemote();message('Список клиентов обновлён: '+(remote.clients||[]).length+'.');}catch(e){message('Обновить клиентов не удалось: '+errorText(e),true);}finally{btn.disabled=false;}});
 $('recheck').addEventListener('click',async()=>{try{await refreshRemote();message('Соединение работает. Версия API: '+(remote.apiVersion??'не определена'));}catch(e){message(errorText(e),true);}});
 $('apiRetry').addEventListener('click',async()=>{const btn=$('apiRetry');btn.disabled=true;try{await refreshRemote();if(compatible()){message('Серверная версия 1.3 подтверждена. Приёмка доступна.');}else{message('Сервер вернул устаревшую версию API: '+(remote.apiVersion??'не определена')+'. Проверьте развёртывание Apps Script.',true);}}catch(e){message('Не удалось проверить сервер: '+errorText(e),true);}finally{btn.disabled=false;}});
 $('showSetup').addEventListener('click',()=>{$('setup').hidden=false;message('Перед заменой токена дождитесь нулевой очереди.',true);});
 document.querySelectorAll('.tabs button').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
 bindPicker();bindReport();
 window.addEventListener('online',()=>{renderNetwork();refreshOnReturn().finally(()=>syncQueue());});
 window.addEventListener('offline',()=>{renderNetwork();renderDirectoryStatus();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshOnReturn();if(navigator.onLine)syncQueue();}});
 window.addEventListener('pageshow',()=>{refreshOnReturn();});
 window.addEventListener('focus',()=>{refreshOnReturn();});
 renderNetwork();renderIdentity();renderClientOptions();buildForms();setAvailability();await renderQueue();
 if(validSetup()&&navigator.onLine){
  try{await refreshRemote();if(navigator.onLine)syncQueue();}
  catch(e){message('Работаем с сохранённым справочником. Проверка связи: '+errorText(e),true);}
 }
}
init().catch(e=>message('Ошибка запуска: '+errorText(e),true));
