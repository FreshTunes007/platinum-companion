import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync,unlinkSync,readFileSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {libraryId} from './library-store.mjs';
import {trophyGroupKind} from './group-classification.mjs';

export const MOBILE_SNAPSHOT_MAX_BYTES=10*1024*1024;
export const ANDROID_TEST_TITLES=Object.freeze(['Hades II','Mortal Shell II','Graveyard Keeper 2','Resident Evil Requiem']);
export const WITCHER_PS5_SET='NPWR24698_00';
const grades=['bronze','silver','gold','platinum'];
const platforms=['PS5','PS4','PS3','PSVITA'];
const invalid=()=>{throw new Error('invalid_mobile_snapshot');};
const fail=code=>{throw new Error(code);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const exact=(o,keys)=>{if(!plain(o)||Object.keys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))invalid();};
const string=(s,max=1024)=>typeof s==='string'&&s.length>0&&s.length<=max;
const utc=s=>{if(typeof s!=='string')return false;const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(s);return !!m&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===`${m[1]}.${(m[2]??'').padEnd(3,'0')}Z`;};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const unique=xs=>new Set(xs).size===xs.length;
export const mobileGameId=(setId,platform)=>`psn:${setId}:${platform}`;
export function mobileSummary(trophies){return {earned:trophies.filter(t=>t.earned===true).length,total:trophies.length,unknown:trophies.filter(t=>t.earned===null).length,platinumEarned:trophies.filter(t=>t.grade==='platinum'&&t.earned===true).length,platinumTotal:trophies.filter(t=>t.grade==='platinum').length};}

/** A strict allowlist. Unknown metadata is rejected rather than silently imported. */
export function validateMobileSnapshot(snapshot){
  exact(snapshot,['schemaVersion','kind','exportedAt','games']);
  if(![1,2].includes(snapshot.schemaVersion)||snapshot.kind!=='platinum_companion_snapshot'||!utc(snapshot.exportedAt)||!Array.isArray(snapshot.games)||snapshot.games.length<1||snapshot.games.length>100||!unique(snapshot.games.map(g=>g?.id)))invalid();
  for(const g of snapshot.games){
    exact(g,['id','title','platform','source','observedAt','sony','coverUrl','groups','trophies','summary']);
    exact(g.sony,['npCommunicationId','service']);
    if(!string(g.title,500)||!platforms.includes(g.platform)||!['direct_psn_api','imported'].includes(g.source)||!utc(g.observedAt)||Date.parse(g.observedAt)>Date.parse(snapshot.exportedAt)||!/^NPWR\d{5,8}_\d{2}$/.test(g.sony.npCommunicationId)||g.sony.service!==(g.platform==='PS5'?'trophy2':'trophy')||g.id!==mobileGameId(g.sony.npCommunicationId,g.platform)||g.coverUrl!==null)invalid();
    if(!Array.isArray(g.groups)||!g.groups.length||g.groups.length>1000||!unique(g.groups.map(x=>x?.id))||!Array.isArray(g.trophies)||!g.trophies.length||g.trophies.length>10000||!unique(g.trophies.map(x=>x?.id)))invalid();
    for(const group of g.groups){exact(group,['id','name','kind']);if(!string(group.id,128)||!group.id.startsWith(`${g.id}:group:`)||!(group.name===null||string(group.name,500))||!['base','dlc','additional'].includes(group.kind))invalid();}
    const knownSonyIds=[];
    for(const t of g.trophies){
      exact(t,['id','sonyTrophyId','groupId','name','description','grade','hidden','earned','earnedAt',...(snapshot.schemaVersion===2&&Object.hasOwn(t,'official')?['official']:[])]);
      if(t.official){
        const o=t.official;exact(o,['iconUrl','originalLocale','localizations']);
        if(o.originalLocale!=='en-US'||!plain(o.localizations)||!o.localizations['en-US']||Object.keys(o.localizations).some(k=>!['en-US','ru-RU'].includes(k))||!(o.iconUrl===null||typeof o.iconUrl==='string'&&o.iconUrl.length<2048&&/^https:\/\//.test(o.iconUrl)))invalid();
        for(const v of Object.values(o.localizations)){exact(v,['name','description','source','observedAt']);if(!(v.name===null||string(v.name,1000))||!(v.description===null||string(v.description,10000))||v.source!=='sony_catalog'||!utc(v.observedAt)||Date.parse(v.observedAt)>Date.parse(snapshot.exportedAt))invalid();}
        if(o.localizations['en-US'].name!==t.name||o.localizations['en-US'].description!==t.description)invalid();
      }
      if(!string(t.id,128)||!t.id.startsWith(`${g.id}:trophy:`)||!g.groups.some(x=>x.id===t.groupId)||!string(t.name,1000)||!(t.description===null||typeof t.description==='string'&&t.description.length<=10000)||!grades.includes(t.grade)||typeof t.hidden!=='boolean'||!(t.earned===null||typeof t.earned==='boolean')||!(t.sonyTrophyId===null||integer(t.sonyTrophyId)&&t.sonyTrophyId<=999999)||!(t.earnedAt===null||utc(t.earnedAt))||t.earned!==true&&t.earnedAt!==null||t.earnedAt&&Date.parse(t.earnedAt)>Date.parse(g.observedAt))invalid();
      if(t.sonyTrophyId!==null){if(t.id!==`${g.id}:trophy:${t.sonyTrophyId}`)invalid();knownSonyIds.push(t.sonyTrophyId);}
    }
    if(!unique(knownSonyIds)||g.groups.some(group=>!g.trophies.some(t=>t.groupId===group.id)))invalid();
    exact(g.summary,['earned','total','unknown','platinumEarned','platinumTotal']);
    const calculated=mobileSummary(g.trophies);
    if(Object.entries(calculated).some(([k,v])=>!integer(g.summary[k])||g.summary[k]!==v))invalid();
  }
  if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>MOBILE_SNAPSHOT_MAX_BYTES)invalid();
  return snapshot;
}

/** Old catalogue hashes are mapped only when the exact normalizer hash matches. */
function recoverNumericTrophyIds(gameId,trophies){
  const remaining=new Set(trophies.map(t=>t.id)),matches=new Map();
  for(let candidate=0;candidate<10000&&remaining.size;candidate++){
    const oldId=libraryId(gameId,'trophy',String(candidate));
    if(remaining.delete(oldId))matches.set(oldId,candidate);
  }
  return matches;
}
function portableGame({id:oldGameId,title,platform,external_set_id:setId,service},snapshot,groups,rows,explicitTrophyIds=null,explicitGroupIds=null,neutralGroups=false){
  const knownIds=rows.every(t=>Number.isInteger(t.sonyTrophyId)&&libraryId(oldGameId,'trophy',String(t.sonyTrophyId))===t.id)?new Map(rows.map(t=>[t.id,t.sonyTrophyId])):null;
  const id=mobileGameId(setId,platform),numeric=explicitTrophyIds??knownIds??recoverNumericTrophyIds(oldGameId,rows);
  const groupMap=new Map(),safeGroups=[];
  for(const group of groups){
    let publicId=explicitGroupIds?.get(group.id)??group.sonyGroupId??null;
    if(publicId===null){
      if(libraryId(oldGameId,'group','default')===group.id)publicId='default';
      else for(let n=0;n<1000;n++){const candidate=String(n).padStart(3,'0');if(libraryId(oldGameId,'group',candidate)===group.id){publicId=candidate;break;}}
    }
    const portableId=`${id}:group:${publicId??`unmapped-${hash([group.name??null,group.kind,rows.filter(t=>t.groupId===group.id).map(t=>[numeric.get(t.id)??null,t.name,t.grade]).sort()])}`}`;
    const kind=neutralGroups?trophyGroupKind(setId,publicId):group.kind==='additional'?'dlc':group.kind;
    groupMap.set(group.id,portableId);safeGroups.push({id:portableId,name:group.name??null,kind});
  }
  const trophies=rows.map(t=>{
    const sonyTrophyId=numeric.get(t.id)??null;
    const groupId=groupMap.get(t.groupId);
    return {id:`${id}:trophy:${sonyTrophyId??`unmapped-${hash([groupId,t.name,t.description??null,t.grade,t.hidden===true])}`}`,sonyTrophyId,groupId,name:t.name,description:t.description??null,grade:t.grade,hidden:t.hidden===true,earned:t.earned,earnedAt:t.earned===true?t.earnedAt??null:null,...(t.official?{official:t.official}:{})};
  }).sort((a,b)=>(a.sonyTrophyId??Number.MAX_SAFE_INTEGER)-(b.sonyTrophyId??Number.MAX_SAFE_INTEGER)||a.id.localeCompare(b.id));
  safeGroups.sort((a,b)=>(a.kind==='base'?0:1)-(b.kind==='base'?0:1)||a.id.localeCompare(b.id));
  return {id,title,platform,source:snapshot.source,observedAt:snapshot.observed_at,sony:{npCommunicationId:setId,service},coverUrl:null,groups:safeGroups,trophies,summary:mobileSummary(trophies)};
}

/** Cloud and Android use the same allowlisted portable schema as file import. */
export function snapshotFromStore(store,gameIds,exportedAt=new Date().toISOString(),{neutralGroups=false}={}){
  const games=gameIds.map(id=>{
    const game=store.rawGame(id),s=store.latest(id);
    if(!game||!s)fail('android_snapshot_missing');
    const groups=store.db.prepare('SELECT payload_json FROM trophy_groups WHERE snapshot_id=? ORDER BY id').all(s.id).map(r=>JSON.parse(r.payload_json));
    const rows=store.db.prepare('SELECT payload_json FROM trophy_rows WHERE snapshot_id=? ORDER BY id').all(s.id).map(r=>JSON.parse(r.payload_json));
    return portableGame(game,s,groups,rows,null,null,neutralGroups);
  });
  return validateMobileSnapshot({schemaVersion:2,kind:'platinum_companion_snapshot',exportedAt,games});
}

/** Reads only the legacy confirmed account snapshot; never infers anything from Run state. */
export function legacyWitcherGame(state,binding){
  const account=state?.account,snapshot=account?.lastConfirmedSnapshot,catalog=account?.catalog;
  if(binding?.externalSetId!==WITCHER_PS5_SET||binding.set?.platform!=='PS5'||!catalog?.complete||!snapshot?.complete||snapshot.source?.kind!=='direct_psn_api'||snapshot.source.externalReference!==WITCHER_PS5_SET||snapshot.accountId!==account.accountId||snapshot.setId!==account.setId||binding.accountId!==account.accountId||binding.set.id!==account.setId)fail('legacy_snapshot_binding_mismatch');
  const trophyMap=new Map(Object.entries(binding.trophyIds??{}).map(([k,v])=>[v,/^(0|[1-9]\d*)$/.test(k)?Number(k):null]));
  const groupMap=new Map(Object.entries(binding.groupIds??{}).map(([k,v])=>[v,k]));
  const obs=snapshot.observations;
  if(!Array.isArray(obs)||obs.length!==catalog.trophies.length||!unique(obs.map(o=>o.trophyId)))fail('legacy_snapshot_incomplete');
  const rows=catalog.trophies.map(t=>{
    const o=obs.find(x=>x.trophyId===t.id),sonyId=trophyMap.get(t.id);
    if(!o||typeof o.earned!=='boolean'||!integer(sonyId)||o.source?.kind!=='direct_psn_api'||o.source.externalReference!==`${WITCHER_PS5_SET}:${sonyId}`||o.accountId!==account.accountId||o.setId!==account.setId||o.observedAt!==snapshot.source.freshness.observedAt)fail('legacy_snapshot_observation_mismatch');
    return {...t,earned:o.earned,earnedAt:o.earnedAt};
  });
  const game=portableGame({id:catalog.set.id,title:catalog.set.title??binding.set.title,platform:'PS5',external_set_id:WITCHER_PS5_SET,service:'trophy2'},{source:'direct_psn_api',observed_at:snapshot.source.freshness.observedAt},catalog.groups,rows,trophyMap,groupMap);
  if(game.summary.total!==snapshot.summary.total||game.summary.earned!==snapshot.summary.earned)fail('legacy_snapshot_summary_mismatch');
  return game;
}

/** No LibraryStore construction, schema mutation, provider/auth module or network request. */
export function exportAndroidSnapshot({databasePath,exportedAt=new Date().toISOString(),legacyState=null,legacyBinding=null}){
  const db=new DatabaseSync(databasePath,{readOnly:true});
  try{
    db.exec('BEGIN');
    const selectionRow=db.prepare("SELECT value FROM library_meta WHERE key='syncSelection'").get();
    const selection=selectionRow?JSON.parse(selectionRow.value):null;
    if(!selection||!Array.isArray(selection.gameIds)||selection.gameIds.length!==4||!unique(selection.gameIds))fail('android_selection_mismatch');
    const selected=selection.gameIds.map(id=>db.prepare('SELECT g.*,b.external_set_id,b.service FROM games g JOIN provider_bindings b ON g.id=b.game_id WHERE g.id=?').get(id));
    if(selected.some(g=>!g||g.platform!=='PS5')||!unique(selected.map(g=>g.title))||ANDROID_TEST_TITLES.some(title=>!selected.some(g=>g.title===title)))fail('android_selection_mismatch');
    const witcher=db.prepare('SELECT g.*,b.external_set_id,b.service FROM games g JOIN provider_bindings b ON g.id=b.game_id WHERE b.external_set_id=? AND g.platform=?').all(WITCHER_PS5_SET,'PS5');
    if(witcher.length>1)fail('android_selection_mismatch');
    const games=[];
    const readGame=g=>{
      const s=db.prepare("SELECT * FROM snapshots WHERE game_id=? ORDER BY CASE source WHEN 'direct_psn_api' THEN 0 ELSE 1 END,observed_at DESC,id DESC LIMIT 1").get(g.id);
      if(!s)return null;
      const groups=db.prepare('SELECT payload_json FROM trophy_groups WHERE snapshot_id=? ORDER BY id').all(s.id).map(r=>JSON.parse(r.payload_json));
      const rows=db.prepare('SELECT payload_json FROM trophy_rows WHERE snapshot_id=? ORDER BY id').all(s.id).map(r=>JSON.parse(r.payload_json));
      const game=portableGame(g,s,groups,rows),stored=JSON.parse(s.summary_json);
      if(game.summary.total!==stored.total||game.summary.earned!==stored.earned)fail('library_snapshot_summary_mismatch');
      return game;
    };
    for(const title of ANDROID_TEST_TITLES){const g=selected.find(g=>g.title===title),game=readGame(g);if(!game)fail('android_snapshot_missing');games.push(game);}
    let witcherGame=witcher.length?readGame(witcher[0]):null;
    if(legacyState&&legacyBinding){const legacy=legacyWitcherGame(legacyState,legacyBinding);if(!witcherGame||Date.parse(legacy.observedAt)>Date.parse(witcherGame.observedAt))witcherGame=legacy;}
    if(!witcherGame)fail('witcher_snapshot_missing');games.push(witcherGame);
    return validateMobileSnapshot({schemaVersion:2,kind:'platinum_companion_snapshot',exportedAt,games});
  }finally{try{db.exec('ROLLBACK');}finally{db.close();}}
}

export function writeMobileSnapshotAtomic(snapshot,outputPath){
  validateMobileSnapshot(snapshot);
  const target=resolve(outputPath),temp=`${target}.${randomUUID()}.tmp`;
  const serialized=`${JSON.stringify(snapshot,null,2)}\n`;if(Buffer.byteLength(serialized,'utf8')>MOBILE_SNAPSHOT_MAX_BYTES)invalid();
  mkdirSync(dirname(target),{recursive:true});
  try{writeFileSync(temp,serialized,{encoding:'utf8',flag:'wx',mode:0o600});renameSync(temp,target);}finally{try{unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return target;
}
export function assertPrivateExportPath(projectRoot,outputPath){
  const base=resolve(projectRoot,'private','android-export'),target=resolve(outputPath),rel=relative(base,target);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||!target.endsWith('.json'))fail('export_requires_private_android_directory');
  return target;
}
export function readJsonFile(path){return JSON.parse(readFileSync(path,'utf8'));}
