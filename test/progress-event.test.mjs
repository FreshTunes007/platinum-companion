import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pack,testState} from './live-fixture.mjs';
import {StateStore} from '../src/state-store.mjs';
import {recordProgressEvent} from '../src/progress-events.mjs';
const changes=[{field:'griffinDefeated',value:true,reportedAnswer:'убил грифона'},{field:'whiteOrchardTransitionCompleted',value:true,reportedAnswer:'прибыл в Вызиму на аудиенцию'},{field:'currentRegion',value:'Vizima',reportedAnswer:'прибыл в Вызиму на аудиенцию'},{field:'currentMilestone',value:'vizima_audience',reportedAnswer:'прибыл в Вызиму на аудиенцию'}];
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'platinum-progress-test-'));
  const state=await testState({goal:'base_platinum',currentRegion:'White Orchard',currentMilestone:'before_griffin',gamePatch:'5.x',mode:'NG',startDeathMarch:'yes',difficultyLowered:'no',whiteOrchardShopCards:'yes',zoltanCard:'yes',unassistedContracts:0,remainingContracts:2,contractAttemptNow:'no'});
  state.player.dataKind='user_state';state.player.activeRun.dataKind='user_state';state.player.stateRevision=15;
  // Isolated fixture for the real-state protocol, never imported into live state.
  for(const f of Object.values(state.player.facts))f.source='user_confirmation';
  state.player.facts.gamePatch.reportedAnswer='5.000.200';
  const store=new StateStore(join(dir,'isolated-state.json'));await store.writeInitial(state);
  return {dir,state,store,args:{eventId:'isolated-test-vizima',runId:state.player.activeRun.id,expectedRevision:15,observedAt:'2026-10-02T16:00:00Z',userFacingWording:['убил грифона','прибыл в Вызиму на аудиенцию'],changes}};
}
test('one real-state progress event advances four confirmations atomically, schedules Vizima and duplicate delivery is a no-op',async()=>{
  const f=await fixture();try{
    const r=await recordProgressEvent(f.store,pack,f.args);
    assert.equal(r.state.player.stateRevision,16);assert.equal(r.state.progressEvents.length,1);
    for(const c of changes){const fact=r.state.player.facts[c.field];assert.equal(fact.value,c.value);assert.equal(fact.source,'user_confirmation');assert.equal(fact.runId,f.args.runId);assert.equal(fact.revision,16);assert.deepEqual(fact.revisionDelta,{from:15,to:16});}
    assert.equal(r.event.changes.find(c=>c.field==='currentMilestone').previous.value,'before_griffin');
    assert.deepEqual(r.state.account,f.state.account);assert.deepEqual(r.state.player.facts.zoltanCard,f.state.player.facts.zoltanCard);
    assert.equal(r.roadmap.questions.length,0);assert.equal(r.roadmap.coach.tips.length,0);
    assert.deepEqual(r.roadmap.updateRequests.map(x=>x.id),['report_post_audience_checkpoint']);
    assert.deepEqual(r.roadmap.evidenceCoverage.activeCriticalGaps.map(g=>g.ruleId),['w3.dm','w3.contracts.reserve']);
    assert.ok(r.roadmap.items.filter(x=>x.ruleId.startsWith('w3.keira.')).every(x=>['future_dependency','not_applicable'].includes(x.status)));
    const duplicate=await recordProgressEvent(f.store,pack,f.args);assert.equal(duplicate.changed,false);assert.deepEqual(duplicate.state,r.state);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('progress events reject wrong run, stale revision, unsupported facts and unresolved conflicts without partial writes',async()=>{
  const f=await fixture();try{
    await assert.rejects(recordProgressEvent(f.store,pack,{...f.args,runId:'another-run'}),/progress_run_mismatch/);
    await assert.rejects(recordProgressEvent(f.store,pack,{...f.args,expectedRevision:14}),/state_revision_conflict/);
    await assert.rejects(recordProgressEvent(f.store,pack,{...f.args,changes:[{field:'keiraOutcome',value:'other',reportedAnswer:'invented'}]}),/invalid_progress_fact/);
    assert.deepEqual(await f.store.read(),f.state);
    await f.store.update(15,s=>{s.player.conflicts.push({fact:'currentMilestone',status:'needs_reconciliation'});return s;});
    const before=await f.store.read();
    await assert.rejects(recordProgressEvent(f.store,pack,{...f.args,expectedRevision:16}),/explicit_reconciliation_required/);
    assert.deepEqual(await f.store.read(),before);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});
