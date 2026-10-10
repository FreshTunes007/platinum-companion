import {readFile} from 'node:fs/promises';
import * as sdk from 'psn-api';
import {installReadOnlyTransport} from './provider.mjs';
import {PSNProvider} from './psn-provider.mjs';
import {refreshAccountTrophies} from './trophy-refresh.mjs';
import {WindowsCredentialVault} from './credential-vault.mjs';
import {PersistentPSNAuth} from './psn-auth.mjs';
export async function refreshWithLocalAuthorization(store,pack,options={}){
  const state=await store.read();
  if(!state.trophySync?.pending.length)return {status:'no_refresh_requested',state};
  if(state.trophySync.nextEligibleAt&&Date.now()<Date.parse(state.trophySync.nextEligibleAt))return {status:'cooldown',state};
  const binding=JSON.parse(await readFile(new URL('../private/psn-binding.json',import.meta.url),'utf8'));
  const auth=new PersistentPSNAuth(new WindowsCredentialVault(),sdk,binding.externalAccountKey,{audit:options.secretAudit??(()=>{})});
  const authStatus=await auth.status();
  if(!authStatus.execution_context_match)return {status:'execution_context_mismatch',state};
  if(!authStatus.refresh_available)return {status:'awaiting_authorization',state};
  const guard=installReadOnlyTransport();
  try{
    const session=await auth.connect();
    const provider=new PSNProvider(session.client,[binding],{blockedExternalAuth:false});
    const result=await refreshAccountTrophies(store,pack,provider,options);
    if(result.status==='refreshed')await auth.recordSync(result.state.account.lastConfirmedSnapshot.source.freshness.observedAt);
    return {...result,authMode:session.mode,actualLivePSNCall:guard.count()>0,requests:guard.count(),secretSaved:'external_DPAPI_refresh_token_only'};
  }catch(error){
    const allowed=['execution_context_mismatch','credential_operation_failed','credential_identity_mismatch','requires_user_reauth','account_binding_mismatch','auth_expired','auth_reauth_required','privacy_or_access_denied','rate_limited','network_or_timeout','invalid_auth_response','invalid_refresh_lifecycle','upstream_or_schema_error'];
    const code=allowed.includes(error.code??error.message)?(error.code??error.message):'psn_auth_or_read_failed';
    const current=await store.read();
    const final=await store.update(current.player.stateRevision,next=>{next.trophySync.status='failed';next.trophySync.error=code;next.trophySync.nextEligibleAt=new Date(Date.now()+60000).toISOString();return next;});
    return {status:'failed',state:final,error:{code},actualLivePSNCall:guard.count()>0,requests:guard.count()};
  }finally{guard.restore();}
}
