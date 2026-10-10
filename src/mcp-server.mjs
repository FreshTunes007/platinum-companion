import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCompanionMcp} from './mcp-tools.mjs';
import {openLibrary,syncLocalLibrary} from './library-runtime.mjs';
import {PersistentPSNAuth} from './psn-auth.mjs';
import {WindowsCredentialVault} from './credential-vault.mjs';
import * as sdk from 'psn-api';
let library;
const getLibrary=()=>library??=openLibrary();
const server=createCompanionMcp({getLibrary,runSync:async({gameId})=>{
  if(gameId)return syncLocalLibrary(getLibrary(),{gameId});
  // Never leave a ChatGPT tool call waiting for a whole multi-minute library scan.
  const vault=new WindowsCredentialVault(),auth=new PersistentPSNAuth(vault,sdk,'');
  const status=await auth.status();if(!status.execution_context_match)return {status:'blocked',code:'execution_context_mismatch',freshFetchPerformed:false};if(!status.refresh_available)return {status:'blocked',code:'requires_user_reauth',freshFetchPerformed:false};
  const last=getLibrary().db.prepare("SELECT id FROM sync_runs WHERE status='running' LIMIT 1").get();
  if(last)return {status:'in_progress',runId:last.id,freshFetchPerformed:false};
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/sync-library.mjs',import.meta.url))],{detached:true,windowsHide:true,stdio:'ignore',env:process.env});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('sync_worker_launch_failed')));});child.unref();
  return {status:'accepted',processId:child.pid,freshFetchPerformed:false,note:'Worker will perform Sony read and persist status; query list_games or get_progress_context for results.'};
}});
process.on('exit',()=>library?.close());
await server.connect(new StdioServerTransport());
