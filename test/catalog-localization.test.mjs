import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeOfficialCatalogs,metadataCoverage} from '../src/catalog-localization.mjs';
import {LibraryStore,normalizeLibrarySnapshot} from '../src/library-store.mjs';
const at='2026-01-02T00:00:00Z';
const en={setId:'NPWR00001_00',platform:'PS5',version:'1',observedAt:at,groups:[{trophyGroupId:'default'}],catalog:[{id:'0',groupId:'default',name:'Synthetic trophy',description:'Synthetic description',grade:'gold',hidden:true,iconUrl:'https://example.invalid/icon.png'}]};
const ru={...en,requestedLanguage:'ru-RU',catalog:[{...en.catalog[0],name:'Тестовый трофей',description:'Тестовое условие'}]};
test('official locales: merge by exact IDs; English fallback never labelled Russian; progress excluded',()=>{
 const merged=mergeOfficialCatalogs(en,ru);assert.equal(merged.catalog[0].official.localizations['ru-RU'].name,'Тестовый трофей');assert.equal(merged.catalog[0].name,en.catalog[0].name);assert.equal(metadataCoverage(merged).russianDescriptions,1);assert.equal(metadataCoverage(mergeOfficialCatalogs(en,en)).russianNames,0);assert.equal(merged.catalog[0].earned,undefined);
});
test('locales with changed version, IDs, groups or grades cannot be joined',()=>{
 for(const change of [x=>x.version='2',x=>x.catalog[0].id='4',x=>x.catalog[0].groupId='001',x=>x.catalog[0].grade='bronze']){const broken=structuredClone(ru);change(broken);assert.throws(()=>mergeOfficialCatalogs(en,broken),/mismatch/);}
});
test('SQLite old schema accepts locale payloads; later incomplete text/dates preserve metadata/history and lost trophies require reconciliation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pc-locales-')),store=new LibraryStore(join(dir,'library.sqlite'));
 try{
  store.replaceInventory('synthetic',[{setId:en.setId,platform:'PS5',title:'Synthetic'}],at);const game=store.list().games[0];
  const raw={dataKind:'live_psn',set:mergeOfficialCatalogs(en,ru),account:{setId:en.setId,version:'1',observedAt:at,trophies:[{id:'0',earned:true,earnedAt:'2026-01-01T00:00:00Z'}]}};
  const first=normalizeLibrarySnapshot(raw,game.gameId);store.commit(first);assert.equal(store.commit(first).changed,false);
  const later=structuredClone(first);later.observedAt='2026-01-03T00:00:00Z';delete later.trophies[0].official;later.trophies[0].description=null;later.trophies[0].earnedAt=null;store.commit(later);
  const t=store.trophies(game.gameId).trophies[0];assert.equal(t.description,'Synthetic description');assert.equal(t.earnedAt,'2026-01-01T00:00:00Z');assert.equal(t.official.localizations['ru-RU'].name,'Тестовый трофей');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n,2);
  const fallback=structuredClone(first);fallback.observedAt='2026-01-04T00:00:00Z';delete fallback.trophies[0].official.localizations['ru-RU'];store.commit(fallback);
  assert.deepEqual(store.trophies(game.gameId).trophies[0].official.localizations['ru-RU'],t.official.localizations['ru-RU']);
  later.observedAt='2026-01-05T00:00:00Z';later.trophies[0].earned=false;assert.throws(()=>store.commit(later),/reconciliation/);assert.equal(store.status(game.gameId).summary.earned,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
