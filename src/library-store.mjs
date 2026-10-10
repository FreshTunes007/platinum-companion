import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {trophyGroupKind} from './group-classification.mjs';
export const libraryId=(...parts)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,24);
const bad=()=>{throw new Error('invalid_library_snapshot');};
export function normalizeLibrarySnapshot(raw,gameId){
  if(raw.dataKind!=='live_psn'||raw.account.setId!==raw.set.setId||raw.set.version!==raw.account.version||!Number.isFinite(Date.parse(raw.account.observedAt)))bad();
  const rows=raw.set.catalog,earned=raw.account.trophies,groups=raw.set.groups;
  if(!rows.length||rows.length!==earned.length||new Set(rows.map(t=>t.id)).size!==rows.length||new Set(earned.map(t=>t.id)).size!==earned.length||new Set(groups.map(g=>g.trophyGroupId)).size!==groups.length)bad();
  const trophies=rows.map(t=>{
    const p=earned.find(x=>x.id===t.id);
    if(!p||typeof p.earned!=='boolean'||!groups.some(g=>g.trophyGroupId===t.groupId)||!['bronze','silver','gold','platinum'].includes(t.grade)||p.earnedAt&&!Number.isFinite(Date.parse(p.earnedAt)))bad();
    return {id:libraryId(gameId,'trophy',t.id),groupId:libraryId(gameId,'group',t.groupId),name:t.name,description:t.description??null,grade:t.grade,hidden:t.hidden===true,
      earned:p.earned,earnedAt:p.earned?p.earnedAt:null,sonyTrophyId:Number(t.id),iconUrl:t.iconUrl??null,progress:p.progress??null,progressTarget:p.progressTarget??null,...(t.official?{official:t.official}:{})};
  });
  const normalizedGroups=groups.map(g=>{
    const id=libraryId(gameId,'group',g.trophyGroupId),items=trophies.filter(t=>t.groupId===id);
    if(g.definedTrophies&&Object.values(g.definedTrophies).reduce((a,b)=>a+b,0)!==items.length)bad();
    return {id,sonyGroupId:g.trophyGroupId,iconUrl:g.trophyGroupIconUrl??null,name:g.trophyGroupName??null,kind:trophyGroupKind(raw.set.setId,g.trophyGroupId),total:items.length,earned:items.filter(t=>t.earned).length};
  });
  const platinums=trophies.filter(t=>t.grade==='platinum');
  return {gameId,source:'direct_psn_api',observedAt:raw.account.observedAt,catalogVersion:raw.set.version??null,complete:true,groups:normalizedGroups,trophies,
    summary:{total:trophies.length,earned:trophies.filter(t=>t.earned).length,groups:normalizedGroups,platinum:{total:platinums.length,earned:platinums.filter(t=>t.earned).length,hasPlatinum:platinums.length>0}},
    providerMetadata:{setId:raw.set.setId,platform:raw.set.platform},evidence:{readMode:'live',catalogPages:raw.set.pages,accountPages:raw.account.pages}};
}

export class LibraryStore{
  constructor(path){mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS library_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY,title TEXT NOT NULL,platform TEXT NOT NULL,listed_at TEXT NOT NULL,present INTEGER NOT NULL DEFAULT 1,last_attempt_at TEXT,last_error TEXT);
    CREATE TABLE IF NOT EXISTS provider_bindings(game_id TEXT PRIMARY KEY REFERENCES games(id),account_key TEXT NOT NULL,external_set_id TEXT NOT NULL,service TEXT NOT NULL,UNIQUE(account_key,external_set_id,service));
    CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,game_id TEXT NOT NULL REFERENCES games(id),source TEXT NOT NULL CHECK(source IN ('direct_psn_api','imported')),observed_at TEXT NOT NULL,fingerprint TEXT NOT NULL,summary_json TEXT NOT NULL,metadata_json TEXT NOT NULL,UNIQUE(game_id,source,observed_at,fingerprint));
    CREATE TABLE IF NOT EXISTS trophy_rows(snapshot_id TEXT NOT NULL REFERENCES snapshots(id),id TEXT NOT NULL,group_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(snapshot_id,id));
    CREATE TABLE IF NOT EXISTS trophy_groups(snapshot_id TEXT NOT NULL REFERENCES snapshots(id),id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(snapshot_id,id));
    CREATE INDEX IF NOT EXISTS latest_snapshot ON snapshots(game_id,source,observed_at DESC);
    CREATE TABLE IF NOT EXISTS inventory_details(game_id TEXT PRIMARY KEY REFERENCES games(id),payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS active_games(game_id TEXT PRIMARY KEY REFERENCES games(id),active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS initial_import(game_id TEXT PRIMARY KEY REFERENCES games(id),status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,completed_at TEXT);
    CREATE TABLE IF NOT EXISTS sync_runs(id TEXT PRIMARY KEY,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,result_json TEXT);
  `);}
  close(){this.db.close();}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  meta(key){const r=this.db.prepare('SELECT value FROM library_meta WHERE key=?').get(key);return r?JSON.parse(r.value):null;}
  setMeta(key,value){this.db.prepare('INSERT INTO library_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  bump(){const n=(this.meta('revision')??0)+1;this.setMeta('revision',n);return n;}
  replaceInventory(accountKey,games,observedAt){
    const checked=games.map(g=>{const platforms=g.platform.split(',').map(x=>x.trim());const platform=platforms.includes('PS5')?'PS5':platforms.find(p=>['PS4','PS3','PSVITA'].includes(p));if(!platform||!g.setId||!g.title)throw new Error('unsupported_platform');return {...g,originalPlatform:g.platform,platform,service:platform==='PS5'?'trophy2':'trophy'};});
    return this.transaction(()=>{
      const owner=this.meta('accountKey');if(owner&&owner!==accountKey)throw new Error('account_binding_mismatch');this.setMeta('accountKey',accountKey);
      this.db.prepare('UPDATE games SET present=0').run();
      const seen=new Set();
      for(const game of checked){
        const key=`${game.setId}:${game.service}`;if(seen.has(key))throw new Error('duplicate_library_binding');seen.add(key);
        const id=libraryId(accountKey,game.setId,game.service);
        this.db.prepare('INSERT INTO games(id,title,platform,listed_at,present) VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,platform=excluded.platform,listed_at=excluded.listed_at,present=1').run(id,game.title,game.platform,observedAt);
        this.db.prepare('INSERT INTO provider_bindings(game_id,account_key,external_set_id,service) VALUES(?,?,?,?) ON CONFLICT(game_id) DO NOTHING').run(id,accountKey,game.setId,game.service);
      }
      for(const game of checked){const id=libraryId(accountKey,game.setId,game.service);this.db.prepare('INSERT INTO inventory_details VALUES(?,?) ON CONFLICT(game_id) DO UPDATE SET payload_json=excluded.payload_json').run(id,JSON.stringify({platforms:game.originalPlatform,iconUrl:game.iconUrl??null,definedTrophies:game.definedTrophies??null,earnedTrophies:game.earnedTrophies??null,lastUpdatedDateTime:game.lastUpdatedDateTime??null}));}
      this.setMeta('inventoryLastSuccessAt',observedAt);this.bump();return checked.length;
    });
  }
  rawGame(id){return this.db.prepare('SELECT g.*,b.external_set_id,b.service FROM games g JOIN provider_bindings b ON b.game_id=g.id WHERE g.id=?').get(id);}
  commit(snapshot){
    snapshot=structuredClone(snapshot);
    const previous=this.latest(snapshot.gameId);
    if(previous&&Date.parse(snapshot.observedAt)>=Date.parse(previous.observed_at)){
      const oldRows=this.db.prepare('SELECT payload_json FROM trophy_rows WHERE snapshot_id=?').all(previous.id).map(r=>JSON.parse(r.payload_json));
      if(oldRows.some(old=>!snapshot.trophies.some(t=>t.id===old.id)))bad();
      for(const t of snapshot.trophies){
        const old=oldRows.find(o=>o.id===t.id);if(!old)continue;
        if(old.earned===true&&t.earned!==true)throw new Error('trophy_reconciliation_required');
        if(old.earnedAt&&t.earnedAt&&old.earnedAt!==t.earnedAt)throw new Error('trophy_reconciliation_required');
        if(t.earned&&!t.earnedAt)t.earnedAt=old.earnedAt??null;
        if(!t.description?.trim()&&old.description?.trim())t.description=old.description;
        if(!t.official&&old.official&&old.name===t.name&&old.description===t.description)t.official=old.official;
        if(t.official&&old.official){
          for(const [locale,previous] of Object.entries(old.official.localizations)){
            const next=t.official.localizations[locale];
            if(!next||previous.name&&!next.name||previous.description&&!next.description){
              // Keep the whole previously observed text and its actual timestamp.
              // Do not attach today's timestamp to yesterday's recovered field.
              if(locale==='en-US'&&(previous.name!==t.name||previous.description!==t.description))throw new Error('catalog_localization_mismatch');
              t.official.localizations[locale]=previous;
            }
          }
        }
      }
      const oldGroups=this.db.prepare('SELECT payload_json FROM trophy_groups WHERE snapshot_id=?').all(previous.id).map(r=>JSON.parse(r.payload_json));
      for(const group of snapshot.groups){if(!group.name?.trim())group.name=oldGroups.find(g=>g.id===group.id)?.name??null;}
    }
    if(!snapshot.complete||!['direct_psn_api','imported'].includes(snapshot.source)||!this.rawGame(snapshot.gameId))bad();
    if(Object.keys(snapshot).some(k=>!['gameId','source','observedAt','catalogVersion','complete','groups','trophies','summary','providerMetadata','evidence'].includes(k)))bad();
    if(!Number.isFinite(Date.parse(snapshot.observedAt))||!Array.isArray(snapshot.trophies)||!snapshot.trophies.length||!Array.isArray(snapshot.groups)||new Set(snapshot.trophies.map(t=>t.id)).size!==snapshot.trophies.length||new Set(snapshot.groups.map(g=>g.id)).size!==snapshot.groups.length)bad();
    if(snapshot.trophies.some(t=>!snapshot.groups.some(g=>g.id===t.groupId)||snapshot.source==='direct_psn_api'&&typeof t.earned!=='boolean'||t.earnedAt&&!Number.isFinite(Date.parse(t.earnedAt))))bad();
    if(snapshot.summary.total!==snapshot.trophies.length||snapshot.summary.earned!==snapshot.trophies.filter(t=>t.earned===true).length||snapshot.groups.some(g=>g.total!==snapshot.trophies.filter(t=>t.groupId===g.id).length||g.earned!==snapshot.trophies.filter(t=>t.groupId===g.id&&t.earned===true).length))bad();
    const fingerprint=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT id FROM snapshots WHERE game_id=? AND source=? AND observed_at=? AND fingerprint=?').get(snapshot.gameId,snapshot.source,snapshot.observedAt,fingerprint);
      if(old)return {changed:false,snapshotId:old.id};
      const id=randomUUID();
      const {trophies,groups,summary,...metadata}=snapshot;
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(id,snapshot.gameId,snapshot.source,snapshot.observedAt,fingerprint,JSON.stringify(summary),JSON.stringify(metadata));
      for(const t of trophies)this.db.prepare('INSERT INTO trophy_rows VALUES(?,?,?,?)').run(id,t.id,t.groupId,JSON.stringify(t));
      for(const g of groups)this.db.prepare('INSERT INTO trophy_groups VALUES(?,?,?)').run(id,g.id,JSON.stringify(g));
      if(snapshot.source==='direct_psn_api')this.db.prepare('UPDATE games SET last_error=NULL WHERE id=?').run(snapshot.gameId);
      this.bump();return {changed:true,snapshotId:id};
    });
  }
  latest(gameId){return this.db.prepare("SELECT * FROM snapshots WHERE game_id=? ORDER BY CASE source WHEN 'direct_psn_api' THEN 0 ELSE 1 END,observed_at DESC,id DESC LIMIT 1").get(gameId);}
  status(gameId){
    const g=this.rawGame(gameId);if(!g)throw new Error('game_not_found');const s=this.latest(gameId);
    const summary=s?JSON.parse(s.summary_json):null;
    if(summary)summary.groups=summary.groups.map(group=>({...group,kind:trophyGroupKind(g.external_set_id,group.sonyGroupId??['default','001','002'].find(id=>libraryId(gameId,'group',id)===group.id))}));
    return {gameId:g.id,title:g.title,platform:g.platform,active:this.db.prepare('SELECT active FROM active_games WHERE game_id=?').get(g.id)?.active===1,providerMetadata:{setId:g.external_set_id,service:g.service},presentInLatestLibrary:!!g.present,libraryRevision:this.meta('revision')??0,
      source:s?.source??null,lastSuccessfulSyncAt:s?.source==='direct_psn_api'?s.observed_at:null,lastObservationAt:s?.observed_at??null,
      readMode:'persisted_snapshot',freshFetchPerformed:false,summary,lastAttemptAt:g.last_attempt_at,lastError:g.last_error,inventoryLastSuccessfulSyncAt:this.meta('inventoryLastSuccessAt')};
  }
  list({query='',platform=null,offset=0,limit=50,includeAll=false}={}){
    const selection=this.meta('syncSelection');
    const games=this.db.prepare('SELECT id,title,platform FROM games WHERE present=1 ORDER BY title,id').all().filter(g=>(includeAll||this.meta('fullLibraryVisible')||!selection||selection.gameIds.includes(g.id))&&(!platform||g.platform===platform)&&g.title.toLowerCase().includes(query.toLowerCase()));
    return {source:'direct_psn_api',readMode:'persisted_inventory',freshFetchPerformed:false,lastSuccessfulSyncAt:this.meta('inventoryLastSuccessAt'),activeSelection:selection??null,total:games.length,offset,limit,nextOffset:offset+limit<games.length?offset+limit:null,games:games.slice(offset,offset+limit).map(g=>this.status(g.id))};
  }
  trophies(gameId,{earned=null,groupId=null,offset=0,limit=50}={}){
    const status=this.status(gameId),s=this.latest(gameId);
    const all=s?this.db.prepare('SELECT payload_json FROM trophy_rows WHERE snapshot_id=? ORDER BY id').all(s.id).map(r=>JSON.parse(r.payload_json)):[];
    const rows=all.filter(t=>(earned===null||t.earned===earned)&&(!groupId||t.groupId===groupId));
    return {gameId,source:status.source,lastSuccessfulSyncAt:status.lastSuccessfulSyncAt,readMode:'persisted_snapshot',freshFetchPerformed:false,total:rows.length,offset,limit,nextOffset:offset+limit<rows.length?offset+limit:null,trophies:rows.slice(offset,offset+limit)};
  }
  attempt(id,at){this.db.prepare('UPDATE games SET last_attempt_at=? WHERE id=?').run(at,id);}
  failure(id,code){this.db.prepare('UPDATE games SET last_error=? WHERE id=?').run(code,id);}
  touchRun(runId,now){this.setMeta('syncHeartbeat',{runId,observedAt:now});}
  beginRun(now,leaseMs=300000){return this.transaction(()=>{
    const running=this.db.prepare("SELECT * FROM sync_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").get();
    const heartbeat=this.meta('syncHeartbeat');const leaseAt=heartbeat&&running&&heartbeat.runId===running.id?heartbeat.observedAt:running?.started_at;
    if(running&&Date.parse(now)-Date.parse(leaseAt)<leaseMs)throw new Error('library_sync_in_progress');
    if(running)this.db.prepare("UPDATE sync_runs SET status='interrupted',finished_at=? WHERE id=?").run(now,running.id);
    const next=this.meta('nextAllowedAt');if(next&&Date.parse(now)<Date.parse(next))throw new Error('library_sync_cooldown');
    const id=randomUUID();this.db.prepare("INSERT INTO sync_runs(id,started_at,status) VALUES(?,?,'running')").run(id,now);this.touchRun(id,now);return id;
  });}
  finishRun(id,result){this.transaction(()=>{this.db.prepare('UPDATE sync_runs SET finished_at=?,status=?,result_json=? WHERE id=?').run(result.finishedAt,result.status,JSON.stringify(result),id);this.setMeta('lastRun',result);this.setMeta('nextAllowedAt',result.nextAllowedAt??new Date(Date.parse(result.finishedAt)+60000).toISOString());});}
}
