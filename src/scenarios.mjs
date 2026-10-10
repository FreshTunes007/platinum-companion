import {observation} from './observations.mjs';
export function scenarioStates(realState){
  const at='2026-10-02T09:00:00Z';
  function state(name,facts,emptyAccount=false){
    const s=structuredClone(realState);
    s.player={dataKind:'synthetic_test',stateRevision:1,activeRun:{id:`synthetic-scenario-${name}`,gameSetId:s.account.setId,dataKind:'synthetic_test'},facts:Object.fromEntries(Object.entries(facts).map(([k,value])=>[k,{value,source:'synthetic_test',observedAt:at,revision:1}])),conflicts:[]};
    if(emptyAccount){
      s.account.observations=s.account.observations.map(o=>observation({...o,earned:false,earnedAt:null,earnedAtDisplay:null,source:{...o.source,kind:'synthetic_test',externalReference:`scenario-a:${o.trophyId}`}}));
      s.account.lastConfirmedSnapshot={...s.account.lastConfirmedSnapshot,observations:s.account.observations,source:{...s.account.lastConfirmedSnapshot.source,kind:'synthetic_test'},summary:{...s.account.lastConfirmedSnapshot.summary,earned:0,groups:s.account.lastConfirmedSnapshot.summary.groups.map(g=>({...g,earned:0}))}};
      s.identity={...s.identity,displayName:'synthetic_new_account',identityStatus:'synthetic_test'};
    }
    return s;
  }
  const common={goal:'base_platinum',gamePatch:'4.x',contractAttemptNow:'no',spoilerPreference:'minimal',remainingContracts:2};
  return {
    A:state('A',{...common,runOrigin:'new',mode:'NG',currentMilestone:'before_start',currentRegion:'White Orchard',difficultyLowered:'no',whiteOrchardShopCards:'no',zoltanCard:'no',unassistedContracts:0,keiraChain:'not_started',keiraOutcome:'pending'},true),
    B:state('B',{...common,runOrigin:'existing',mode:'NG',currentMilestone:'keira_chain',currentRegion:'Velen',startDeathMarch:'yes',difficulty:'Death March',keiraChain:'active',keiraOutcome:'pending'}),
    C:state('C',{...common,runOrigin:'existing',mode:'NG+',currentMilestone:'keira_final_choice',currentRegion:'Velen',startDeathMarch:'yes',difficultyLowered:'no',unassistedContracts:0,keiraChain:'completed',whiteOrchardShopCards:'yes',zoltanCard:'yes',currentCollectionChecked:'yes'})
  };
}
