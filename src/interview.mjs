import {evaluateDependencies,factValue,expressionFacts} from './rule-evaluator.mjs';
import {buildRoadmap} from './roadmap.mjs';
const signature=item=>item.accountEarned||['not_applicable','future_dependency'].includes(item.status)?JSON.stringify([item.status]):JSON.stringify([item.status,item.possible,item.applicability,item.inScope]);
export function interviewCandidates(pack,state){
  const baseline=evaluateDependencies(pack,state),candidates=[];
  if(factValue(state.player,'currentMilestone')==='outside_pack_scope')return candidates;
  const fields=[...new Set(['gamePatch',...pack.rules.flatMap(r=>[expressionFacts(r.activation),...r.branches.map(b=>expressionFacts(b.when))].flat())])];
  for(const fact of fields){
    if(factValue(state.player,fact)!==undefined || state.player.conflicts.some(c=>c.fact===fact&&c.status==='needs_reconciliation'))continue;
    const alternatives=pack.facts[fact].values.map(value=>{
      const hypothetical=structuredClone(state);
      hypothetical.player.facts[fact]={value,source:'hypothesis',observedAt:null,revision:state.player.stateRevision};
      const roadmap=evaluateDependencies(pack,hypothetical);
      return {value,roadmap,changed:roadmap.items.filter((item,i)=>signature(item)!==signature(baseline.items[i])).map(item=>item.ruleId)};
    });
    const affected=[...new Set(alternatives.flatMap(a=>a.changed))];
    // Exclude questions whose answers cannot distinguish routes, even if a fact is missing.
    const distinct=new Set(alternatives.map(a=>JSON.stringify(a.roadmap.items.map(signature)))).size;
    if(!affected.length||distinct<2)continue;
    const relevant=pack.rules.filter(r=>affected.includes(r.ruleId));
    const missable=relevant.some(r=>r.missableStatus!=='not_missable')?1:0;
    const preventPlaythrough=relevant.some(r=>['run_invalidated_if_difficulty_requirement_broken','irreversible_choice','quest_chain','finite_opportunities','collection_can_be_missed'].includes(r.missableStatus))?1:0;
    const urgency=Math.max(...relevant.map(r=>r.deadline.urgency));
    const indirectlyResolved=Math.max(0,...alternatives.map(a=>new Set(baseline.criticalUnknowns.map(u=>u.fact).filter(Boolean)).size-new Set(a.roadmap.criticalUnknowns.map(u=>u.fact).filter(Boolean)).size-1));
    const components={branches:distinct-1,affectedRules:affected.length,missable,preventPlaythrough,urgency,indirectlyResolved};
    const priority=2*components.branches+3*components.affectedRules+4*missable+6*preventPlaythrough+2*urgency+indirectlyResolved;
    candidates.push({fact,label:pack.facts[fact].label,priority,components,affectedRules:affected,options:alternatives.map(a=>({value:a.value,changes:a.roadmap.items.filter(i=>a.changed.includes(i.ruleId)).map(i=>({ruleId:i.ruleId,status:i.status,possible:i.possible,applicability:i.applicability}))})),why:'Only unknown facts whose alternative answers change rule decisions are ranked.'});
  }
  return candidates.sort((a,b)=>b.priority-a.priority||b.components.urgency-a.components.urgency||a.fact.localeCompare(b.fact));
}
export function nextQuestion(pack,state){
  const candidates=interviewCandidates(pack,state),selected=candidates[0]??null;
  if(!selected)return {selected:null,candidates,reconciliation:state.player.conflicts};
  const schema=pack.facts[selected.fact],minimal=factValue(state.player,'spoilerPreference')!=='full';
  const sensitive=schema.spoilerLevel==='quest_outcome'&&minimal;
  return {selected:{...selected,question:sensitive?`Уточни, пожалуйста, ${schema.label}: решение ещё впереди или уже принято? Если принято, назови свой выбор; последствия раскрывать не буду.`:`Уточни, пожалуйста, ${schema.label}.`,answerValues:sensitive?null:schema.values,spoilerDetailsHidden:sensitive},candidates,policy:'ask_one_then_recompute',reconciliation:state.player.conflicts};
}
export async function recordAnswer(store,pack,{fact,value,expectedRevision,observedAt=new Date().toISOString(),allowCorrection=false,reportedAnswer=null}){
  const validRegion=fact==='currentRegion'&&typeof value==='string'&&value.trim().length>0&&value.length<=120;
  if(!pack.facts[fact]?.values.includes(value)&&!validRegion)throw new Error('invalid_answer');
  if(reportedAnswer!==null&&(typeof reportedAnswer!=='string'||reportedAnswer.length>5000))throw new Error('invalid_reported_answer');
  if(!Number.isFinite(Date.parse(observedAt)))throw new Error('invalid_observed_at');
  const before=await store.read();
  if(before.player.stateRevision!==expectedRevision)throw new Error('state_revision_conflict');
  const old=before.player.facts[fact];
  if(before.player.conflicts.some(c=>c.fact===fact&&c.status==='needs_reconciliation'))throw new Error('explicit_reconciliation_required');
  if(old?.value===value)return {changed:false,state:before,roadmap:buildRoadmap(pack,before)};
  const state=await store.update(expectedRevision,next=>{
    const incoming={value,source:'user_confirmation',observedAt,runId:next.player.activeRun.id,field:fact,revision:expectedRevision+1,...(reportedAnswer===null?{}:{reportedAnswer})};
    if(next.player.conflicts.some(c=>c.fact===fact&&c.status==='needs_reconciliation'))throw new Error('explicit_reconciliation_required');
    if(old?.source==='user_confirmation'&&!allowCorrection)throw new Error('explicit_correction_required');
    next.player.facts[fact]=incoming;
    next.progressEvents??=[];next.progressEvents.push({type:'fact_confirmation',runId:next.player.activeRun.id,field:fact,previous:old?.value??null,value,source:'user_confirmation',observedAt,revision:expectedRevision+1});
    next.roadmap=buildRoadmap(pack,{...next,player:{...next.player,stateRevision:expectedRevision+1}});
    if(next.player.dataKind==='user_state'&&next.player.activeRun.status==='awaiting_intake'&&next.roadmap.questions.length===0)next.player.activeRun.status='intake_complete_for_current_scope';
    return next;
  });
  return {changed:true,state,roadmap:state.roadmap};
}
export async function observeRunFact(store,pack,{fact,value,source,expectedRevision,observedAt=new Date().toISOString()}){
  if(!pack.facts[fact]?.values.includes(value)||!['evidence','synthetic_test'].includes(source))throw new Error('invalid_fact_evidence');
  if(!Number.isFinite(Date.parse(observedAt)))throw new Error('invalid_observed_at');
  return store.update(expectedRevision,next=>{
    const old=next.player.facts[fact],incoming={value,source,observedAt,runId:next.player.activeRun.id,field:fact,revision:expectedRevision+1};
    if(old&&old.value!==value){
      next.player.conflicts.push({fact,confirmed:old,incoming,status:'needs_reconciliation'});
    } else if(!old)next.player.facts[fact]=incoming;
    next.roadmap=buildRoadmap(pack,{...next,player:{...next.player,stateRevision:expectedRevision+1}});
    return next;
  });
}
