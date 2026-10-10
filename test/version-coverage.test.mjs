import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pack,testState} from './live-fixture.mjs';
import {applyVersionReview,currentVersionReview} from '../src/knowledge-version.mjs';
import {validatePack} from '../src/knowledge-validation.mjs';
import {buildRoadmap} from '../src/roadmap.mjs';
import {progressContext} from '../src/context.mjs';
const review=JSON.parse(await readFile(new URL('../knowledge/witcher3-ps5-5.000.200-review.json',import.meta.url),'utf8'));
const base=JSON.parse(await readFile(new URL('../knowledge/history/witcher3-ps5-v0.0.1.json',import.meta.url),'utf8'));
async function currentState(){
  const state=await testState({goal:'base_platinum',gamePatch:'5.x',currentMilestone:'before_griffin',currentRegion:'White Orchard',mode:'NG',startDeathMarch:'yes',difficultyLowered:'no',whiteOrchardShopCards:'yes',zoltanCard:'yes',unassistedContracts:0,remainingContracts:2,contractAttemptNow:'no'});
  state.player.facts.gamePatch.reportedAnswer='5.000.200';state.player.stateRevision=15;
  return state;
}
test('all 12 original claims have a separate current-version verdict, with no new scope or whole-claim verification inflation',()=>{
  assert.equal(pack.version,'0.0.3');assert.deepEqual(pack.scope,base.scope);
  assert.deepEqual(pack.rules.map(r=>[r.ruleId,r.claim]),base.rules.map(r=>[r.ruleId,r.claim]));
  assert.deepEqual(review.counts,{VERIFIED_FOR_CURRENT_VERSION:0,SUPPORTED_FOR_CURRENT_VERSION:4,VERSION_UNCERTAIN:7,DISPUTED:1});
  assert.ok(review.rules.every(r=>r.absenceOfListedChangeUsedAsProof===false));
  assert.deepEqual(validatePack(pack),{rules:12,valid:true});
});
test('a confirmed shop/card observation does not verify recovery behavior or inflate critical version proof',()=>{
  const shop=pack.rules.find(r=>r.ruleId==='w3.cards.shop').versionVerification['5.000.200'];
  assert.equal(shop.status,'VERSION_UNCERTAIN');assert.equal(shop.applicability.components[0].status,'VERIFIED_FOR_CURRENT_VERSION');
  const changed=structuredClone(pack),dm=changed.rules.find(r=>r.ruleId==='w3.dm').versionVerification['5.000.200'];
  dm.status='VERIFIED_FOR_CURRENT_VERSION';assert.throws(()=>validatePack(changed),/missing_current_version_proof/);
  dm.practicalCurrentVersionTest=true;assert.throws(()=>validatePack(changed),/insufficient_critical_version_proof/);
});
test('review binding is exact: a 5.x family or future hotfix is not covered, and conflicting version is unknown',async()=>{
  const state=await currentState();assert.ok(currentVersionReview(pack,state.player));
  delete state.player.facts.gamePatch.reportedAnswer;assert.equal(currentVersionReview(pack,state.player),null);
  state.player.facts.gamePatch.reportedAnswer='5.000.300';assert.equal(currentVersionReview(pack,state.player),null);
  state.player.facts.gamePatch.reportedAnswer='5.000.200';state.player.conflicts.push({fact:'gamePatch',status:'needs_reconciliation'});assert.equal(currentVersionReview(pack,state.player),null);
});
test('MUST, precaution and convenience are distinct; unsupported critical conditions do not become actionable or safely deferrable',async()=>{
  const state=await currentState(),roadmap=buildRoadmap(pack,state);
  assert.deepEqual(roadmap.nextSteps.map(r=>r.requirementLevel),['MUST']);
  assert.equal(roadmap.coach.tips[0].category,'TIP');
  assert.equal(roadmap.updateRequests[0].category,'UPDATE_NEEDED');
  const dm=roadmap.beforeProgressing.find(r=>r.ruleId==='w3.dm');assert.equal(dm.requirementLevel,'MUST');assert.equal(dm.actionable,false);assert.equal(dm.currentVersionStatus,'VERSION_UNCERTAIN');
  assert.ok(roadmap.doNow.some(r=>r.ruleId==='w3.books'&&r.requirementLevel==='OPTIONAL'&&r.currentVersionStatus==='SUPPORTED_FOR_CURRENT_VERSION'));
  assert.equal(roadmap.doNow.find(r=>r.ruleId==='w3.books').objectiveRequirementLevel,'MUST');
  assert.equal(roadmap.canDefer.length,0);assert.equal(roadmap.questions.length,0);
});
test('known cards/NG/early milestone prevent irrelevant blockers and repeated interview while gaps remain visible',async()=>{
  const state=await currentState(),roadmap=buildRoadmap(pack,state);
  assert.deepEqual(roadmap.evidenceCoverage.activeCriticalGaps.map(g=>g.ruleId),['w3.dm','w3.contracts.reserve']);
  assert.ok(!roadmap.criticalUnknowns.some(g=>g.ruleId==='w3.ng.cards'));
  state.player.facts.mode.value='NG+';state.player.facts.currentCollectionChecked={value:'yes',source:'synthetic_test'};
  assert.ok(buildRoadmap(pack,state).criticalUnknowns.some(g=>g.ruleId==='w3.ng.cards'&&g.kind==='evidence'));
});
test('knowledge revision changes context independently of player revision and does not mutate or fabricate gameplay',async()=>{
  const state=await currentState(),before=JSON.stringify(state);
  const oldContext=progressContext(state,base,buildRoadmap),newContext=progressContext(state,pack,buildRoadmap);
  assert.equal(oldContext.stateRevision,15);assert.equal(newContext.stateRevision,15);
  assert.equal(oldContext.knowledgePackVersion,'0.0.1');assert.equal(newContext.knowledgePackVersion,'0.0.3');
  assert.equal(newContext.currentRunFacts.currentMilestone.value,'before_griffin');
  assert.deepEqual(oldContext.currentRunFacts,newContext.currentRunFacts);assert.equal(JSON.stringify(state),before);
  assert.equal(newContext.evidenceCoverage.patchStatus,'REVIEWED_PARTIAL');assert.equal(newContext.questions.length,0);
});
test('rebuilding preserves audited verdicts; a changed original claim requires a new review',()=>{
  const rebuilt=applyVersionReview(base,review);assert.equal(rebuilt.version,'0.0.2');assert.deepEqual(rebuilt.versionReviews,pack.versionReviews);
  const changed=structuredClone(base);changed.rules[0].claim+=' changed';assert.throws(()=>applyVersionReview(changed,review),/version_review_claim_changed/);
});
