import {randomUUID} from 'node:crypto';
import {buildRoadmap} from './roadmap.mjs';
import {accountTrophy} from './account-state.mjs';
import {queueTrophyRefresh,refreshAccountTrophies} from './trophy-refresh.mjs';
const earnedIds=state=>state.account.catalog.trophies.filter(t=>accountTrophy(state.account,t.id).earned===true&&!accountTrophy(state.account,t.id).conflict).map(t=>t.id);
const validTime=t=>Number.isFinite(Date.parse(t));
export async function startSession(store,{expectedRevision,startedAt=new Date().toISOString()}){
  if(!validTime(startedAt))throw new Error('invalid_session_time');
  return store.update(expectedRevision,state=>{
    if(state.activeSession)throw new Error('session_already_active');
    state.activeSession={id:randomUUID(),runId:state.player.activeRun.id,startedAt,startRevision:expectedRevision+1,baselineEarnedIds:earnedIds(state),baselineFacts:structuredClone(state.player.facts),eventOffset:(state.progressEvents??[]).length};
    return state;
  });
}
export async function endSession(store,pack,{expectedRevision,endedAt=new Date().toISOString(),provider=null,refreshOptions={}}){
  const state=await store.update(expectedRevision,state=>{
    const session=state.activeSession;if(!session)throw new Error('no_active_session');
    if(!validTime(endedAt)||Date.parse(endedAt)<Date.parse(session.startedAt))throw new Error('invalid_session_time');
    const newlyObserved=earnedIds(state).filter(id=>!session.baselineEarnedIds.includes(id));
    const during=[],unknown=[];
    for(const id of newlyObserved){
      const times=state.account.observations.filter(o=>o.trophyId===id&&o.earned&&o.earnedAt).map(o=>o.earnedAt);
      const inInterval=times.some(t=>Date.parse(t)>=Date.parse(session.startedAt)&&Date.parse(t)<=Date.parse(endedAt));
      (inInterval?during:unknown).push({id,name:state.account.catalog.trophies.find(t=>t.id===id).name,association:inInterval?'earned_timestamp_in_session_interval':'first_observed_only'});
    }
    const future={...state,player:{...state.player,stateRevision:expectedRevision+1}};
    const roadmap=buildRoadmap(pack,future);
    const confirmed=Object.entries(state.player.facts).filter(([k,v])=>v.source==='user_confirmation'&&JSON.stringify(v)!==JSON.stringify(session.baselineFacts[k])).map(([field,v])=>({field,...v}));
    state.lastSessionSnapshot={id:session.id,runId:session.runId,startedAt:session.startedAt,endedAt,changes:(state.progressEvents??[]).slice(session.eventOffset),earnedTrophiesDuringSession:during,newlyObservedWithoutSessionAttribution:unknown,importantConfirmedFacts:confirmed,lastKnownMilestone:state.player.facts.currentMilestone??null,lastKnownLocation:state.player.facts.currentRegion??null,nextRecommendedAction:roadmap.doNow[0]??roadmap.beforeProgressing[0]??null,unresolvedCriticalWarning:roadmap.criticalUnknowns[0]??null,resultingStateRevision:expectedRevision+1};
    queueTrophyRefresh(state,{category:'session_end',eventId:session.id,requestedAt:endedAt});
    state.activeSession=null;state.roadmap=roadmap;return state;
  });
  if(provider)return (await refreshAccountTrophies(store,pack,provider,refreshOptions)).state;
  if(state.trophySync?.autoRefreshEnabled){const {refreshWithLocalAuthorization}=await import('./local-psn-auth.mjs');return (await refreshWithLocalAuthorization(store,pack,refreshOptions)).state;}
  return state;
}
