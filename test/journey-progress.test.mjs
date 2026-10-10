import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LibraryStore,normalizeLibrarySnapshot} from '../src/library-store.mjs';
import {journeyContext,journeyCommand,journeyState,journeyFields,journeyActionProgress,validateJourneyFact,importJourneySeed} from '../src/journey.mjs';

const binding=JSON.parse(readFileSync(new URL('../knowledge/journey-bindings.json',import.meta.url)));
function fixture(path=':memory:'){
 const store=new LibraryStore(path);store.replaceInventory('test-user',[{title:'Test Witcher',setId:binding.setId,platform:'PS5',service:'trophy2'}],'2026-10-10T00:00:00Z');
 const id=store.list().games[0].gameId;store.db.prepare('INSERT INTO active_games VALUES(?,1)').run(id);
 const entries=Object.values(binding.trophies),raw={dataKind:'live_psn',set:{setId:binding.setId,platform:'PS5',version:'test',groups:[{trophyGroupId:'default'}],catalog:entries.map(t=>({...t,id:String(t.id),grade:'bronze',groupId:'default',hidden:false}))},account:{setId:binding.setId,version:'test',observedAt:'2026-10-10T00:00:00Z',trophies:entries.map(t=>({id:String(t.id),earned:false,earnedAt:null}))}};
 store.commit(normalizeLibrarySnapshot(raw,id));return {store,id};
}
function seed(store,id,extra={}){
 const facts=Object.fromEntries(Object.entries({goal:'base_platinum',gamePatch:'5.x',currentMilestone:'vizima_audience',currentRegion:'Вызима',mode:'NG',startDeathMarch:'yes',difficultyLowered:'no',whiteOrchardShopCards:'yes',zoltanCard:'yes',contractAttemptNow:'no',...extra}).map(([field,value])=>[field,{field,value,source:'user_confirmation',observedAt:'2026-10-02T00:00:00Z',runId:'test-run',revision:29,...(field==='gamePatch'?{reportedAnswer:'5.000.200'}:{})}]));
 importJourneySeed(store,id,{setId:binding.setId,player:{dataKind:'user_state',stateRevision:29,activeRun:{id:'test-run'},facts,conflicts:[]}});return facts;
}
function send(store,id,type,extra={}){return journeyCommand(store,id,{requestId:`journey_test_${type}_${crypto.randomUUID()}`,expectedRevision:journeyState(store,id)?.revision??0,type,...extra},'2026-10-10T01:00:00Z');}

test('bomb types have real partial progress and exact six completion; provider trophy is independent',()=>{
 const {store,id}=fixture();try{
  seed(store,id);assert.equal(journeyActionProgress(store,id,'w3.bombs').counter.value,null);
  send(store,id,'fact',{field:'bombRecipeTypes',value:0});assert.equal(journeyActionProgress(store,id,'w3.bombs').status,'not_started');
  send(store,id,'fact',{field:'bombRecipeTypes',value:1});const first=journeyContext(store,id);assert.equal(first.actions.find(a=>a.id==='w3.bombs').progress.status,'in_progress');assert.ok(!first.confirmedActions.some(a=>a.id==='w3.bombs'));
  send(store,id,'fact',{field:'bombRecipeTypes',value:6});assert.equal(journeyContext(store,id).confirmedActions.find(a=>a.id==='w3.bombs').progress.counter.value,6);
  send(store,id,'fact',{field:'bombRecipeTypes',value:3});assert.equal(journeyContext(store,id).actions.find(a=>a.id==='w3.bombs').progress.status,'in_progress');
  assert.equal(store.status(id).summary.earned,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,1);
 }finally{store.close();}
});
test('quantitative completion cannot invent a count; a bad item rolls back every selected fact',()=>{
 const {store,id}=fixture();try{
  seed(store,id);assert.throws(()=>send(store,id,'fact',{field:'actionDone:w3.bombs',value:true}),/invalid_journey_value/);
  assert.throws(()=>send(store,id,'batch',{facts:[{field:'currentRegion',value:'Оксенфурт'},{field:'actionStatus:w3.bombs',value:'completed'}]}),/invalid_journey_value/);
  assert.equal(journeyState(store,id).revision,29);assert.equal(journeyState(store,id).facts.currentRegion.value,'Вызима');
  send(store,id,'batch',{facts:[{field:'bombRecipeTypes',value:6},{field:'actionStatus:w3.bombs',value:'completed'}]});
  assert.equal(journeyActionProgress(store,id,'w3.bombs').status,'completed');
  for(const value of [-1,7,1.2,'6'])assert.throws(()=>validateJourneyFact(store,id,{field:'bombRecipeTypes',value}),/invalid_journey_value/);
 }finally{store.close();}
});
test('legacy completion retains its historical claim but unknown numeric progress stays unknown',()=>{
 const {store,id}=fixture();try{
  const facts=seed(store,id,{'actionDone:w3.bombs':true});const c=journeyContext(store,id),a=c.confirmedActions.find(x=>x.id==='w3.bombs');
  assert.equal(a.progress.status,'completed');assert.equal(a.progress.legacyUnknownCount,true);assert.equal(a.progress.counter.value,null);assert.equal(c.currentRunFacts.bombRecipeTypes,undefined);
  assert.deepEqual(journeyState(store,id).facts,facts);
  send(store,id,'fact',{field:'bombRecipeTypes',value:1});assert.equal(journeyActionProgress(store,id,'w3.bombs').status,'in_progress');assert.equal(journeyState(store,id).seed.facts['actionDone:w3.bombs'].value,true);
 }finally{store.close();}
});
test('Baron letter and Oxenfurt confirmation is one event; free text does not fabricate Velen scope or erase history',()=>{
 const {store,id}=fixture();try{
  seed(store,id);const result=send(store,id,'batch',{facts:[{field:'items',value:['Грамота Барона'],operation:'add',wording:'Получил грамоту от Барона'},{field:'currentRegion',value:'Оксенфурт',wording:'Приехал в Оксенфурт'},{field:'currentMilestone',value:'Получил грамоту от Барона, ищу его дочь'},{field:'currentObjective',value:'Найти дочь Барона'}]});
  const c=journeyContext(store,id);assert.equal(c.revision,30);assert.equal(result.event.type,'batch');assert.equal(result.event.facts.length,4);
  assert.equal(c.currentRunFacts.currentRegion.value,'Оксенфурт');assert.deepEqual(c.currentRunFacts.items.value,['Грамота Барона']);assert.equal(c.currentRunFacts.currentMilestone.value,'Получил грамоту от Барона, ищу его дочь');
  assert.equal(c.coverage.scopeStatus,'OUTSIDE_COVERAGE');assert.ok(!c.updateRequests.some(u=>u.id==='report_velen_arrival_checkpoint'));
  assert.ok(c.history.some(e=>e.type==='seed'&&e.field==='currentRegion'&&e.value==='Вызима'));assert.ok(c.history.some(e=>e.type==='fact'&&e.field==='currentRegion'&&e.value==='Оксенфурт'));
  assert.equal(c.currentRunFacts.arrivedInVelen,undefined);assert.ok(!c.updateRequests.some(u=>['whiteOrchardShopCards','zoltanCard'].includes(u.field)));assert.equal(store.status(id).summary.earned,0);
  for(const f of Object.values(c.currentRunFacts).filter(f=>f.revision===30)){assert.equal(f.source,'user_confirmation');assert.equal(f.runId,'test-run');assert.deepEqual(f.revisionDelta,{from:29,to:30});}
 }finally{store.close();}
});
test('selected batch fact undo preserves other changes and supports idempotent retries and concurrent conflicts',()=>{
 const {store,id}=fixture();try{
  seed(store,id);const cmd={requestId:'batch_selected_test_0001',expectedRevision:29,type:'batch',facts:[{field:'currentRegion',value:'Оксенфурт'},{field:'items',value:['Грамота'],operation:'add'}]};
  journeyCommand(store,id,cmd);assert.equal(journeyCommand(store,id,cmd).replayed,true);assert.throws(()=>journeyCommand(store,id,{...cmd,facts:[{field:'note',value:'different'}]}),/idempotency_conflict/);
  assert.throws(()=>send(store,id,'fact',{expectedRevision:29,field:'note',value:'stale'}),/revision_conflict/);
  send(store,id,'retract',{targetId:cmd.requestId,field:'currentRegion'});assert.equal(journeyState(store,id).facts.currentRegion.value,'Вызима');assert.deepEqual(journeyState(store,id).facts.items.value,['Грамота']);
  assert.equal(journeyContext(store,id).history.find(e=>e.id===cmd.requestId&&e.field==='currentRegion').retracted,true);
  assert.throws(()=>send(store,id,'retract',{targetId:cmd.requestId,field:'currentRegion'}),/already_retracted/);
  send(store,id,'retract',{targetId:cmd.requestId});assert.equal(journeyState(store,id).facts.items,undefined);
  assert.throws(()=>send(store,id,'retract',{targetId:cmd.requestId,field:'items'}),/already_retracted/);
 }finally{store.close();}
});
test('partial collection observations merge and deduplicate; unseen quests remain unknown, contradictions are visible',()=>{
 const {store,id}=fixture();try{
  seed(store,id);send(store,id,'fact',{field:'completedQuests',value:['Первое задание'],operation:'add'});
  send(store,id,'fact',{field:'completedQuests',value:['Первое   задание','Второе задание','второе задание'],operation:'add'});
  assert.deepEqual(journeyState(store,id).facts.completedQuests.value,['Первое задание','Второе задание']);
  send(store,id,'fact',{field:'activeQuests',value:['Третье задание','Первое задание'],operation:'add'});
  assert.equal(journeyContext(store,id).conflicts[0].kind,'quest_status_conflict');assert.equal(journeyState(store,id).facts.completedQuests.value.includes('Третье задание'),false);
  send(store,id,'fact',{field:'activeQuests',value:['Первое задание'],operation:'remove'});assert.equal(journeyContext(store,id).conflicts.length,0);
  assert.throws(()=>send(store,id,'batch',{facts:[{field:'cards',value:['a']},{field:'cards',value:['b']}]}),/invalid_journey_value/);
  assert.throws(()=>validateJourneyFact(store,id,{field:'items',value:['x'.repeat(161)]}),/invalid_journey_value/);
  assert.throws(()=>validateJourneyFact(store,id,{field:'earned',value:true}),/invalid_journey_field/);
  assert.throws(()=>validateJourneyFact(store,id,{field:'currentRegion',value:'bad\ntext'}),/invalid_journey_value/);
 }finally{store.close();}
});
test('companion receipt and facts can commit in one outer transaction, including rollback after accepted facts',()=>{
 const {store,id}=fixture();try{
  seed(store,id);store.db.exec('CREATE TABLE test_receipts(id TEXT)');
  assert.throws(()=>store.transaction(()=>{send(store,id,'batch',{facts:[{field:'note',value:'not committed'}]});throw Error('receipt_write_failed');}),/receipt_write_failed/);
  assert.equal(journeyState(store,id).revision,29);assert.equal(journeyState(store,id).facts.note,undefined);
  store.transaction(()=>{send(store,id,'batch',{facts:[{field:'note',value:'committed'}]});store.db.prepare('INSERT INTO test_receipts VALUES(?)').run('receipt');});assert.equal(journeyState(store,id).revision,30);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM test_receipts').get().n,1);
 }finally{store.close();}
});
test('restarted SQLite preserves batches, scope, counter and corrections; no automatic run exists before start',()=>{
 const folder=mkdtempSync(join(tmpdir(),'pc-journey-progress-')),path=join(folder,'journey.sqlite');let store;
 try{const f=fixture(path);store=f.store;const {id}=f;assert.equal(journeyState(store,id),null);assert.equal(journeyContext(store,id).run,null);seed(store,id);const batch=send(store,id,'batch',{facts:[{field:'bombRecipeTypes',value:3},{field:'decisions',value:['Передал письмо'],operation:'add'}]});store.close();store=new LibraryStore(path);
  assert.equal(journeyState(store,id).revision,30);assert.equal(journeyActionProgress(store,id,'w3.bombs').counter.value,3);assert.equal(journeyContext(store,id).currentRunFacts.decisions,undefined);assert.deepEqual(journeyContext(store,id,{reveal:true}).currentRunFacts.decisions.value,['Передал письмо']);
  const hidden=journeyContext(store,id).history.find(e=>e.id===batch.event.id&&e.field==='decisions');assert.equal(hidden.value,null);assert.equal(hidden.wording,'Скрытое сюжетное подтверждение');
  send(store,id,'retract',{targetId:batch.event.id,field:'bombRecipeTypes'});assert.equal(journeyActionProgress(store,id,'w3.bombs').counter.value,null);assert.equal(journeyFields(store,id).bombRecipeTypes.type,'number');
 }finally{store?.close();rmSync(folder,{recursive:true,force:true});}
});
