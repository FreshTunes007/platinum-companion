import {evaluateDependencies,expressionFacts,factValue} from './rule-evaluator.mjs';
import {accountTrophy} from './account-state.mjs';
import {nextQuestion} from './interview.mjs';
import {currentVersionReview,ruleVersionAssessment,exactReportedVersion,disputeRelevant} from './knowledge-version.mjs';
import {isFutureDependency} from './roadmap-stage-policy.mjs';
import {buildContextualCoach} from './contextual-coach.mjs';

const lost=new Set(['needs_eligible_story_run','needs_save_or_new_contract_run','review_old_save_or_new_run','review_save_before_keira_choice','change_start_plan_or_add_story_run']);
const satisfied=new Set(['early_shop_cards_recorded','zoltan_card_recorded','qualifying_kills_recorded','auto_oils_guard_satisfied','chain_recorded_for_this_run','keira_dependency_satisfied','recovery_save_available']);
export function assertRealState(state){
  if(state.player.dataKind!=='user_state')return;
  if(state.player.activeRun.dataKind!=='user_state'||Object.values(state.player.facts).some(f=>f.source==='synthetic_test'||f.source==='hypothesis')||state.account.observations.some(o=>o.source.kind==='synthetic_test'))throw new Error('synthetic_facts_in_user_state');
}
export function evidenceCoverage(pack,state){
  const patch=factValue(state.player,'gamePatch'),milestone=factValue(state.player,'currentMilestone');
  const review=currentVersionReview(pack,state.player);
  const activeCriticalGaps=(review?.criticalGaps??[]).filter(g=>{
    const rule=pack.rules.find(r=>r.ruleId===g.ruleId);
    if(isFutureDependency(rule,state.player)||!disputeRelevant(ruleVersionAssessment(rule,state.player),state.player))return false;
    if(rule.affectedTrophies.every(key=>{const t=accountTrophy(state.account,state.trophyMapping[key]);return t.earned===true&&!t.conflict;}))return false;
    if(g.ruleId==='w3.cards.shop'&&factValue(state.player,'whiteOrchardShopCards')==='yes'||g.ruleId==='w3.cards.scholar'&&factValue(state.player,'zoltanCard')==='yes'||g.ruleId==='w3.contracts.oils'&&factValue(state.player,'contractAttemptNow')==='no')return false;
    return true;
  });
  return {scope:pack.scope,ruleCount:pack.rules.length,statuses:Object.fromEntries(['CONFIRMED','SUPPORTED','UNVERIFIED','DISPUTED'].map(s=>[s,pack.rules.filter(r=>r.verificationStatus===s).length])),patchVerified:pack.appliesTo.patchVerified,patchStatus:patch===undefined?'UNKNOWN':review?'REVIEWED_PARTIAL':pack.appliesTo.patchCandidates.includes(patch)?'CANDIDATE_ONLY':'OUTSIDE_COVERAGE',scopeStatus:milestone===undefined?'UNKNOWN':milestone==='outside_pack_scope'?'OUTSIDE_COVERAGE':'EARLY_SCOPE',fullPlatinumCoverage:false,...(review?{reviewedVersion:exactReportedVersion(state.player),versionVerificationCounts:review.counts,versionReviewStatus:review.status,criticalGaps:review.criticalGaps,activeCriticalGaps}: {})};
}
export function buildRoadmap(pack,state){
  assertRealState(state);
  const dependencies=evaluateDependencies(pack,state),coverage=evidenceCoverage(pack,state);
  const result={mode:'roadmap_v0',doNow:[],beforeProgressing:[],canDefer:[],blockedOrLost:[],criticalUnknowns:[...dependencies.criticalUnknowns],questions:[],evidenceCoverage:coverage,stateRevision:state.player.stateRevision,knowledgePackVersion:pack.version,items:dependencies.items};
  if(coverage.scopeStatus==='UNKNOWN')result.criticalUnknowns.push({kind:'coverage',fact:'currentMilestone',reason:'Сюжетная точка неизвестна; положение в раннем маршруте не установлено.'});
  if(coverage.patchStatus==='OUTSIDE_COVERAGE')result.criticalUnknowns.push({kind:'applicability',fact:'gamePatch',reason:'Эта версия не покрыта проверенным пакетом.'});
  for(const gap of coverage.activeCriticalGaps??[])result.criticalUnknowns.push({kind:'version',ruleId:gap.ruleId,fact:null,reason:gap.reason});
  for(const item of dependencies.items){
    const rule=pack.rules.find(r=>r.ruleId===item.ruleId);
    const assessment=ruleVersionAssessment(rule,state.player);
    if(item.accountEarned||['not_applicable','future_dependency'].includes(item.status)||satisfied.has(item.status))continue;
    if(assessment?.status==='DISPUTED'&&!disputeRelevant(assessment,state.player))continue;
    const facts=[...new Set([expressionFacts(rule.activation),...rule.branches.map(b=>expressionFacts(b.when))].flat())];
    const usedFacts=facts.filter(f=>factValue(state.player,f)!==undefined).map(f=>({field:f,...state.player.facts[f]}));
    const trophies=rule.affectedTrophies.map(key=>({key,...accountTrophy(state.account,state.trophyMapping[key])}));
    const detailsHidden=rule.spoilerLevel==='quest_outcome'&&factValue(state.player,'spoilerPreference')!=='full';
    const explanation={ruleId:rule.ruleId,playerFacts:usedFacts,accountTrophyFacts:trophies,evidenceStatus:rule.verificationStatus,evidence:rule.evidence.map(e=>({sourceId:e.sourceId,url:e.url})),versionCoverage:coverage.patchStatus,currentVersionStatus:assessment?.status??null,requirementLevel:rule.recommendationLevel??'RECOMMENDED',purpose:rule.recommendationPurpose??'unclassified_legacy',versionGap:assessment?.gap??null};
    let category,reason;
    if(item.status==='reconcile_trophy_evidence'||item.status==='unknown_trophy_mapping_or_state'||item.unresolved||item.status==='unknown'){
      if(item.critical){category='beforeProgressing';reason='Важная зависимость не определена; сначала уточнить факты, без вывода о безопасности.';}
      else continue;
    }else if(lost.has(item.status)){
      category='blockedOrLost';reason='Известные факты указывают на закрытую ветку; требуется проверка сохранения или подходящего run, без гарантии восстановления.';
    }else if(item.safeToDefer){category='canDefer';reason='Условия отсрочки и version coverage явно проверены.';}
    else if(rule.spoilerLevel==='quest_outcome'||rule.deadline.urgency>=4||item.status==='check_elsa_inventory'||item.status==='play_scholar'){
      category='beforeProgressing';reason='Зависимость нужна до закрывающего события; отсрочка не доказана.';
    }else{category='doNow';reason='Действие входит в доступный ранний участок и ещё не закрыто account trophy.';}
    const versionAllowsAdvice=assessment?assessment.status==='VERIFIED_FOR_CURRENT_VERSION'||assessment.status==='SUPPORTED_FOR_CURRENT_VERSION'&&assessment.threshold!=='critical':coverage.patchStatus==='CANDIDATE_ONLY';
    const uncertain=item.unresolved||item.status==='unknown'||coverage.scopeStatus!=='EARLY_SCOPE'||!versionAllowsAdvice||['DISPUTED','UNVERIFIED'].includes(rule.verificationStatus);
    if(category==='doNow'&&(coverage.scopeStatus!=='EARLY_SCOPE'||!versionAllowsAdvice)){category='beforeProgressing';reason='Сначала установить применимость раннего маршрута и версии.';}
    const actionable=!uncertain;
    const recommendation={ruleId:rule.ruleId,title:rule.title,status:item.status,activationState:item.activationState,urgency:item.urgency,critical:item.critical,verificationStatus:rule.verificationStatus,currentVersionStatus:assessment?.status??null,requirementLevel:rule.recommendationLevel??'RECOMMENDED',objectiveRequirementLevel:rule.objectiveRequirementLevel??'MUST',purpose:rule.recommendationPurpose??'unclassified_legacy',trophyCondition:rule.trophyCondition??false,certainty:uncertain?'needs_verification':assessment?.status==='SUPPORTED_FOR_CURRENT_VERSION'||rule.verificationStatus==='SUPPORTED'?'supported':'working_rule_in_candidate_coverage',actionable,safeToDefer:item.safeToDefer&&!uncertain,message:uncertain?'Уточнить зависимость: '+rule.title:detailsHidden?'Перед продвижением проверить необратимое решение; подробности скрыты.':rule.claim,spoilerDetailsHidden:detailsHidden,explanation:{...explanation,category,reason}};
    result[category].push(recommendation);
  }
  for(const key of ['doNow','beforeProgressing','canDefer','blockedOrLost'])result[key].sort((a,b)=>Number(b.activationState==='active')-Number(a.activationState==='active')||Number(b.critical)-Number(a.critical)||b.urgency-a.urgency||a.ruleId.localeCompare(b.ruleId));
  const question=nextQuestion(pack,state);if(question.selected)result.questions=[question.selected];
  result.criticalUnknowns=[...new Map(result.criticalUnknowns.map(u=>[`${u.kind}:${u.fact??u.ruleId??u.reason}`,u])).values()];
  result.nextSteps=milestoneGuidance(state,result);
  result.coach=buildContextualCoach(state);
  result.updateRequests=result.questions.map(q=>({id:`confirm_${q.fact}`,category:'UPDATE_NEEDED',fact:q.fact,message:q.question,whyNow:q.why,trigger:'unresolved_player_fact',status:'ready',answerValues:q.answerValues}));
  if(factValue(state.player,'currentMilestone')==='before_griffin')result.updateRequests.push({id:'report_post_griffin_milestone',category:'UPDATE_NEEDED',fact:'currentMilestone',message:'После победы сообщить текущее основное задание / новый milestone.',whyNow:'Следующий маршрут зависит от фактической сюжетной точки после боя.',trigger:'real_user_confirmation_after_play',status:'waiting_for_gameplay_event'});
  if(factValue(state.player,'currentMilestone')==='vizima_audience'){
    const departureKnown=factValue(state.player,'currentObjective')==='travel_to_velen';
    result.updateRequests.push(departureKnown?
      {id:'report_velen_arrival_checkpoint',category:'UPDATE_NEEDED',fact:'currentRegion',message:'После прибытия в Велен сообщить место и текущую цель основного задания.',whyNow:'Цель отправиться в Велен подтверждена; фактическое прибытие и новая точка ещё неизвестны.',trigger:'real_user_confirmation_after_arrival',status:'waiting_for_gameplay_event'}:
      {id:'report_post_audience_checkpoint',category:'UPDATE_NEEDED',fact:'currentMilestone',message:'После аудиенции сообщить новое основное задание и локацию.',whyNow:'Следующий участок определяется реальным состоянием после аудиенции; дальнейшие решения не предполагаются.',trigger:'real_user_confirmation_after_audience',status:'waiting_for_gameplay_event'});
  }
  return result;
}

function milestoneGuidance(state,roadmap){
  if(!['before_griffin','vizima_audience'].includes(factValue(state.player,'currentMilestone')))return [];
  const difficulty=roadmap.beforeProgressing.find(r=>r.ruleId==='w3.dm');
  return [
    ...(difficulty?[{id:'preserve_death_march',requirementLevel:'MUST',purpose:'trophy_requirement',trophyCondition:true,actionable:difficulty.actionable,ruleId:'w3.dm',currentVersionStatus:difficulty.currentVersionStatus,message:'Сохранять выбранную Death March для цели Walked the Path; точный runtime новой версии имеет отдельный статус проверки.',basis:'published_trophy_objective_and_historical_continuity_evidence',safeToDefer:false}]:[]),
  ];
}
