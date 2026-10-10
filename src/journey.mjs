import {libraryId} from './library-store.mjs';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {buildRoadmap} from './roadmap.mjs';
import {resolveTrophyImplications} from './trophy-implications.mjs';

const pack=JSON.parse(readFileSync(new URL('../knowledge/witcher3-ps5-v0.json',import.meta.url)));
const bindings=JSON.parse(readFileSync(new URL('../knowledge/journey-bindings.json',import.meta.url)));
const hades=JSON.parse(readFileSync(new URL('../knowledge/hades2-journey-v0.json',import.meta.url)));
const fail=code=>{throw Error(code);};
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const own=(o,k)=>Object.hasOwn(o,k);
const basicFields={currentRegion:{label:'Текущая локация',type:'text'},currentMilestone:{label:'Текущая сюжетная точка',type:'text'},currentObjective:{label:'Текущая цель / задание',type:'text'},gameVersion:{label:'Установленная версия игры',type:'text'},note:{label:'Заметка о прохождении',type:'text'},
 completedQuests:{label:'Подтверждённые выполненные задания',type:'array'},activeQuests:{label:'Подтверждённые активные задания',type:'array'},decisions:{label:'Подтверждённые решения',type:'array',spoilerLevel:'quest_outcome'},items:{label:'Подтверждённые предметы',type:'array'},recipes:{label:'Подтверждённые рецепты',type:'array'},cards:{label:'Подтверждённые карты',type:'array'},characterLevel:{label:'Уровень персонажа',type:'number',min:1,max:1000}};
const actionStates=['not_started','in_progress','completed'];
const collectionLimit=200;
const cleanText=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max&&!/[\x00-\x1f\x7f]/.test(s);
const collectionKey=s=>s.normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru-RU');
function mergeCollection(before,incoming,operation){
 const old=Array.isArray(before)?before:[],keyed=new Map((operation==='set'?[]:old).map(s=>[collectionKey(s),s]));
 for(const item of incoming)if(operation==='remove')keyed.delete(collectionKey(item));else if(!keyed.has(collectionKey(item)))keyed.set(collectionKey(item),item);
 if(keyed.size>collectionLimit)fail('invalid_journey_value');return [...keyed.values()];
}
/** The same bounded schema is used for manual facts and untrusted AI proposals. */
export function validateJourneyFact(store,id,item){
 if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['field','value','wording','operation'].includes(k)))fail('invalid_journey_value');
 const def=journeyFields(store,id,true)[item.field];if(!def)fail('invalid_journey_field');
 let value=item.value;const operation=item.operation??'set';
 if(!['set','add','remove'].includes(operation)||def.type!=='array'&&operation!=='set')fail('invalid_journey_value');
 if(def.type==='text'){if(!cleanText(value,300))fail('invalid_journey_value');value=value.trim();}
 else if(def.type==='number'){if(!Number.isSafeInteger(value)||value<def.min||value>def.max)fail('invalid_journey_value');}
 else if(def.type==='array'){
  if(!Array.isArray(value)||value.length>100||value.some(s=>!cleanText(s,160)))fail('invalid_journey_value');
  value=mergeCollection([],value.map(s=>s.normalize('NFC').trim()),'set');
 }else if(!def.values?.some(v=>v===value))fail('invalid_journey_value');
 if(item.wording!==undefined&&(typeof item.wording!=='string'||item.wording.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.wording)))fail('invalid_journey_value');
 return {field:item.field,value,operation,wording:item.wording??(Array.isArray(value)?value.join('; '):String(value))};
}
export function initJourney(store){store.db.exec(`
 CREATE TABLE IF NOT EXISTS journey_runs(game_id TEXT PRIMARY KEY REFERENCES games(id),run_id TEXT NOT NULL,revision INTEGER NOT NULL,seed_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS journey_events(id TEXT PRIMARY KEY,game_id TEXT NOT NULL REFERENCES games(id),run_id TEXT NOT NULL,revision INTEGER NOT NULL,request_hash TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(game_id,revision));
 CREATE INDEX IF NOT EXISTS journey_event_game ON journey_events(game_id,revision);
`);}
function kind(store,id){const g=store.rawGame(id);if(!g)fail('game_not_found');return g.platform==='PS5'?g.external_set_id:null;}
export function journeyFields(store,id,reveal=false){
 const k=kind(store,id),defs=k===bindings.setId?pack.facts:k===hades.setId?hades.facts:{};
 const ruleList=k===bindings.setId?pack.rules:k===hades.setId?hades.rules:[];
 const progressFields=Object.fromEntries(ruleList.flatMap(r=>{const spoilerLevel=r.spoilerLevel==='quest_outcome'?'quest_outcome':'none';return [[`actionDone:${r.ruleId}`,{label:`Ранее отмечено выполненным: ${r.title}`,values:[true,false],spoilerLevel,legacy:true}],[`actionStatus:${r.ruleId}`,{label:`Прогресс действия: ${r.title}`,values:actionStates,spoilerLevel}]];}));
 const quantitative=k===bindings.setId?{bombRecipeTypes:{label:'Изучено разных типов рецептов бомб',type:'number',min:0,max:6}}:{};
 return Object.fromEntries(Object.entries({...defs,...basicFields,...progressFields,...quantitative}).filter(([,d])=>reveal||d.spoilerLevel!=='quest_outcome').map(([key,d])=>[key,{...d,type:d.type??'choice',spoilerLevel:d.spoilerLevel??'none',...(key==='currentMilestone'&&defs.currentMilestone?{suggestions:defs.currentMilestone.values}:{})}]));
}
function row(store,id){return store.db.prepare('SELECT * FROM journey_runs WHERE game_id=?').get(id);}
function replayFacts(seed,events){
 const undone=new Set(events.filter(e=>e.type==='retract'&&!e.targetField).map(e=>e.targetId)),partial=new Set(events.filter(e=>e.type==='retract'&&e.targetField).map(e=>`${e.targetId}:${e.targetField}`)),facts=structuredClone(seed.facts??{});
 const isRetracted=(e,f)=>undone.has(e.id)||partial.has(`${e.id}:${f}`);
 for(const e of events){const changes=e.type==='fact'?[e]:e.type==='batch'?e.facts:[];
  for(const f of changes)if(!isRetracted(e,f.field)){
   const value=f.operation&&f.operation!=='set'?mergeCollection(facts[f.field]?.value,f.value,f.operation):f.value;
   facts[f.field]={field:f.field,value,source:'user_confirmation',provenance:'USER_CONFIRMED',observedAt:e.observedAt,runId:e.runId,revision:e.revision,revisionDelta:e.revisionDelta,reportedAnswer:f.wording,eventId:e.id};
  }
 }
 return {facts,events:events.map(e=>({...e,retracted:undone.has(e.id),...(e.type==='fact'?{retracted:isRetracted(e,e.field)}:{}),...(e.type==='batch'?{facts:e.facts.map(f=>({...f,retracted:isRetracted(e,f.field)}))}:{})}))};
}
export function journeyState(store,id){
 initJourney(store);const r=row(store,id);if(!r)return null;
 const seed=JSON.parse(r.seed_json),events=store.db.prepare('SELECT payload_json FROM journey_events WHERE game_id=? ORDER BY revision').all(id).map(x=>JSON.parse(x.payload_json));
 return {runId:r.run_id,revision:r.revision,createdAt:r.created_at,...replayFacts(seed,events),seed};
}
/** Copy only confirmed context; no account credentials or trophy state are imported. */
export function importJourneySeed(store,id,seed){
 initJourney(store);if(kind(store,id)!==bindings.setId||seed.setId!==bindings.setId||seed.player?.dataKind!=='user_state')fail('invalid_journey_seed');
 if(!seed.player.activeRun?.id||Object.values(seed.player.facts).some(f=>f.source!=='user_confirmation'))fail('invalid_journey_seed');
 return store.transaction(()=>{const old=row(store,id);if(old){if(JSON.parse(old.seed_json).importHash!==digest(seed))fail('journey_seed_conflict');return {changed:false};}
 const copy={facts:seed.player.facts,conflicts:seed.player.conflicts??[],history:seed.history??[],importHash:digest(seed),originalRevision:seed.player.stateRevision};
 store.db.prepare('INSERT INTO journey_runs VALUES(?,?,?,?,?)').run(id,seed.player.activeRun.id,seed.player.stateRevision,JSON.stringify(copy),new Date().toISOString());store.bump();return {changed:true,revision:seed.player.stateRevision};});
}
export function journeyCommand(store,id,command,now=new Date().toISOString()){
 initJourney(store);kind(store,id);
 if(!command||typeof command!=='object'||Array.isArray(command)||!/^[-a-zA-Z0-9_]{16,80}$/.test(command.requestId??'')||!Number.isSafeInteger(command.expectedRevision)||command.expectedRevision<0||!Number.isFinite(Date.parse(now)))fail('invalid_journey_command');
 const schemas={start:['requestId','expectedRevision','type'],fact:['requestId','expectedRevision','type','field','value','wording','operation'],batch:['requestId','expectedRevision','type','facts'],retract:['requestId','expectedRevision','type','targetId','field']};
 if(!own(schemas,command.type))fail('invalid_journey_command');const allowed=schemas[command.type];if(Object.keys(command).some(k=>!allowed.includes(k)))fail('invalid_journey_command');
 const hash=digest({gameId:id,command});
 const commit=()=>{
  const duplicate=store.db.prepare('SELECT request_hash FROM journey_events WHERE id=?').get(command.requestId);
  if(duplicate){if(duplicate.request_hash!==hash)fail('idempotency_conflict');return {replayed:true};}
  const r=row(store,id),revision=r?.revision??0;if(revision!==command.expectedRevision)fail('journey_revision_conflict');
  if(!r&&command.type!=='start')fail('journey_not_started');if(r&&command.type==='start')fail('journey_already_started');
  const runId=r?.run_id??randomUUID(),next=revision+1;
  const event={id:command.requestId,type:command.type,runId,source:'user_confirmation',provenance:'USER_CONFIRMED',observedAt:now,revision:next,revisionDelta:{from:revision,to:next}};
  if(command.type==='start'){
   if(store.status(id).active!==true)fail('active_game_required');
   store.db.prepare('INSERT INTO journey_runs VALUES(?,?,?,?,?)').run(id,runId,0,JSON.stringify({facts:{},history:[]}),now);
  }else if(command.type==='fact'||command.type==='batch'){
   const input=command.type==='fact'?[Object.fromEntries(Object.entries(command).filter(([key])=>['field','value','wording','operation'].includes(key)))]:command.facts;
   if(!Array.isArray(input)||!input.length||input.length>20)fail('invalid_journey_value');
   const normalized=input.map(f=>validateJourneyFact(store,id,f));if(new Set(normalized.map(f=>f.field)).size!==normalized.length)fail('invalid_journey_value');
   const projected=structuredClone(journeyState(store,id).facts);
   for(const f of normalized)projected[f.field]={value:journeyFields(store,id,true)[f.field].type==='array'?mergeCollection(projected[f.field]?.value,f.value,f.operation):f.value};
   if(kind(store,id)===bindings.setId&&normalized.some(f=>f.field==='actionStatus:w3.bombs'&&f.value==='completed'||f.field==='actionDone:w3.bombs'&&f.value===true)&&projected.bombRecipeTypes?.value!==6)fail('invalid_journey_value');
   if(command.type==='fact')Object.assign(event,normalized[0]);else event.facts=normalized;
  }else if(command.type==='retract'){
   if(typeof command.targetId!=='string'||!/^[-a-zA-Z0-9_]{16,80}$/.test(command.targetId))fail('invalid_journey_target');
   const target=store.db.prepare('SELECT payload_json FROM journey_events WHERE id=? AND game_id=?').get(command.targetId,id);
   const targetEvent=target?JSON.parse(target.payload_json):null;
   if(!targetEvent||!['fact','batch'].includes(targetEvent.type)||command.field!==undefined&&(targetEvent.type!=='batch'||!targetEvent.facts.some(f=>f.field===command.field)))fail('invalid_journey_target');
   const allEvents=store.db.prepare('SELECT payload_json FROM journey_events WHERE game_id=? ORDER BY revision').all(id).map(e=>JSON.parse(e.payload_json)),prior=allEvents.filter(e=>e.type==='retract'&&e.targetId===command.targetId);
   if(prior.some(e=>!e.targetField||e.targetField===command.field)||command.field===undefined&&targetEvent.type==='fact'&&prior.length)fail('already_retracted');event.targetId=command.targetId;if(command.field!==undefined)event.targetField=command.field;
   // Undo can restore previously removed collection entries; validate the full
   // replay before committing so corrections cannot make the context unreadable.
   replayFacts(JSON.parse(r.seed_json),[...allEvents,event]);
  }else fail('invalid_journey_command');
  store.db.prepare('INSERT INTO journey_events VALUES(?,?,?,?,?,?)').run(event.id,id,runId,next,hash,JSON.stringify(event));store.db.prepare('UPDATE journey_runs SET revision=? WHERE game_id=?').run(next,id);store.bump();return {replayed:false,event};
 };return store.db.isTransaction?commit():store.transaction(commit);
}
function legacyState(store,id,j){
 const status=store.status(id),rows=store.trophies(id,{limit:1000}).trophies;
 const source={kind:status.source,freshness:{observedAt:status.lastObservationAt}};
 const observations=rows.map(t=>({id:t.id,accountId:'bound_owner',setId:id,trophyId:t.id,earned:t.earned,earnedAt:t.earnedAt,observedAt:status.lastObservationAt,source}));
 const trophyMapping=Object.fromEntries(Object.entries(bindings.trophies).map(([key,ref])=>[key,rows.find(t=>t.id===libraryId(id,'trophy',String(ref.id))&&t.name===ref.name)?.id??null]));
 // Free-form player wording stays authoritative. The bounded early guide receives
 // a conservative scope key; an unfamiliar quest is not assumed to be early Velen.
 const playerFacts=structuredClone(j?.facts??{}),milestone=playerFacts.currentMilestone;
 const outsideRegion=/^(оксенфурт|oxenfurt|новиград|novigrad|скеллиге|skellige|туссент|toussaint)$/i.test(playerFacts.currentRegion?.value??'');
 if(milestone&&(!pack.facts.currentMilestone.values.includes(milestone.value)||outsideRegion))playerFacts.currentMilestone={...milestone,value:'outside_pack_scope',reportedAnswer:milestone.reportedAnswer??milestone.value};
 return {player:{dataKind:'user_state',stateRevision:j?.revision??0,activeRun:{id:j?.runId??null,dataKind:'user_state'},facts:playerFacts,conflicts:j?.seed.conflicts??[]},account:{accountId:'bound_owner',setId:id,catalog:{trophies:rows},observations,lastConfirmedSnapshot:{summary:status.summary,observations,source}},trophyMapping};
}
export function journeyActionProgress(store,id,actionId,facts=journeyState(store,id)?.facts??{}){
 const statusField=`actionStatus:${actionId}`,legacy=facts[`actionDone:${actionId}`],explicit=facts[statusField];
 const useExplicit=explicit&&(explicit.revision??0)>=(legacy?.revision??0);
 let status=useExplicit?explicit.value:legacy?.value===true?'completed':'not_started',statusSource=useExplicit?'user_confirmation':legacy?'legacy_user_confirmation':'unknown';
 const counter=kind(store,id)===bindings.setId&&actionId==='w3.bombs'?{field:'bombRecipeTypes',value:facts.bombRecipeTypes?.value??null,target:6,unit:'типов рецептов',min:0,max:6}:null;
 const completionNeedsConfirmation=Boolean(counter&&counter.value===null&&useExplicit&&status==='completed');
 if(completionNeedsConfirmation)status='in_progress';
 if(counter&&Number.isSafeInteger(counter.value)){status=counter.value===0?'not_started':counter.value===6?'completed':'in_progress';statusSource='user_confirmation';}
 return {status,field:statusField,statusSource,legacyUnknownCount:Boolean(counter&&counter.value===null&&legacy?.value===true&&!useExplicit),...(completionNeedsConfirmation?{completionNeedsConfirmation:true}:{}),...(counter?{counter}:{})};
}
function safeRule(r,hide){return hide?{...r,title:'Скрытая сюжетная зависимость',message:'Есть сюжетная зависимость. Раскройте подробности, когда будете готовы.',dependencies:[],affectedTrophies:[],spoilerHidden:true}:r;}
export function journeyContext(store,id,{reveal=false}={}){
 initJourney(store);const status=store.status(id),j=journeyState(store,id),k=kind(store,id),rows=store.trophies(id,{limit:1000}).trophies,fields=journeyFields(store,id,reveal);
 let actions=[],unknowns=[],coach=[],updates=[],coverage={ruleCount:0,fullPlatinumCoverage:false,scope:'official_trophy_objectives_only'},rules=[],implications=[];
 const facts=j?.facts??{},value=f=>facts[f]?.value;
 if(k===bindings.setId){
  const state=legacyState(store,id,j); // No PSN observations are written to the manual Run.
  const roadmap=buildRoadmap(pack,state);coverage={...roadmap.evidenceCoverage,packVersion:pack.version};implications=resolveTrophyImplications(pack,state);
  for(const category of ['doNow','beforeProgressing','canDefer','blockedOrLost'])for(const a of roadmap[category]){
   const rule=pack.rules.find(r=>r.ruleId===a.ruleId),hide=!reveal&&rule.spoilerLevel==='quest_outcome';
   const uncertain=!a.actionable;
   actions.push(safeRule({id:a.ruleId,title:a.title,message:a.message,category:uncertain?'UPDATE_NEEDED':a.requirementLevel,certainty:a.currentVersionStatus??a.verificationStatus,source:'GUIDE_VERIFIED',status:a.status,whyNow:a.explanation.reason.replaceAll('account trophy','трофей аккаунта').replaceAll('run','прохождение'),evidence:a.explanation.evidence,dependencies:rule.prerequisites,affectedTrophies:rule.affectedTrophies.map(t=>state.trophyMapping[t]).filter(Boolean),missable:rule.missableStatus,ngPlus:rule.ngRelevance,difficulty:rule.difficultyRelevance,oneRun:rule.oneRunRequirement,actionable:a.actionable},hide));
  }
  // A published difficulty objective remains valid; patch-specific runtime fidelity stays qualified.
  if(value('startDeathMarch')==='yes'&&value('difficultyLowered')==='no'&&!rows.find(t=>t.id===libraryId(id,'trophy','10')&&t.name===bindings.trophies.difficulty_completion.name)?.earned){
   const existing=actions.find(a=>a.id==='w3.dm');if(existing){existing.category='MUST';existing.message='Сохраняйте «На смерть!» до завершения основной истории. Начало на этой сложности и отсутствие снижений подтверждены вами.';existing.whyNow='Трофей за сложность ещё не получен. Точное поведение версии 5.000.200 имеет отдельное ограничение проверки.';}
  }
  unknowns=roadmap.criticalUnknowns.map(u=>({kind:u.kind,message:!reveal&&u.ruleId&&pack.rules.find(r=>r.ruleId===u.ruleId)?.spoilerLevel==='quest_outcome'?'Требуется проверка сюжетной зависимости.':u.reason,field:fields[u.fact]?u.fact:null}));
  updates=roadmap.updateRequests.filter(u=>!u.fact||!own(facts,u.fact)||u.status==='waiting_for_gameplay_event').map(u=>({id:u.id,category:'UPDATE_NEEDED',message:u.message,whyNow:u.whyNow,field:fields[u.fact]?u.fact:null}));
  coach=(roadmap.coach.tips??[]).slice(0,2);
  rules=pack.rules.map(r=>({id:r.ruleId,title:!reveal&&r.spoilerLevel==='quest_outcome'?'Скрытая сюжетная зависимость':r.title,status:r.verificationStatus,spoilerHidden:!reveal&&r.spoilerLevel==='quest_outcome'}));
 }else if(k===hades.setId){
  coverage={ruleCount:hades.rules.length,packVersion:hades.version,scope:hades.scope,fullPlatinumCoverage:false,patchStatus:'VERSION_UNCERTAIN',limitation:'Версия установки и текущее сохранение не подтверждены; описания Sony проверены, механики руководства имеют статус SUPPORTED.'};
  for(const r of hades.rules){
   const trophy=rows.find(t=>t.id===libraryId(id,'trophy',String(r.trophyId))&&t.name===r.expectedName);rules.push({id:r.ruleId,title:r.title,status:trophy?'SUPPORTED':'UNVERIFIED'});
   if(!trophy){unknowns.push({kind:'mapping',message:'Не подтверждено соответствие трофея правилу.'});continue;}if(trophy.earned===true)continue;
   const known=r.requires.every(f=>value(f)==='yes'),blocked=r.requires.some(f=>value(f)==='no');
   const hide=!reveal&&(r.spoilerLevel==='story'||trophy.hidden);
   actions.push(safeRule({id:r.ruleId,title:r.title,message:blocked?'Сначала откройте необходимую систему; готовность к следующему шагу пока не подтверждена.':known?r.action:r.preview,category:known?'RECOMMENDED':'UPDATE_NEEDED',source:'GUIDE_VERIFIED',certainty:'SUPPORTED',whyNow:'Соответствующий трофей ещё не получен; условия текущего сохранения учитываются только по вашим ответам.',evidence:r.evidence,affectedTrophies:[trophy.id],dependencies:r.requires,missable:'UNKNOWN',ngPlus:'UNKNOWN',difficulty:'UNKNOWN',oneRun:r.oneRun,actionable:known},hide));
   if(!hide)for(const f of r.requires)if(!own(facts,f)&&!updates.some(u=>u.field===f))updates.push({id:f,category:'UPDATE_NEEDED',field:f,message:fields[f].label,whyNow:`Ответ определит следующий шаг: ${r.title}`});
  }
  unknowns.push({kind:'coverage',message:'Не подтверждены версия игры, ограничения NG+ и полный список рисков. Отсутствие предупреждения не означает доказанную безопасность.'});
 }else{
  unknowns.push({kind:'coverage',message:'Подробный проверенный маршрут для этого набора ещё не создан. Доступны условия Sony и ваши заметки; пропускаемость, сложность и NG+ неизвестны.'});
  actions=rows.filter(t=>t.earned===false&&!t.hidden&&t.grade!=='platinum').slice(0,3).map(t=>({id:`objective:${t.id}`,title:t.official?.localizations?.['ru-RU']?.name??t.name,message:t.official?.localizations?.['ru-RU']?.description??t.description??'Условие не предоставлено Sony.',category:'OPTIONAL',source:status.source==='direct_psn_api'?'PSN_VERIFIED':'IMPORTED',certainty:'OFFICIAL_OBJECTIVE_ONLY',whyNow:'Это неполученный трофей. Порядок и способ выполнения не утверждаются.',evidence:[],affectedTrophies:[t.id],dependencies:[],missable:'UNKNOWN',actionable:false}));
 }
 for(const a of actions){
  if(!a.spoilerHidden&&fields[`actionStatus:${a.id}`])a.progress=journeyActionProgress(store,id,a.id,facts);
  // Legacy binary buttons remain in the response only for older applications.
  if(!a.spoilerHidden&&a.actionable&&a.category!=='MUST'&&a.id!=='w3.bombs'&&fields[`actionDone:${a.id}`])a.confirmField=`actionDone:${a.id}`;
  if(a.progress?.legacyUnknownCount)a.message+=' Ранее действие было отмечено выполненным; число изученных типов не сообщалось. Уточните счётчик при возможности.';
  if(a.progress?.status==='completed'&&a.category!=='MUST'){a.userActionConfirmed=true;a.message+=' Действие отмечено вами; статус трофея определяется только Sony.';}
 }
 const contract=actions.find(a=>a.id==='w3.contracts.reserve');
 if(contract&&k===bindings.setId&&value('remainingContracts')===2&&value('unassistedContracts')===0){contract.category='RECOMMENDED';contract.message='Оставьте минимум два подходящих заказа для «Равных шансов»: в этом прохождении вы ещё не записали подходящие победы. Перед попыткой проверьте запрет Знаков, зелий, мутагенов, масел и бомб.';contract.whyNow='Две будущие возможности подтверждены вами. Это осторожное планирование; поведение точной версии отдельно не проверено.';}
 actions.sort((a,b)=>(['MUST','RECOMMENDED','OPTIONAL','UPDATE_NEEDED'].indexOf(a.category))-(['MUST','RECOMMENDED','OPTIONAL','UPDATE_NEEDED'].indexOf(b.category)));
 const confirmedActions=actions.filter(a=>a.userActionConfirmed);actions=actions.filter(a=>!a.userActionConfirmed);
 const visibleFacts=Object.fromEntries(Object.entries(facts).filter(([f])=>reveal||journeyFields(store,id,true)[f]?.spoilerLevel!=='quest_outcome'));
 const allHistory=(j?.events??[]).flatMap(e=>e.type==='batch'?e.facts.map((f,index)=>({...e,...f,type:'fact',batch:true,batchIndex:index,retracted:e.retracted||f.retracted,facts:undefined})):e);
 const history=allHistory.slice(-50).reverse().map(e=>!reveal&&journeyFields(store,id,true)[e.field]?.spoilerLevel==='quest_outcome'?{...e,value:null,wording:'Скрытое сюжетное подтверждение'}:e);
 // Retain the originally imported confirmations in history after a new current
 // location/quest replaces the current value. The immutable seed is not erased.
 const seedFacts=Object.entries(j?.seed.facts??{}).filter(([field])=>reveal||journeyFields(store,id,true)[field]?.spoilerLevel!=='quest_outcome').map(([field,f])=>({id:`seed:${field}`,type:'seed',field,...f,provenance:'USER_CONFIRMED',canRetract:false}));
 const completed=rows.filter(t=>t.earned===true).map(t=>({id:t.id,name:t.official?.localizations?.['ru-RU']?.name??t.name,earnedAt:t.earnedAt,source:status.source==='direct_psn_api'?'PSN_VERIFIED':'IMPORTED'}));
 return {schemaVersion:1,gameId:id,title:status.title,platform:status.platform,setId:status.providerMetadata.setId,active:status.active,run:j?{id:j.runId,revision:j.revision,createdAt:j.createdAt}:null,revision:j?.revision??0,libraryRevision:store.meta('revision')??0,source:'COMPOSED',generatedAt:new Date().toISOString(),revealed:reveal,
  trophySummary:status.summary,trophySource:status.source,lastSuccessfulSyncAt:status.lastSuccessfulSyncAt,freshFetchPerformed:false,
  currentRunFacts:visibleFacts,fields,history:[...history,...seedFacts],historyTotal:allHistory.length+seedFacts.length,
  actions,confirmedActions,updateRequests:updates,coach,criticalUnknowns:unknowns,coverage,rules,trophyImplications:implications,
  completed:completed.slice(0,12),completedTotal:completed.length,remainingCount:rows.filter(t=>t.earned===false).length,
  progress:{kind:'covered_rules_only',total:rules.length,providerConfirmed: k===hades.setId?hades.rules.filter(r=>rows.some(t=>t.id===libraryId(id,'trophy',String(r.trophyId))&&t.name===r.expectedName&&t.earned)).length:k===bindings.setId?buildRoadmap(pack,legacyState(store,id,j)).items.filter(i=>i.accountEarned).length:0},
  conflicts:[...(j?.seed.conflicts??[]),...(Array.isArray(value('activeQuests'))&&Array.isArray(value('completedQuests'))?value('activeQuests').filter(q=>value('completedQuests').some(c=>collectionKey(c)===collectionKey(q))).map(q=>({fact:'activeQuests',relatedFact:'completedQuests',value:q,status:'needs_reconciliation',kind:'quest_status_conflict'})):[])],policy:'PSN trophies never establish current run facts; user confirmation never sets provider earned.'};
}
