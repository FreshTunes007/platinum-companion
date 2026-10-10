import {readFile} from 'node:fs/promises';
import {createSyntheticRecording,SyntheticRecordedPSNClient,syntheticObservedAt} from './synthetic-recording.mjs';
import {PSNProvider} from '../src/psn-provider.mjs';
import {emptyAccountState,ingestProvider} from '../src/account-state.mjs';
export const pack=JSON.parse(await readFile(new URL('../knowledge/witcher3-ps5-v0.json',import.meta.url),'utf8'));
export const recorded=createSyntheticRecording();
export const fixtureBinding={accountId:'fixture-account',externalAccountKey:recorded.account.accountKey,externalSetId:recorded.set.setId,set:{id:'fixture-set',gameKey:'witcher3',title:recorded.set.title,platform:'PS5',edition:'complete',gamePatch:null,catalogVersion:null,mappingStatus:'explicit_binding'},trophyIds:Object.fromEntries(recorded.set.catalog.map((t,index)=>[t.id,`internal-fixture-trophy-${index}`])),groupIds:{default:'fixture-base','001':'fixture-dlc-one','002':'fixture-dlc-two'}};
export function recordedProvider(){return new PSNProvider(new SyntheticRecordedPSNClient(recorded),[fixtureBinding],{blockedExternalAuth:false,clock:()=>syntheticObservedAt});}
export async function testState(facts={}){
  const result=await ingestProvider(emptyAccountState(fixtureBinding.accountId,fixtureBinding.set.id),recordedProvider(),{priority:30});if(!result.ok)throw new Error(result.error.code);
  const titles={difficulty_completion:'Walked the Path',difficulty_hard:'Ran the Gauntlet',collect_cards:'Card Collector',complete_keira:'Friends With Benefits',recruit_allies:'Full Crew',two_unassisted_contracts:'Even Odds',five_sign_bonuses:'Power Overwhelming',learn_bomb_recipes:'Bombardier',read_books:'Bookworm'};
  const trophyMapping=Object.fromEntries(Object.entries(titles).map(([key,name])=>[key,fixtureBinding.trophyIds[recorded.set.catalog.find(t=>t.name===name).id]]));
  return {account:result.state,identity:{accountId:fixtureBinding.accountId},trophyMapping,player:{dataKind:'synthetic_test',stateRevision:1,activeRun:{id:'synthetic-test-run',gameSetId:fixtureBinding.set.id,dataKind:'synthetic_test'},facts:Object.fromEntries(Object.entries(facts).map(([k,value])=>[k,{value,source:'synthetic_test',observedAt:'2026-10-02T13:00:00Z',revision:1}])),conflicts:[]},progressEvents:[],lastSessionSnapshot:null,activeSession:null};
}
