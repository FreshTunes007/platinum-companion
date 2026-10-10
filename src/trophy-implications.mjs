import {factValue} from './rule-evaluator.mjs';
import {accountTrophy} from './account-state.mjs';

export function applyTrophyImplicationPack(pack,config){
  const next=structuredClone(pack);
  next.version=config.packVersion;
  next.trophyDefinitions=config.trophyDefinitions;
  next.trophyImplications=config.trophyImplications;
  for(const source of config.sources)if(!next.sources.some(s=>s.id===source.id))next.sources.push(source);
  return next;
}
function satisfied(condition,player){
  if(condition.fact)return factValue(player,condition.fact)===condition.eq;
  if(condition.and)return condition.and.every(c=>satisfied(c,player));
  return condition.or?.some(c=>satisfied(c,player))??false;
}
function fields(condition){return condition.fact?[condition.fact]:(condition.and??condition.or??[]).flatMap(fields);}
export function resolveTrophyImplications(pack,state){
  const snapshot=state.account.lastConfirmedSnapshot;
  const candidates=(pack.trophyImplications??[]).filter(i=>satisfied(i.condition,state.player)).map(i=>({
    trophyKey:i.trophyKey,implicationId:i.implicationId,expectationSource:'game_state',expectedStatus:'EXPECTED_FROM_GAME_STATE',
    evidence:i.evidence,conditionFacts:fields(i.condition).map(field=>({field,...state.player.facts[field]})),
    expectationObservedAt:fields(i.condition).map(field=>state.player.facts[field].observedAt).sort().at(-1)
  }));
  for(const report of state.reportedTrophies??[])if(report.runId===state.player.activeRun.id&&!candidates.some(c=>c.trophyKey===report.trophyKey))candidates.push({trophyKey:report.trophyKey,implicationId:null,expectationSource:'user_report',expectedStatus:'REPORTED_BY_USER',evidence:[report],conditionFacts:[],expectationObservedAt:report.observedAt});
  return candidates.map(c=>{
    const trophyId=state.trophyMapping[c.trophyKey]??null;
    const resolved=accountTrophy(state.account,trophyId);
    const providerRow=trophyId?snapshot?.observations.find(o=>o.trophyId===trophyId):null;
    const confirmed=providerRow?.earned===true&&!resolved.conflict;
    return {...c,runId:state.player.activeRun.id,trophyId,name:pack.trophyDefinitions?.[c.trophyKey]?.displayName??c.trophyKey,
      status:confirmed?'CONFIRMED_BY_PROVIDER':c.expectedStatus,
      providerConfirmed:confirmed,providerEarned:providerRow?.earned??null,earnedAt:confirmed?providerRow.earnedAt:null,
      providerObservedAt:snapshot?.source.freshness.observedAt??null,providerSource:snapshot?.source.kind??null,
      reconciliation:resolved.conflict?'NEEDS_RECONCILIATION':confirmed?'MATCH':!trophyId?'UNKNOWN_MAPPING':'PROVIDER_LAG_OR_UNCERTAINTY',
      providerRunAssociation:'unknown',inferenceDoesNotWriteAccount:true};
  });
}
