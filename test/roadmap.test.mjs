import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,unlink,rmdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildRoadmap,assertRealState} from '../src/roadmap.mjs';
import {pack,testState,recorded,recordedProvider,fixtureBinding} from './live-fixture.mjs';
import {accountTrophy,ingestProvider} from '../src/account-state.mjs';
import {observation,mergeObservations} from '../src/observations.mjs';
import {fetchPreferredAccount} from '../src/provider-selection.mjs';
import {ImportProvider,ManualProvider} from '../src/import-provider.mjs';
import {StateStore} from '../src/state-store.mjs';
import {recordAnswer,observeRunFact} from '../src/interview.mjs';
import {startSession,endSession} from '../src/sessions.mjs';
const facts={goal:'base_platinum',gamePatch:'4.x',currentMilestone:'keira_chain',mode:'NG',startDeathMarch:'yes',difficultyLowered:'no',whiteOrchardShopCards:'no',zoltanCard:'no',unassistedContracts:0,remainingContracts:2,contractAttemptNow:'no',keiraChain:'active',keiraOutcome:'pending',spoilerPreference:'minimal'};

test('synthetic protocol fixture goes through actual PSNProvider: 79 flags, 53/13/13 groups, synthetic UTC dates; no live evidence claimed',async()=>{
  const state=await testState();
  assert.equal(state.account.lastConfirmedSnapshot.summary.total,79);assert.equal(state.account.lastConfirmedSnapshot.summary.earned,4);
  assert.deepEqual(state.account.lastConfirmedSnapshot.summary.groups.map(g=>[g.total,g.earned]),[[53,4],[13,0],[13,0]]);
  assert.equal(state.account.sync.readMode,'synthetic_fixture');assert.equal(state.account.sync.automatic,false);
  assert.equal(state.account.observations.filter(o=>o.earnedAt!==null).length,4);
  assert.equal(recorded.account.accountKey,'synthetic-test-account');assert.equal(recorded.provenance.kind,'synthetic_test_fixture');assert.equal(recorded.provenance.personalProgressIncluded,false);
  assert.ok(!/freshtunes|mail\.ru|accessToken|refreshToken|npsso/i.test(JSON.stringify(recorded)));
});
test('deterministic categories explain rule, used player/account facts and evidence; minimal spoilers redact outcome advice',async()=>{
  const state=await testState(facts),a=buildRoadmap(pack,state),b=buildRoadmap(pack,state);
  assert.deepEqual(a,b);for(const k of ['doNow','beforeProgressing','canDefer','blockedOrLost','criticalUnknowns','questions','evidenceCoverage','stateRevision','knowledgePackVersion'])assert.ok(k in a);
  for(const r of [...a.doNow,...a.beforeProgressing,...a.blockedOrLost]){assert.equal(r.explanation.ruleId,r.ruleId);assert.ok(r.explanation.evidence.length);assert.ok(r.explanation.accountTrophyFacts.length);assert.ok(r.explanation.reason);}
  const ally=a.beforeProgressing.find(r=>r.ruleId==='w3.keira.ally');assert.equal(ally.spoilerDetailsHidden,true);assert.ok(!ally.message.includes('Каэр'));
  assert.ok(!a.items.find(i=>i.ruleId==='w3.power').unresolved);assert.equal(a.items.find(i=>i.ruleId==='w3.power').accountEarned,true);
});
test('unknown difficulty is not false or a safe/lost conclusion; explicit broken difficulty is a reviewed blocked branch',async()=>{
  const state=await testState(facts);delete state.player.facts.startDeathMarch;
  const unknown=buildRoadmap(pack,state);assert.ok(unknown.criticalUnknowns.some(u=>u.fact==='startDeathMarch'));assert.ok(!unknown.blockedOrLost.some(r=>r.ruleId==='w3.dm'));assert.ok(!unknown.canDefer.some(r=>r.ruleId==='w3.dm'));
  state.player.facts.startDeathMarch={value:'no',source:'synthetic_test'};
  assert.ok(buildRoadmap(pack,state).blockedOrLost.some(r=>r.ruleId==='w3.dm'&&r.status==='needs_eligible_story_run'));
});
test('DISPUTED/unverified and unknown/unsupported versions never create safe deferral',async()=>{
  const state=await testState(facts);
  for(const version of [undefined,'4.x','5.x']){if(version)state.player.facts.gamePatch={value:version,source:'synthetic_test'};else delete state.player.facts.gamePatch;
    const result=buildRoadmap(pack,state);assert.equal(result.canDefer.length,0);assert.ok([...result.doNow,...result.beforeProgressing,...result.blockedOrLost].filter(r=>r.verificationStatus==='DISPUTED').every(r=>!r.safeToDefer));
  }
  const changed=structuredClone(pack);changed.appliesTo.patchVerified=true;changed.rules.find(r=>r.ruleId==='w3.bombs').verificationStatus='UNVERIFIED';state.player.facts.gamePatch={value:'4.x',source:'synthetic_test'};
  assert.ok(!buildRoadmap(changed,state).canDefer.some(r=>r.ruleId==='w3.bombs'));
});
test('provider precedence selects snapshot metadata only: manual trophy evidence remains and conflict blocks certainty',async()=>{
  const state=await testState(facts);const old=state.account.observations.find(o=>o.trophyId===state.trophyMapping.difficulty_completion);
  const manual=observation({...old,earned:true,observedAt:'2026-10-02T14:00:00Z',source:{...old.source,kind:'user_confirmation',providerId:'manual'}});
  const fresh=observation({...old,earned:false,observedAt:'2026-10-02T15:00:00Z'});
  state.account.observations=mergeObservations(state.account.observations,[manual,fresh]);
  const resolved=accountTrophy(state.account,old.trophyId);assert.equal(resolved.conflict,true);
  assert.ok(buildRoadmap(pack,state).criticalUnknowns.some(u=>u.kind==='reconciliation'&&u.ruleId==='w3.dm'));
  const fallbackProgress=structuredClone(state.account.lastConfirmedSnapshot);fallbackProgress.source.freshness.observedAt='2026-10-03T00:00:00Z';
  const fallback=new ImportProvider({catalog:state.account.catalog,progress:fallbackProgress});
  const selected=await fetchPreferredAccount(state.account,[{name:'failed_psn',priority:30,provider:{getTrophies:async()=>{throw new Error('offline');}}},{name:'fallback',priority:20,provider:fallback}],ingestProvider);
  assert.equal(selected.selected,'fallback');assert.equal(selected.attempts[0].ok,false);assert.deepEqual(selected.state.lastConfirmedSnapshot,state.account.lastConfirmedSnapshot);
  assert.ok(selected.state.observations.some(o=>o.source.kind==='user_confirmation'));
  const failed=await fetchPreferredAccount(state.account,[{name:'offline',priority:30,provider:{getTrophies:async()=>{throw new Error('offline');}}}],ingestProvider);assert.deepEqual(failed.state,state.account);
});
test('ImportProvider and ManualProvider share contract, no real confirmations fabricated in fixtures',async()=>{
  const state=await testState();const data={catalog:state.account.catalog,progress:state.account.lastConfirmedSnapshot};
  assert.equal((await new ImportProvider(data).getGameSets())[0].id,fixtureBinding.set.id);
  assert.throws(()=>new ManualProvider(data),/manual_confirmation_required/);
});
test('synthetic facts are rejected inside real user state; empty user run generates impact-ranked first question',async()=>{
  const state=await testState();state.player.dataKind='user_state';state.player.activeRun.dataKind='user_state';assertRealState(state);
  const first=buildRoadmap(pack,state);assert.equal(first.questions.length,1);assert.equal(first.questions[0].fact,'goal');assert.equal(first.stateRevision,1);
  state.player.facts.mode={value:'NG',source:'synthetic_test'};assert.throws(()=>buildRoadmap(pack,state),/synthetic_facts_in_user_state/);
});
test('answer transaction stores provenance/run/revision, no repeated question; conflicting evidence preserves confirmation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'platinum-roadmap-')),store=new StateStore(join(dir,'state.json'));
  try{await store.writeInitial(await testState());
    const answer=await recordAnswer(store,pack,{fact:'goal',value:'base_platinum',expectedRevision:1});
    assert.equal(answer.state.player.facts.goal.runId,'synthetic-test-run');assert.equal(answer.state.player.facts.goal.field,'goal');assert.equal(answer.state.player.facts.goal.source,'user_confirmation');assert.equal(answer.roadmap.mode,'roadmap_v0');assert.equal(answer.roadmap.stateRevision,2);assert.ok(!answer.roadmap.questions.some(q=>q.fact==='goal'));
    const duplicate=await recordAnswer(store,pack,{fact:'goal',value:'base_platinum',expectedRevision:2});assert.equal(duplicate.changed,false);
    const conflict=await observeRunFact(store,pack,{fact:'goal',value:'dlc_only',source:'evidence',expectedRevision:2});assert.equal(conflict.player.facts.goal.value,'base_platinum');assert.equal(conflict.player.conflicts[0].status,'needs_reconciliation');
    await assert.rejects(recordAnswer(store,pack,{fact:'goal',value:'base_platinum',expectedRevision:3}),/explicit_reconciliation_required/);
  }finally{await unlink(store.path);await rmdir(dir);}
});
test('session domain flow captures confirmations/events and honest trophy attribution, reusable saved snapshot',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'platinum-session-')),store=new StateStore(join(dir,'state.json'));
  try{await store.writeInitial(await testState(facts));await startSession(store,{expectedRevision:1,startedAt:'2026-10-02T14:00:00Z'});
    await recordAnswer(store,pack,{fact:'currentMilestone',value:'keira_final_choice',expectedRevision:2,observedAt:'2026-10-02T14:10:00Z'});
    await store.update(3,state=>{const old=state.account.observations.find(o=>!o.earned);state.account.observations.push(observation({...old,earned:true,earnedAt:'2026-10-01T00:00:00Z',observedAt:'2026-10-02T14:15:00Z'}));return state;});
    const end=await endSession(store,pack,{expectedRevision:4,endedAt:'2026-10-02T14:30:00Z'});
    assert.equal(end.lastSessionSnapshot.resultingStateRevision,5);assert.equal(end.lastSessionSnapshot.earnedTrophiesDuringSession.length,0);assert.equal(end.lastSessionSnapshot.newlyObservedWithoutSessionAttribution.length,1);assert.equal(end.lastSessionSnapshot.importantConfirmedFacts[0].field,'currentMilestone');assert.ok(end.lastSessionSnapshot.changes.length);assert.ok(end.lastSessionSnapshot.nextRecommendedAction);assert.equal(end.activeSession,null);
    assert.deepEqual((await new StateStore(store.path).read()).lastSessionSnapshot,end.lastSessionSnapshot);
  }finally{await unlink(store.path);await rmdir(dir);}
});

test('confirmed White Orchard/pre-griffin stage schedules Velen dependencies later without a safety claim or premature interview',async()=>{
  const state=await testState({goal:'base_platinum',currentMilestone:'before_griffin',currentRegion:'White Orchard'});
  const roadmap=buildRoadmap(pack,state);
  assert.equal(roadmap.items.find(r=>r.ruleId==='w3.keira.chain').status,'future_dependency');
  assert.equal(roadmap.items.find(r=>r.ruleId==='w3.keira.ally').safeToDefer,false);
  assert.ok(!roadmap.questions.some(q=>q.fact==='keiraOutcome'));
  assert.ok(![...roadmap.doNow,...roadmap.beforeProgressing].some(r=>r.ruleId==='w3.keira.chain'||r.ruleId==='w3.keira.ally'));
});

test('a real user location answer is saved as confirmation and its broad wording does not invent cards/quest facts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'platinum-location-')),store=new StateStore(join(dir,'state.json'));
  try{const state=await testState();state.player.dataKind='user_state';state.player.activeRun.dataKind='user_state';await store.writeInitial(state);
    const result=await recordAnswer(store,pack,{fact:'currentRegion',value:'White Orchard',reportedAnswer:'Белый Сад, зачистил всё',expectedRevision:1});
    assert.equal(result.state.player.facts.currentRegion.source,'user_confirmation');assert.equal(result.state.player.facts.currentRegion.reportedAnswer,'Белый Сад, зачистил всё');assert.equal(result.state.player.stateRevision,2);
    assert.equal(result.state.player.facts.whiteOrchardShopCards,undefined);assert.equal(result.state.player.facts.zoltanCard,undefined);assert.equal(result.state.player.facts.keiraChain,undefined);
  }finally{await unlink(store.path);await rmdir(dir);}
});

test('last needed confirmation completes current-scope intake while unsupported version stays unresolved',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'platinum-intake-')),store=new StateStore(join(dir,'state.json'));
  try{
    const state=await testState({...facts,currentMilestone:'before_griffin',gamePatch:'5.x',whiteOrchardShopCards:'yes'});
    state.player.dataKind='user_state';state.player.activeRun.dataKind='user_state';state.player.activeRun.status='awaiting_intake';
    for(const fact of Object.values(state.player.facts))fact.source='user_confirmation';
    delete state.player.facts.zoltanCard;
    await store.writeInitial(state);
    const result=await recordAnswer(store,pack,{fact:'zoltanCard',value:'yes',expectedRevision:1});
    assert.equal(result.state.player.activeRun.status,'intake_complete_for_current_scope');
    assert.equal(result.roadmap.questions.length,0);
    assert.equal(result.roadmap.evidenceCoverage.patchStatus,'OUTSIDE_COVERAGE');
    assert.ok(result.roadmap.criticalUnknowns.some(u=>u.kind==='applicability'));
    assert.equal(result.roadmap.canDefer.length,0);
    assert.ok([...result.roadmap.doNow,...result.roadmap.beforeProgressing].every(r=>!r.actionable));
  }finally{await unlink(store.path);await rmdir(dir);}
});
