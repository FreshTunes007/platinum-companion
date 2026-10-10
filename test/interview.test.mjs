import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {providers} from './fixtures.mjs';
import {emptyAccountState,ingestProvider} from '../src/account-state.mjs';
import {StateStore} from '../src/state-store.mjs';
import {scenarioStates} from '../src/scenarios.mjs';
import {interviewCandidates,nextQuestion,recordAnswer,observeRunFact} from '../src/interview.mjs';
import {evaluateDependencies} from '../src/rule-evaluator.mjs';
import {progressContext} from '../src/context.mjs';
import {observation} from '../src/observations.mjs';
const pack=JSON.parse(await readFile(new URL('../knowledge/witcher3-ps5-v0.json',import.meta.url),'utf8'));
async function fixture(providerName='stratege'){
  const p=providers(),{state:account}=await ingestProvider(emptyAccountState(p.binding.accountId,p.binding.set.id),p[providerName]);
  const falseId=account.observations.find(o=>o.earned===false).trophyId;
  return {account,identity:{accountId:account.accountId},trophyMapping:Object.fromEntries(pack.rules.flatMap(r=>r.affectedTrophies).map(key=>[key,falseId])),player:{dataKind:'synthetic_test',stateRevision:1,activeRun:{id:'synthetic',gameSetId:account.setId},facts:{},conflicts:[]}};
}
test('A/B/C questions come from distinct unresolved rules and their counterfactual route changes',async()=>{
  const scenarios=scenarioStates(await fixture());
  const expected={A:'startDeathMarch',B:'difficultyLowered',C:'keiraOutcome'};
  for(const [id,state]of Object.entries(scenarios)){
    const {selected,candidates}=nextQuestion(pack,state);
    assert.equal(selected.fact,expected[id]);assert.ok(selected.priority>0);
    assert.ok(candidates.every(c=>c.options.some(o=>o.changes.length)));
    assert.ok(!candidates.some(c=>c.fact==='goal'||c.fact==='mode'||c.fact==='runOrigin'));
  }
  const c=nextQuestion(pack,scenarios.C).selected;
  const early=evaluateDependencies(pack,scenarios.A);
  assert.equal(early.items.find(i=>i.ruleId==='w3.cards.shop').status,'check_elsa_inventory');
  assert.equal(early.items.find(i=>i.ruleId==='w3.cards.scholar').status,'play_scholar');
  assert.equal(c.spoilerDetailsHidden,true);assert.equal(c.answerValues,null);
  assert.ok(!c.question.includes('Каэр'));
});
test('confirmed account trophies suppress redundant objectives but cannot establish current run facts',async()=>{
  const state=scenarioStates(await fixture()).B;
  const id=state.trophyMapping.difficulty_completion;
  state.account.observations=state.account.observations.map(o=>o.trophyId===id?observation({...o,earned:true,source:{...o.source,kind:'synthetic_test'}}):o);
  const candidates=interviewCandidates(pack,state);
  assert.ok(!candidates.some(c=>c.fact==='difficultyLowered'));
  assert.equal(state.player.facts.difficultyLowered,undefined);
});
test('questions are regenerated for unknown goal/version/mode only when answers change covered decisions',async()=>{
  const state=scenarioStates(await fixture()).B;
  for(const key of ['goal','gamePatch','mode'])delete state.player.facts[key];
  const candidates=interviewCandidates(pack,state);
  for(const key of ['goal','gamePatch','mode'])assert.ok(candidates.some(c=>c.fact===key));
  assert.ok(!candidates.some(c=>c.fact==='autoOils')); // no attempt now
});
test('answer persists provenance/revision/roadmap; duplicate answer is a no-op; later evidence creates reconciliation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'platinum-interview-')),store=new StateStore(join(dir,'state.json'));
  try{
    const state=scenarioStates(await fixture()).B;await store.writeInitial(state);
    const answer={fact:'difficultyLowered',value:'no',expectedRevision:1,observedAt:'2026-10-02T09:10:00Z'};
    const result=await recordAnswer(store,pack,answer);
    assert.equal(result.state.player.stateRevision,2);
    assert.equal(result.state.player.facts.difficultyLowered.source,'user_confirmation');
    assert.equal(result.state.player.facts.difficultyLowered.observedAt,answer.observedAt);
    assert.equal(result.roadmap.stateRevision,2);
    assert.equal(result.roadmap.items.find(i=>i.ruleId==='w3.dm').status,'preserve_death_march');
    assert.ok(!interviewCandidates(pack,result.state).some(c=>c.fact===answer.fact));
    const duplicate=await recordAnswer(store,pack,{...answer,expectedRevision:2});assert.equal(duplicate.changed,false);
    await assert.rejects(recordAnswer(store,pack,{...answer,value:'yes',expectedRevision:1}),/state_revision_conflict/);
    const conflict=await observeRunFact(store,pack,{fact:answer.fact,value:'yes',source:'evidence',observedAt:'2026-10-02T09:20:00Z',expectedRevision:2});
    assert.equal(conflict.player.facts.difficultyLowered.value,'no');assert.equal(conflict.player.conflicts[0].status,'needs_reconciliation');
    assert.equal(conflict.player.stateRevision,3);assert.equal(conflict.roadmap.items.find(i=>i.ruleId==='w3.dm').status,'needs_facts');
    await assert.rejects(recordAnswer(store,pack,{...answer,value:'yes',expectedRevision:3}),/explicit_reconciliation_required/);
    assert.equal((await store.read()).player.stateRevision,3);
  }finally{await unlink(store.path);await rmdir(dir);}
});
test('disputed/unverified critical evidence and unknown/unsupported patch never promise safe deferral',async()=>{
  const state=scenarioStates(await fixture()).C;
  for(const patch of ['unknown','5.x','4.x']){
    state.player.facts.gamePatch.value=patch;
    for(const status of ['DISPUTED','UNVERIFIED']){
      const changed=structuredClone(pack);changed.rules[0].verificationStatus=status;
      assert.ok(evaluateDependencies(changed,state).items.every(i=>i.safeToDefer===false));
    }
  }
  state.player.facts.currentMilestone.value='outside_pack_scope';
  assert.equal(interviewCandidates(pack,state).length,0);
});
test('provider swap needs no changes to pack, player, run, decisions, interview or context contract',async()=>{
  // Same fixture binding is shared across the two adapters in this proof.
  const p=providers(),initial=emptyAccountState(p.binding.accountId,p.binding.set.id);
  const a=(await ingestProvider(initial,p.stratege)).state,b=(await ingestProvider(initial,p.psn)).state;
  const falseId=a.observations[1].trophyId;
  const initialState={account:a,identity:{accountId:a.accountId},trophyMapping:Object.fromEntries(pack.rules.flatMap(r=>r.affectedTrophies).map(key=>[key,falseId])),player:{dataKind:'synthetic_test',stateRevision:1,activeRun:{id:'run',gameSetId:a.setId},facts:{},conflicts:[]}};
  const playerState=scenarioStates(initialState).B;
  const swapped={...structuredClone(playerState),account:b};
  const original=JSON.stringify(pack),playerBefore=JSON.stringify(playerState.player);
  assert.deepEqual(evaluateDependencies(pack,playerState),evaluateDependencies(pack,swapped));
  assert.deepEqual(nextQuestion(pack,playerState),nextQuestion(pack,swapped));
  const contextA=progressContext(playerState,pack,evaluateDependencies),contextB=progressContext(swapped,pack,evaluateDependencies);
  assert.deepEqual(Object.keys(contextA),Object.keys(contextB));assert.deepEqual(contextA.roadmap,contextB.roadmap);
  assert.deepEqual(contextA.currentRunFacts,contextB.currentRunFacts);
  assert.equal(JSON.stringify(pack),original);assert.equal(JSON.stringify(playerState.player),playerBefore);
});
