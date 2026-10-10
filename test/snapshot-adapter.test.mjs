import test from 'node:test';
import assert from 'node:assert/strict';
import { StrategeSnapshotAdapter,createBinding } from '../src/stratege-snapshot-adapter.mjs';
import { PSNProvider } from '../src/psn-provider.mjs';
import { mergeObservations, resolveAccountTrophy, observation } from '../src/observations.mjs';

// Synthetic fixture contains no user account data; actual snapshot tested by import.
function snapshot() {
  const at='2026-10-02T08:00:00Z';
  return {schemaVersion:1,dataKind:'observed_stratege_snapshot',account:{psnOnlineId:'test'},
    game:{title:'Test game',platform:'PS5'},source:{url:'https://example.test/profile',gameUrl:'https://example.test/game',observedAt:at,lastSuccessfulSyncAt:null,syncAgeText:'1 дн. 7 часов',syncStatus:'in_progress'},
    counts:{all:3,base:2,dlc:1,earned:1},completeWithinPage:true,
    trophies:[0,1,2].map(i=>({id:`external:${i}`,name:`Trophy ${i}`,earned:i===0,earnedAt:null,
      earnedAtDisplay:i===0?'30.09.2026 в 01:15:03':null,earnedAtTimezone:null,observedAt:at,sourceUrl:`https://example.test/trophy/${i}`}))};
}
function fixture() {
  const s=snapshot(),b=createBinding(s,{gameKey:'testgame',edition:'test',confirmedGroups:{baseEarned:1,dlcEarned:0}});
  return {s,b,a:new StrategeSnapshotAdapter(s,b)};
}
async function contract(provider,accountId) {
  const sets=await provider.getGameSets();assert.equal(sets.length,1);
  const catalog=await provider.getTrophies(sets[0].id),progress=await provider.getAccountProgress(accountId,sets[0].id);
  assert.equal(catalog.trophies.length,3);assert.equal(progress.observations.length,3);
  assert.equal(progress.summary.earned,1);assert.equal(progress.summary.groups.length,2);
  assert.deepEqual(new Set(catalog.trophies.map(t=>t.id)),new Set(progress.observations.map(t=>t.trophyId)));
  assert.equal(progress.complete,true);assert.equal(typeof provider.getSyncStatus().automatic,'boolean');
  assert.ok(progress.observations.every(o=>o.accountId===accountId && !('runId' in o)));
  return {catalog,progress};
}
test('snapshot provider satisfies common contract; freshness/timezone stay distinct',async()=>{
  const {a,b}=fixture(),{catalog,progress}=await contract(a,b.accountId);
  assert.equal(progress.source.kind,'stratege_session_snapshot');
  assert.equal(a.getSyncStatus().automatic,false);
  assert.equal(progress.source.freshness.sourceSyncedAt,null);
  assert.equal(progress.source.freshness.sourceSyncAgeText,'1 дн. 7 часов');
  assert.equal(progress.observations[0].earnedAt,null);
  assert.equal(progress.observations[0].earnedAtTimezone,null);
  assert.equal(progress.observations[0].earnedAtDisplay,'30.09.2026 в 01:15:03');
  assert.ok(catalog.trophies.every(t=>t.groupId===null));
  assert.ok(catalog.trophies.every(t=>!t.id.startsWith('external:')));
});
test('same snapshot import is idempotent',async()=>{
  const {a,b}=fixture(),p=await a.getAccountProgress(b.accountId,b.set.id);
  assert.equal(mergeObservations(p.observations,(await a.getAccountProgress(b.accountId,b.set.id)).observations).length,3);
});
test('corrupt/incomplete/unknown rows fail closed',()=>{
  const {s,b}=fixture();
  for (const mutate of [x=>x.trophies.pop(),x=>x.trophies[1].id=x.trophies[0].id,x=>x.trophies[1].earned=null,x=>x.counts.earned=2,x=>x.counts.base=1]) {
    const bad=structuredClone(s);mutate(bad);assert.throws(()=>new StrategeSnapshotAdapter(bad,b));
  }
});
test('another account, edition/platform or newer snapshot cannot reuse unchecked binding',async()=>{
  const {s,b,a}=fixture();
  for(const mutate of [x=>x.account.psnOnlineId='other',x=>x.game.platform='PS4',x=>x.source.gameUrl='other']) {
    const bad=structuredClone(s);mutate(bad);assert.throws(()=>new StrategeSnapshotAdapter(bad,b),/snapshot_binding_mismatch/);
  }
  const bad=structuredClone(s);bad.source.observedAt='2026-10-03T08:00:00Z';bad.trophies.forEach(t=>t.observedAt=bad.source.observedAt);
  assert.throws(()=>new StrategeSnapshotAdapter(bad,b),/group_evidence_needs_review/);
  await assert.rejects(a.getAccountProgress('other',b.set.id),/unknown_account/);
  await assert.rejects(a.getTrophies('other'),/unknown_set/);
});
test('historical not-earned before positive preserves earned without false conflict; unknown stays unknown',async()=>{
  const {a,b}=fixture(),p=await a.getAccountProgress(b.accountId,b.set.id),positive=p.observations[0];
  const negative=observation({...positive,earned:false,earnedAtDisplay:null,observedAt:'2026-10-01T08:00:00Z'});
  const merged=mergeObservations([positive],[negative]);
  const state=resolveAccountTrophy(merged,b.accountId,b.set.id,positive.trophyId);
  assert.equal(state.earned,true);assert.equal(state.conflict,false);
  assert.equal(resolveAccountTrophy(merged,'other',b.set.id,positive.trophyId).earned,null);
  assert.equal(resolveAccountTrophy([],b.accountId,b.set.id,'unknown').earned,null);
});
test('blocked direct PSN provider does no calls',async()=>{
  const client=new Proxy({}, {get(){throw new Error('client_must_not_be_touched');}});
  const p=new PSNProvider(client,[]);
  assert.equal(p.getSyncStatus().state,'blocked_external_auth');
  await assert.rejects(p.getGameSets(),/BLOCKED_EXTERNAL_AUTH/);
  await assert.rejects(p.getTrophies('set'),/BLOCKED_EXTERNAL_AUTH/);
  await assert.rejects(p.getAccountProgress('account','set'),/BLOCKED_EXTERNAL_AUTH/);
});
test('synthetic direct PSN provider satisfies SAME contract with explicit identity binding',async()=>{
  const b={accountId:'account-1',externalAccountKey:'account-hash',externalSetId:'TEST-NPWR',
    set:{id:'set-1',gameKey:'testgame',title:'Test game',platform:'PS5',edition:null,gamePatch:null,catalogVersion:null},
    trophyIds:{0:'trophy-a',1:'trophy-b',2:'trophy-c'},groupIds:{default:'base','001':'dlc'}};
  const at='2026-10-02T08:00:00Z';
  const client={accountKey:b.externalAccountKey,
    listGames:async()=>({items:[{setId:b.externalSetId,platform:'PS5'}]}),
    getTrophySet:async()=>({version:'1',catalog:[0,1,2].map(i=>({id:String(i),name:`Trophy ${i}`,groupId:i===2?'001':'default',grade:'bronze',hidden:false})),groups:[{trophyGroupId:'default'},{trophyGroupId:'001'}]}),
    getAccountTrophies:async()=>({version:'1',observedAt:at,trophies:[0,1,2].map(i=>({id:String(i),earned:i===0,earnedAt:i===0?'2026-09-30T20:00:00Z':null,observedAt:at,progress:null,progressTarget:null}))}),
    getSyncStatus:()=>({state:'ready',lastSuccessAt:at,error:null})};
  const p=new PSNProvider(client,[b],{blockedExternalAuth:false,clock:()=>at});
  const {progress}=await contract(p,b.accountId);assert.equal(progress.source.kind,'direct_psn_api');
  assert.equal(progress.observations[0].earnedAt,'2026-09-30T20:00:00Z');
  await assert.rejects(p.getAccountProgress('other',b.set.id),/account_binding_mismatch/);
});
