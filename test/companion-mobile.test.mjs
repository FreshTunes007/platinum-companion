import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LibraryStore,normalizeLibrarySnapshot} from '../src/library-store.mjs';
import {createMobileApi,bindAppOwner,sessionKey} from '../src/mobile-api.mjs';
import {journeyState,importJourneySeed} from '../src/journey.mjs';

const binding=JSON.parse(readFileSync(new URL('../knowledge/journey-bindings.json',import.meta.url)));
const principal={issuer:'https://isolated-auth.invalid',subject:'isolated-owner',sessionId:'isolated-session',scopes:['platinum:sync']};
let serial=0;
const command=(type,revision,extra={})=>({requestId:`companion_mobile_test_${++serial}`,type,expectedRevision:revision,...extra});
function setup(provider=null){
 const store=new LibraryStore(':memory:');store.replaceInventory('isolated-account',[{title:'Test Witcher',setId:binding.setId,platform:'PS5',service:'trophy2'}],'2026-10-10T00:00:00Z');const gameId=store.list().games[0].gameId;store.db.prepare('INSERT INTO active_games VALUES(?,1)').run(gameId);
 const entries=Object.values(binding.trophies),raw={dataKind:'live_psn',set:{setId:binding.setId,platform:'PS5',version:'test',groups:[{trophyGroupId:'default'}],catalog:entries.map(t=>({...t,id:String(t.id),grade:'bronze',groupId:'default',hidden:false}))},account:{setId:binding.setId,version:'test',observedAt:'2026-10-10T00:00:00Z',trophies:entries.map(t=>({id:String(t.id),earned:false,earnedAt:null}))}};store.commit(normalizeLibrarySnapshot(raw,gameId));
 const facts=Object.fromEntries(Object.entries({goal:'base_platinum',gamePatch:'5.x',currentRegion:'Вызима',currentMilestone:'vizima_audience',startDeathMarch:'yes',difficultyLowered:'no',mode:'NG',whiteOrchardShopCards:'yes',zoltanCard:'yes'}).map(([field,value])=>[field,{field,value,source:'user_confirmation',observedAt:'2026-10-02T00:00:00Z',runId:'isolated-run',revision:29,...(field==='gamePatch'?{reportedAnswer:'5.000.200'}:{})}]));
 importJourneySeed(store,gameId,{setId:binding.setId,player:{dataKind:'user_state',activeRun:{id:'isolated-run'},stateRevision:29,facts,conflicts:[]}});bindAppOwner(store,principal);
 let syncCalls=0;const api=createMobileApi({store,clock:()=>Date.parse('2026-10-10T01:00:00Z'),aiProvider:provider,runSync:()=>{syncCalls++;assert.fail('Companion must not call Sony sync.');}});
 const invoke=async(method,body,options={})=>{
  const path=options.path??`/api/v2/games/${gameId}/companion`;const headers={'content-type':'application/json',...options.headers};let code,data,responseHeaders;
  const content=options.raw??(body===undefined?'':JSON.stringify(body));
  await api({method,url:path,headers,async *[Symbol.asyncIterator](){yield content;}},{writeHead(c,h){code=c;responseHeaders=h;},end(d){data=JSON.parse(d);}},options.principal??principal,path);
  return {code,data,headers:responseHeaders};
 };
 return {store,gameId,invoke,syncCalls:()=>syncCalls};
}

test('companion mobile routes enforce owner, session, write scope and revocation before reading private chat',async()=>{
 const {store,invoke,syncCalls}=setup();try{
  assert.equal((await invoke('GET',undefined,{principal:{...principal,sessionId:null}})).code,403);
  assert.equal((await invoke('GET',undefined,{principal:{...principal,subject:'other-owner'}})).code,403);
  assert.equal((await invoke('POST',command('manual',29,{items:[{field:'note',value:'blocked'}]}),{principal:{...principal,scopes:[]}})).code,403);
  const readable=await invoke('GET',undefined,{principal:{...principal,scopes:[]}});assert.equal(readable.code,200);assert.equal(readable.data.currentRunFacts.currentRegion.value,'Вызима');assert.equal(readable.headers['Cache-Control'],'no-store');
  store.db.prepare('UPDATE app_sessions SET revoked_at=? WHERE id=?').run('2026-10-10T01:01:00Z',sessionKey(principal));assert.equal((await invoke('GET')).code,403);assert.equal(syncCalls(),0);assert.equal(journeyState(store,store.list().games[0].gameId).revision,29);
 }finally{store.close();}
});
test('mobile preview, per-item acceptance/rejection, retry and selective correction use one canonical event stream',async()=>{
 const {store,gameId,invoke,syncCalls}=setup();try{
  const preview=command('manual',29,{text:'Получил грамоту от Барона, приехал в Оксенфурт. Ищу его дочь.',items:[{field:'currentRegion',value:'Оксенфурт'},{field:'currentObjective',value:'Ищу дочь Барона'},{field:'items',value:['Грамота Барона'],operation:'add'}]});
  const draft=await invoke('POST',preview);assert.equal(draft.code,200);assert.equal(draft.data.revision,29);assert.equal(journeyState(store,gameId).facts.currentRegion.value,'Вызима');assert.equal(draft.data.proposals[0].source,'USER_DRAFT');
  const proposal=draft.data.proposals[0];assert.equal(proposal.items.find(i=>i.field==='currentRegion').conflict.previousValue,'Вызима');
  const first=command('resolve',29,{proposalId:proposal.id,decisions:[{itemId:proposal.items.find(i=>i.field==='currentRegion').id,decision:'accept'},{itemId:proposal.items.find(i=>i.field==='currentObjective').id,decision:'reject'}]});
  const confirmed=await invoke('POST',first);assert.equal(confirmed.code,200);assert.equal(confirmed.data.revision,30);assert.equal(confirmed.data.currentRunFacts.currentRegion.value,'Оксенфурт');assert.equal(confirmed.data.currentRunFacts.currentObjective,undefined);assert.equal(confirmed.data.currentRunFacts.items,undefined);
  const event=journeyState(store,gameId).events[0];assert.equal(event.type,'batch');assert.equal(event.facts.length,1);assert.equal(event.source,'user_confirmation');assert.deepEqual(event.revisionDelta,{from:29,to:30});
  const retry=await invoke('POST',first);assert.equal(retry.code,200);assert.equal(retry.data.replayed,true);assert.equal(journeyState(store,gameId).events.length,1);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM companion_receipts WHERE request_id=?').get(first.requestId).n,1);
  const remainder=confirmed.data.proposals[0],pending=remainder.items.find(i=>i.status==='pending');assert.equal(pending.field,'items');assert.equal(remainder.baseRevision,30);
  const second=await invoke('POST',command('resolve',30,{proposalId:remainder.id,decisions:[{itemId:pending.id,decision:'accept'}]}));assert.equal(second.code,200);assert.equal(second.data.revision,31);assert.deepEqual(second.data.currentRunFacts.items.value,['Грамота Барона']);
  const undo=await invoke('POST',command('retract',31,{targetId:first.requestId,field:'currentRegion'}),{path:`/api/v2/games/${gameId}/journey`});assert.equal(undo.code,200);assert.equal(undo.data.revision,32);assert.equal(undo.data.currentRunFacts.currentRegion.value,'Вызима');assert.deepEqual(undo.data.currentRunFacts.items.value,['Грамота Барона']);
  assert.equal(store.status(gameId).summary.earned,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,1);assert.equal(syncCalls(),0);
 }finally{store.close();}
});
test('mobile companion rejects bad bodies, corrupted screenshots and stale changes without changing confirmed state',async()=>{
 const {store,gameId,invoke}=setup();try{
  assert.equal((await invoke('POST',undefined,{raw:'{bad-json'})).code,400);
  assert.equal((await invoke('POST',command('manual',29,{items:[{field:'note',value:'x'}]}),{headers:{'content-type':'text/plain'}})).code,415);
  assert.equal((await invoke('POST',command('constructor',29))).code,400);
  assert.equal((await invoke('POST',command('manual',28,{items:[{field:'note',value:'stale'}]}))).code,409);
  assert.equal((await invoke('POST',command('manual',29,{items:[{field:'earned',value:true}]}))).code,400);
  assert.equal((await invoke('POST',command('message',29,{text:'Журнал',images:[{mimeType:'image/png',dataBase64:Buffer.from('this is not a png image at all').toString('base64')}]}))).code,400);
  assert.equal((await invoke('POST',undefined,{headers:{'content-length':String(14*1024*1024+1)}})).code,413);
  assert.equal((await invoke('POST',undefined,{raw:'x'.repeat(14*1024*1024+1)})).code,413);
  assert.equal(journeyState(store,gameId).revision,29);assert.equal(journeyState(store,gameId).events.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM companion_messages').get().n,0);
 }finally{store.close();}
});
test('unconfigured model honestly persists a chat message without parsing it or changing player facts',async()=>{
 const {store,gameId,invoke,syncCalls}=setup();try{
  const body=command('message',29,{text:'Я приехал в Оксенфурт и получил грамоту Барона.'});const response=await invoke('POST',body);assert.equal(response.code,200);assert.equal(response.data.provider.status,'UNCONFIGURED');assert.equal(response.data.proposals.length,0);assert.equal(response.data.messages.at(-1).code,'ai_not_configured');assert.equal(response.data.revision,29);
  assert.equal(journeyState(store,gameId).facts.currentRegion.value,'Вызима');assert.equal((await invoke('POST',body)).data.replayed,true);assert.equal((await invoke('GET')).data.messages.length,2);assert.equal(syncCalls(),0);
 }finally{store.close();}
});
test('mobile companion queue admits two bounded test-provider requests and releases its slots after completion',async()=>{
 // This is an isolated provider contract fixture, not a live model/vision test.
 const pending=[];const provider={status:()=>({configured:true,status:'ISOLATED_CONTRACT_FIXTURE'}),generate:()=>new Promise(resolve=>pending.push(resolve))};
 const {store,gameId,invoke,syncCalls}=setup(provider);try{
  const first=invoke('POST',command('message',29,{text:'first',consentExternal:true}));const second=invoke('POST',command('message',29,{text:'second',consentExternal:true}));
  for(let tries=0;pending.length<2&&tries<10;tries++)await new Promise(resolve=>setImmediate(resolve));assert.equal(pending.length,2);
  const third=await invoke('POST',command('message',29,{text:'third',consentExternal:true}));assert.equal(third.code,429);assert.equal(third.data.error,'companion_busy');
  for(const resolve of pending)resolve({reply:'Тестовый контракт без извлечения фактов.',updates:[],advice:[],questions:[]});assert.equal((await first).code,200);assert.equal((await second).code,200);
  assert.equal((await invoke('POST',command('manual',29,{items:[{field:'note',value:'queue released'}]}))).code,200);assert.equal(journeyState(store,gameId).revision,29);assert.equal(syncCalls(),0);
 }finally{store.close();}
});
