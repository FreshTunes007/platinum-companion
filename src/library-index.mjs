import {artworkForGame} from './artwork.mjs';
import {mobileGameId} from './mobile-snapshot.mjs';
export function seedActiveGames(store){
  if(store.meta('activeGamesInitialized'))return;
  for(const id of store.meta('syncSelection')?.gameIds??[])store.db.prepare('INSERT OR IGNORE INTO active_games VALUES(?,1)').run(id);
  store.setMeta('activeGamesInitialized',true);
}
export function setActiveGame(store,id,active){
  if(!store.rawGame(id))throw Error('game_not_found');
  store.db.prepare('INSERT INTO active_games VALUES(?,?) ON CONFLICT(game_id) DO UPDATE SET active=excluded.active').run(id,active?1:0);store.bump();
}
export function libraryIndex(store,{query='',platform=null,activeOnly=false,offset=0,limit=40,sort='title'}={}){
  const rows=store.db.prepare(`SELECT g.*,b.external_set_id,b.service,a.active,i.payload_json AS inventory,
   s.source,s.observed_at,s.summary_json FROM games g JOIN provider_bindings b ON b.game_id=g.id
   LEFT JOIN active_games a ON a.game_id=g.id LEFT JOIN inventory_details i ON i.game_id=g.id
   LEFT JOIN snapshots s ON s.id=(SELECT id FROM snapshots WHERE game_id=g.id ORDER BY CASE source WHEN 'direct_psn_api' THEN 0 ELSE 1 END,observed_at DESC,id DESC LIMIT 1)
   WHERE g.present=1`).all();
  const all=rows.map(g=>{
    const inv=g.inventory?JSON.parse(g.inventory):{},s=g.summary_json?JSON.parse(g.summary_json):null;
    const total=s?.total??Object.values(inv.definedTrophies??{}).reduce((a,b)=>a+b,0),earned=s?.earned??Object.values(inv.earnedTrophies??{}).reduce((a,b)=>a+b,0);
    return {gameId:g.id,id:mobileGameId(g.external_set_id,g.platform),title:g.title,platform:g.platform,sony:{npCommunicationId:g.external_set_id,service:g.service},active:g.active===1,source:g.source??'sony_inventory',observedAt:g.observed_at??null,iconUrl:inv.iconUrl??null,artwork:artworkForGame(store,g.id,inv),catalogComplete:!!s,summary:{total,earned,unknown:s?0:total-earned,platinumTotal:s?.platinum.total??inv.definedTrophies?.platinum??0,platinumEarned:s?.platinum.earned??inv.earnedTrophies?.platinum??0},lastError:g.last_error};
  });
  const matched=all.filter(g=>(!platform||g.platform===platform)&&(!activeOnly||g.active)&&g.title.toLowerCase().includes(query.toLowerCase()));
  matched.sort((a,b)=>sort==='progress'?(b.summary.earned/Math.max(1,b.summary.total))-(a.summary.earned/Math.max(1,a.summary.total))||a.title.localeCompare(b.title):sort==='remaining'?(a.summary.total-a.summary.earned)-(b.summary.total-b.summary.earned)||a.title.localeCompare(b.title):sort==='observed'?String(b.observedAt??'').localeCompare(String(a.observedAt??''))||a.title.localeCompare(b.title):a.title.localeCompare(b.title)||a.gameId.localeCompare(b.gameId));
  return {source:'direct_psn_api',readMode:'persisted_index',freshFetchPerformed:false,revision:store.meta('revision'),lastInventorySyncAt:store.meta('inventoryLastSuccessAt'),total:matched.length,offset,limit,nextOffset:offset+limit<matched.length?offset+limit:null,games:matched.slice(offset,offset+limit),totals:{sets:all.length,uniqueTitles:new Set(all.map(g=>g.title.normalize('NFKC').toLowerCase())).size,complete:all.filter(g=>g.catalogComplete).length,earned:all.reduce((n,g)=>n+g.summary.earned,0),trophies:all.reduce((n,g)=>n+g.summary.total,0),platinums:all.reduce((n,g)=>n+g.summary.platinumEarned,0)},initialImport:store.meta('initialImport')};
}
