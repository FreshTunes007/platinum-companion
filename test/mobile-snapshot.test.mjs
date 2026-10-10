import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {LibraryStore,normalizeLibrarySnapshot} from '../src/library-store.mjs';
import {exportAndroidSnapshot,validateMobileSnapshot,mobileSummary,writeMobileSnapshotAtomic,assertPrivateExportPath,legacyWitcherGame,ANDROID_TEST_TITLES,WITCHER_PS5_SET} from '../src/mobile-snapshot.mjs';
const at='2026-10-08T20:00:00.000Z',exportedAt='2026-10-09T00:00:00.000Z';
function fixture(accountKey='SYNTHETIC_PRIVATE_OWNER'){
  const dir=mkdtempSync(join(tmpdir(),'pc-mobile-')),databasePath=join(dir,'library.sqlite'),store=new LibraryStore(databasePath);
  const inventory=[...ANDROID_TEST_TITLES,'The Witcher 3: Wild Hunt'].map((title,i)=>({setId:i===4?WITCHER_PS5_SET:`NPWR9999${i}_00`,platform:'PS5',title}));
  store.replaceInventory(accountKey,inventory,at);
  const games=store.list({includeAll:true}).games;
  store.setMeta('syncSelection',{gameIds:ANDROID_TEST_TITLES.map(title=>games.find(g=>g.title===title).gameId)});
  for(const g of games){
    const setId=g.providerMetadata.setId;
    const raw={dataKind:'live_psn',set:{setId,platform:'PS5',version:'1',pages:1,catalog:[['0','default','platinum'],['1','default','bronze'],['2','001','silver']].map(([id,groupId,grade])=>({id,groupId,grade,name:`Synthetic ${id}`,description:`Synthetic description ${id}`,hidden:id==='2'})),groups:[{trophyGroupId:'default',trophyGroupName:'Base'},{trophyGroupId:'001',trophyGroupName:'DLC'}]},account:{setId,version:'1',observedAt:at,pages:1,trophies:['0','1','2'].map(id=>({id,earned:id==='1',earnedAt:id==='1'?'2026-10-08T19:00:00.000Z':null}))}};
    const normalized=normalizeLibrarySnapshot(raw,g.gameId);normalized.providerMetadata.extraSecret='SYNTHETIC_SECRET_SENTINEL';store.commit(normalized);
  }
  store.close();
  return {dir,databasePath,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('mobile export: selected five exact sets, Sony IDs, DLC, timestamps and counts survive read-only export; private metadata excluded',()=>{
  const f=fixture();try{
    const before=readFileSync(f.databasePath),s=exportAndroidSnapshot({databasePath:f.databasePath,exportedAt});
    assert.equal(s.games.length,5);assert.deepEqual(s.games[0].summary,{earned:1,total:3,unknown:0,platinumEarned:0,platinumTotal:1});assert.equal(s.games[0].groups.find(g=>g.kind==='dlc').name,'DLC');
    assert.deepEqual(s.games[0].trophies.map(t=>t.sonyTrophyId),[0,1,2]);assert.equal(s.games[0].trophies[1].earnedAt,'2026-10-08T19:00:00.000Z');assert.equal(s.games[0].observedAt,at);
    assert.equal(JSON.stringify(s).includes('SYNTHETIC_PRIVATE_OWNER'),false);assert.equal(JSON.stringify(s).includes('SYNTHETIC_SECRET_SENTINEL'),false);assert.deepEqual(readFileSync(f.databasePath),before);
  }finally{f.cleanup();}
});
test('mobile export: portable identifiers are account-independent; safe atomic file roundtrip',()=>{
  const a=fixture('SYNTHETIC_A'),b=fixture('SYNTHETIC_B');try{
    const x=exportAndroidSnapshot({databasePath:a.databasePath,exportedAt}),y=exportAndroidSnapshot({databasePath:b.databasePath,exportedAt});assert.deepEqual(x,y);
    const out=join(a.dir,'export.json');writeMobileSnapshotAtomic(x,out);assert.deepEqual(JSON.parse(readFileSync(out,'utf8')),x);
    const updated=structuredClone(x);updated.exportedAt='2026-10-09T01:00:00Z';writeMobileSnapshotAtomic(updated,out);assert.equal(JSON.parse(readFileSync(out,'utf8')).exportedAt,updated.exportedAt);
  }finally{a.cleanup();b.cleanup();}
});
test('mobile validator: rejects duplicate IDs, broken groups, wrong counts, secret fields and inconsistent timestamps; unknown stays unknown',()=>{
  const f=fixture();try{
    const s=exportAndroidSnapshot({databasePath:f.databasePath,exportedAt});
    for(const change of [x=>x.games.push(x.games[0]),x=>x.games[0].trophies[1].id=x.games[0].trophies[0].id,x=>x.games[0].trophies[0].groupId='absent',x=>x.games[0].summary.earned++,x=>x.token='SYNTHETIC_SECRET_SENTINEL',x=>x.games[0].sony.accountId='PRIVATE',x=>x.games[0].trophies[0].earnedAt=at,x=>x.games[0].observedAt='2027-01-01T00:00:00Z',x=>x.games[0].trophies[1].earnedAt='2026-10-08T21:00:00Z',x=>x.games[0].coverUrl='https://untrusted.invalid/pixel']){const copy=structuredClone(s);change(copy);assert.throws(()=>validateMobileSnapshot(copy),/invalid_mobile_snapshot/);}
    s.games[0].source='imported';s.games[0].trophies[2].earned=null;s.games[0].summary=mobileSummary(s.games[0].trophies);validateMobileSnapshot(s);assert.equal(s.games[0].summary.unknown,1);assert.equal(s.games[0].trophies.filter(t=>t.earned===false).length,1);
  }finally{f.cleanup();}
});
test('mobile export: exact active four selection required; extra inventory never exported; missing Sony ID is null, not guessed',()=>{
  const f=fixture();try{
    let store=new LibraryStore(f.databasePath);const game=store.list().games[0];const old=store.latest(game.gameId);const row=store.db.prepare('SELECT * FROM trophy_rows WHERE snapshot_id=? LIMIT 1').get(old.id);const payload=JSON.parse(row.payload_json);payload.id='unmappable-private-id';store.db.prepare('UPDATE trophy_rows SET id=?,payload_json=? WHERE snapshot_id=? AND id=?').run(payload.id,JSON.stringify(payload),old.id,row.id);store.close();
    const s=exportAndroidSnapshot({databasePath:f.databasePath,exportedAt});assert.equal(s.games.flatMap(g=>g.trophies).filter(t=>t.sonyTrophyId===null).length,1);assert.equal(JSON.stringify(s).includes('unmappable-private-id'),false);
    store=new LibraryStore(f.databasePath);store.setMeta('syncSelection',{gameIds:[]});store.close();assert.throws(()=>exportAndroidSnapshot({databasePath:f.databasePath,exportedAt}),/android_selection_mismatch/);
  }finally{f.cleanup();}
});
test('legacy Witcher: only last provider-confirmed Account observation used, unrelated Run facts ignored and exact mappings required',()=>{
  const trophyId='domain-trophy',groupId='domain-group',setId='domain-set',accountId='domain-account';
  const binding={externalSetId:WITCHER_PS5_SET,accountId,set:{id:setId,title:'The Witcher 3: Wild Hunt',platform:'PS5'},trophyIds:{'0':trophyId},groupIds:{default:groupId}};
  const source={kind:'direct_psn_api',externalReference:WITCHER_PS5_SET,freshness:{observedAt:at}};
  const state={player:{secret:'SYNTHETIC_RUN_FACT'},account:{accountId,setId,catalog:{complete:true,set:{id:setId,title:binding.set.title},groups:[{id:groupId,kind:'base'}],trophies:[{id:trophyId,groupId,name:'Synthetic',grade:'platinum',hidden:false}]},lastConfirmedSnapshot:{accountId,setId,complete:true,source,summary:{earned:1,total:1},observations:[{accountId,setId,trophyId,earned:true,earnedAt:at,observedAt:at,source:{...source,externalReference:`${WITCHER_PS5_SET}:0`}}]}}};
  const game=legacyWitcherGame(state,binding);validateMobileSnapshot({schemaVersion:1,kind:'platinum_companion_snapshot',exportedAt,games:[game]});assert.equal(game.trophies[0].description,null);assert.equal(game.trophies[0].sonyTrophyId,0);assert.equal(JSON.stringify(game).includes('SYNTHETIC_RUN_FACT'),false);
  state.account.lastConfirmedSnapshot.observations[0].source.kind='user_confirmation';assert.throws(()=>legacyWitcherGame(state,binding),/legacy_snapshot_observation_mismatch/);
});
test('mobile CLI: requires explicit transfer consent before reading data, and rejects export outside private area',()=>{
  const command=spawnSync(process.execPath,['scripts/export-android-snapshot.mjs'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.equal(command.status,1);assert.match(command.stderr,/personal_progress_consent_required/);assert.equal(command.stdout,'');
  assert.throws(()=>assertPrivateExportPath(process.cwd(),'docs/progress.json'),/export_requires_private_android_directory/);
});
