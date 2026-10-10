import {normalizeLibrarySnapshot} from './library-store.mjs';
import {mergeOfficialCatalogs} from './catalog-localization.mjs';
const allowed=['auth_expired','auth_reauth_required','requires_user_reauth','execution_context_mismatch','credential_operation_failed','account_binding_mismatch','network_or_timeout','rate_limited','privacy_or_access_denied','endpoint_or_title_missing','schema_changed','invalid_library_snapshot','catalog_changed_during_pagination','snapshot_changed_during_pagination','upstream_error','upstream_or_schema_error','unsupported_platform','pagination_limit','cooldown','library_sync_in_progress','library_sync_cooldown'];
export const safeSyncError=e=>['game_outside_active_scope','game_not_found'].includes(e?.code??e?.message)?e.code??e.message:allowed.includes(e?.code??e?.message)?e.code??e.message:'psn_sync_failed';
export async function syncLibrary(store,client,{gameId=null,priorityTitle='Hades II',clock=Date.now,onProgress=()=>{},existingRunId=null,scopedGames=null,localized=false,cooldownMs=60000}={}){
  const startedAt=new Date(clock()).toISOString(),runId=existingRunId??store.beginRun(startedAt);
  const result={runId,startedAt,status:'running',source:'direct_psn_api',freshFetchPerformed:true,inventoryFetched:false,gamesAttempted:0,gamesSynced:0,gamesFailed:0,errors:[],priorityGame:null};
  try{
    if(!scopedGames){
    const inventory=await client.listGames();store.replaceInventory(client.accountKey,inventory.items,new Date(clock()).toISOString());result.inventoryFetched=true;result.inventoryPages=inventory.pages;result.libraryTotal=inventory.items.length;
    const selection=store.meta('syncSelection');
    if(selection?.titles?.length){
      const discovered=store.list({includeAll:true,limit:100000}).games;
      const selected=selection.titles.map(title=>{const matches=discovered.filter(g=>g.title===title&&g.platform===(selection.platform??'PS5'));if(matches.length!==1)throw new Error('ambiguous_game_selection');return matches[0].gameId;});
      store.setMeta('syncSelection',{...selection,gameIds:selected});
    }
    }
    let games=scopedGames?[...scopedGames]:store.list({limit:100000}).games;
    if(scopedGames&&(store.meta('accountKey')!==client.accountKey||!games.length||games.some(g=>!store.rawGame(g.gameId))))throw new Error('account_binding_mismatch');
    const priority=g=>g.platform==='PS5'&&g.title.normalize('NFKC').toLowerCase().includes(priorityTitle.toLowerCase());
    games.sort((a,b)=>Number(priority(b))-Number(priority(a))||a.title.localeCompare(b.title));
    result.priorityGame=games.find(priority)?.gameId??null;
    if(gameId){if(!store.rawGame(gameId))throw new Error('game_not_found');if(!games.some(g=>g.gameId===gameId))throw new Error('game_outside_active_scope');games=games.filter(g=>g.gameId===gameId);}
    result.gamesSelected=games.length;let skipped=0;
    for(const g of games){
      const at=new Date(clock()).toISOString();
      store.touchRun(runId,at);
      if(g.lastSuccessfulSyncAt&&clock()-Date.parse(g.lastSuccessfulSyncAt)<cooldownMs){skipped++;onProgress({gameId:g.gameId,status:'cooldown',lastSuccessfulSyncAt:g.lastSuccessfulSyncAt});continue;}
      store.attempt(g.gameId,at);result.gamesAttempted++;
      try{
        const input={setId:g.providerMetadata.setId,title:g.title,platform:g.platform};
        let raw;
        if(localized){
          const en=await client.getTrophySet(input,'en-US'),ru=await client.getTrophySet(input,'ru-RU');
          const account=await client.getAccountTrophies(input);
          raw={dataKind:'live_psn',set:mergeOfficialCatalogs(en,ru),account};
        }else raw=await client.sync(input);
        const snapshot=normalizeLibrarySnapshot(raw,g.gameId);store.commit(snapshot);result.gamesSynced++;
        onProgress({gameId:g.gameId,title:g.title,status:'synced',observedAt:snapshot.observedAt,summary:snapshot.summary});
      }catch(e){
        const code=safeSyncError(e);store.failure(g.gameId,code);result.gamesFailed++;result.errors.push({gameId:g.gameId,code});onProgress({gameId:g.gameId,title:g.title,status:'failed',code});
        if(['rate_limited','auth_expired','auth_reauth_required','network_or_timeout','credential_operation_failed'].includes(code)){
          result.nextAllowedAt=new Date(clock()+Math.max(e.retryAfterMs??0,code==='rate_limited'?300000:60000)).toISOString();break;
        }
        client.continueAfterTitleFailure?.();
      }
    }
    result.gamesSkippedCooldown=skipped;result.gamesNotAttempted=games.length-result.gamesAttempted-skipped;
    result.status=result.gamesSynced===games.length?'success':result.gamesSynced?'partial':result.gamesFailed?'failed':'cooldown';
  }catch(e){result.status='failed';result.errors.push({code:safeSyncError(e)});}
  result.finishedAt=new Date(clock()).toISOString();
  result.nextAllowedAt=new Date(Math.max(Date.parse(result.nextAllowedAt??result.finishedAt),clock()+cooldownMs)).toISOString();
  store.finishRun(runId,result);return result;
}
