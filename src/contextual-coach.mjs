import {factValue} from './rule-evaluator.mjs';

// Coach advice is independent of trophy rules. Emit only the coach contract,
// never a deadline, missable flag or a platinum-critical assessment.
export function selectCoachTips(candidates){
  const seen=new Set();
  return candidates.filter(t=>{
    if(t.category!=='TIP'||!t.id||!t.message||!t.whyNow||!t.evidence?.length||
      ['deadline','missableStatus','critical','trophyCondition','requirementLevel','affectedTrophies'].some(k=>k in t)||seen.has(t.id))return false;
    seen.add(t.id);return true;
  }).slice(0,2).map(({id,category,message,whyNow,evidence})=>({id,category,message,whyNow,evidence:structuredClone(evidence)}));
}

export function buildContextualCoach(state){
  const candidates=[];
  if(factValue(state.player,'currentMilestone')==='before_griffin')candidates.push({
    id:'pre_griffin_manual_save',category:'TIP',
    message:'Отдельный ручной save перед боем — страховка для возврата к подготовке, не требование платины.',
    whyNow:'Текущий подтверждённый milestone — подготовка к грифону.',
    evidence:[{source:'companion_workflow_heuristic',reference:'docs/roadmap-categories.md#coach-evidence',verificationStatus:'workflow_precaution',limitation:'Не обещает исправление trophy flags или восстановление любого исхода.'}]
  });
  return {mode:'contextual_coach_v0',tips:selectCoachTips(candidates),limit:2};
}
