import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pack,testState} from './live-fixture.mjs';
import {StateStore} from '../src/state-store.mjs';
import {resolveTrophyImplications} from '../src/trophy-implications.mjs';
import {refreshAccountTrophies,queueTrophyRefresh,refreshCategories} from '../src/trophy-refresh.mjs';
import {recordProgressEvent} from '../src/progress-events.mjs';
import {accountTrophy} from '../src/account-state.mjs';
import {observation} from '../src/observations.mjs';

async function fixture(){
  const state=await testState({goal:'base_platinum',mode:'NG',currentRegion:'White Orchard',currentMilestone:'before_griffin',gamePatch:'5.x',startDeathMarch:'yes',difficultyLowered:'no',whiteOrchardShopCards:'yes',zoltanCard:'yes',unassistedContracts:0,remainingContracts:2,contractAttemptNow:'no'});
  state.player.dataKind='user_state';state.player.activeRun.dataKind='user_state';for(const f of Object.values(state.player.facts))f.source='user_confirmation';
  for(const [key,definition] of Object.entries(pack.trophyDefinitions))state.trophyMapping[key]=state.account.catalog.trophies.find(t=>t.name===definition.catalogName).id;
  const dir=await mkdtemp(join(tmpdir(),'platinum-implication-test-')),store=new StateStore(join(dir,'state.json'));await store.writeInitial(state);
  return {state,dir,store};
}
function providerFor(state,{negative=false,fail=false}={}){
  let calls=0;
  const progress=structuredClone(state.account.lastConfirmedSnapshot),at='2026-10-03T12:00:00Z';
  progress.source.freshness.observedAt=at;
  const targets=new Set(['find_yennefer','butcher_blaviken'].map(k=>state.trophyMapping[k]));
  progress.observations=progress.observations.map(o=>observation({...o,observedAt:at,source:{...o.source,freshness:{...o.source.freshness,observedAt:at}},earned:targets.has(o.trophyId)?!negative:o.earned,earnedAt:targets.has(o.trophyId)&&!negative?at:o.earnedAt}));
  progress.summary.earned=progress.observations.filter(o=>o.earned).length;
  progress.summary.groups[0].earned=6;
  return {getTrophies:async()=>structuredClone(state.account.catalog),getAccountProgress:async()=>{calls++;if(fail)throw new Error('network_or_timeout');return progress;},getSyncStatus:()=>({state:'ready',readMode:'synthetic_test'}),calls:()=>calls};
}
const event=(state)=>({eventId:'test-vizima',runId:state.player.activeRun.id,expectedRevision:state.player.stateRevision,observedAt:'2026-10-03T11:00:00Z',userFacingWording:['прибыл в Вызиму на аудиенцию'],changes:[{field:'currentRegion',value:'Vizima',reportedAnswer:'прибыл в Вызиму на аудиенцию'},{field:'currentMilestone',value:'vizima_audience',reportedAnswer:'прибыл в Вызиму на аудиенцию'}]});
const options={clock:()=>Date.parse('2026-10-03T12:00:00Z'),sleep:async()=>{},debounceMs:0,cooldownMs:60000};

test('regression: Vizima creates expectation and queues refresh, not earned=true; provider discovers story and unrelated trophy',async()=>{
  const f=await fixture();try{
    const oldAccount=structuredClone(f.state.account);
    const r=await recordProgressEvent(f.store,pack,event(f.state));
    const implication=r.state.trophyImplications[0];assert.equal(implication.status,'EXPECTED_FROM_GAME_STATE');
    assert.equal(implication.providerConfirmed,false);assert.equal(implication.earnedAt,null);
    assert.equal(accountTrophy(r.state.account,r.state.trophyMapping.find_yennefer).earned,false);
    assert.deepEqual(r.state.account,oldAccount);assert.equal(r.state.trophyImplications.length,1);
    assert.deepEqual(r.state.trophySync.pending.map(t=>t.category),['major_story_milestone','chapter_or_region_transition']);
    const provider=providerFor(r.state),result=await refreshAccountTrophies(f.store,pack,provider,options);
    assert.equal(result.status,'refreshed');assert.equal(provider.calls(),1);
    assert.equal(result.state.trophyImplications[0].status,'CONFIRMED_BY_PROVIDER');
    assert.equal(result.state.account.lastConfirmedSnapshot.summary.earned,6);
    assert.equal(accountTrophy(result.state.account,result.state.trophyMapping.butcher_blaviken).earned,true);
    assert.equal(result.state.trophyImplications.length,1); // No Blaviken story inference.
    assert.equal(result.state.trophyImplications[0].earnedAt,'2026-10-03T12:00:00Z');
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('connected provider is automatically refreshed after a major event through the event handler',async()=>{
  const f=await fixture();try{const provider=providerFor(f.state);const r=await recordProgressEvent(f.store,pack,{...event(f.state),provider,refreshOptions:options});assert.equal(r.refresh.status,'refreshed');assert.equal(r.state.trophyImplications[0].status,'CONFIRMED_BY_PROVIDER');assert.equal(provider.calls(),1);}finally{await rm(f.dir,{recursive:true,force:true});}
});
test('negative lag, unknown mapping or failed provider preserve expectation and last confirmed state',async()=>{
  const f=await fixture();try{
    const r=await recordProgressEvent(f.store,pack,event(f.state));
    const unknown=structuredClone(r.state);delete unknown.trophyMapping.find_yennefer;
    assert.equal(resolveTrophyImplications(pack,unknown)[0].reconciliation,'UNKNOWN_MAPPING');
    const result=await refreshAccountTrophies(f.store,pack,providerFor(r.state,{negative:true}),options);
    assert.equal(result.state.trophyImplications[0].status,'EXPECTED_FROM_GAME_STATE');assert.equal(result.state.trophyImplications[0].reconciliation,'PROVIDER_LAG_OR_UNCERTAINTY');
    await f.store.update(result.state.player.stateRevision,s=>{queueTrophyRefresh(s,{category:'explicit_manual_refresh',eventId:'retry-later',requestedAt:'2026-10-03T12:00:00Z'});s.trophySync.nextEligibleAt=null;return s;});
    const before=await f.store.read(),failed=await refreshAccountTrophies(f.store,pack,providerFor(before,{fail:true}),options);
    assert.equal(failed.status,'failed');assert.deepEqual(failed.state.account,before.account);assert.equal(failed.state.trophyImplications[0].status,'EXPECTED_FROM_GAME_STATE');
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('refresh requests coalesce, concurrent flushes share one fetch, cooldown retains pending event; minor updates do not trigger',async()=>{
  const f=await fixture();try{
    const r=await recordProgressEvent(f.store,pack,event(f.state)),provider=providerFor(r.state);
    const [a,b]=await Promise.all([refreshAccountTrophies(f.store,pack,provider,options),refreshAccountTrophies(f.store,pack,provider,options)]);
    assert.equal(a.status,'refreshed');assert.equal(b.status,'refreshed');assert.equal(provider.calls(),1);
    const state=await f.store.update(a.state.player.stateRevision,s=>{for(const category of refreshCategories)queueTrophyRefresh(s,{category,eventId:category,requestedAt:'2026-10-03T12:00:00Z'});return s;});
    const deferred=await refreshAccountTrophies(f.store,pack,provider,options);assert.equal(deferred.status,'cooldown');assert.equal(provider.calls(),1);assert.equal(deferred.state.trophySync.pending.length,6);
    const minor=await recordProgressEvent(f.store,pack,{...event(state),eventId:'minor-same-region',expectedRevision:state.player.stateRevision,changes:[{field:'currentRegion',value:'Vizima',reportedAnswer:'still Vizima'}]});
    assert.equal(minor.state.trophySync.pending.length,6);
    const later={...options,clock:()=>Date.parse('2026-10-03T12:01:05Z')};await refreshAccountTrophies(f.store,pack,provider,later);assert.equal(provider.calls(),2);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('griffin death alone does not imply finding Yennefer; conflicting milestone is unknown',async()=>{
  const f=await fixture();try{
    f.state.player.facts.griffinDefeated={value:true,source:'user_confirmation'};assert.deepEqual(resolveTrophyImplications(pack,f.state),[]);
    f.state.player.facts.currentRegion.value='Vizima';f.state.player.facts.currentMilestone.value='vizima_audience';f.state.player.conflicts.push({fact:'currentMilestone',status:'needs_reconciliation'});assert.deepEqual(resolveTrophyImplications(pack,f.state),[]);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('debounce extends for a later queued event and still performs one provider fetch',async()=>{
  const f=await fixture();try{
    const base=Date.parse('2026-10-03T12:00:00Z');let now=base;const waits=[];
    const queued=await f.store.update(f.state.player.stateRevision,s=>{queueTrophyRefresh(s,{category:'explicit_manual_refresh',eventId:'first',requestedAt:new Date(base).toISOString()});return s;});
    const provider=providerFor(queued);
    const sleep=async ms=>{waits.push(ms);now+=ms;if(waits.length===1){const s=await f.store.read();await f.store.update(s.player.stateRevision,n=>{queueTrophyRefresh(n,{category:'user_reports_trophy_earned',eventId:'second',requestedAt:new Date(base+500).toISOString()});return n;});}};
    const result=await refreshAccountTrophies(f.store,pack,provider,{clock:()=>now,sleep,debounceMs:1000,cooldownMs:60000});
    assert.deepEqual(waits,[1000,500]);assert.equal(provider.calls(),1);assert.equal(result.triggers.length,2);assert.equal(result.state.trophySync.pending.length,0);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
