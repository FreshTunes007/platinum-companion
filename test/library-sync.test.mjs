import test from 'node:test';
import assert from 'node:assert/strict';
import {LibraryStore,normalizeLibrarySnapshot} from '../src/library-store.mjs';
import {syncLibrary} from '../src/library-sync.mjs';
import {PSNClient,ProviderError} from '../src/provider.mjs';
const at='2026-10-08T00:00:00Z';
function raw(setId='SET',observedAt=at){return {dataKind:'live_psn',set:{setId,title:'Synthetic',platform:'PS5',version:'1',pages:1,
  catalog:[['0','default','platinum'],['1','default','bronze'],['2','001','silver']].map(([id,groupId,grade])=>({id,groupId,grade,name:`Synthetic ${id}`,description:'Synthetic description',hidden:false})),
  groups:[{trophyGroupId:'default',trophyGroupName:'Base',definedTrophies:{platinum:1,bronze:1}},{trophyGroupId:'001',trophyGroupName:'DLC',definedTrophies:{silver:1}}]},
  account:{setId,version:'1',accountKey:'synthetic-account',observedAt,pages:1,trophies:['0','1','2'].map(id=>({id,earned:id!=='1',earnedAt:id!=='1'?'2026-10-07T23:00:00Z':null}))}};}
function setup(){const store=new LibraryStore(':memory:');store.replaceInventory('synthetic-account',[{setId:'SET',title:'Hades II',platform:'PS5'}],at);const id=store.list().games[0].gameId;return {store,id};}

test('library: base/DLC, platinum and timestamps normalize; exact repeated import is idempotent',()=>{
  const {store,id}=setup();try{
    const s=normalizeLibrarySnapshot(raw(),id);assert.deepEqual(s.summary.platinum,{total:1,earned:1,hasPlatinum:true});assert.equal(s.groups[1].kind,'additional');
    assert.equal(store.commit(s).changed,true);assert.equal(store.commit(s).changed,false);
    assert.equal(store.db.prepare('SELECT count(*) n FROM snapshots').get().n,1);
    assert.equal(store.status(id).summary.earned,2);assert.equal(store.status(id).freshFetchPerformed,false);
    assert.equal(store.trophies(id,{earned:false}).trophies[0].earnedAt,null);
    assert.equal(store.trophies(id,{limit:1}).nextOffset,1);
  }finally{store.close();}
});

test('library: failed/partial catalog and imported data cannot replace last successful direct snapshot',()=>{
  const {store,id}=setup();try{
    const s=normalizeLibrarySnapshot(raw(),id);store.commit(s);const corrupt=structuredClone(s);corrupt.trophies.pop();assert.throws(()=>store.commit(corrupt),/invalid_library_snapshot/);
    const imported=structuredClone(s);imported.source='imported';imported.observedAt='2026-10-09T00:00:00Z';store.commit(imported);
    store.failure(id,'privacy_or_access_denied');assert.equal(store.status(id).lastSuccessfulSyncAt,at);assert.equal(store.status(id).source,'direct_psn_api');assert.equal(store.status(id).summary.earned,2);
    store.replaceInventory('synthetic-account',[],imported.observedAt);assert.equal(store.status(id).presentInLatestLibrary,false);assert.equal(store.status(id).summary.total,3);
    assert.throws(()=>store.replaceInventory('different-account',[],at),/account_binding_mismatch/);
  }finally{store.close();}
});

test('library: imported unknown never appears as unearned',()=>{
  const {store,id}=setup();try{
    const s=normalizeLibrarySnapshot(raw(),id);s.source='imported';s.trophies[1].earned=null;store.commit(s);
    assert.equal(store.trophies(id,{earned:false}).total,0);assert.equal(store.status(id).lastSuccessfulSyncAt,null);assert.equal(store.status(id).source,'imported');
  }finally{store.close();}
});

test('library: Hades II PS5 first; title failure keeps prior state; single transaction inventory with distinct PS4/PS5 bindings',async()=>{
  const store=new LibraryStore(':memory:'),order=[];
  try{
    const client={accountKey:'synthetic-account',listGames:async()=>({pages:2,items:[{setId:'OTHER',title:'AAA',platform:'PS4'},{setId:'SET',title:'Hades II',platform:'PS5'}]}),
      sync:async game=>{order.push(game.setId);if(game.setId==='OTHER')throw new ProviderError('privacy_or_access_denied');return raw(game.setId);}};
    const result=await syncLibrary(store,client,{clock:()=>Date.parse(at)});assert.deepEqual(order,['SET','OTHER']);assert.equal(result.status,'partial');assert.equal(result.gamesSynced,1);
    assert.equal(store.list({query:'Hades'}).games[0].summary.earned,2);
    assert.throws(()=>store.replaceInventory('synthetic-account',[{setId:'BAD',title:'Bad',platform:'UNKNOWN'}],at),/unsupported_platform/);assert.equal(store.list().total,2);
    store.replaceInventory('synthetic-account',[{setId:'DUAL',title:'Same title',platform:'PS5'},{setId:'DUAL',title:'Same title',platform:'PS4'}],at);assert.equal(store.list().total,2);assert.notEqual(store.list().games[0].gameId,store.list().games[1].gameId);
  }finally{store.close();}
});

test('library: lease blocks concurrent sync and shared cooldown prevents rapid fresh requests',()=>{
  const {store}=setup();try{
    const runId=store.beginRun(at);assert.throws(()=>store.beginRun(at),/library_sync_in_progress/);
    store.finishRun(runId,{status:'success',finishedAt:at});assert.throws(()=>store.beginRun(at),/library_sync_cooldown/);
    assert.ok(store.beginRun('2026-10-08T00:02:00Z'));
  }finally{store.close();}
});

test('protocol: actual pagination over 123 sets preserves platforms; malformed page never becomes a full inventory',async()=>{
  const titles=Array.from({length:123},(_,i)=>({npCommunicationId:`SET_${i}`,trophyTitleName:`Game ${i}`,trophyTitlePlatform:'PS5'}));
  titles[1].npCommunicationId=titles[0].npCommunicationId;titles[1].trophyTitlePlatform='PS4';
  const requests=[],sdk={exchangeRefreshTokenForAuthTokens:async()=>({accessToken:'synthetic',refreshToken:'synthetic-refresh',expiresIn:7200}),getUserTrophyProfileSummary:async()=>({accountId:'synthetic'}),
    getUserTitles:async(_auth,_id,o)=>{requests.push(o.offset);return {trophyTitles:titles.slice(o.offset,o.offset+50),totalItemCount:123,nextOffset:o.offset+50<123?o.offset+50:undefined};}};
  const p=new PSNClient(sdk,{gapMs:0,sleep:async()=>{}});await p.authenticateWithRefreshToken('synthetic-refresh');
  const result=await p.listGames();assert.equal(result.items.length,123);assert.deepEqual(requests,[0,50,100]);
  sdk.getUserTitles=async()=>({trophyTitles:[],totalItemCount:123});await assert.rejects(p.listGames(),{code:'schema_changed'});
});

test('protocol: bounded transient backoff honors Retry-After; large server cooldown is not bypassed',async()=>{
  let attempts=0;const waits=[];
  const sdk={exchangeRefreshTokenForAuthTokens:async()=>({accessToken:'synthetic',refreshToken:'synthetic',expiresIn:7200}),getUserTrophyProfileSummary:async()=>({accountId:'synthetic'}),
    getUserTitles:async()=>{if(attempts++===0)throw new ProviderError('rate_limited',1500);return {trophyTitles:[],totalItemCount:0};}};
  const p=new PSNClient(sdk,{gapMs:0,sleep:async ms=>{if(ms)waits.push(ms);},retryAttempts:2,maxRetryWaitMs:30000});await p.authenticateWithRefreshToken('synthetic');await p.listGames();assert.equal(attempts,2);assert.deepEqual(waits,[1500]);
  sdk.getUserTitles=async()=>{throw new ProviderError('rate_limited',120000);};await assert.rejects(p.listGames(),{code:'rate_limited'});assert.ok(p.getSyncStatus().nextAllowedAt>Date.now()+119000);
});

test('library: fatal rate limit stops remaining games and retains successful snapshots',async()=>{
  const store=new LibraryStore(':memory:');try{
    const client={accountKey:'synthetic-account',listGames:async()=>({pages:1,items:[{setId:'SET',title:'Hades II',platform:'PS5'},{setId:'RATE',title:'Second',platform:'PS5'},{setId:'THIRD',title:'Third',platform:'PS5'}]}),
      sync:async g=>{if(g.setId==='SET')return raw();throw new ProviderError('rate_limited',600000);}};
    const result=await syncLibrary(store,client,{clock:()=>Date.parse(at)});assert.equal(result.gamesSynced,1);assert.equal(result.gamesNotAttempted,1);assert.equal(result.nextAllowedAt,'2026-10-08T00:10:00.000Z');
    assert.equal(store.list({query:'Hades'}).games[0].summary.total,3);
  }finally{store.close();}
});

test('scope steering: inventory remains complete but trophy sync reads only selected sets; abandoned worker lease recovers',async()=>{
  const {store,id}=setup(),calls=[];try{
    store.setMeta('syncSelection',{gameIds:[id],source:'user_confirmation'});
    const client={accountKey:'synthetic-account',listGames:async()=>({pages:1,items:[{setId:'SET',title:'Hades II',platform:'PS5'},{setId:'UNSELECTED',title:'Not selected',platform:'PS5'}]}),sync:async g=>{calls.push(g.setId);return raw(g.setId);}};
    const result=await syncLibrary(store,client,{clock:()=>Date.parse(at)});assert.equal(result.gamesSelected,1);assert.deepEqual(calls,['SET']);assert.equal(store.list().total,1);assert.equal(store.list({includeAll:true}).total,2);
    const run=store.beginRun('2026-10-08T00:02:00Z');store.touchRun(run,'2026-10-08T00:03:00Z');
    assert.throws(()=>store.beginRun('2026-10-08T00:07:00Z'),/library_sync_in_progress/);
    assert.ok(store.beginRun('2026-10-08T00:09:00Z'));
    assert.equal(store.db.prepare('SELECT status FROM sync_runs WHERE id=?').get(run).status,'interrupted');
  }finally{store.close();}
});

test('deployment scope: exact selected titles resolve only after discovery; a missing title never expands to all games',async()=>{
  const store=new LibraryStore(':memory:'),calls=[];try{
    store.setMeta('syncSelection',{titles:['Hades II'],gameIds:[],platform:'PS5'});
    const client={accountKey:'synthetic-account',listGames:async()=>({pages:1,items:[{setId:'SET',title:'Hades II',platform:'PS5'},{setId:'OTHER',title:'Hades',platform:'PS5'}]}),sync:async g=>{calls.push(g.setId);return raw(g.setId);}};
    const success=await syncLibrary(store,client,{clock:()=>Date.parse(at)});assert.equal(success.gamesSelected,1);assert.deepEqual(calls,['SET']);
    store.setMeta('syncSelection',{titles:['Missing requested sequel'],gameIds:[],platform:'PS5'});
    const failed=await syncLibrary(store,client,{clock:()=>Date.parse('2026-10-08T00:02:00Z')});assert.equal(failed.status,'failed');assert.deepEqual(calls,['SET']);assert.equal(store.list().total,0);
  }finally{store.close();}
});
