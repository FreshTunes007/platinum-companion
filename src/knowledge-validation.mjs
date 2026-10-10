import {versionStatuses} from './knowledge-version.mjs';
export function validatePack(pack) {
  if(pack.rules.length<10||pack.rules.length>15)throw new Error('pack_scope_rule_count');
  const ids=new Set(),sourceIds=new Set(pack.sources.map(s=>s.id));
  const required=['ruleId','title','claim','appliesTo','prerequisites','affectedTrophies','deadline','missableStatus','oneRunRequirement','ngRelevance','difficultyRelevance','canDefer','spoilerLevel','evidence','verificationStatus','checkedAt','contradictions','notes'];
  function checkExpr(expr){if(!expr)return;if(expr.fact){if(!pack.facts[expr.fact]?.values.includes(expr.eq))throw new Error('invalid_rule_fact');}else if(expr.and||expr.or)(expr.and??expr.or).forEach(checkExpr);else throw new Error('invalid_expression');}
  const implicationIds=new Set();
  for(const implication of pack.trophyImplications??[]){
    if(implicationIds.has(implication.implicationId)||!pack.trophyDefinitions?.[implication.trophyKey]||implication.expectedStatus!=='EXPECTED_FROM_GAME_STATE'||!implication.evidence.length||implication.evidence.some(e=>!sourceIds.has(e.sourceId)))throw new Error('invalid_trophy_implication');
    implicationIds.add(implication.implicationId);
    // Location is a free-text domain fact; only this explicitly reviewed value is used.
    const check=expr=>expr.fact==='currentRegion'?expr.eq==='Vizima'||(()=>{throw new Error('unreviewed_implication_location');})():expr.fact?checkExpr(expr):(expr.and??expr.or).forEach(check);
    check(implication.condition);
  }
  for(const rule of pack.rules){
    if(required.some(key=>!(key in rule)))throw new Error('missing_rule_field');
    if(ids.has(rule.ruleId))throw new Error('duplicate_rule_id');ids.add(rule.ruleId);
    if(!['CONFIRMED','SUPPORTED','UNVERIFIED','DISPUTED'].includes(rule.verificationStatus))throw new Error('invalid_evidence_status');
    if(rule.verificationStatus==='CONFIRMED' && !rule.evidence.some(e=>e.practicalTest) && new Set(rule.evidence.map(e=>e.sourceId)).size<2)throw new Error('insufficient_confirmed_evidence');
    if(['UNVERIFIED','DISPUTED'].includes(rule.verificationStatus)&&rule.canDefer.policy==='yes')throw new Error('unsafe_deferral');
    if(rule.evidence.some(e=>!sourceIds.has(e.sourceId)||!e.url||!e.locator||!e.checkedAt))throw new Error('invalid_evidence');
    for(const [version,review] of Object.entries(rule.versionVerification??{})){
      if(review.ruleId!==rule.ruleId||review.originalClaim!==rule.claim||review.targetVersion!==version||!versionStatuses.includes(review.status))throw new Error('invalid_version_review');
      if(!['MUST','RECOMMENDED','OPTIONAL'].includes(review.recommendation.level)||!['trophy_requirement','safety_precaution','convenience'].includes(review.recommendation.purpose))throw new Error('invalid_recommendation_classification');
      if(review.recommendation.level==='MUST'&&!review.recommendation.trophyCondition)throw new Error('precaution_mislabeled_must');
      if(review.evidenceIds.some(id=>!sourceIds.has(id)))throw new Error('invalid_version_source');
      if(review.status==='VERIFIED_FOR_CURRENT_VERSION'&&!review.practicalCurrentVersionTest&&!review.explicitWholeClaimCurrentVersionProof)throw new Error('missing_current_version_proof');
      if(review.threshold==='critical'&&review.status==='VERIFIED_FOR_CURRENT_VERSION'&&(!review.currentIndependentCorroboration||!review.fullCriticalClausesCovered))throw new Error('insufficient_critical_version_proof');
    }
    checkExpr(rule.activation);rule.branches.forEach(b=>checkExpr(b.when));
  }
  for(const [version,review] of Object.entries(pack.versionReviews??{})){
    if(pack.rules.some(r=>!r.versionVerification?.[version]))throw new Error('incomplete_version_review');
    for(const status of versionStatuses)if(review.counts[status]!==pack.rules.filter(r=>r.versionVerification[version].status===status).length)throw new Error('version_review_count_mismatch');
  }
  return {rules:ids.size,valid:true};
}
