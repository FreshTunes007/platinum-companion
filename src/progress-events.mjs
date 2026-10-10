import {buildRoadmap} from './roadmap.mjs';
import {resolveTrophyImplications} from './trophy-implications.mjs';
import {queueTrophyRefresh,progressionRefreshCategories,refreshAccountTrophies} from './trophy-refresh.mjs';

// A reported progression advances time within the same run. Unlike contradictory
// evidence, it can supersede the previous location while retaining its history.
export async function recordProgressEvent(store,pack,{eventId,runId,expectedRevision,observedAt,userFacingWording,changes,provider=null,refreshOptions={}}){
  if(!eventId||!Number.isFinite(Date.parse(observedAt))||!userFacingWording?.length||!changes?.length)throw new Error('invalid_progress_event');
  const allowed=new Set(['griffinDefeated','whiteOrchardTransitionCompleted','currentRegion','currentMilestone']);
  if(new Set(changes.map(c=>c.field)).size!==changes.length)throw new Error('duplicate_progress_field');
  for(const c of changes){
    if(!allowed.has(c.field)||typeof c.reportedAnswer!=='string'||!c.reportedAnswer.trim())throw new Error('invalid_progress_fact');
    const validRegion=c.field==='currentRegion'&&typeof c.value==='string'&&c.value.trim().length>0&&c.value.length<=120;
    if(!validRegion&&!pack.facts[c.field]?.values.includes(c.value))throw new Error('invalid_progress_value');
  }
  const before=await store.read();
  const previousEvent=before.progressEvents?.find(e=>e.id===eventId);
  if(previousEvent){
    if(previousEvent.runId!==runId||JSON.stringify(previousEvent.changes.map(({field,value,reportedAnswer})=>({field,value,reportedAnswer})))!==JSON.stringify(changes))throw new Error('progress_event_id_collision');
    return {changed:false,state:before,event:previousEvent,roadmap:buildRoadmap(pack,before)};
  }
  if(before.player.activeRun.id!==runId)throw new Error('progress_run_mismatch');
  if(before.player.dataKind!=='user_state')throw new Error('real_state_required');
  const revision=expectedRevision+1;
  const state=await store.update(expectedRevision,next=>{
    if(changes.some(c=>next.player.conflicts.some(x=>x.fact===c.field&&x.status==='needs_reconciliation')))throw new Error('explicit_reconciliation_required');
    const eventChanges=changes.map(c=>{
      const previous=next.player.facts[c.field]??null;
      const incoming={...c,source:'user_confirmation',observedAt,runId,revision,revisionDelta:{from:expectedRevision,to:revision}};
      next.player.facts[c.field]=incoming;
      return {...incoming,previous};
    });
    next.progressEvents??=[];
    const event={id:eventId,type:'ProgressEvent',dataKind:'user_state',source:'user_confirmation',runId,observedAt,userFacingWording,revision,revisionDelta:{from:expectedRevision,to:revision},changes:eventChanges};
    next.progressEvents.push(event);
    next.trophyImplications=resolveTrophyImplications(pack,next);
    for(const category of progressionRefreshCategories(event,next.trophyImplications))queueTrophyRefresh(next,{category,eventId,requestedAt:observedAt});
    next.roadmap=buildRoadmap(pack,{...next,player:{...next.player,stateRevision:revision}});
    return next;
  });
  let refresh=null;
  if(provider)refresh=await refreshAccountTrophies(store,pack,provider,refreshOptions);
  else if(state.trophySync?.autoRefreshEnabled&&state.trophySync.pending.length){
    const {refreshWithLocalAuthorization}=await import('./local-psn-auth.mjs');
    refresh=await refreshWithLocalAuthorization(store,pack,refreshOptions);
  }
  const final=refresh?.state??state;
  return {changed:true,state:final,event:state.progressEvents.find(e=>e.id===eventId),roadmap:final.roadmap,refresh};
}
