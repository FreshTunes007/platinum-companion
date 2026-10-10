import {accountTrophy} from './account-state.mjs';
import {resolveTrophyImplications} from './trophy-implications.mjs';

export function progressContext(state,pack=null,evaluate=null) {
  const {account,player}=state, snapshot=account.lastConfirmedSnapshot;
  const earned=account.catalog.trophies.filter(t=>accountTrophy(account,t.id).earned===true).map(t=>({id:t.id,name:t.name,earnedAt:snapshot.observations.find(o=>o.trophyId===t.id&&o.earned)?.earnedAt??null,runAssociation:'unknown',conflict:accountTrophy(account,t.id).conflict}));
  const roadmap=pack&&evaluate?evaluate(pack,state):{mode:'dependency_spike',items:[],criticalUnknowns:[],limitation:'knowledge_pack_pending'};
  const summary={...snapshot.summary,scope:'account_all_runs',basis:'last_confirmed_provider_snapshot',resolvedAccountEarned:earned.length,manualOrHistoricalConflicts:account.catalog.trophies.filter(t=>accountTrophy(account,t.id).conflict).length};
  const relevantItems=roadmap.items.filter(i=>!i.accountEarned&&i.status!=='not_applicable').sort((a,b)=>Number(b.critical)-Number(a.critical)||b.urgency-a.urgency);
  const compactUnknowns=[...new Map(roadmap.criticalUnknowns.map(u=>[`${u.kind}:${u.fact??u.ruleId??u.reason}`,u])).values()];
  const compactRecommendation=r=>({ruleId:r.ruleId,title:r.title,status:r.status,message:r.message,actionable:r.actionable,verificationStatus:r.verificationStatus,currentVersionStatus:r.currentVersionStatus,requirementLevel:r.requirementLevel,objectiveRequirementLevel:r.objectiveRequirementLevel,purpose:r.purpose,trophyCondition:r.trophyCondition,safeToDefer:r.safeToDefer,spoilerDetailsHidden:r.spoilerDetailsHidden,why:{category:r.explanation.category,reason:r.explanation.reason,playerFacts:r.explanation.playerFacts.map(f=>({field:f.field,value:f.value,source:f.source,revision:f.revision})),accountTrophyFacts:r.explanation.accountTrophyFacts.map(t=>({key:t.key,earned:t.earned,conflict:t.conflict,mappingStatus:t.mappingStatus})),evidence:r.explanation.evidence.slice(0,2),versionCoverage:r.explanation.versionCoverage,currentVersionStatus:r.explanation.currentVersionStatus,versionGap:r.explanation.versionGap}});
  const session=state.lastSessionSnapshot;
  const compactSession=session?{...session,changes:session.changes.slice(-8),earnedTrophiesDuringSession:session.earnedTrophiesDuringSession.slice(0,5),newlyObservedWithoutSessionAttribution:session.newlyObservedWithoutSessionAttribution.slice(0,5),importantConfirmedFacts:session.importantConfirmedFacts.slice(0,8),nextRecommendedAction:session.nextRecommendedAction?compactRecommendation(session.nextRecommendedAction):null,selection:{totalChanges:session.changes.length,totalEarned:session.earnedTrophiesDuringSession.length,totalFirstObserved:session.newlyObservedWithoutSessionAttribution.length,totalConfirmedFacts:session.importantConfirmedFacts.length}}:null;
  return {
    identity:{...state.identity,game:account.catalog.set},
    companionPreferences:state.companionPreferences??null,
    activeRun:{...player.activeRun,dataKind:player.dataKind},
    accountTrophySummary:summary,
    trophyImplications:pack?resolveTrophyImplications(pack,state):[],
    trophySync:state.trophySync??null,
    relevantEarnedTrophies:earned.slice(0,12),earnedTrophySelection:{returned:Math.min(earned.length,12),totalEarned:earned.length,policy:'first_12_catalog_order'},
    currentRunFacts:player.facts,
    roadmap:{mode:roadmap.mode,items:relevantItems.slice(0,6).map(({ruleId,title,status,possible,verificationStatus,currentVersionStatus,adviceMode,safeToDefer})=>({ruleId,title,status,possible,verificationStatus,currentVersionStatus,adviceMode,safeToDefer})),nextSteps:roadmap.nextSteps??[],...Object.fromEntries(['doNow','beforeProgressing','canDefer','blockedOrLost'].map(k=>[k,(roadmap[k]??[]).slice(0,3).map(compactRecommendation)])),selection:{returned:Math.min(relevantItems.length,6),totalRelevant:relevantItems.length,categoryTotals:Object.fromEntries(['doNow','beforeProgressing','canDefer','blockedOrLost'].map(k=>[k,(roadmap[k]??[]).length])),policy:'critical_then_urgency'}},criticalUnknowns:compactUnknowns.slice(0,12),unknownSelection:{returned:Math.min(compactUnknowns.length,12),total:compactUnknowns.length},
    questions:roadmap.questions?.map(q=>({fact:q.fact,question:q.question,answerValues:q.answerValues,priority:q.priority,why:q.why}))??[],
    contextualCoach:roadmap.coach??{mode:'contextual_coach_v0',tips:[],limit:2},
    updateRequests:roadmap.updateRequests??[],
    conflicts:player.conflicts,
    lastSessionSnapshot:compactSession,
    freshness:{...snapshot.source.freshness,source:snapshot.source.kind,sync:account.sync,sourceAgeTextAsOf:snapshot.source.freshness.observedAt,warning:'observed_at_is_capture_time_not_a_live_sync_promise'},
    stateRevision:player.stateRevision,knowledgePackVersion:pack?.version??null,
    evidenceCoverage:roadmap.evidenceCoverage??(pack?{scope:pack.scope,ruleCount:pack.rules.length,statuses:Object.fromEntries(['CONFIRMED','SUPPORTED','UNVERIFIED','DISPUTED'].map(s=>[s,pack.rules.filter(r=>r.verificationStatus===s).length])),patchVerified:pack.appliesTo.patchVerified,fullPlatinumCoverage:false}:null)
  };
}
