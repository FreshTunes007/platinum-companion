import {accountTrophy} from './account-state.mjs';
import {isFutureDependency} from './roadmap-stage-policy.mjs';
import {ruleVersionAssessment,disputeRelevant,currentVersionReview} from './knowledge-version.mjs';
export function factValue(player,key){
  if(player.conflicts.some(c=>c.fact===key&&c.status==='needs_reconciliation'))return undefined;
  const value=player.facts[key]?.value;return value===null||value==='unknown'?undefined:value;
}
export function expressionFacts(expr){
  if(!expr)return [];if(expr.fact)return [expr.fact];
  return [...new Set((expr.and??expr.or).flatMap(expressionFacts))];
}
function matches(expr,values){
  if(!expr)return true;
  if(expr.fact)return values[expr.fact]===expr.eq;
  if(expr.and)return expr.and.every(e=>matches(e,values));
  return expr.or.some(e=>matches(e,values));
}
function outcomes(rule,pack,player){
  const referenced=[...new Set([expressionFacts(rule.activation),...rule.branches.map(b=>expressionFacts(b.when))].flat())];
  const known=Object.fromEntries(referenced.map(key=>[key,factValue(player,key)]));
  const unknown=referenced.filter(key=>known[key]===undefined);
  let combinations=1;
  for(const key of unknown)combinations*=pack.facts[key].values.length;
  if(combinations>4096)throw new Error('rule_dependency_space_too_large');
  const found=new Set(),activationStates=new Set();
  function visit(index,values){
    if(index<unknown.length){const key=unknown[index];for(const value of pack.facts[key].values)visit(index+1,{...values,[key]:value});return;}
    const active=matches(rule.activation,values);activationStates.add(active);
    found.add(!active?'not_applicable':rule.branches.find(b=>matches(b.when,values))?.status??rule.fallback);
  }
  visit(0,known);return {possible:[...found].sort(),unknown,activationState:activationStates.size>1?'conditional':activationStates.has(true)?'active':'inactive'};
}
export function evaluateDependencies(pack,state){
  const {account,player}=state,items=[],criticalUnknowns=[];
  const patch=factValue(player,'gamePatch');
  const review=currentVersionReview(pack,player);
  const applicability=patch===undefined?'unknown_patch':review?'reviewed_current_version':pack.appliesTo.patchCandidates.includes(patch)?'candidate_version':'unsupported_version';
  const inScope=factValue(player,'currentMilestone')!=='outside_pack_scope';
  if(patch===undefined)criticalUnknowns.push({kind:'applicability',fact:'gamePatch',reason:'Exact version must be checked; historical guides do not validate a newer version.'});
  if(!inScope)criticalUnknowns.push({kind:'coverage',fact:null,reason:'Current milestone is outside White Orchard / early Velen coverage.'});
  if(['dlc_only','100_percent'].includes(factValue(player,'goal')))criticalUnknowns.push({kind:'coverage',fact:null,reason:'DLC/100% goal exceeds the base-platinum knowledge pack.'});
  for(const rule of pack.rules){
    const versionAssessment=ruleVersionAssessment(rule,player);
    const trophies=rule.affectedTrophies.map(key=>({key,...accountTrophy(account,state.trophyMapping[key])}));
    const confirmedEarned=trophies.length>0&&trophies.every(t=>t.earned===true&&!t.conflict);
    const mappingUnknown=trophies.some(t=>t.mappingStatus==='unknown'||t.earned===null);
    const conflict=trophies.some(t=>t.conflict);
    const decision=outcomes(rule,pack,player);
    const possible=confirmedEarned?['account_objective_already_earned']:conflict?['reconcile_trophy_evidence']:mappingUnknown?['unknown_trophy_mapping_or_state']:isFutureDependency(rule,player)?['future_dependency']:decision.possible;
    const unresolved=possible.length>1;
    const item={ruleId:rule.ruleId,title:rule.title,verificationStatus:rule.verificationStatus,applicability,inScope,activationState:decision.activationState,critical:rule.missableStatus!=='not_missable',urgency:rule.deadline.urgency,status:unresolved?'needs_facts':possible[0],possible,unresolvedFacts:unresolved?decision.unknown:[],accountEarned:confirmedEarned,
      currentVersionStatus:versionAssessment?.status??null,
      safeToDefer:!unresolved&&!conflict&&!mappingUnknown&&inScope&&(versionAssessment?versionAssessment.status==='VERIFIED_FOR_CURRENT_VERSION':pack.appliesTo.patchVerified&&applicability==='candidate_version')&&['CONFIRMED','SUPPORTED'].includes(rule.verificationStatus)&&rule.canDefer.policy==='yes',
      adviceMode:confirmedEarned?'account_complete_run_facts_still_independent':applicability==='candidate_version'&&inScope?'tentative_v0':'applicability_review_required'};
    items.push(item);
    if(!confirmedEarned){
      if(mappingUnknown)criticalUnknowns.push({kind:'mapping',ruleId:rule.ruleId,fact:null,reason:'Missing internal trophy mapping/state is UNKNOWN, never false.'});
      if(conflict)criticalUnknowns.push({kind:'reconciliation',ruleId:rule.ruleId,fact:null,reason:'Conflicting trophy observations.'});
      if(unresolved&&item.critical)for(const fact of decision.unknown)criticalUnknowns.push({kind:'run_fact',ruleId:rule.ruleId,fact});
      if(['UNVERIFIED','DISPUTED'].includes(rule.verificationStatus)&&disputeRelevant(versionAssessment,player))criticalUnknowns.push({kind:'evidence',ruleId:rule.ruleId,fact:null,reason:rule.verificationStatus});
    }
  }
  return {mode:'dependency_spike_only',items,criticalUnknowns,stateRevision:player.stateRevision,knowledgePackVersion:pack.version};
}
