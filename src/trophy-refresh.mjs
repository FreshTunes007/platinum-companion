import {ingestProvider} from './account-state.mjs';
import {resolveTrophyImplications} from './trophy-implications.mjs';
import {buildRoadmap} from './roadmap.mjs';

export const refreshCategories=['major_story_milestone','linked_boss_or_quest_completion','chapter_or_region_transition','user_reports_trophy_earned','session_end','explicit_manual_refresh'];
const inFlight=new Map();
export function queueTrophyRefresh(state,{category,eventId,requestedAt=new Date().toISOString()}){
  if(!refreshCategories.includes(category)||!Number.isFinite(Date.parse(requestedAt)))throw new Error('invalid_trophy_refresh_trigger');
  state.trophySync??={pending:[],status:'idle',lastAttemptAt:null,lastSuccessAt:null,nextEligibleAt:null};
  const sync=state.trophySync;
  if(!sync.pending.some(t=>t.eventId===eventId&&t.category===category))sync.pending.push({category,eventId,requestedAt});
  sync.status='requested';return sync;
}
export function progressionRefreshCategories(event,implications){
  const changes=event.changes??[];
  const changed=field=>changes.some(c=>c.field===field&&c.previous?.value!==c.value);
  const result=[];
  if(changed('currentMilestone'))result.push('major_story_milestone');
  if(changed('currentRegion')||changed('whiteOrchardTransitionCompleted'))result.push('chapter_or_region_transition');
  if(changed('griffinDefeated')&&implications.some(i=>i.conditionFacts.some(f=>f.field==='griffinDefeated')))result.push('linked_boss_or_quest_completion');
  return result;
}
export async function refreshAccountTrophies(store,pack,provider,{clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),debounceMs=1500,cooldownMs=60000}={}){
  if(inFlight.has(store.path))return inFlight.get(store.path);
  const job=(async()=>{
    let state=await store.read();
    if(!state.trophySync?.pending.length)return {status:'no_refresh_requested',state};
    if(!provider)return {status:'awaiting_authorization',state};
    const sync=provider.getSyncStatus();
    if(['not_connected','blocked_external_auth'].includes(sync.state))return {status:'provider_unavailable',state};
    if(state.trophySync.nextEligibleAt&&clock()<Date.parse(state.trophySync.nextEligibleAt))return {status:'cooldown',state};
    let wait=Math.max(0,Math.max(...state.trophySync.pending.map(t=>Date.parse(t.requestedAt)))+debounceMs-clock());
    while(wait){await sleep(wait);state=await store.read();wait=Math.max(0,Math.max(...state.trophySync.pending.map(t=>Date.parse(t.requestedAt)))+debounceMs-clock());}
    // Same-store calls join one fetch; persist the attempt before network so another
    // process observes the cooldown. No automatic retries or fallback replay.
    state=await store.read();
    if(state.trophySync.nextEligibleAt&&clock()<Date.parse(state.trophySync.nextEligibleAt))return {status:'cooldown',state};
    const triggers=structuredClone(state.trophySync.pending),attemptAt=new Date(clock()).toISOString();
    state=await store.update(state.player.stateRevision,next=>{
      next.trophySync.lastAttemptAt=attemptAt;next.trophySync.nextEligibleAt=new Date(clock()+cooldownMs).toISOString();next.trophySync.status='fetching';
      next.roadmap=buildRoadmap(pack,{...next,player:{...next.player,stateRevision:next.player.stateRevision+1}});return next;
    });
    const fetched=await ingestProvider(state.account,provider,{priority:30});
    const latest=await store.read();
    // Never overwrite an account that a concurrent operation changed during fetch.
    if(JSON.stringify(latest.account)!==JSON.stringify(state.account))throw new Error('concurrent_account_refresh_requires_reconciliation');
    const committed=await store.update(latest.player.stateRevision,next=>{
      if(fetched.ok){next.account=fetched.state;next.trophySync.lastSuccessAt=fetched.state.lastConfirmedSnapshot.source.freshness.observedAt;next.trophySync.pending=next.trophySync.pending.filter(t=>!triggers.some(x=>x.eventId===t.eventId&&x.category===t.category));}
      else if(fetched.error.code==='rate_limited')next.trophySync.nextEligibleAt=new Date(clock()+300000).toISOString();
      next.trophySync.status=fetched.ok?(next.trophySync.pending.length?'requested':'synced'):'failed';next.trophySync.error=fetched.ok?null:fetched.error.code;
      next.trophyImplications=resolveTrophyImplications(pack,next);
      next.progressEvents??=[];next.progressEvents.push({type:'trophy_refresh_result',source:fetched.ok?next.account.lastConfirmedSnapshot.source.kind:'provider_failure',observedAt:new Date(clock()).toISOString(),runId:next.player.activeRun.id,revision:next.player.stateRevision+1,triggers,outcome:fetched.ok?'success':'failed'});
      next.roadmap=buildRoadmap(pack,{...next,player:{...next.player,stateRevision:next.player.stateRevision+1}});return next;
    });
    return {status:fetched.ok?'refreshed':'failed',state:committed,error:fetched.error??null,triggers};
  })();
  inFlight.set(store.path,job);try{return await job;}finally{inFlight.delete(store.path);}
}

export async function requestTrophyRefresh(store,pack,{category,eventId,requestedAt=new Date().toISOString(),provider=null,refreshOptions={}}){
  const before=await store.read();
  await store.update(before.player.stateRevision,next=>{queueTrophyRefresh(next,{category,eventId,requestedAt});return next;});
  if(provider)return refreshAccountTrophies(store,pack,provider,refreshOptions);
  const {refreshWithLocalAuthorization}=await import('./local-psn-auth.mjs');
  return refreshWithLocalAuthorization(store,pack,refreshOptions);
}
