import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LibraryStore,normalizeLibrarySnapshot} from '../src/library-store.mjs';
import {journeyCommand,journeyState} from '../src/journey.mjs';
import {handleCompanion,companionGet} from '../src/companion.mjs';
import {createMobileApi,bindAppOwner} from '../src/mobile-api.mjs';
const binding=JSON.parse(readFileSync(new URL('../knowledge/journey-bindings.json',import.meta.url)));
const ownerId='synthetic-owner';
let serial=0;
const command=(type,revision,more={})=>({type,expectedRevision:revision,requestId:`companion_contract_${++serial}`,...more});
function setup(path=':memory:'){
 const store=new LibraryStore(path);store.replaceInventory('private-provider-account',[{title:'Synthetic Witcher',setId:binding.setId,platform:'PS5'}],new Date().toISOString());
 const gameId=store.list().games[0].gameId;store.db.prepare('INSERT INTO active_games VALUES(?,1)').run(gameId);
 const entries=Object.values(binding.trophies),raw={dataKind:'live_psn',set:{setId:binding.setId,platform:'PS5',version:'contract-test',groups:[{trophyGroupId:'default'}],catalog:entries.map(t=>({...t,id:String(t.id),grade:'bronze',groupId:'default',hidden:false}))},account:{setId:binding.setId,version:'contract-test',observedAt:new Date().toISOString(),trophies:entries.map(t=>({id:String(t.id),earned:false,earnedAt:null}))}};
 store.commit(normalizeLibrarySnapshot(raw,gameId));journeyCommand(store,gameId,command('start',0));return {store,gameId};
}
const invoke=(s,id,b,options={})=>handleCompanion(s,id,b,{ownerId,...options});
test('unconfigured text is retained as chat, honestly unavailable; no inferred or confirmed facts',async()=>{
 const {store,gameId}=setup();try{const before=store.meta('revision'),body=command('message',1,{text:'Получил грамоту от Барона, приехал в Оксенфурт. Сейчас ищу его дочь.'});const answer=await invoke(store,gameId,body);
 assert.equal(answer.provider.status,'UNCONFIGURED');assert.equal(answer.revision,1);assert.equal(answer.proposals.length,0);assert.match(answer.messages.at(-1).text,/не подключён/);assert.equal(answer.messages.at(-1).source,'SYSTEM');assert.deepEqual(journeyState(store,gameId).facts,{});assert.equal(store.meta('revision'),before);
 const replay=await invoke(store,gameId,body);assert.equal(replay.replayed,true);assert.equal(replay.messages.length,2);assert.equal(companionGet(store,gameId,{ownerId:'different-owner'}).messages.length,0);
 }finally{store.close();}
});
test('manual Baron→Oxenfurt draft supports per-item accept/edit/reject; history and Sony remain independent',async()=>{
 const {store,gameId}=setup();try{const draft=await invoke(store,gameId,command('manual',1,{text:'Барон → грамота → Оксенфурт',items:[{field:'currentRegion',value:'Оксенфурт'},{field:'currentObjective',value:'Ищу дочь Барона'},{field:'items',value:['Грамота Барона'],operation:'add'}]}));const p=draft.proposals[0];assert.equal(p.source,'USER_DRAFT');assert.equal(draft.revision,1);
 const first=command('resolve',1,{proposalId:p.id,decisions:[{itemId:p.items[0].id,decision:'accept'},{itemId:p.items[1].id,decision:'accept',value:'Подтверждённое название задания'},{itemId:p.items[2].id,decision:'reject'}]});const result=await invoke(store,gameId,first);
 assert.equal(result.revision,2);assert.equal(result.journey.currentRunFacts.currentRegion.value,'Оксенфурт');assert.equal(result.journey.currentRunFacts.currentObjective.value,'Подтверждённое название задания');assert.equal(result.journey.currentRunFacts.items,undefined);assert.equal(result.journey.currentRunFacts.currentRegion.provenance,'USER_CONFIRMED');assert.equal(journeyState(store,gameId).events.at(-1).type,'batch');assert.equal(journeyState(store,gameId).events.at(-1).facts.length,2);assert.equal(store.status(gameId).summary.earned,0);
 assert.equal((await invoke(store,gameId,first)).replayed,true);assert.equal(journeyState(store,gameId).events.length,2);
 const correction=command('retract',2,{targetId:first.requestId,field:'currentRegion'});journeyCommand(store,gameId,correction);assert.equal(journeyState(store,gameId).facts.currentRegion,undefined);assert.equal(journeyState(store,gameId).facts.currentObjective.value,'Подтверждённое название задания');
 }finally{store.close();}
});
test('stale proposal is re-previewed and cannot silently overwrite a concurrent device update',async()=>{
 const {store,gameId}=setup();try{
 journeyCommand(store,gameId,command('fact',1,{field:'currentRegion',value:'Велен'}));const draft=await invoke(store,gameId,command('manual',2,{items:[{field:'currentRegion',value:'Оксенфурт'}]}));const p=draft.proposals[0];assert.equal(p.items[0].conflict.previousValue,'Велен');
 journeyCommand(store,gameId,command('fact',2,{field:'currentRegion',value:'Новиград'}));const resolve=command('resolve',3,{proposalId:p.id,decisions:[{itemId:p.items[0].id,decision:'accept'}]});
 await assert.rejects(invoke(store,gameId,resolve),/companion_revision_conflict/);assert.equal(journeyState(store,gameId).facts.currentRegion.value,'Новиград');const refreshed=companionGet(store,gameId,{ownerId}).proposals[0];assert.equal(refreshed.items[0].previousValue,'Новиград');assert.equal(refreshed.baseRevision,3);
 const accepted=await invoke(store,gameId,resolve);assert.equal(accepted.revision,4);assert.equal(accepted.currentRunFacts.currentRegion.value,'Оксенфурт');
 }finally{store.close();}
});
test('AI contract fixture merges partial screenshot lists; extracts drafts only, without image retention or private account context',async()=>{
 const {store,gameId}=setup();try{
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(400,16);png.writeUInt32BE(800,20);
 let sent;const provider={status:()=>({configured:true,textAvailable:true,visionAvailable:true,status:'CONTRACT_TEST_PROVIDER'}),async generate(input){sent=input;return {reply:'На тестовых снимках видны задания. Проверьте черновик.',updates:[{field:'completedQuests',value:['Лихо у колодца','Задание A'],operation:'add',wording:'Видно на первом снимке',evidence:['image:0'],confidence:'clear'},{field:'completedQuests',value:['лихо у колодца','Задание B'],operation:'add',wording:'Видно на втором снимке',evidence:['image:1'],confidence:'clear'}],advice:[],questions:[]};}};
 const body=command('message',1,{text:'Выполненные задания',images:[0,1].map(()=>({mimeType:'image/png',dataBase64:png.toString('base64')})),consentExternal:true});const result=await invoke(store,gameId,body,{provider});const p=result.proposals[0];assert.equal(p.source,'INFERRED');assert.equal(p.items.length,1);assert.deepEqual(p.items[0].value,['Лихо у колодца','Задание A','Задание B']);assert.equal(result.revision,1);assert.ok(!JSON.stringify(sent.context).includes('private-provider-account'));
 const db=store.db.prepare('SELECT payload_json FROM companion_messages').all().map(x=>x.payload_json).join('');assert.ok(!db.includes('dataBase64'));assert.ok(!db.includes(png.toString('base64')));
 journeyCommand(store,gameId,command('fact',1,{field:'completedQuests',value:['Уже подтверждённое невидимое задание'],operation:'add'}));const accept=command('resolve',2,{proposalId:p.id,decisions:[{itemId:p.items[0].id,decision:'accept'}]});await assert.rejects(invoke(store,gameId,accept,{provider}),/revision_conflict/);const confirmed=await invoke(store,gameId,accept,{provider});assert.ok(confirmed.currentRunFacts.completedQuests.value.includes('Уже подтверждённое невидимое задание'));
 }finally{store.close();}
});
test('acceptance is atomic and a premature six-type bomb completion cannot partly apply other changes',async()=>{
 const {store,gameId}=setup();try{
 const draft=await invoke(store,gameId,command('manual',1,{items:[{field:'currentRegion',value:'Оксенфурт'},{field:'bombRecipeTypes',value:1},{field:'actionStatus:w3.bombs',value:'completed'}]})),p=draft.proposals[0],choices=p.items.map(i=>({itemId:i.id,decision:'accept'}));await assert.rejects(invoke(store,gameId,command('resolve',1,{proposalId:p.id,decisions:choices})),/invalid_journey_value/);
 assert.equal(journeyState(store,gameId).revision,1);assert.deepEqual(journeyState(store,gameId).facts,{});assert.ok(companionGet(store,gameId,{ownerId}).proposals[0].items.every(i=>i.status==='pending'));
 const result=await invoke(store,gameId,command('resolve',1,{proposalId:p.id,decisions:choices.map(d=>d.itemId===p.items.find(i=>i.field==='actionStatus:w3.bombs').id?{...d,value:'in_progress'}:d)}));assert.equal(result.revision,2);assert.equal(result.currentRunFacts.bombRecipeTypes.value,1);assert.equal(result.currentRunFacts['actionStatus:w3.bombs'].value,'in_progress');assert.equal(store.status(gameId).summary.earned,0);
 }finally{store.close();}
});
test('chat persists across database reopen, hidden outcome draft stays redacted and consent blocks external calls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pc-companion-contract-')),path=join(dir,'test.sqlite');let {store,gameId}=setup(path);try{
 let calls=0;const provider={status:()=>({configured:true}),generate:()=>{calls++;assert.fail('no external consent');}};await assert.rejects(invoke(store,gameId,command('message',1,{text:'hello'}),{provider}),/consent_required/);assert.equal(calls,0);
 const draft=await invoke(store,gameId,command('manual',1,{reveal:true,items:[{field:'decisions',value:['Скрытое сюжетное решение'],operation:'add'}]}));assert.equal(draft.proposals[0].items[0].value[0],'Скрытое сюжетное решение');store.close();store=new LibraryStore(path);
 const safe=companionGet(store,gameId,{ownerId});assert.equal(safe.messages.length,2);assert.equal(safe.proposals[0].items[0].value,null);assert.ok(!JSON.stringify(safe).includes('Скрытое сюжетное решение'));await assert.rejects(invoke(store,gameId,command('resolve',1,{proposalId:safe.proposals[0].id,decisions:[{itemId:safe.proposals[0].items[0].id,decision:'accept'}]})),/invalid_companion_proposal/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('existing authenticated mobile API exposes the same chat and confirmation state; session, owner, scope and JSON gates hold',async()=>{
 const {store,gameId}=setup();try{
 const principal={issuer:'https://issuer.contract.invalid',subject:'owner',sessionId:'device',scopes:['platinum:sync']};bindAppOwner(store,principal);const api=createMobileApi({store,runSync:()=>assert.fail('companion never invokes Sony')});
 const request=async(method,body,p=principal,contentType='application/json')=>{let status,data;const path=`/api/v2/games/${gameId}/companion`;await api({method,url:path,headers:{'content-type':contentType},async *[Symbol.asyncIterator](){if(body)yield JSON.stringify(body);}},{writeHead(s){status=s;},end(value){data=JSON.parse(value);}},p,path);return {status,data};};
 assert.equal((await request('GET',null,{...principal,sessionId:null})).status,403);assert.equal((await request('GET',null,{...principal,subject:'outsider'})).status,403);assert.equal((await request('POST',command('message',1,{text:'hello'}),{...principal,scopes:[]})).status,403);assert.equal((await request('POST',command('message',1,{text:'hello'}),principal,'text/plain')).status,415);assert.equal((await request('POST',command('constructor',1))).status,400);
 const draft=await request('POST',command('manual',1,{items:[{field:'currentRegion',value:'Оксенфурт'}]}));assert.equal(draft.status,200);const p=draft.data.proposals[0],accepted=await request('POST',command('resolve',1,{proposalId:p.id,decisions:[{itemId:p.items[0].id,decision:'accept'}]}));assert.equal(accepted.status,200);assert.equal(accepted.data.revision,2);assert.equal((await request('GET')).data.currentRunFacts.currentRegion.value,'Оксенфурт');assert.equal(store.status(gameId).summary.earned,0);
 }finally{store.close();}
});
