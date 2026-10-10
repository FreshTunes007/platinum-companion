import test from 'node:test';
import assert from 'node:assert/strict';
import {pack,testState} from './live-fixture.mjs';
import {buildRoadmap} from '../src/roadmap.mjs';
import {progressContext} from '../src/context.mjs';
import {buildContextualCoach,selectCoachTips} from '../src/contextual-coach.mjs';

test('coach and updates are separate from platinum roadmap and preserve player state and evidence coverage',async()=>{
  const state=await testState({goal:'base_platinum',gamePatch:'5.x',currentMilestone:'before_griffin',mode:'NG',startDeathMarch:'yes',difficultyLowered:'no',whiteOrchardShopCards:'yes',zoltanCard:'yes',unassistedContracts:0,remainingContracts:2,contractAttemptNow:'no'});
  state.player.facts.gamePatch.reportedAnswer='5.000.200';
  const before=JSON.stringify(state),roadmap=buildRoadmap(pack,state),context=progressContext(state,pack,buildRoadmap);
  assert.deepEqual(roadmap.nextSteps.map(s=>s.requirementLevel),['MUST']);
  for(const key of ['doNow','beforeProgressing','canDefer','blockedOrLost','nextSteps'])assert.ok(!roadmap[key].some(r=>r.id==='report_post_griffin_milestone'||r.category==='UPDATE_NEEDED'||r.category==='TIP'));
  assert.equal(context.updateRequests.find(r=>r.id==='report_post_griffin_milestone').status,'waiting_for_gameplay_event');
  assert.equal(context.updateRequests[0].requirementLevel,undefined);
  assert.equal(context.contextualCoach.tips[0].category,'TIP');
  assert.ok(context.contextualCoach.tips[0].whyNow&&context.contextualCoach.tips[0].evidence.length);
  assert.equal(JSON.stringify(state),before);
  assert.deepEqual(context.evidenceCoverage,roadmap.evidenceCoverage);
  assert.equal(roadmap.beforeProgressing.find(r=>r.ruleId==='w3.dm').currentVersionStatus,'VERSION_UNCERTAIN');
  assert.equal(context.questions.length,0);
});

test('coach suppresses irrelevant tips, caps two, and rejects attempts to inject platinum-critical rules',async()=>{
  const state=await testState({currentMilestone:'early_velen'});
  assert.equal(buildContextualCoach(state).tips.length,0);
  const tip=id=>({id,category:'TIP',message:'Advice',whyNow:'Current context',evidence:[{source:'test',reference:'synthetic',verificationStatus:'test'}]});
  const selected=selectCoachTips([{...tip('bad'),deadline:'now'}, {...tip('bad2'),critical:true}, {...tip('bad3'),category:'MUST'}, {...tip('bad4'),evidence:[]},tip('a'),tip('a'),tip('b'),tip('c')]);
  assert.deepEqual(selected.map(t=>t.id),['a','b']);
  assert.ok(selected.every(t=>!('deadline'in t)&&!('critical'in t)&&!('requirementLevel'in t)));
});

test('an intake question is a state update request, never an OPTIONAL game action',async()=>{
  const state=await testState({currentMilestone:'before_griffin'}),roadmap=buildRoadmap(pack,state);
  assert.ok(roadmap.questions.length>0);
  const request=roadmap.updateRequests.find(r=>r.trigger==='unresolved_player_fact');
  assert.equal(request.category,'UPDATE_NEEDED');assert.equal(request.fact,roadmap.questions[0].fact);
  assert.equal(request.requirementLevel,undefined);
});
