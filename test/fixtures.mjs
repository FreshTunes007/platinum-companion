import { StrategeSnapshotAdapter, createBinding } from '../src/stratege-snapshot-adapter.mjs';
import { PSNProvider } from '../src/psn-provider.mjs';
export function providers() {
  const at='2026-10-02T08:00:00Z';
  const snapshot={schemaVersion:1,dataKind:'observed_stratege_snapshot',account:{psnOnlineId:'synthetic-account'},game:{title:'Synthetic game',platform:'PS5'},source:{url:'https://example.test/profile',gameUrl:'https://example.test/game',observedAt:at,lastSuccessfulSyncAt:null,syncAgeText:'1 day',syncStatus:'unknown'},counts:{all:3,base:2,dlc:1,earned:1},completeWithinPage:true,trophies:[0,1,2].map(i=>({id:`external:${i}`,name:`Trophy ${i}`,earned:i===0,earnedAt:null,earnedAtDisplay:null,earnedAtTimezone:null,observedAt:at,sourceUrl:`https://example.test/trophy/${i}`}))};
  const binding=createBinding(snapshot,{gameKey:'test',edition:'test',confirmedGroups:{baseEarned:1,dlcEarned:0}});
  const psnBinding={accountId:binding.accountId,externalAccountKey:'SYNTHETIC-ACCOUNT',externalSetId:'SYNTHETIC-NPWR',set:binding.set,trophyIds:Object.fromEntries([0,1,2].map(i=>[String(i),binding.trophyIds[`external:${i}`]])),groupIds:{default:binding.groups.baseId,'001':binding.groups.dlcId}};
  const client={accountKey:psnBinding.externalAccountKey,listGames:async()=>({items:[{setId:psnBinding.externalSetId,platform:'PS5'}]}),getTrophySet:async()=>({version:'test',catalog:[0,1,2].map(i=>({id:String(i),name:`Trophy ${i}`,groupId:i===2?'001':'default',grade:'bronze',hidden:false})),groups:[{trophyGroupId:'default'},{trophyGroupId:'001'}]}),getAccountTrophies:async()=>({version:'test',observedAt:at,trophies:[0,1,2].map(i=>({id:String(i),earned:i===0,earnedAt:null,observedAt:at,progress:null,progressTarget:null}))}),getSyncStatus:()=>({state:'ready',lastSuccessAt:at,error:null})};
  return {binding,stratege:new StrategeSnapshotAdapter(snapshot,binding),psn:new PSNProvider(client,[psnBinding],{blockedExternalAuth:false,clock:()=>at})};
}
