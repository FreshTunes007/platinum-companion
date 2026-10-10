import {normalizeLibrarySnapshot} from './library-store.mjs';
import {mergeOfficialCatalogs} from './catalog-localization.mjs';
import {safeSyncError} from './library-sync.mjs';
import {seedActiveGames} from './library-index.mjs';
export async function importFullLibrary(store,client,{runId,clock=Date.now,onProgress=()=>{},requestCount=()=>0,maxSets=Infinity}={}){
  let state=store.meta('initialImport');
  const publish=()=>{
    const counts=store.db.prepare('SELECT status,count(*) AS n FROM initial_import GROUP BY status').all();
    const n=k=>counts.find(x=>x.status===k)?.n??0;
    state={...state,complete:n('complete'),partial:n('error'),remaining:n('pending'),retryable:store.db.prepare("SELECT count(*) AS n FROM initial_import WHERE status IN ('pending','error') AND attempts<3").get().n,requests:(state?.previousRequests??0)+requestCount(),updatedAt:new Date(clock()).toISOString()};
    store.setMeta('initialImport',state);onProgress(state);return state;
  };
  if(!state?.indexComplete){
    const inventory=await client.listGames();
    seedActiveGames(store);
    store.replaceInventory(client.accountKey,inventory.items,new Date(clock()).toISOString());store.setMeta('fullLibraryVisible',true);store.setMeta('inventoryMetadataVersion',1);
    const ids=store.db.prepare('SELECT id FROM games WHERE present=1').all();
    store.transaction(()=>{for(const {id} of ids)store.db.prepare('INSERT OR IGNORE INTO initial_import(game_id,status) VALUES(?,?)').run(id,store.latest(id)?.source==='direct_psn_api'?'complete':'pending');});
    state={status:'running',indexComplete:true,discovered:inventory.items.length,indexPages:inventory.pages,startedAt:new Date(clock()).toISOString(),previousRequests:0};
  }else {
    state={...state,status:'running',previousRequests:state.requests??0};
    if(store.meta('inventoryMetadataVersion')!==1){
      const inventory=await client.listGames();
      const previous=new Set(store.db.prepare('SELECT external_set_id,service FROM provider_bindings JOIN games ON games.id=game_id WHERE present=1').all().map(g=>`${g.external_set_id}:${g.service}`));
      const current=new Set(inventory.items.map(g=>`${g.setId}:${g.platform.split(',').map(p=>p.trim()).includes('PS5')?'trophy2':'trophy'}`));
      if(previous.size!==current.size||[...previous].some(id=>!current.has(id)))throw Error('snapshot_changed_during_pagination');
      store.replaceInventory(client.accountKey,inventory.items,new Date(clock()).toISOString());store.setMeta('inventoryMetadataVersion',1);state.indexVerificationPages=inventory.pages;
    }
  }
  // Recover a crash between the durable snapshot commit and queue checkpoint.
  for(const row of store.db.prepare("SELECT game_id FROM initial_import WHERE status<>'complete'").all()){
    const snapshot=store.latest(row.game_id);
    if(snapshot?.source==='direct_psn_api'&&Date.parse(snapshot.observed_at)>=Date.parse(state.startedAt))store.db.prepare("UPDATE initial_import SET status='complete',error=NULL,completed_at=? WHERE game_id=?").run(snapshot.observed_at,row.game_id);
  }
  publish();
  const queue=store.db.prepare(`SELECT q.game_id AS gameId FROM initial_import q JOIN games g ON g.id=q.game_id LEFT JOIN active_games a ON a.game_id=g.id WHERE q.status IN ('pending','error') AND q.attempts<3 AND g.present=1 ORDER BY a.active DESC,g.title,g.id`).all();
  let attempted=0;
  for(const {gameId} of queue){
    if(attempted++>=maxSets)break;
    const g=store.rawGame(gameId),at=new Date(clock()).toISOString();store.touchRun(runId,at);store.attempt(gameId,at);
    store.db.prepare('UPDATE initial_import SET attempts=attempts+1 WHERE game_id=?').run(gameId);
    try{
      const input={setId:g.external_set_id,title:g.title,platform:g.platform};
      const en=await client.getTrophySet(input,'en-US'),ru=await client.getTrophySet(input,'ru-RU'),account=await client.getAccountTrophies(input);
      const snapshot=normalizeLibrarySnapshot({dataKind:'live_psn',set:mergeOfficialCatalogs(en,ru),account},gameId);
      const inv=JSON.parse(store.db.prepare('SELECT payload_json FROM inventory_details WHERE game_id=?').get(gameId)?.payload_json??'{}');
      const expected=Object.values(inv.definedTrophies??{}).reduce((n,x)=>n+x,0);
      if(expected&&snapshot.summary.total!==expected)throw Error('invalid_library_snapshot');
      store.commit(snapshot);store.db.prepare("UPDATE initial_import SET status='complete',error=NULL,completed_at=? WHERE game_id=?").run(snapshot.observedAt,gameId);
    }catch(e){
      const code=safeSyncError(e);store.failure(gameId,code);
      store.db.prepare("UPDATE initial_import SET status='error',error=? WHERE game_id=?").run(code,gameId);
      if(['rate_limited','auth_expired','auth_reauth_required','requires_user_reauth','network_or_timeout','credential_operation_failed'].includes(code)){
        state.status=['auth_expired','auth_reauth_required','requires_user_reauth','credential_operation_failed'].includes(code)?'blocked':'paused';state.nextAllowedAt=new Date(clock()+Math.max(e.retryAfterMs??0,300000)).toISOString();publish();break;
      }
      client.continueAfterTitleFailure?.();
    }
    publish();
  }
  publish();
  state.status=state.complete===state.discovered?'complete':['paused','blocked'].includes(state.status)?state.status:'partial';
  if(state.status==='complete')state.finishedAt=new Date(clock()).toISOString();
  publish();
  return {status:state.status==='complete'?'success':'partial',source:'direct_psn_api',freshFetchPerformed:true,gamesSynced:state.complete,initialImport:state,requests:requestCount(),finishedAt:new Date(clock()).toISOString(),nextAllowedAt:state.nextAllowedAt??new Date(clock()+300000).toISOString(),errors:[]};
}
