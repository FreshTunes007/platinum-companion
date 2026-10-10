import { mergeObservations, resolveAccountTrophy } from './observations.mjs';

// Providers supply observations. Only this boundary commits a validated fetch.
export function emptyAccountState(accountId, setId) {
  return {accountId, setId, observations:[], catalog:null, lastConfirmedSnapshot:null, sync:null};
}
export async function ingestProvider(state, provider, {priority=0}={}) {
  try {
    const catalog=await provider.getTrophies(state.setId);
    const progress=await provider.getAccountProgress(state.accountId,state.setId);
    if(catalog.complete!==true||progress.complete!==true)throw new Error('incomplete_provider_snapshot');
    if(catalog.set.id!==state.setId || progress.accountId!==state.accountId || progress.setId!==state.setId) throw new Error('identity_mismatch');
    const known=new Set(catalog.trophies.map(t=>t.id));
    if(progress.observations.some(o=>!known.has(o.trophyId) || o.accountId!==state.accountId || o.setId!==state.setId)) throw new Error('unmapped_observation');
    const observations=mergeObservations(state.observations,progress.observations);
    const previousPriority=state.lastSnapshotPriority??0;
    const older=state.lastConfirmedSnapshot&&(priority<previousPriority||(priority===previousPriority&&Date.parse(progress.source.freshness.observedAt)<Date.parse(state.lastConfirmedSnapshot.source.freshness.observedAt)));
    return {ok:true,state:{...structuredClone(state),catalog:older?state.catalog:catalog,observations,lastConfirmedSnapshot:older?state.lastConfirmedSnapshot:progress,lastSnapshotPriority:older?previousPriority:priority,sync:older?state.sync:provider.getSyncStatus()},added:observations.length-state.observations.length};
  } catch(error) {
    // Failure is an event, never a replacement of confirmed account state.
    return {ok:false,state:structuredClone(state),error:{code:error.message}};
  }
}
export function accountTrophy(state,trophyId) {
  if(!trophyId || !state.catalog?.trophies.some(t=>t.id===trophyId)) return {trophyId:trophyId??null,earned:null,conflict:false,mappingStatus:'unknown',observationIds:[]};
  return {...resolveAccountTrophy(state.observations,state.accountId,state.setId,trophyId),mappingStatus:'mapped'};
}
export function correlateAccountAndRun(account,player) {
  return {account,player:structuredClone(player),inferencePolicy:'account_trophies_do_not_establish_run_facts'};
}
