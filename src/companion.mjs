import {createHash} from 'node:crypto';
import {journeyContext,journeyState,journeyCommand,validateJourneyFact} from './journey.mjs';
import {validateCompanionImages,validateAIOutput} from './ai-provider.mjs';

const fail=code=>{throw Error(code);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const makeId=(...parts)=>digest(parts).slice(0,32);
const safeId=id=>typeof id==='string'&&/^[-a-zA-Z0-9_]{16,80}$/.test(id);
const atomic=(store,fn)=>store.db.isTransaction?fn():store.transaction(fn);
const unavailable={configured:false,textAvailable:false,visionAvailable:false,requiresConsent:false,status:'UNCONFIGURED'};
const errorMessages={ai_not_configured:'AI-провайдер пока не подключён. Сообщение сохранено в чате; распознавание текста и изображений не выполнялось. Можно составить ручной черновик изменений и подтвердить его.',ai_external_consent_required:'Для AI-анализа нужно отдельно разрешить передачу сообщения, игрового контекста и вложений внешнему провайдеру.',ai_vision_unavailable:'Анализ изображений у провайдера пока не включён. Изображения не распознаны и не сохранены.',ai_budget_exhausted:'Лимит AI-бюджета достигнут. Состояние прохождения не изменено; ручное обновление доступно.',ai_daily_limit:'Дневной лимит AI-запросов достигнут. Ручное обновление доступно.',ai_cooldown:'Между AI-запросами нужна короткая пауза. Состояние не изменено.',ai_busy:'Другой AI-запрос ещё выполняется. Этот запрос не отправлен провайдеру.',ai_rate_limited:'Провайдер ограничил частоту запросов. Автоматических повторов нет; состояние не изменено.',ai_timeout:'Провайдер не вернул результат вовремя. Повторный платный запрос автоматически не выполняется; состояние не изменено.',ai_result_unknown:'Получение AI-результата было прервано. Состояние не изменено; повторной платной отправки не было.'};
errorMessages.ai_budget_estimate_exceeded='Фактическое использование превысило защитную оценку. AI-запросы остановлены до проверки бюджета; состояние прохождения не изменено.';
export const COMPANION_ERRORS=['invalid_companion_command','invalid_companion_images','invalid_companion_proposal','companion_proposal_not_found','companion_item_not_pending','companion_owner_required','companion_consent_required','companion_revision_conflict','idempotency_conflict','journey_revision_conflict','journey_not_started','invalid_journey_field','invalid_journey_value','game_not_found','active_game_required'];

export function initCompanion(store){store.db.exec(`
 CREATE TABLE IF NOT EXISTS companion_messages(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,game_id TEXT NOT NULL REFERENCES games(id),created_at TEXT NOT NULL,payload_json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS companion_message_scope ON companion_messages(owner_id,game_id,created_at);
 CREATE TABLE IF NOT EXISTS companion_proposals(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,game_id TEXT NOT NULL REFERENCES games(id),created_at TEXT NOT NULL,payload_json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS companion_proposal_scope ON companion_proposals(owner_id,game_id,created_at);
 CREATE TABLE IF NOT EXISTS companion_receipts(owner_id TEXT NOT NULL,game_id TEXT NOT NULL REFERENCES games(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,game_id,request_id));
`);}
function ownerCheck(ownerId){if(typeof ownerId!=='string'||!ownerId||ownerId.length>128)fail('companion_owner_required');}
function addMessage(store,ownerId,gameId,payload){store.db.prepare('INSERT INTO companion_messages VALUES(?,?,?,?,?)').run(payload.id,ownerId,gameId,payload.createdAt,JSON.stringify(payload));}
function putProposal(store,ownerId,gameId,proposal){store.db.prepare('INSERT INTO companion_proposals VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(proposal.id,ownerId,gameId,proposal.createdAt,JSON.stringify(proposal));}
function addReceipt(store,ownerId,gameId,body,hash,state,now){store.db.prepare('INSERT INTO companion_receipts VALUES(?,?,?,?,?,?)').run(ownerId,gameId,body.requestId,hash,state,now);}
function priorReceipt(store,ownerId,gameId,requestId){return store.db.prepare('SELECT * FROM companion_receipts WHERE owner_id=? AND game_id=? AND request_id=?').get(ownerId,gameId,requestId);}
function currentFields(context){return Object.fromEntries(Object.entries(context.fields).filter(([,d])=>!d.legacy));}
function contextForAI(context){return {game:{title:context.title,platform:context.platform,runId:context.run?.id??null,revision:context.revision},reveal:context.revealed,facts:Object.fromEntries(Object.entries(context.currentRunFacts).map(([k,f])=>[k,{value:f.value,source:'USER_CONFIRMED'}])),allowedFields:currentFields(context),trophySummary:{...context.trophySummary,source:context.trophySource==='direct_psn_api'?'PSN_VERIFIED':'IMPORTED',observedAt:context.lastSuccessfulSyncAt},rules:context.actions.filter(a=>!a.spoilerHidden).map(a=>({ruleId:a.id,title:a.title,message:a.message,category:a.category,verificationStatus:a.certainty,evidence:(a.evidence??[]).slice(0,3)})),criticalUnknowns:context.criticalUnknowns,coverage:context.coverage,policy:context.policy};}
function replacement(previous,value,operation){return previous!==undefined&&operation==='set'&&JSON.stringify(previous)!==JSON.stringify(value)?{kind:'replacement',previousValue:previous,proposedValue:value,requiresExplicitConfirmation:true}:null;}
function proposalItems(store,gameId,input,context,source){
 const items=new Map();
 for(const candidate of input){
  if(candidate.confidence==='uncertain')continue;
  if(!Object.hasOwn(context.fields,candidate.field)||context.fields[candidate.field].legacy)fail('invalid_companion_proposal');
  const checked=validateJourneyFact(store,gameId,Object.fromEntries(Object.entries(candidate).filter(([k])=>['field','value','operation','wording'].includes(k))));
  // An AI observation is not proof of a complete collection. A partial image cannot replace existing entries.
  if(source==='INFERRED'&&context.fields[checked.field].type==='array'&&checked.operation==='set')checked.operation='add';
  const def=context.fields[checked.field],old=items.get(checked.field);
  if(old){if(def.type==='array'&&checked.operation==='add'&&old.operation==='add'){old.value=validateJourneyFact(store,gameId,{...checked,value:[...old.value,...checked.value]}).value;old.evidence=[...new Set([...old.evidence,...candidate.evidence??['manual']])];continue;}if(JSON.stringify(old.value)===JSON.stringify(checked.value)&&old.operation===checked.operation)continue;fail('invalid_companion_proposal');}
  const previous=context.currentRunFacts[checked.field]?.value;
  items.set(checked.field,{...checked,id:makeId('item',checked.field),label:def.label,previousValue:previous??null,status:'pending',source,evidence:candidate.evidence??['manual'],conflict:replacement(previous,checked.value,checked.operation),spoilerLevel:def.spoilerLevel??'none'});
 }
 return [...items.values()];
}
function createProposal(store,gameId,ownerId,body,items,context,source,now){if(!items.length)return null;const id=makeId(ownerId,gameId,body.requestId,'proposal'),proposal={id,messageId:makeId(ownerId,gameId,body.requestId,'user'),baseRevision:context.revision,runId:context.run?.id??null,createdAt:now,source,status:'pending',revealed:context.revealed,items:items.map(item=>({...item,id:makeId(id,item.field)}))};putProposal(store,ownerId,gameId,proposal);return proposal;}

/** Read-only composed view. No run creation or confirmed state change occurs in chat reads. */
export function companionGet(store,gameId,{ownerId,provider=null,reveal=false,now=new Date().toISOString()}={}){
 ownerCheck(ownerId);initCompanion(store);const context=journeyContext(store,gameId,{reveal});
 // A lost/unknown billable response is never replayed after process restart. Only chat metadata is repaired.
 const interrupted=store.db.prepare("SELECT request_id FROM companion_receipts WHERE owner_id=? AND game_id=? AND state='processing' AND created_at<?").all(ownerId,gameId,new Date(Date.parse(now)-60_000).toISOString());
 if(interrupted.length)atomic(store,()=>{for(const {request_id:requestId} of interrupted){
  const id=makeId(ownerId,gameId,requestId,'assistant');
  if(!store.db.prepare('SELECT 1 FROM companion_messages WHERE id=?').get(id))addMessage(store,ownerId,gameId,{id,requestId,role:'assistant',text:errorMessages.ai_result_unknown,source:'SYSTEM',createdAt:now,code:'ai_result_unknown',revealed:false});
  const userRow=store.db.prepare('SELECT payload_json FROM companion_messages WHERE id=?').get(makeId(ownerId,gameId,requestId,'user'));
  if(userRow){const user=JSON.parse(userRow.payload_json);user.state='unknown';store.db.prepare('UPDATE companion_messages SET payload_json=? WHERE id=?').run(JSON.stringify(user),user.id);}
  store.db.prepare("UPDATE companion_receipts SET state='complete' WHERE owner_id=? AND game_id=? AND request_id=?").run(ownerId,gameId,requestId);
 }});
 const messages=store.db.prepare('SELECT payload_json FROM companion_messages WHERE owner_id=? AND game_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(ownerId,gameId).reverse().map(r=>JSON.parse(r.payload_json)).map(m=>m.revealed&&!reveal?{...m,text:'Сюжетные подробности скрыты. Включите показ подробностей, чтобы увидеть это сообщение.',advice:[],questions:[]}:m);
 const proposals=store.db.prepare('SELECT payload_json FROM companion_proposals WHERE owner_id=? AND game_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(ownerId,gameId).map(r=>JSON.parse(r.payload_json)).map(p=>({...p,stale:p.baseRevision!==context.revision||p.runId!==(context.run?.id??null),items:p.items.map(i=>!reveal&&(p.revealed||i.spoilerLevel==='quest_outcome')?{...i,value:null,previousValue:null,wording:'Скрытое сюжетное изменение',label:'Скрытое сюжетное изменение',conflict:null,spoilerHidden:true}:i)}));
 const appliedRequestIds=store.db.prepare("SELECT request_id FROM companion_receipts WHERE owner_id=? AND game_id=? AND state='complete' ORDER BY created_at DESC,rowid DESC LIMIT 100").all(ownerId,gameId).map(r=>r.request_id);
 return {schemaVersion:1,ownerId,gameId,title:context.title,revision:context.revision,libraryRevision:context.libraryRevision,runId:context.run?.id??null,run:context.run,fields:currentFields(context),currentRunFacts:context.currentRunFacts,provider:provider?.status?.()??unavailable,messages,proposals,appliedRequestIds,coverage:context.coverage,revealed:reveal,policy:'Drafts never change confirmed facts. Explicit accepted items become USER_CONFIRMED; PSN trophies remain provider-only.'};
}

/** Auth/session/owner gate is owned by mobile-api; this function additionally scopes every row by owner+game. */
export async function handleCompanion(store,gameId,body,{ownerId,provider=null,now=new Date().toISOString(),reveal=false}={}){
 ownerCheck(ownerId);initCompanion(store);
 if(!body||typeof body!=='object'||Array.isArray(body)||!safeId(body.requestId)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!Number.isFinite(Date.parse(now)))fail('invalid_companion_command');
 const type=body.type==='manual_proposal'?'manual':body.type;
 const schemas={message:['requestId','expectedRevision','type','text','images','consentExternal','reveal'],manual:['requestId','expectedRevision','type','text','items','reveal'],resolve:['requestId','expectedRevision','type','proposalId','decisions','reveal']},allowed=Object.hasOwn(schemas,type)?schemas[type]:null;
 if(!allowed||Object.keys(body).some(k=>!allowed.includes(k))||body.reveal!==undefined&&typeof body.reveal!=='boolean')fail('invalid_companion_command');
 reveal=body.reveal??reveal;const context=journeyContext(store,gameId,{reveal});if(!context.active)fail('active_game_required');
 let images=[];if(type==='message')images=validateCompanionImages(body.images??[]);
 const hashed={...body,...(type==='message'?{images:images.map(({dataBase64,...metadata})=>metadata)}:{})},hash=digest({gameId,body:hashed});
 const old=priorReceipt(store,ownerId,gameId,body.requestId);
 if(old){if(old.request_hash!==hash)fail('idempotency_conflict');return {...companionGet(store,gameId,{ownerId,provider,reveal,now}),replayed:true,requestState:old.state};}
 if(context.revision!==body.expectedRevision)fail('companion_revision_conflict');
 if(type==='resolve'){
  const record=store.db.prepare('SELECT payload_json FROM companion_proposals WHERE id=? AND owner_id=? AND game_id=?').get(body.proposalId,ownerId,gameId);if(!record)fail('companion_proposal_not_found');
  const proposal=JSON.parse(record.payload_json);
  if(!Array.isArray(body.decisions)||!body.decisions.length||body.decisions.length>20||new Set(body.decisions.map(d=>d?.itemId)).size!==body.decisions.length||body.decisions.some(d=>!d||typeof d!=='object'||Object.keys(d).some(k=>!['itemId','decision','value'].includes(k))||!['accept','reject'].includes(d.decision)))fail('invalid_companion_command');
  const choices=body.decisions.map(d=>{const item=proposal.items.find(i=>i.id===d.itemId);if(!item||item.status!=='pending')fail('companion_item_not_pending');if(!reveal&&(proposal.revealed||item.spoilerLevel==='quest_outcome'))fail('invalid_companion_proposal');return {decision:d,item};});
  if(proposal.baseRevision!==context.revision||proposal.runId!==(context.run?.id??null)){
   // Persist an updated preview only. A second explicit click against this revision is required.
   proposal.baseRevision=context.revision;proposal.runId=context.run?.id??null;proposal.reconciledAt=now;
   for(const i of proposal.items)if(i.status==='pending'){const previous=context.currentRunFacts[i.field]?.value;i.previousValue=previous??null;i.conflict=replacement(previous,i.value,i.operation);}
   putProposal(store,ownerId,gameId,proposal);fail('companion_revision_conflict');
  }
  const accepted=choices.filter(c=>c.decision.decision==='accept').map(({decision,item})=>validateJourneyFact(store,gameId,{field:item.field,value:Object.hasOwn(decision,'value')?decision.value:item.value,operation:item.operation,wording:Object.hasOwn(decision,'value')?`Исправлено перед подтверждением: ${Array.isArray(decision.value)?decision.value.join('; '):String(decision.value)}`:item.wording}));
  if(accepted.length&&!context.run)fail('journey_not_started');
  atomic(store,()=>{
   if(accepted.length)journeyCommand(store,gameId,{requestId:body.requestId,expectedRevision:context.revision,type:'batch',facts:accepted},now);
   for(const {decision,item} of choices){item.status=decision.decision==='accept'?'accepted':'rejected';item.resolvedAt=now;if(item.status==='accepted'){const fact=accepted.find(f=>f.field===item.field);item.value=fact.value;item.confirmedSource='USER_CONFIRMED';item.eventId=body.requestId;}}
   proposal.status=proposal.items.some(i=>i.status==='pending')?'pending':'resolved';
   // A partially accepted draft belongs to the new revision; remaining choices still receive an explicit preview.
   const current=journeyState(store,gameId);proposal.baseRevision=current?.revision??0;
   for(const i of proposal.items)if(i.status==='pending'){const previous=current?.facts[i.field]?.value;i.previousValue=previous??null;i.conflict=replacement(previous,i.value,i.operation);}
   putProposal(store,ownerId,gameId,proposal);addReceipt(store,ownerId,gameId,body,hash,'complete',now);
   addMessage(store,ownerId,gameId,{id:makeId(ownerId,gameId,body.requestId,'receipt'),requestId:body.requestId,role:'assistant',text:accepted.length?`Подтверждено изменений: ${accepted.length}. Маршрут пересчитан; трофеи Sony не изменены.`:'Выбранные изменения отклонены. Подтверждённое прохождение не изменено.',source:accepted.length?'USER_CONFIRMED':'SYSTEM',createdAt:now,proposalId:proposal.id,revealed:reveal});
  });
  return {...companionGet(store,gameId,{ownerId,provider,reveal,now}),journey:journeyContext(store,gameId,{reveal}),replayed:false};
 }
 if(body.text!==undefined&&(typeof body.text!=='string'||body.text.length>3000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.text)))fail('invalid_companion_command');
 const text=body.text?.trim()??'';if(type==='message'&&!text&&!images.length)fail('invalid_companion_command');
 if(type==='manual'){
  if(!Array.isArray(body.items)||!body.items.length||body.items.length>20||body.items.some(i=>!i||typeof i!=='object'||Object.keys(i).some(k=>!['field','value','operation','wording'].includes(k))))fail('invalid_companion_proposal');
  const items=proposalItems(store,gameId,body.items,context,'USER_DRAFT');
  atomic(store,()=>{addMessage(store,ownerId,gameId,{id:makeId(ownerId,gameId,body.requestId,'user'),requestId:body.requestId,role:'user',text:text||'Ручной черновик обновления прохождения',source:'USER_DRAFT',createdAt:now,revealed:reveal});const p=createProposal(store,gameId,ownerId,body,items,context,'USER_DRAFT',now);addMessage(store,ownerId,gameId,{id:makeId(ownerId,gameId,body.requestId,'assistant'),requestId:body.requestId,role:'assistant',text:'Ручной черновик готов. Проверьте отдельные изменения: они сохранятся только после вашего подтверждения.',source:'SYSTEM',createdAt:now,proposalId:p.id,revealed:reveal});addReceipt(store,ownerId,gameId,body,hash,'complete',now);});
  return companionGet(store,gameId,{ownerId,provider,reveal,now});
 }
 const configured=provider?.status?.().configured===true;
 // Never send anything externally unless both server budget and this request's disclosure consent permit it.
 if(configured&&body.consentExternal!==true)fail('companion_consent_required');
 atomic(store,()=>{addMessage(store,ownerId,gameId,{id:makeId(ownerId,gameId,body.requestId,'user'),requestId:body.requestId,role:'user',text:text||'Скриншоты игры',source:'USER_MESSAGE',createdAt:now,revealed:reveal,images:images.map(({dataBase64,...metadata})=>metadata),state:configured?'processing':'unavailable'});addReceipt(store,ownerId,gameId,body,hash,'processing',now);});
 let result,code,items=[];
 if(!configured)code='ai_not_configured';
 else try{
  const history=companionGet(store,gameId,{ownerId,provider,reveal,now}).messages.filter(m=>m.requestId!==body.requestId).slice(-4).map(m=>({role:m.role,text:m.text.slice(0,1000),source:m.source}));
  result=validateAIOutput(await provider.generate({requestId:makeId(ownerId,gameId,body.requestId,'AI'),text,images,context:contextForAI(context),history,consentExternal:true}));
  for(const update of result.updates)if(context.fields[update.field]?.type==='array'&&update.operation==='remove'&&!update.evidence.includes('text'))update.confidence='uncertain';
  const uncertain=result.updates.filter(u=>u.confidence==='uncertain');if(uncertain.length)result.questions=[...result.questions,...uncertain.map(u=>`Не удалось уверенно определить «${context.fields[u.field]?.label??'игровое условие'}». Уточните значение вручную.`)].slice(0,4);
  if(result.updates.some(u=>u.evidence.some(e=>e.startsWith('image:')&&Number(e.slice(6))>=images.length)||u.evidence.includes('text')&&!text))fail('ai_invalid_output');
  const allowedRules=new Set(context.actions.filter(a=>!a.spoilerHidden).map(a=>a.id));if(result.advice.some(a=>!allowedRules.has(a.ruleId)))fail('ai_invalid_output');
  items=proposalItems(store,gameId,result.updates,context,'INFERRED');
 }catch(e){code=Object.hasOwn(errorMessages,e.message)?e.message:'ai_provider_error';}
 atomic(store,()=>{
  const p=!code?createProposal(store,gameId,ownerId,body,items,context,'INFERRED',now):null;
  addMessage(store,ownerId,gameId,{id:makeId(ownerId,gameId,body.requestId,'assistant'),requestId:body.requestId,role:'assistant',text:code?errorMessages[code]??'AI-ответ не удалось безопасно обработать. Подтверждённое состояние не изменено. Автоматической повторной отправки не было.':result.reply,source:code?'SYSTEM':'INFERRED',createdAt:now,revealed:reveal,proposalId:p?.id??null,code:code??null,advice:code?[]:result.advice.map(a=>context.actions.find(r=>r.id===a.ruleId)),questions:code?[]:result.questions});
  store.db.prepare("UPDATE companion_receipts SET state='complete' WHERE owner_id=? AND game_id=? AND request_id=?").run(ownerId,gameId,body.requestId);
  const userRow=store.db.prepare('SELECT payload_json FROM companion_messages WHERE id=?').get(makeId(ownerId,gameId,body.requestId,'user'));
  if(userRow){const user=JSON.parse(userRow.payload_json);user.state=code?'unavailable':'complete';store.db.prepare('UPDATE companion_messages SET payload_json=? WHERE id=?').run(JSON.stringify(user),user.id);}
 });
 return companionGet(store,gameId,{ownerId,provider,reveal,now});
}
