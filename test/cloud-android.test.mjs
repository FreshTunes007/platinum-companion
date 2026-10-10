import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {LibraryStore,normalizeLibrarySnapshot} from '../src/library-store.mjs';
import {ANDROID_TEST_TITLES,WITCHER_PS5_SET,snapshotFromStore} from '../src/mobile-snapshot.mjs';
import {activeFive} from '../src/active-scope.mjs';
import {syncLibrary} from '../src/library-sync.mjs';
import {createSyncCoordinator} from '../src/sync-coordinator.mjs';
import {createMobileApi,sessionRevoked,bindAppOwner} from '../src/mobile-api.mjs';
import {createRemoteMcp} from '../src/remote-mcp.mjs';
import {OidcResourceAuthorization} from '../src/remote-authorization.mjs';
const at='2026-10-08T00:00:00.000Z',later='2026-10-09T00:00:00.000Z';
function raw(setId,observedAt=at){return {dataKind:'live_psn',set:{setId,platform:'PS5',version:'1',observedAt,pages:1,
  groups:[{trophyGroupId:'default',trophyGroupName:'Synthetic',definedTrophies:{bronze:1,platinum:1}}],
  catalog:[{id:'0',name:'Synthetic platinum',description:'Synthetic only',groupId:'default',grade:'platinum',hidden:false},{id:'1',name:'Synthetic trophy',description:'Synthetic only',groupId:'default',grade:'bronze',hidden:false}]},
  account:{setId,version:'1',observedAt,pages:1,trophies:[{id:'0',earned:false,earnedAt:null},{id:'1',earned:true,earnedAt:at}]}};}
function fixture(){
  const store=new LibraryStore(':memory:');
  store.replaceInventory('synthetic-account',[...ANDROID_TEST_TITLES.map((title,i)=>({title,setId:`NPWR9000${i}_00`,platform:'PS5'})),{title:'The Witcher 3',setId:WITCHER_PS5_SET,platform:'PS5'},{title:'Excluded',setId:'NPWR99999_00',platform:'PS5'}],at);
  for(const g of activeFive(store))store.commit(normalizeLibrarySnapshot(raw(g.providerMetadata.setId),g.gameId));
  return store;
}
test('existing database cannot silently switch its application owner',()=>{
  const store=fixture();try{
    bindAppOwner(store,{issuer:'https://synthetic.invalid',subject:'one'});
    bindAppOwner(store,{issuer:'https://synthetic.invalid',subject:'one'});
    assert.throws(()=>bindAppOwner(store,{issuer:'https://synthetic.invalid',subject:'two'}),/app_owner_migration_required/);
  }finally{store.close();}
});

test('mobile status preserves imported observation dates without claiming a direct PSN sync; mixed sources remain explicit',async()=>{
  const store=fixture();
  try{
    store.db.exec("UPDATE snapshots SET source='imported'");
    const api=createMobileApi({store,runSync:()=>{throw new Error('no_sync_expected');}});
    const read=async()=>{let body;await api({method:'GET',headers:{}},{writeHead(code){assert.equal(code,200);},end(value){body=JSON.parse(value);}},{issuer:'https://test.invalid',subject:'test-owner',sessionId:'test-session'},'/api/v1/status');return body;};
    const imported=await read();assert.equal(imported.source,'imported');assert.equal(imported.freshFetchPerformed,false);
    assert.ok(imported.games.every(g=>g.source==='imported'&&g.observedAt===at&&g.lastSuccessfulSyncAt===null));
    const game=activeFive(store)[0];store.commit(normalizeLibrarySnapshot(raw(game.providerMetadata.setId,later),game.gameId));
    const mixed=await read();assert.equal(mixed.source,'mixed');assert.equal(mixed.games.filter(g=>g.source==='direct_psn_api'&&g.lastSuccessfulSyncAt===later).length,1);
  }finally{store.close();}
});
test('active-five sync never discovers inventory; localized full snapshots preserve earned dates',async()=>{
  const store=fixture(),calls=[];
  try{
    const client={accountKey:'synthetic-account',listGames(){throw new Error('inventory_must_not_be_called');},
      async getTrophySet(g,language){calls.push([g.setId,language]);const s=raw(g.setId,later).set;if(language==='ru-RU')s.catalog=s.catalog.map(t=>({...t,name:'Тестовый трофей',description:'Только тест'}));return s;},
      async getAccountTrophies(g){const a=raw(g.setId,later).account;a.trophies[1].earnedAt=null;return a;}};
    const result=await syncLibrary(store,client,{scopedGames:activeFive(store),localized:true,clock:()=>Date.parse(later),cooldownMs:300000});
    assert.equal(result.status,'success');assert.equal(result.inventoryFetched,false);assert.equal(result.gamesSynced,5);assert.equal(calls.length,10);
    const portable=snapshotFromStore(store,activeFive(store).map(g=>g.gameId),later);
    assert.equal(portable.games.length,5);assert.equal(portable.games[0].trophies[1].earnedAt,at);
    assert.equal(portable.games[0].trophies[0].official.localizations['ru-RU'].name,'Тестовый трофей');
    assert.equal(result.nextAllowedAt,'2026-10-09T00:05:00.000Z');
    assert.equal(store.list({query:'Excluded'}).games[0].summary,null);
  }finally{store.close();}
});
test('partial localization and trophy failure never publish an incomplete mobile catalogue',async()=>{
  const store=fixture();try{
    const before=snapshotFromStore(store,activeFive(store).map(g=>g.gameId),later);
    const result=await syncLibrary(store,{accountKey:'synthetic-account',async getTrophySet(g,lang){const s=raw(g.setId,later).set;if(lang==='ru-RU')s.catalog.pop();return s;},async getAccountTrophies(g){return raw(g.setId,later).account;}},
      {scopedGames:activeFive(store),localized:true,clock:()=>Date.parse(later)});
    assert.equal(result.gamesSynced,0);assert.deepEqual(snapshotFromStore(store,activeFive(store).map(g=>g.gameId),later),before);
  }finally{store.close();}
});
test('one sync queue for API, MCP and scheduled requests; persistent cooldown after completion',async()=>{
  const store=fixture();let resolve,calls=0;const work=new Promise(r=>{resolve=r;});
  try{
    const queue=createSyncCoordinator({store,sync:async()=>{calls++;await work;store.setMeta('nextAllowedAt',new Date(Date.now()+300000).toISOString());}});
    assert.equal((await queue.request()).status,'accepted');assert.equal((await queue.request()).status,'in_progress');assert.equal(calls,1);
    resolve();await queue.drain();assert.equal((await queue.request()).status,'cooldown');
  }finally{store.close();}
});

test('real local HTTP: Android and MCP same revision; owner/scope/expiry checks; device revocation also blocks MCP',async()=>{
  const store=fixture();let syncs=0;
  const config={resource:'https://test.invalid/mcp',issuer:'https://issuer.invalid/realms/companion',jwksUri:'https://issuer.invalid/jwks',audience:'companion',ownerSubject:'synthetic-owner',allowedClientIds:['android'],maxTokenLifetimeSeconds:900};
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const key={...publicKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
  const token=(changes={})=>{const now=Math.floor(Date.now()/1000);const parts=[{alg:'RS256',kid:'test'},{iss:config.issuer,aud:config.audience,sub:config.ownerSubject,iat:now,exp:now+300,azp:'android',sid:'test-session',scope:'platinum:read platinum:sync',...changes}].map(p=>Buffer.from(JSON.stringify(p)).toString('base64url'));return `${parts.join('.')}.${sign('RSA-SHA256',Buffer.from(parts.join('.')),privateKey).toString('base64url')}`;};
  const runSync=async()=>{syncs++;return {status:'accepted',freshFetchPerformed:false};};
  const mobileApi=createMobileApi({store,runSync});
  const authorization=new OidcResourceAuthorization(config,{fetcher:async()=>new Response(JSON.stringify({keys:[key]})),isRevoked:p=>sessionRevoked(store,p)});
  const http=createRemoteMcp({authorization,mobileApi,getLibrary:()=>store,runSync,getLegacyContext:async()=>({stateRevision:store.meta('revision')}),getDefaultGameId:()=>null});
  await new Promise(r=>http.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${http.address().port}`;
  const request=(path,changes={},method='GET')=>fetch(base+path,{method,headers:{Authorization:`Bearer ${token(changes)}`}});
  try{
    assert.equal((await fetch(base+'/api/v1/snapshot')).status,401);
    assert.equal((await fetch(base+'/api/v2/library')).status,401);
    const indexResponse=await request('/api/v2/library?limit=2&offset=0');assert.equal(indexResponse.status,200);
    const index=await indexResponse.json();assert.equal(index.total,6);assert.equal(index.games.length,2);assert.equal(index.nextOffset,2);assert.equal(index.games[0].trophies,undefined);assert.equal((await (await request('/api/v2/library?limit=0.25')).json()).games.length,1);
    const chosenDetail=activeFive(store)[0];const detail=await (await request('/api/v2/games/'+chosenDetail.gameId)).json();assert.equal(detail.snapshot.games.length,1);assert.equal(detail.snapshot.games[0].trophies.length,2);
    const setFlag=(tokenChanges,body)=>fetch(base+'/api/v2/games/'+chosenDetail.gameId+'/active',{method:'PUT',headers:{Authorization:'Bearer '+token(tokenChanges),'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await setFlag({scope:'platinum:read'},{active:true})).status,403);
    assert.equal((await setFlag({},{active:true,owner:'arbitrary'})).status,400);
    assert.equal((await setFlag({},{active:true})).status,200);
    assert.equal((await (await request('/api/v2/library?active=true')).json()).total,1);
    assert.equal(store.db.prepare('SELECT active FROM active_games WHERE game_id=?').get(chosenDetail.gameId).active,1);

    for(const change of [{sub:'other'},{aud:'other'},{iss:'https://evil.invalid'},{exp:0},{iat:0},{azp:'other'}])assert.equal((await request('/api/v1/snapshot',change)).status,401);
    assert.equal((await request('/api/v1/snapshot',{sid:null})).status,403);
    const me=await (await request('/api/v1/me')).json();const data=await (await request('/api/v1/snapshot')).json();
    assert.equal(data.ownerId,me.ownerId);assert.equal(data.revision,store.meta('revision'));assert.equal(data.snapshot.games.length,5);
    assert.equal(JSON.stringify(data).includes('synthetic-account'),false);
    assert.equal((await request('/api/v1/sync',{scope:'platinum:read'},'POST')).status,403);assert.equal(syncs,0);
    assert.equal((await request('/api/v1/sync',{},'POST')).status,202);assert.equal(syncs,1);
    const devices=await (await request('/api/v1/devices')).json();assert.equal(devices.devices.length,1);
    const rpc=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_progress_context',arguments:{}}})});
    assert.equal(rpc.status,200);const body=await rpc.json();assert.equal(body.result.structuredContent.stateRevision,data.revision);
    const chosen=activeFive(store)[0],observed='2026-10-08T01:00:00.000Z',changed=raw(chosen.providerMetadata.setId,observed);changed.account.trophies[0]={id:'0',earned:true,earnedAt:observed};store.commit(normalizeLibrarySnapshot(changed,chosen.gameId));
    const updated=await (await request('/api/v1/snapshot')).json();assert.ok(updated.revision>data.revision);assert.equal(updated.snapshot.games[0].summary.earned,2);
    assert.equal((await request(`/api/v1/devices/${me.deviceId}`,{},'DELETE')).status,200);
    assert.equal((await request('/api/v1/snapshot')).status,401);
    assert.equal((await request('/mcp',{},'POST')).status,401);
    assert.equal((await request('/api/v1/me',{sid:'fresh-login'})).status,200);
  }finally{await new Promise(r=>http.close(r));store.close();}
});

test('persistent lease prevents a second worker before authentication',async()=>{
 const store=fixture();try{store.beginRun(new Date().toISOString());let calls=0;const queue=createSyncCoordinator({store,sync:async()=>{calls++;}});assert.equal((await queue.request({initialImport:true})).status,'in_progress');assert.equal(calls,0);}finally{store.close();}
});

 test('collection groups are neutral, verified Witcher DLC remains DLC, legacy detail stays compatible',()=>{
 const store=fixture();try{
 for(const setId of ['NPWR90000_00',WITCHER_PS5_SET]){
 const game=store.list({}).games.find(g=>g.providerMetadata.setId===setId);
 const data=raw(setId,later);data.set.groups[0].trophyGroupId='001';for(const t of data.set.catalog)t.groupId='001';
 store.commit(normalizeLibrarySnapshot(data,game.gameId));
 const neutral=snapshotFromStore(store,[game.gameId],later,{neutralGroups:true});
 assert.equal(neutral.games[0].groups[0].kind,setId===WITCHER_PS5_SET?'dlc':'additional');
 assert.equal(snapshotFromStore(store,[game.gameId],later).games[0].groups[0].kind,'dlc');
 }
 }finally{store.close();}
 });
