// Imports already-normalized observations; it cannot invent missing fields.
export class ImportProvider {
  constructor({catalog,progress,providerId='import'}){
    if(catalog.set.id!==progress.setId||!catalog.complete||!progress.complete)throw new Error('invalid_import');
    this.catalog=structuredClone(catalog);this.progress=structuredClone(progress);this.providerId=providerId;
  }
  async getGameSets(){return [structuredClone(this.catalog.set)];}
  async getTrophies(id){if(id!==this.catalog.set.id)throw new Error('unknown_set');return structuredClone(this.catalog);}
  async getAccountProgress(accountId,setId){if(accountId!==this.progress.accountId||setId!==this.progress.setId)throw new Error('identity_mismatch');return structuredClone(this.progress);}
  getSyncStatus(){return {providerId:this.providerId,state:'snapshot_available',automatic:false,lastSuccessfulFetchAt:this.progress.source.freshness.observedAt,sourceSyncedAt:null,sourceSyncAgeText:null,error:null};}
}
export class ManualProvider extends ImportProvider {
  constructor(data){super({...data,providerId:'manual'});if(this.progress.observations.some(o=>o.source.kind!=='user_confirmation'))throw new Error('manual_confirmation_required');}
}
