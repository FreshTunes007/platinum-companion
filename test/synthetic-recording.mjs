import {readFile} from 'node:fs/promises';
import {RecordedPSNClient} from '../src/psn-recording.mjs';

// Public catalogue only. No private earned state, dates, account binding or recording.
const catalog=JSON.parse(await readFile(new URL('./data/witcher-ps5-catalog.json',import.meta.url),'utf8'));
export const syntheticObservedAt='2020-01-02T00:00:00.000Z';
export function createSyntheticRecording(){
  const earnedNames=new Set(['Power Overwhelming','Kaer Morhen Trained','What Was That?','Triple Threat']);
  if(catalog.catalog.filter(t=>earnedNames.has(t.name)).length!==4)throw new Error('synthetic_catalog_incomplete');
  const trophies=catalog.catalog.map(t=>{
    const earned=earnedNames.has(t.name);
    return {id:t.id,earned,earnedAt:earned?'2020-01-01T12:00:00.000Z':null,observedAt:syntheticObservedAt,provider:'psn',progress:null,progressTarget:null};
  });
  // dataKind is the existing protocol DTO discriminant, not an evidence claim.
  return {schemaVersion:1,dataKind:'live_psn',provenance:{kind:'synthetic_test_fixture',notANewLiveCall:true,personalProgressIncluded:false},
    set:{setId:catalog.setId,title:catalog.title,platform:catalog.platform,version:catalog.version,catalog:structuredClone(catalog.catalog),groups:structuredClone(catalog.groups),pages:1},
    account:{setId:catalog.setId,version:catalog.version,accountKey:'synthetic-test-account',observedAt:syntheticObservedAt,pages:1,trophies},
    sync:{provider:'psn',state:'ready',lastSuccessAt:syntheticObservedAt,error:null,nextAllowedAt:null,authExchanges:0,refreshes:0}};
}
export class SyntheticRecordedPSNClient extends RecordedPSNClient{
  getSyncStatus(){return {...super.getSyncStatus(),readMode:'synthetic_fixture',automatic:false};}
}
