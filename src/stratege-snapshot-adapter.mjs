import { randomUUID } from 'node:crypto';
import { observation } from './observations.mjs';

const validDate = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const requireValue = (condition, code) => { if (!condition) throw new Error(code); };
export function validateSnapshot(s) {
  requireValue(s?.schemaVersion === 1 && s.dataKind === 'observed_stratege_snapshot','unsupported_snapshot');
  requireValue(typeof s.account?.psnOnlineId === 'string' && s.account.psnOnlineId.length > 0,'missing_account_identity');
  requireValue(validDate(s.source?.observedAt),'missing_snapshot_time');
  requireValue(typeof s.source.url === 'string' && typeof s.source.gameUrl === 'string','missing_snapshot_source');
  requireValue(typeof s.game?.title === 'string' && typeof s.game.platform === 'string','missing_game_identity');
  for (const key of ['all','base','dlc','earned']) requireValue(Number.isInteger(s.counts?.[key]) && s.counts[key] >= 0,'invalid_counts');
  requireValue(s.counts.all === s.counts.base + s.counts.dlc && s.counts.earned <= s.counts.all,'contradictory_counts');
  requireValue(s.completeWithinPage === true && Array.isArray(s.trophies) && s.trophies.length === s.counts.all,'incomplete_snapshot');
  const ids = new Set();
  for (const t of s.trophies) {
    requireValue(typeof t.id === 'string' && !ids.has(t.id),'duplicate_or_missing_trophy_id'); ids.add(t.id);
    requireValue(typeof t.earned === 'boolean' && typeof t.name === 'string' && t.name.length > 0,'invalid_trophy_row');
    requireValue(t.observedAt === s.source.observedAt,'mixed_snapshot_times');
    requireValue(t.earnedAt === null && t.earnedAtTimezone === null,'unexpected_timestamp_fidelity');
    requireValue(t.earnedAtDisplay === null || typeof t.earnedAtDisplay === 'string','invalid_display_time');
    requireValue(t.earned || t.earnedAtDisplay === null,'unearned_has_earned_time');
    requireValue(typeof t.sourceUrl === 'string','missing_trophy_evidence');
  }
  requireValue(s.trophies.filter(t=>t.earned).length === s.counts.earned,'earned_count_mismatch');
}

// Binding metadata remains inside the adapter. Domain IDs are allocated once.
export function createBinding(s, {gameKey, edition, confirmedGroups}) {
  validateSnapshot(s);
  requireValue(typeof gameKey === 'string' && gameKey.length > 0,'missing_game_key');
  requireValue(confirmedGroups?.baseEarned + confirmedGroups?.dlcEarned === s.counts.earned,'missing_confirmed_group_counts');
  return {schemaVersion:1,adapter:'stratege_session_snapshot',
    expected:{onlineId:s.account.psnOnlineId,title:s.game.title,platform:s.game.platform,gameUrl:s.source.gameUrl},
    accountId:randomUUID(),set:{id:randomUUID(),gameKey,title:s.game.title,platform:s.game.platform,edition,
      gamePatch:null,catalogVersion:null,mappingStatus:'external_set_unconfirmed'},
    trophyIds:Object.fromEntries(s.trophies.map(t=>[t.id,randomUUID()])),
    groups:{baseId:randomUUID(),dlcId:randomUUID()},
    groupEvidence:{baseEarned:confirmedGroups.baseEarned,dlcEarned:confirmedGroups.dlcEarned,
      observedAt:s.source.observedAt,basis:'user_confirmed_source_page_aggregates'},directPsnBinding:null};
}

export class StrategeSnapshotAdapter {
  #snapshot; #binding;
  constructor(snapshot, binding) {
    validateSnapshot(snapshot);
    requireValue(binding?.schemaVersion === 1 && binding.adapter === 'stratege_session_snapshot','invalid_binding');
    requireValue(binding.expected.onlineId === snapshot.account.psnOnlineId && binding.expected.title === snapshot.game.title && binding.expected.platform === snapshot.game.platform && binding.expected.gameUrl === snapshot.source.gameUrl,'snapshot_binding_mismatch');
    requireValue(binding.groupEvidence.observedAt === snapshot.source.observedAt,'group_evidence_needs_review');
    requireValue(Number.isInteger(binding.groupEvidence.baseEarned) && binding.groupEvidence.baseEarned >= 0 && binding.groupEvidence.baseEarned <= snapshot.counts.base && Number.isInteger(binding.groupEvidence.dlcEarned) && binding.groupEvidence.dlcEarned >= 0 && binding.groupEvidence.dlcEarned <= snapshot.counts.dlc && binding.groupEvidence.baseEarned + binding.groupEvidence.dlcEarned === snapshot.counts.earned,'invalid_group_evidence');
    const internalIds = snapshot.trophies.map(t=>binding.trophyIds[t.id]);
    requireValue(internalIds.every(id=>typeof id === 'string' && id.length > 0) && new Set(internalIds).size === snapshot.counts.all,'trophy_binding_incomplete');
    requireValue([binding.accountId,binding.set.id,binding.groups.baseId,binding.groups.dlcId].every(id=>typeof id === 'string' && id.length > 0),'internal_binding_missing');
    this.#snapshot = structuredClone(snapshot); this.#binding = structuredClone(binding);
  }
  #source(reference, url) {
    const s = this.#snapshot;
    return {kind:'stratege_session_snapshot',providerId:'stratege_snapshot_adapter',externalReference:reference,url,
      freshness:{observedAt:s.source.observedAt,sourceSyncedAt:s.source.lastSuccessfulSyncAt??null,
        sourceSyncAgeText:s.source.syncAgeText??null,sourceSyncState:s.source.syncStatus??null,assessment:'reported_age'}};
  }
  #checkSet(setId) { requireValue(setId === this.#binding.set.id,'unknown_set'); }
  async getGameSets() { return [structuredClone(this.#binding.set)]; }
  async getTrophies(setId) {
    this.#checkSet(setId); const s=this.#snapshot, b=this.#binding;
    return {set:structuredClone(b.set),complete:true,
      trophies:s.trophies.map(t=>({id:b.trophyIds[t.id],setId,name:t.name,groupId:null,grade:null,hidden:null})),
      groups:[{id:b.groups.baseId,kind:'base',total:s.counts.base},{id:b.groups.dlcId,kind:'dlc',total:s.counts.dlc}],
      source:this.#source(s.source.gameUrl,s.source.gameUrl)};
  }
  async getAccountProgress(accountId,setId) {
    this.#checkSet(setId); requireValue(accountId === this.#binding.accountId,'unknown_account');
    const s=this.#snapshot, b=this.#binding;
    return {accountId,setId,identityStatus:'user_supplied_profile',complete:true,
      observations:s.trophies.map(t=>observation({accountId,setId,trophyId:b.trophyIds[t.id],earned:t.earned,
        earnedAt:null,earnedAtDisplay:t.earnedAtDisplay,earnedAtTimezone:null,observedAt:s.source.observedAt,
        progress:null,progressTarget:null,source:this.#source(t.id,t.sourceUrl)})),
      summary:{total:s.counts.all,earned:s.counts.earned,groups:[
        {id:b.groups.baseId,kind:'base',total:s.counts.base,earned:b.groupEvidence.baseEarned},
        {id:b.groups.dlcId,kind:'dlc',total:s.counts.dlc,earned:b.groupEvidence.dlcEarned}]},
      source:this.#source(s.source.gameUrl,s.source.gameUrl)};
  }
  getSyncStatus() {
    const s=this.#snapshot;
    return {providerId:'stratege_snapshot_adapter',state:'snapshot_available',automatic:false,
      lastSuccessfulFetchAt:s.source.observedAt,sourceSyncedAt:s.source.lastSuccessfulSyncAt??null,
      sourceSyncAgeText:s.source.syncAgeText??null,error:null};
  }
}
