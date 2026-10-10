// Original synthetic demo; no Sony requests, owner data, assets or credentials.
import {mkdirSync,writeFileSync} from 'node:fs';
import {validateMobileSnapshot} from '../src/mobile-snapshot.mjs';
const id='psn:NPWR00001_00:PS5',at='2020-01-02T00:00:00.000Z';
const snapshot={schemaVersion:1,kind:'platinum_companion_snapshot',exportedAt:at,games:[{
 id,title:'Демонстрационная игра',platform:'PS5',source:'imported',observedAt:at,sony:{npCommunicationId:'NPWR00001_00',service:'trophy2'},coverUrl:null,
 groups:[{id:id+':group:default',name:'Основная игра',kind:'base'}],
 trophies:[{id:id+':trophy:0',sonyTrophyId:null,groupId:id+':group:default',name:'Первый шаг',description:'Открыть демонстрационную игру.',grade:'bronze',hidden:false,earned:true,earnedAt:'2020-01-01T00:00:00.000Z'},
 {id:id+':trophy:1',sonyTrophyId:null,groupId:id+':group:default',name:'Мастер демо',description:'Это синтетический трофей, не наблюдение Sony.',grade:'platinum',hidden:true,earned:false,earnedAt:null}],
 summary:{earned:1,total:2,unknown:0,platinumEarned:0,platinumTotal:1},
}]};
validateMobileSnapshot(snapshot);
mkdirSync('private',{recursive:true});writeFileSync('private/demo-library.json',JSON.stringify(snapshot,null,2)+'\n');
console.log('Synthetic demo written to private/demo-library.json; transfer separately and import with the Android file picker.');
