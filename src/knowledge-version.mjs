import {createHash} from 'node:crypto';

export const versionStatuses=['VERIFIED_FOR_CURRENT_VERSION','SUPPORTED_FOR_CURRENT_VERSION','VERSION_UNCERTAIN','DISPUTED'];
export function exactReportedVersion(player){
  const fact=player.facts.gamePatch;
  if(player.conflicts.some(c=>c.fact==='gamePatch'&&c.status==='needs_reconciliation'))return null;
  for(const value of [fact?.reportedAnswer,fact?.value])if(typeof value==='string'&&/^\d+\.\d+\.\d+$/.test(value.trim()))return value.trim();
  return null;
}
export function currentVersionReview(pack,player){return pack.versionReviews?.[exactReportedVersion(player)]??null;}
export function ruleVersionAssessment(rule,player){return rule.versionVerification?.[exactReportedVersion(player)]??null;}
export function disputeRelevant(assessment,player){
  const when=assessment?.conflictAppliesWhen;
  if(!when)return true;
  const fact=player.facts[when.fact];
  if(!fact||player.conflicts.some(c=>c.fact===when.fact&&c.status==='needs_reconciliation'))return true;
  return fact.value===when.value;
}
export function applyVersionReview(pack,review){
  if(review.rules.length!==pack.rules.length||new Set(review.rules.map(r=>r.ruleId)).size!==pack.rules.length)throw new Error('version_review_rule_set_mismatch');
  const next=structuredClone(pack);
  for(const rule of next.rules){
    const row=review.rules.find(r=>r.ruleId===rule.ruleId);
    if(!row||row.originalClaim!==rule.claim||row.originalClaimSha256!==createHash('sha256').update(rule.claim).digest('hex'))throw new Error('version_review_claim_changed');
    rule.versionVerification={...rule.versionVerification,[review.targetVersion]:row};
    rule.recommendationLevel=row.recommendation.level;
    rule.recommendationPurpose=row.recommendation.purpose;
    rule.trophyCondition=row.recommendation.trophyCondition;
    rule.objectiveRequirementLevel=row.recommendation.objectiveRequirementLevel;
  }
  next.version=review.resultPackVersion;
  next.versionReviews={...next.versionReviews,[review.targetVersion]:{
    targetVersion:review.targetVersion,checkedAt:review.checkedAt,status:review.status,
    counts:review.counts,fullVerification:false,reviewFile:'knowledge/witcher3-ps5-5.000.200-review.json',
    criticalGaps:review.rules.filter(r=>r.threshold==='critical'&&['VERSION_UNCERTAIN','DISPUTED'].includes(r.status)).map(r=>({ruleId:r.ruleId,status:r.status,reason:r.gap,conflictAppliesWhen:r.conflictAppliesWhen??null})),
    policy:review.policy,versionIdentity:review.versionIdentity
  }};
  next.appliesTo.reviewedVersions=[...new Set([...(next.appliesTo.reviewedVersions??[]),review.targetVersion])];
  next.appliesTo.patchVerified=false;
  next.sources.push(...review.sources.filter(s=>!next.sources.some(old=>old.id===s.id)));
  next.limitations=next.limitations.filter(s=>!s.startsWith('User patch unknown.'));
  next.limitations.push('5.000.200 reviewed per rule; PARTIAL is not blanket version verification. No safe deferral inferred from missing patch notes.');
  return next;
}
