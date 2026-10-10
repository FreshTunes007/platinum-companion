// A replay of a verified fetch, never a claim that a new network call happened.
export class RecordedPSNClient {
  constructor(snapshot) {
    if(snapshot.dataKind!=='live_psn')throw new Error('verified_psn_recording_required');
    this.snapshot=structuredClone(snapshot);this.accountKey=snapshot.account.accountKey;
  }
  async listGames(){return {items:[this.snapshot.set],pages:1};}
  async getTrophySet(game){if(game.setId!==this.snapshot.set.setId)throw new Error('unknown_set');return structuredClone(this.snapshot.set);}
  async getAccountTrophies(game){if(game.setId!==this.snapshot.account.setId)throw new Error('unknown_set');return structuredClone(this.snapshot.account);}
  getSyncStatus(){return {...this.snapshot.sync,automatic:false,readMode:'verified_recording',lastSuccessAt:this.snapshot.account.observedAt};}
}
