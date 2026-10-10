import { observation } from './observations.mjs';

// PSNClient handles the external protocol; this provider returns domain DTOs.
// Binding requires confirmed Sony accountKey, set ID, trophy IDs and group IDs.
export class PSNProvider {
  #client; #bindings; #blocked; #clock; #catalogs=new Map(); #lastValidatedAt=null;
  constructor(client, bindings, {blockedExternalAuth=true,clock=()=>new Date().toISOString()}={}) {
    this.#client=client; this.#bindings=structuredClone(bindings); this.#blocked=blockedExternalAuth; this.#clock=clock;
  }
  #ready() { if(this.#blocked) throw new Error('BLOCKED_EXTERNAL_AUTH'); }
  #binding(setId) {
    const b=this.#bindings.find(b=>b.set.id===setId);
    if(!b || !b.externalSetId) throw new Error('psn_mapping_unconfirmed');
    return b;
  }
  #source(b,ref,observedAt) {
    return {kind:'direct_psn_api',providerId:'psn',externalReference:ref,url:null,
      freshness:{observedAt,sourceSyncedAt:null,sourceSyncAgeText:null,sourceSyncState:null,assessment:'fetch_observed'}};
  }
  #game(b) { return {setId:b.externalSetId,title:b.set.title,platform:b.set.platform}; }
  #id(mapping, externalId) {
    const id=mapping?.[externalId]; if(typeof id!=='string' || !id) throw new Error('psn_mapping_unconfirmed'); return id;
  }
  async getGameSets() {
    this.#ready();const games=await this.#client.listGames();
    return this.#bindings.filter(b=>games.items.some(g=>g.setId===b.externalSetId && g.platform===b.set.platform)).map(b=>({...b.set,mappingStatus:'explicit_binding'}));
  }
  async getTrophies(setId) {
    this.#ready();const b=this.#binding(setId),raw=await this.#client.getTrophySet(this.#game(b));
    const trophies=raw.catalog.map(t=>({id:this.#id(b.trophyIds,t.id),setId,name:t.name,
      groupId:this.#id(b.groupIds,t.groupId),grade:t.grade,hidden:t.hidden}));
    if(new Set(trophies.map(t=>t.id)).size!==trophies.length) throw new Error('duplicate_psn_binding');
    const groups=raw.groups.map(g=>({id:this.#id(b.groupIds,g.trophyGroupId),kind:g.trophyGroupId==='default'?'base':'dlc',
      total:g.definedTrophies?Object.values(g.definedTrophies).reduce((n,v)=>n+v,0):null}));
    const result={set:{...b.set,catalogVersion:raw.version,mappingStatus:'explicit_binding'},trophies,groups,complete:true,
      source:this.#source(b,b.externalSetId,this.#client.getSyncStatus().readMode==='verified_recording'?this.#client.getSyncStatus().lastSuccessAt:this.#clock())};
    this.#catalogs.set(setId,result); return structuredClone(result);
  }
  async getAccountProgress(accountId,setId) {
    this.#ready();const b=this.#binding(setId);
    if(accountId!==b.accountId || this.#client.accountKey!==b.externalAccountKey) throw new Error('account_binding_mismatch');
    const catalog=this.#catalogs.get(setId) ?? await this.getTrophies(setId);
    const raw=await this.#client.getAccountTrophies(this.#game(b));
    if(raw.version!==catalog.set.catalogVersion || raw.trophies.length!==catalog.trophies.length) throw new Error('psn_catalog_changed');
    const observations=raw.trophies.map(t=>observation({accountId,setId,trophyId:this.#id(b.trophyIds,t.id),earned:t.earned,
      earnedAt:t.earnedAt,earnedAtDisplay:null,earnedAtTimezone:t.earnedAt?'timestamp_offset':null,
      observedAt:t.observedAt,progress:t.progress,progressTarget:t.progressTarget,
      source:this.#source(b,`${b.externalSetId}:${t.id}`,t.observedAt)}));
    if(new Set(observations.map(t=>t.trophyId)).size!==observations.length) throw new Error('duplicate_psn_binding');
    if(observations.some(o=>!catalog.trophies.some(t=>t.id===o.trophyId))) throw new Error('psn_catalog_mismatch');
    const groups=catalog.groups.map(g=>({id:g.id,kind:g.kind,
      total:catalog.trophies.filter(t=>t.groupId===g.id).length,
      earned:observations.filter(o=>o.earned && catalog.trophies.find(t=>t.id===o.trophyId)?.groupId===g.id).length}));
    this.#lastValidatedAt=raw.observedAt;
    return {accountId,setId,identityStatus:'authenticated_account',observations,
      summary:{total:observations.length,earned:observations.filter(t=>t.earned).length,groups},
      complete:true,source:this.#source(b,b.externalSetId,raw.observedAt)};
  }
  getSyncStatus() {
    if(this.#blocked) return {providerId:'psn',state:'blocked_external_auth',automatic:false,lastSuccessfulFetchAt:null,
      sourceSyncedAt:null,sourceSyncAgeText:null,error:'BLOCKED_EXTERNAL_AUTH'};
    const s=this.#client.getSyncStatus();
    return {providerId:'psn',state:s.state==='degraded'?'degraded':this.#lastValidatedAt?'ready':s.state,automatic:s.automatic??true,lastSuccessfulFetchAt:this.#lastValidatedAt??s.lastSuccessAt,readMode:s.readMode??'live',
      sourceSyncedAt:null,sourceSyncAgeText:null,error:s.error};
  }
}
