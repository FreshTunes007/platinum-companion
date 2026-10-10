import test from 'node:test';
import assert from 'node:assert/strict';
import {providers} from './fixtures.mjs';
import {emptyAccountState,ingestProvider,accountTrophy,correlateAccountAndRun} from '../src/account-state.mjs';
import {observation,mergeObservations} from '../src/observations.mjs';

test('same domain account/run state for Stratege and synthetic PSN, source IDs only in metadata',async()=>{
  const {binding,stratege,psn}=providers(),initial=emptyAccountState(binding.accountId,binding.set.id);
  const a=await ingestProvider(initial,stratege),b=await ingestProvider(initial,psn);
  assert.ok(a.ok&&b.ok);
  const semantic=s=>s.catalog.trophies.map(t=>({id:t.id,earned:accountTrophy(s,t.id).earned}));
  assert.deepEqual(semantic(a.state),semantic(b.state));
  assert.deepEqual(a.state.lastConfirmedSnapshot.summary,b.state.lastConfirmedSnapshot.summary);
  const player={activeRun:{id:'run'},facts:{},stateRevision:1};
  assert.deepEqual(correlateAccountAndRun(a.state,player).player,player);
  assert.deepEqual(correlateAccountAndRun(b.state,player).player,player);
  assert.equal(a.state.lastConfirmedSnapshot.source.freshness.sourceSyncAgeText,'1 day');
  assert.equal(b.state.lastConfirmedSnapshot.source.freshness.sourceSyncAgeText,null);
  assert.ok(semantic(b.state).every(t=>!t.id.includes('external')&&!t.id.includes('NPWR')));
});
test('unknown mapping never means not earned; duplicates add zero observations',async()=>{
  const {binding,stratege}=providers();
  const first=await ingestProvider(emptyAccountState(binding.accountId,binding.set.id),stratege);
  const second=await ingestProvider(first.state,stratege);
  assert.equal(second.added,0);
  assert.equal(accountTrophy(second.state,null).earned,null);
  assert.equal(accountTrophy(second.state,'unmapped').earned,null);
});
test('new provider negative preserves user confirmation and raises conflict',async()=>{
  const {binding,stratege}=providers();
  const {state}=await ingestProvider(emptyAccountState(binding.accountId,binding.set.id),stratege);
  const old=state.observations[1];
  const manual=observation({...old,earned:true,observedAt:'2026-10-02T09:00:00Z',source:{...old.source,kind:'user_confirmation',providerId:'user',externalReference:'confirmation-1'}});
  const freshNegative=observation({...old,observedAt:'2026-10-02T10:00:00Z'});
  state.observations=mergeObservations([manual],[freshNegative]);
  const result=accountTrophy(state,old.trophyId);
  assert.equal(result.earned,true);assert.equal(result.conflict,true);
  assert.ok(state.observations.some(o=>o.source.kind==='user_confirmation'));
});
test('provider failure and unmapped rows leave complete last confirmed state untouched',async()=>{
  const {binding,stratege}=providers();
  const {state}=await ingestProvider(emptyAccountState(binding.accountId,binding.set.id),stratege);
  const broken={getTrophies:async()=>{throw new Error('offline');}};
  const failure=await ingestProvider(state,broken);
  assert.equal(failure.ok,false);assert.deepEqual(failure.state,state);
  const unknown={getTrophies:()=>stratege.getTrophies(binding.set.id),getAccountProgress:async()=>{const p=await stratege.getAccountProgress(binding.accountId,binding.set.id);p.observations[0].trophyId='unknown';return p;}};
  assert.deepEqual((await ingestProvider(state,unknown)).state,state);
  const incomplete={getTrophies:()=>stratege.getTrophies(binding.set.id),getAccountProgress:async()=>({...await stratege.getAccountProgress(binding.accountId,binding.set.id),complete:false})};
  assert.deepEqual((await ingestProvider(state,incomplete)).state,state);
});
