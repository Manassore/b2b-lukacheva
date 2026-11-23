/**
 * B2B Лукачёва — Apps Script v1.3
 * Для существующего проекта сохраните значения CONFIG из рабочей версии.
 * ВНИМАНИЕ: токены сотрудников — секреты, никогда не записывайте их в GitHub.
 */
const CONFIG = Object.freeze({
  DB_ID: 'ВСТАВИТЬ_DB_ID',
  SHIFT_ID: 'ВСТАВИТЬ_SHIFT_ID',
  MASTER_ID: 'ВСТАВИТЬ_MASTER_ID',
  TZ: 'Europe/Samara',
  MAX_BATCH: 12,
  MAX_WEIGHT: 1000,
  MAX_BAGS: 200
});

const API_VERSION = 4;
const T = Object.freeze({
  clients:'Клиенты', users:'Сотрудники', records:'Поступления',
  ops:'Операции', sync:'Синхронизация', config:'Настройки',
  catalog:'Номенклатура', tariffs:'Тарифы', lines:'Позиции'
});
const RECORD_COLS = [
  'record_id','client_id','client_name','source','pickup_bags','received_bags',
  'weigh_mode','weight_kg','status','pickup_at','received_at','weighed_at',
  'account_date','courier_id','receiver_id','weigher_id','note','updated_at',
  'revision','discrepancy','verified','last_op_id','account_type','item_count','object_id','object_name'
];

function db_(){return SpreadsheetApp.openById(CONFIG.DB_ID);}
function tab_(name){const s=db_().getSheetByName(name); if(!s)throw Error('Нет листа: '+name);return s;}
function now_(){return new Date().toISOString();}
function day_(iso){const d=new Date(iso);if(!Number.isFinite(d.getTime()))throw Error('Некорректная дата');return Utilities.formatDate(d,CONFIG.TZ,'yyyy-MM-dd');}
function sha_(raw){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(raw)).map(b=>('0'+(b&255).toString(16)).slice(-2)).join('');}
function rows_(name){const s=tab_(name), last=s.getLastRow();if(last<2)return [];
  const rows=s.getRange(1,1,last,s.getLastColumn()).getValues(),heads=rows.shift().map(String);
  return rows.map((r,i)=>({index:i+2,obj:Object.fromEntries(heads.map((h,j)=>[h,r[j]]))}));
}
function findUser_(token){if(typeof token!=='string'||token.length<40)throw Error('Нужен токен устройства');
  const digest=sha_(token);
  const u=rows_(T.users).find(r=>String(r.obj.token_hash)===digest && (r.obj.active===true || String(r.obj.active)==='TRUE'));
  if(!u)throw Error('Токен не найден или отключён');
  return {id:String(u.obj.user_id),name:String(u.obj.name),role:String(u.obj.role).toUpperCase()};
}
function role_(user,...roles){if(user.role!=='OWNER'&&!roles.includes(user.role))throw Error('Недостаточно прав');}
/**
 * Единственный первичный источник клиентов — B2B — Справочник клиентов Лукачёва — 2026.
 * В локальном листе Клиенты хранится только соответствие legacy ID → master ID,
 * чтобы ранее созданные поступления и тарифы не потеряли связь.
 * Новые клиенты не нуждаются в локальном добавлении: ID равен LUK-B2B-###.
 */
function masterClients_(){
  const sheet=SpreadsheetApp.openById(CONFIG.MASTER_ID).getSheetByName('Клиенты');
  if(!sheet)throw Error('Не найден лист Клиенты в первичном B2B-справочнике');
  const values=sheet.getDataRange().getValues();
  if(values.length<2)throw Error('Первичный справочник пуст');
  const headers=values[0].map(x=>String(x).trim());
  const required=['Код клиента','Клиент','Вид сотрудничества','Статус','Способ расчёта','Канал учёта поступлений'];
  const idx=Object.fromEntries(required.map(k=>[k,headers.indexOf(k)]));
  const missing=required.filter(k=>idx[k]<0);
  if(missing.length)throw Error('В реестре отсутствуют столбцы: '+missing.join(', '));
  const byMaster=clientIdMap_();
  const shortColumn=headers.indexOf('Краткое название');
  const clients=[],usedMaster=new Set(),usedIds=new Set();
  for(let i=1;i<values.length;i++){
    const row=values[i],masterId=String(row[idx['Код клиента']]||'').trim();
    if(!masterId)continue;
    if(usedMaster.has(masterId))throw Error('В первичном реестре повторяется код: '+masterId);
    usedMaster.add(masterId);
    const collaboration=String(row[idx['Вид сотрудничества']]||'').trim();
    const status=String(row[idx['Статус']]||'').trim();
    if(status!=='Активный'||!['B2B','Спецодежда'].includes(collaboration))continue;
    const channel=String(row[idx['Канал учёта поступлений']]||'').trim();
    if(!['','Приложение','Quick Resto','Не учитывать'].includes(channel))
      throw Error('Неизвестный канал учёта у '+masterId+': '+channel);
    if(channel==='Quick Resto'||channel==='Не учитывать')continue;
    const name=String(row[idx['Клиент']]||'').trim();
    if(!name)throw Error('Нет имени клиента: '+masterId);
    const shortName=String(row[shortColumn]||'').trim();
    if(shortName && shortName.split(/\s+/).length>2)throw Error('Краткое название должно содержать 1–2 слова: '+masterId);
    const method=String(row[idx['Способ расчёта']]||'').trim();
    const accountType=method==='За кг'?'WEIGHT':method==='Поштучно'?'PIECE':'UNKNOWN';
    const appId=byMaster.get(masterId)||masterId;
    if(usedIds.has(appId))throw Error('Повторяется ID приложения: '+appId);
    usedIds.add(appId);
    clients.push({client_id:appId,master_id:masterId,display_name:name,short_name:shortName||name,collaboration,
      account_type:accountType,method,active:true});
  }
  return clients;
}

function clientIdMap_(){
  const byMaster=new Map(),byLocal=new Set();
  for(const entry of rows_(T.clients)){
    const c=entry.obj,mid=String(c.master_id||'').trim(),legacyId=String(c.client_id||'').trim();
    if(!mid||!legacyId)continue;
    if(byMaster.has(mid))throw Error('Двойное сопоставление master ID: '+mid);
    if(byLocal.has(legacyId))throw Error('Дублируется ID приложения: '+legacyId);
    byMaster.set(mid,legacyId);byLocal.add(legacyId);
  }
  return byMaster;
}

function masterObjects_(){
  const sheet=SpreadsheetApp.openById(CONFIG.MASTER_ID).getSheetByName('Объекты');
  if(!sheet)throw Error('Не найден лист Объекты в B2B-справочнике');
  const [header,...rows]=sheet.getDataRange().getValues();
  const columns=['ID объекта','Код клиента','Краткое название','Адрес','Активен'];
  const indexes=columns.map(name=>header.indexOf(name));
  if(indexes.includes(-1))throw Error('Проверьте заголовки листа Объекты');
  const objects=new Map();
  for(const [index,row] of rows.entries()){
    const [id,masterId,name,address,active]=indexes.map(col=>String(row[col]).trim());
    if(!id&&!masterId&&!name&&!address)continue;
    if(!id||!masterId||!name||!address||!['true','false'].includes(active.toLowerCase()))
      throw Error('Заполните ID, код клиента, название, адрес и активность объекта. Строка '+(index+2));
    if(objects.has(id))throw Error('Повторяется ID объекта: '+id);
    objects.set(id,{id,masterId,name,address,active:active.toLowerCase()==='true'});
  }
  return objects;
}

function recordSchema_(){
  const sheet=tab_(T.records);
  const header=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  if(RECORD_COLS.some((col,index)=>header[index]!==col))
    throw Error('Проверьте заголовки A:Z листа Поступления для v1.3');
}

function selectedObject_(client,objectId){
  const id=String(objectId||'').trim();
  if(!id)return null;
  const object=masterObjects_().get(id);
  // Очередь могла быть создана до отключения объекта. Владение объектом проверяется и после отключения.
  if(!object||object.masterId!==client.master_id)throw Error('Объект не принадлежит выбранному клиенту или отсутствует');
  return object;
}
function getClient_(id){return masterClients_().find(c=>String(c.client_id)===id);}
/** Запускается владельцем вручную после обновления скрипта; ничего не записывает. */
function diagnoseDirectory(){
  const list=masterClients_();
  recordSchema_();
  const objects=masterObjects_();
  const report={apiVersion:API_VERSION,total:list.length,activeObjects:[...objects.values()].filter(x=>x.active).length,
    byMode:{WEIGHT:list.filter(x=>x.account_type==='WEIGHT').length,
      PIECE:list.filter(x=>x.account_type==='PIECE').length,
      UNKNOWN:list.filter(x=>x.account_type==='UNKNOWN').length},
    unknown:list.filter(x=>x.account_type==='UNKNOWN').map(x=>({id:x.master_id,name:x.display_name}))};
  Logger.log(JSON.stringify(report,null,2));return report;
}

function key_(v){if(!/^[a-zA-Z0-9-]{16,80}$/.test(String(v||'')))throw Error('Некорректный ID операции');return String(v);}
function bags_(n){const v=Number(n);if(!Number.isInteger(v)||v<1||v>CONFIG.MAX_BAGS)throw Error('Мешков должно быть от 1 до '+CONFIG.MAX_BAGS);return v;}
function kilos_(n){const v=Number(n);if(!Number.isFinite(v)||v<=0||v>CONFIG.MAX_WEIGHT||Math.round(v*10)!==v*10)throw Error('Вес: положительное число с точностью 0,1 кг');return v;}
function text_(s,max){return String(s||'').trim().slice(0,max);}
function accountType_(c){const mode=String(c.account_type||'UNKNOWN').trim().toUpperCase();return ['WEIGHT','PIECE'].includes(mode)?mode:'UNKNOWN';}
function quantity_(n){const v=Number(n);if(!Number.isInteger(v)||v<1||v>1000)throw Error('Количество изделий: целое число от 1 до 1000');return v;}
function serviceAccess_(clientId){
  const catalog=new Map(rows_(T.catalog).map(x=>x.obj).filter(s=>s.service_code && (s.active===true||String(s.active)==='TRUE')).map(s=>[String(s.service_code),s]));
  const found=new Map();
  for(const x of rows_(T.tariffs).map(r=>r.obj)){
    if(String(x.client_id)!==String(clientId)||!(x.active===true||String(x.active)==='TRUE'))continue;
    const code=String(x.service_code||'');const svc=catalog.get(code);if(!svc)continue;
    if(found.has(code))throw Error('Дубли тарифов: '+clientId+' / '+code);
    const raw=x.price_rub;
    const price=raw===''||raw===null?null:Number(raw);
    if(price!==null&&(!Number.isFinite(price)||price<0||Math.round(price*100)!==price*100))throw Error('Неверный тариф: '+code);
    found.set(code,{code,name:String(svc.name),unit:String(svc.unit||'шт'),price});
  }
  return found;
}
function validateLines_(p,clientId,recordId,opId,at){
  if(!Array.isArray(p.items)||p.items.length<1||p.items.length>25)throw Error('Добавьте хотя бы одно изделие (максимум 25)');
  const avail=serviceAccess_(clientId),seen=new Set(),output=[];
  for(const x of p.items){
    const code=String(x.code||'');const svc=avail.get(code);if(!svc)throw Error('Изделие не разрешено для клиента: '+code);
    if(seen.has(code))throw Error('Повторная позиция: '+code);seen.add(code);
    const qty=quantity_(x.qty);
    const amt=svc.price===null?'':Math.round(svc.price*qty*100)/100;
    output.push({lineId:recordId+'-'+code,recordId,opId,clientId,code,name:svc.name,qty,unit:svc.unit,
      price:svc.price===null?'':svc.price,amount:amt,accountDate:day_(at),createdAt:now_(),priceStatus:svc.price===null?'PRICE_MISSING':'PRICED'});
  }
  return output;
}
function parseWhen_(raw){const d=new Date(raw);if(!Number.isFinite(d.getTime()))throw Error('Нет даты операции');
  if(d.getTime()>Date.now()+24*3600000)throw Error('Проверьте время телефона');return d.toISOString();}
function sheetGet_(s,name){return s.getRange(1,1,1,s.getLastColumn()).getValues()[0].indexOf(name)+1;}
function record_(id){const r=rows_(T.records).find(row=>String(row.obj.record_id)===id);return r||null;}
function initRecord_(id,c,source){const o={};RECORD_COLS.forEach(k=>o[k]='');o.record_id=id;o.client_id=String(c.client_id);
  o.client_name=String(c.display_name);o.source=source;o.revision=0;o.verified=false;return o;}
function event_(ev,user,existing){
  const op=String(ev.type||'').toUpperCase(),id=key_(ev.recordId),at=parseWhen_(ev.at),p=ev.data||{};
  let r=existing?Object.assign({},existing):null;
  if(op==='PICKUP'){
    role_(user,'COURIER');if(r)throw Error('Забор уже зарегистрирован');
    const c=getClient_(String(p.clientId||''));if(!c)throw Error('Клиент неактивен или отсутствует');
    r=initRecord_(id,c,'COURIER');r.pickup_bags=bags_(p.bags);r.pickup_at=at;r.courier_id=user.id;r.status='IN_TRANSIT';
    if(accountType_(c)!=='WEIGHT')throw Error('Курьерский модуль временно отключён или способ расчёта не уточнён');
    r.account_type='WEIGHT';r.weigh_mode='BEFORE';r.note=text_(p.note,300);
  }else if(op==='DIRECT'){
    role_(user,'OFFICE');if(r)throw Error('Поступление уже зарегистрировано');
    const c=getClient_(String(p.clientId||''));if(!c)throw Error('Клиент неактивен или отсутствует');
    if(accountType_(c)==='UNKNOWN')throw Error('Способ расчёта не уточнён в B2B-справочнике: '+c.display_name);
    r=initRecord_(id,c,'DIRECT');r.received_at=at;r.receiver_id=user.id;r.weigh_mode='BEFORE';
    const object=selectedObject_(c,p.objectId);
    if(object){r.object_id=object.id;r.object_name=object.name;}
    r.account_type=accountType_(c);r.note=text_(p.note,300);r.account_date=day_(at);
    if(r.account_type==='PIECE'){
      r._items=validateLines_(p,String(c.client_id),id,String(ev.opId),at);
      r.item_count=r._items.reduce((acc,x)=>acc+x.qty,0);
      r.status='ACCEPTED_ITEMS';
    }else{
      r.received_bags=bags_(p.bags);r.weight_kg=kilos_(p.weight);
      r.weighed_at=at;r.weigher_id=user.id;r.status='WEIGHED';
    }
  }else if(op==='RECEIVE'){
    role_(user,'OFFICE');if(!r||r.status!=='IN_TRANSIT')throw Error('Забор не найден или уже принят');
    r.received_bags=bags_(p.bags);r.received_at=at;r.receiver_id=user.id;r.note=[r.note,text_(p.note,300)].filter(Boolean).join(' / ');
    r.discrepancy=Number(r.pickup_bags)!==Number(r.received_bags);
    if(r.weigh_mode==='BEFORE'){
      r.weight_kg=kilos_(p.weight);r.weighed_at=at;r.weigher_id=user.id;r.account_date=day_(at);
    }
    r.status=r.discrepancy?'DISCREPANCY':r.weight_kg?'WEIGHED':'AWAITING_WEIGH';
  }else if(op==='WEIGH'){
    role_(user,'OFFICE');if(!r||!['AWAITING_WEIGH','DISCREPANCY'].includes(r.status))throw Error('Эта запись не ожидает взвешивания');
    r.weight_kg=kilos_(p.weight);r.weighed_at=at;r.weigher_id=user.id;r.account_date=day_(at);
    r.status=r.discrepancy&&!r.verified?'DISCREPANCY':'WEIGHED';
  }else if(op==='RESOLVE'){
    role_(user,'OWNER');if(!r||r.status!=='DISCREPANCY')throw Error('Нет нерешённого расхождения');
    if(!text_(p.note,300))throw Error('Нужно объяснение расхождения');r.verified=true;
    r.note=[r.note,'СОГЛАСОВАНО: '+text_(p.note,300)].filter(Boolean).join(' / ');
    r.status=r.weight_kg?'WEIGHED':'AWAITING_WEIGH';
  }else throw Error('Неизвестная операция');
  r.revision=Number(r.revision||0)+1;r.updated_at=now_();r.last_op_id=key_(ev.opId);
  return r;
}
function persistLines_(event,patch){
  if(String(event.type||'').toUpperCase()!=='DIRECT')return;
  const existing=rows_(T.lines).map(r=>String(r.obj.line_id));const ids=new Set(existing);
  const lines=patch._items||[];
  if(patch.account_type!=='PIECE')return;
  const s=tab_(T.lines);
  for(const line of lines){
    if(ids.has(line.lineId))continue;
    s.appendRow([line.lineId,line.recordId,line.opId,line.clientId,line.code,line.name,line.qty,line.unit,
      line.price,line.amount,line.accountDate,line.createdAt,line.priceStatus]);
    ids.add(line.lineId);
  }
}
function persistRecord_(r){const sheet=tab_(T.records),obj=record_(String(r.record_id));
  const vals=RECORD_COLS.map(c=>r[c]===undefined?'':r[c]);
  if(obj){if(String(obj.obj.last_op_id)===String(r.last_op_id))return;
    sheet.getRange(obj.index,1,1,vals.length).setValues([vals]);
  }else sheet.appendRow(vals);
}
function writeOp_(ev,user,status,error){const sh=tab_(T.ops);
  sh.appendRow([key_(ev.opId),key_(ev.recordId),String(ev.type).toUpperCase(),user.id,
    parseWhen_(ev.at),now_(),JSON.stringify(ev),status||'PENDING',error||'']);
  return sh.getLastRow();
}
function setOp_(row,status,error){const sh=tab_(T.ops);sh.getRange(row,8,1,2).setValues([[status,error||'']]);}
function opIndex_(){return new Map(rows_(T.ops).map(r=>[String(r.obj.op_id),r]));}
function processOne_(ev,user,index){const opId=key_(ev.opId),rid=key_(ev.recordId);
  if(index.has(opId))return;
  // Сначала бизнес-проверка, затем журналируем операцию (единственный первичный источник).
  let patch;
  try{patch=event_(ev,user,record_(rid)?.obj||null);}catch(err){
    const row=writeOp_(ev,user,'REJECTED',String(err.message||err));
    index.set(opId,{index:row,obj:{result:'REJECTED',error:String(err.message||err)}});return;
  }
  const row=writeOp_(ev,user,'PENDING','');index.set(opId,{index:row,obj:{result:'PENDING'}});
  try{persistRecord_(patch);persistLines_(ev,patch);setOp_(row,'APPLIED','');index.get(opId).obj.result='APPLIED';}
  catch(err){setOp_(row,'PENDING',String(err.message||err));}
}
function repairPending_(){const jobs=rows_(T.ops).filter(x=>x.obj.result==='PENDING');
  for(const job of jobs.slice(0,30)){
    try{
      const ev=JSON.parse(String(job.obj.payload_json));const r=record_(String(ev.recordId));
      if(r&&String(r.obj.last_op_id)===String(ev.opId)){
        if(String(ev.type||'').toUpperCase()==='DIRECT' && String(r.obj.account_type)==='PIECE'){
          const lines=validateLines_(ev.data||{},String(r.obj.client_id),String(ev.recordId),String(ev.opId),String(ev.at));
          persistLines_(ev,Object.assign({},r.obj,{_items:lines}));
        }
        setOp_(job.index,'APPLIED','');continue;
      }
      const u=rows_(T.users).find(x=>String(x.obj.user_id)===String(job.obj.actor_id));
      if(!u)throw Error('Нет автора операции');
      const patch=event_(ev,{id:String(u.obj.user_id),role:String(u.obj.role).toUpperCase()},r?.obj||null);
      persistRecord_(patch);persistLines_(ev,patch);setOp_(job.index,'APPLIED','');
    }catch(err){setOp_(job.index,'PENDING',String(err.message||err));}
  }
}
function withLock_(fn){const lock=LockService.getScriptLock();lock.waitLock(25000);try{return fn();}finally{lock.releaseLock();}}
function doPost(e){try{
  const body=JSON.parse((e.parameter&&e.parameter.payload)||'{}');const u=findUser_(body.token),ops=body.ops;
  if(!Array.isArray(ops)||ops.length<1||ops.length>CONFIG.MAX_BATCH)throw Error('Некорректное количество операций');
  return json_(withLock_(()=>{recordSchema_();repairPending_();const index=opIndex_();
    ops.forEach(op=>processOne_(op,u,index));return {ok:true,processed:ops.length};}));
}catch(err){return json_({ok:false,error:String(err.message||err)});}}
function json_(o){return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);}
function doGet(e){let out;try{
  const p=e.parameter||{};const u=findUser_(p.token);const action=String(p.action||'bootstrap');
  if(action==='version'){
    recordSchema_();
    out={ok:true,apiVersion:API_VERSION};
  }else if(action==='summary'){
    role_(u,'OFFICE');
    const from=reportDate_(p.from),to=reportDate_(p.to);
    if(from>to)throw Error('Дата начала должна быть раньше даты окончания');
    const clients=masterClients_();
    const records=withLock_(()=>{
      const pending=new Set(rows_(T.ops).filter(row=>row.obj.result==='PENDING').map(row=>String(row.obj.op_id)));
      return rows_(T.records).map(row=>row.obj).filter(row=>!pending.has(String(row.last_op_id)));
    });
    out={ok:true,from,to,clients:summarizeReceipts_(records,from,to,
      clientIdMap_(),new Map(clients.map(c=>[c.client_id,c.short_name])),masterObjects_())};
  }else if(action==='status'){
    withLock_(repairPending_);
    const ids=String(p.ids||'').split(',').filter(Boolean).slice(0,30),found=opIndex_();
    out={ok:true,ops:ids.map(id=>{const z=found.get(id);return {id,status:z?String(z.obj.result):'NOT_FOUND',error:z?String(z.obj.error||''):''};})};
  }else if(action==='bootstrap'){
    // Каждое открытие/обновление запрашивает актуальный реестр напрямую из Google Sheets.
    recordSchema_();
    const objects=masterObjects_();
    const clients=masterClients_()
      .map(c=>({id:c.client_id,masterId:c.master_id,name:c.display_name,shortName:c.short_name,
        collaboration:c.collaboration,accountType:accountType_(c),
        objects:[...objects.values()].filter(o=>o.active&&o.masterId===c.master_id)
          .map(({id,name,address})=>({id,name,address}))}))
      .sort((a,b)=>a.name.localeCompare(b.name,'ru'));
    const services=[];
    for(const c of clients.filter(x=>x.accountType==='PIECE')){
      serviceAccess_(c.id).forEach(s=>services.push({clientId:c.id,code:s.code,name:s.name,unit:s.unit}));
    }
    const all=rows_(T.records).map(x=>x.obj).filter(x=>x.record_id)
      .sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))).slice(0,120)
      .map(r=>({id:String(r.record_id),clientId:String(r.client_id),client:String(r.client_name),
        objectId:String(r.object_id||''),objectName:String(r.object_name||''),
        status:String(r.status),source:String(r.source),pickupBags:Number(r.pickup_bags||0),receivedBags:Number(r.received_bags||0),
        mode:String(r.weigh_mode),accountType:String(r.account_type||'WEIGHT'),itemsCount:Number(r.item_count||0),
        weight:r.weight_kg===''?null:Number(r.weight_kg),
        date:String(r.received_at||r.pickup_at),note:String(r.note||''),discrepancy:Boolean(r.discrepancy)}));
    out={ok:true,user:u,clients,services,records:all,serverTime:now_(),clientDirectoryTime:now_(),apiVersion:API_VERSION};
  }else out={ok:false,error:'Неизвестное действие'};
}catch(err){out={ok:false,error:String(err.message||err)};}
  // JSONP нужен для совместимости статического PWA с Apps Script (read-only!).
  const fn=String((e.parameter||{}).callback||'');
  if(!/^[A-Za-z_$][A-Za-z0-9_$]{0,60}$/.test(fn))return json_(out);
  return ContentService.createTextOutput(fn+'('+JSON.stringify(out).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')+');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function reportDate_(value){
  const date=String(value||'');
  const parsed=new Date(date+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)
    throw Error('Укажите даты в формате ГГГГ-ММ-ДД');
  return date;
}

function summarizeReceipts_(rows,from,to,aliases,names,objects){
  const clients=new Map(),seen=new Set();
  const total=()=>({receipts:0,weightTenths:0,items:0});
  for(const r of rows){
    const id=String(r.record_id||''),rawId=String(r.client_id||'');
    if(!id||!rawId||seen.has(id)||!r.account_date)continue;
    const date=r.account_date instanceof Date?day_(r.account_date):String(r.account_date);
    if(date<from||date>to)continue;
    const piece=r.status==='ACCEPTED_ITEMS'&&r.account_type==='PIECE';
    const weighed=r.status==='WEIGHED'&&r.account_type!=='PIECE'&&
      (!(r.discrepancy===true||String(r.discrepancy).toUpperCase()==='TRUE')||
        r.verified===true||String(r.verified).toUpperCase()==='TRUE');
    const weight=weighed?Number(r.weight_kg):0,items=piece?Number(r.item_count):0;
    if(!(Number.isFinite(weight)&&weight>0)&&!(Number.isInteger(items)&&items>0))continue;
    seen.add(id);
    const clientId=aliases.get(rawId)||rawId,objectId=String(r.object_id||'');
    if(!clients.has(clientId)){
      clients.set(clientId,{id:clientId,name:names.get(clientId)||r.client_name||clientId,
        totals:total(),objects:new Map()});
    }
    const client=clients.get(clientId);
    if(!client.objects.has(objectId)){
      client.objects.set(objectId,{id:objectId,
        name:objectId?(objects.get(objectId)?.name||r.object_name||objectId):'Без указания объекта',totals:total()});
    }
    for(const bucket of [client.totals,client.objects.get(objectId).totals]){
      bucket.receipts++;
      bucket.weightTenths+=Math.round(weight*10);
      bucket.items+=items;
    }
  }
  const volume=({receipts,weightTenths,items})=>({receipts,weightKg:weightTenths/10,items});
  const byName=(a,b)=>a.name.localeCompare(b.name,'ru');
  return [...clients.values()].map(c=>({id:c.id,name:c.name,...volume(c.totals),
    objects:[...c.objects.values()].map(o=>({id:o.id,name:o.name,...volume(o.totals)})).sort(byName)})).sort(byName);
}

/** Один раз запустить из редактора, меняя имя и роль для каждого телефона.
 * Роли: COURIER, OFFICE, OWNER. Скопируйте токен из Журнала выполнения!
 */
function provisionUser(){
  const NAME='ЗАМЕНИТЬ НА ИМЯ СОТРУДНИКА';
  const ROLE='OFFICE';
  const token=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'');
  const id='U'+Utilities.getUuid().slice(0,8);
  if(NAME.startsWith('ЗАМЕНИТЬ'))throw Error('Сначала измените NAME в provisionUser()');
  if(!['OFFICE','COURIER','OWNER'].includes(ROLE))throw Error('Недопустимая роль');
  tab_(T.users).appendRow([id,NAME,ROLE,sha_(token),true,now_(),'']);
  Logger.log('ПОЛЬЗОВАТЕЛЬ: '+NAME+' / '+ROLE+' / '+id);
  Logger.log('ТОКЕН (сохраните сейчас): '+token);
}
function revokeUser(){const USER_ID='ВСТАВИТЬ_ID';if(USER_ID.startsWith('ВСТАВИТЬ'))throw Error('Укажите USER_ID');
  const item=rows_(T.users).find(x=>String(x.obj.user_id)===USER_ID);if(!item)throw Error('Нет пользователя');
  tab_(T.users).getRange(item.index,5).setValue(false);
}

/** Интеграция с Графиком смен (по умолчанию — только сверка).
 * Запуск previewShiftSync: выведет проверку в лог. Исправления/перезаписи чужих ячеек нет.
 */
function previewShiftSync(){const r=syncShift_(true);Logger.log(JSON.stringify(r,null,2));return r;}
function applyShiftSync(){const mode=rows_(T.config).find(r=>r.obj.key==='SYNC_MODE');
  if(!mode||String(mode.obj.value)!=='LIVE')throw Error('Сначала установите SYNC_MODE=LIVE в листе Настройки');
  const r=syncShift_(false);Logger.log(JSON.stringify(r,null,2));return r;}
function syncShift_(dry){
  const clients=new Map(rows_(T.clients).map(r=>[String(r.obj.client_id),r.obj]));
  const grouped=new Map();
  rows_(T.records).map(x=>x.obj).forEach(r=>{
    if(r.status!=='WEIGHED'||String(r.account_type)==='PIECE'||!r.account_date||!r.weight_kg||r.discrepancy&&!r.verified)return;
    const key=String(r.client_id)+'|'+String(r.account_date);
    grouped.set(key,Math.round((grouped.get(key)||0)+Number(r.weight_kg)*10));
  });
  const mapping=['Янв','Фев','Март','Апр','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Дек'];
  const target=SpreadsheetApp.openById(CONFIG.SHIFT_ID),syncTab=tab_(T.sync);
  const checkpoints=rows_(T.sync),summary={dryRun:dry,ok:[],conflicts:[],errors:[]};
  grouped.forEach((tenths,key)=>{
    const [cid,date]=key.split('|'),c=clients.get(cid);if(!c){summary.errors.push(key+': клиент исчез');return;}
    const parts=date.split('-').map(Number),month=mapping[parts[1]-1],tab=month+' '+String(parts[0]).slice(-2);
    const sh=target.getSheetByName(tab);if(!sh){summary.errors.push(key+': нет листа '+tab);return;}
    const dayLabel=('0'+parts[2]).slice(-2)+'.'+('0'+parts[1]).slice(-2)+'.'+String(parts[0]).slice(-2);
    const headers=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0];
    const col=headers.indexOf(dayLabel)+1;
    if(col<2){summary.errors.push(key+': не найдена дата '+dayLabel);return;}
    const names=sh.getRange(1,1,Math.min(sh.getLastRow(),60),1).getDisplayValues().flat();
    const row=names.indexOf(String(c.sheet_match))+1;
    if(row<2){summary.errors.push(key+': не найдена строка клиента');return;}
    const cell=sh.getRange(row,col),v=cell.getValue(),written=tenths/10,
      old=checkpoints.find(x=>String(x.obj.client_id)===cid&&String(x.obj.account_date)===date);
    const empty=(v===''||v===null),prev=old?Number(old.obj.last_written_kg):null;
    const valid=old?Math.abs(Number(v)-prev)<0.0001:empty;
    const label=key+' → '+tab+'!'+cell.getA1Notation()+' = '+written;
    if(!valid){summary.conflicts.push(label+' (сейчас '+v+', контроль '+prev+')');return;}
    if(!dry){cell.setValue(written);const record=[cid,date,tab,cell.getA1Notation(),written,now_(),'DONE',''];
      if(old)syncTab.getRange(old.index,1,1,8).setValues([record]);else syncTab.appendRow(record);}
    summary.ok.push(label);
  });
  return summary;
}
/** После ручных тестов и включения LIVE можно включить почасовую синхронизацию. */
function installHourlySync(){const existing=ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='applyShiftSync');
 if(!existing.length)ScriptApp.newTrigger('applyShiftSync').timeBased().everyHours(1).create();}
function removeHourlySync(){ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='applyShiftSync').forEach(ScriptApp.deleteTrigger);}
