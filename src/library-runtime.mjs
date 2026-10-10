import {importFullLibrary} from './initial-import.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as sdk from 'psn-api';
import {LibraryStore} from './library-store.mjs';
import {syncLibrary,safeSyncError} from './library-sync.mjs';
import {WindowsCredentialVault} from './credential-vault.mjs';
import {PersistentPSNAuth} from './psn-auth.mjs';
import {installReadOnlyTransport} from './provider.mjs';
import {activeFive} from './active-scope.mjs';
export const libraryPath=()=>process.env.PLATINUM_LIBRARY_PATH??fileURLToPath(new URL('../private/psn-library.sqlite',import.meta.url));
export async function syncLocalLibrary(store,{gameId=null,onProgress=()=>{},secretAudit=()=>{},vault=null,bindingPath=null,activeScopeOnly=false,initialImport=false}={}){
  let guard=null,runId=null;const startedAt=new Date().toISOString();
  try{
    const scopedGames=initialImport?null:activeScopeOnly?(store.meta('activeGamesInitialized')?store.list({includeAll:true,limit:100000}).games.filter(g=>store.db.prepare('SELECT active FROM active_games WHERE game_id=?').get(g.gameId)?.active===1):activeFive(store)):null;
    const selection=store.meta('syncSelection');if(gameId&&!(scopedGames?scopedGames.some(g=>g.gameId===gameId):!selection||selection.gameIds.includes(gameId)))throw new Error('game_outside_active_scope');
    runId=store.beginRun(new Date().toISOString());
    if(scopedGames?.length===0){const result={status:'success',source:'direct_psn_api',freshFetchPerformed:false,gamesSynced:0,requests:0,finishedAt:new Date().toISOString(),errors:[]};store.finishRun(runId,result);return result;}
    const binding=JSON.parse(await readFile(bindingPath??new URL('../private/psn-binding.json',import.meta.url),'utf8'));
    const auth=new PersistentPSNAuth(vault??new WindowsCredentialVault(),sdk,binding.externalAccountKey,{audit:secretAudit,clientOptions:{snapshotCooldownMs:0,retryAttempts:2,maxRetryWaitMs:30000}});
    const status=await auth.status();if(!status.execution_context_match)throw new Error('execution_context_mismatch');if(!status.refresh_available)throw new Error('requires_user_reauth');
    guard=installReadOnlyTransport();const session=await auth.connect();
    const result=initialImport?await importFullLibrary(store,session.client,{runId,onProgress,requestCount:()=>guard.count()}):await syncLibrary(store,session.client,{gameId,onProgress,existingRunId:runId,scopedGames,localized:activeScopeOnly,cooldownMs:activeScopeOnly?300000:60000});
    if(result.gamesSynced)await auth.recordSync(result.finishedAt);
    const final={...result,authMode:session.mode,requests:guard.count()};store.finishRun(runId,final);return final;
  }catch(e){const result={status:'failed',source:'direct_psn_api',startedAt,freshFetchPerformed:(guard?.count()??0)>0,requests:guard?.count()??0,errors:[{code:safeSyncError(e)}],finishedAt:new Date().toISOString(),nextAllowedAt:new Date(Date.now()+Math.max(e.retryAfterMs??0,activeScopeOnly?300000:60000)).toISOString()};if(runId)store.finishRun(runId,result);return result;}
  finally{guard?.restore();}
}
export function openLibrary(){return new LibraryStore(libraryPath());}
