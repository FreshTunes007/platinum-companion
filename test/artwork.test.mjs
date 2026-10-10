import test from 'node:test';
import assert from 'node:assert/strict';
import {LibraryStore} from '../src/library-store.mjs';
import {safeImageUrl,artworkTables,attachTitleBindings,artworkForGame,recoverArtwork} from '../src/artwork.mjs';
test('artwork URL is bounded HTTPS on exact observed Sony CDN hosts',()=>{
 for(const u of ['http://image.api.playstation.com/x','https://image.api.playstation.com.evil/x','https://u:p@image.api.playstation.com/x','https://127.0.0.1/x','https://image.api.playstation.com:444/x'])assert.equal(safeImageUrl(u),null);
 assert.ok(safeImageUrl('https://image.api.playstation.com/x.png'));
});
test('exact Sony ID/platform mapping; no match by similar title or collection icon promoted to cover',()=>{
 const store=new LibraryStore(':memory:');try{
 store.replaceInventory('synthetic',[{setId:'NPWR00001_00',title:'Same title',platform:'PS4'},{setId:'NPWR00002_00',title:'Same title',platform:'PS5'}],new Date().toISOString());artworkTables(store);
 store.db.prepare('INSERT INTO artwork_titles VALUES(?,?)').run('PPSA00001_00',JSON.stringify({imageUrl:'https://image.api.playstation.com/icon.png'}));
 attachTitleBindings(store,[{npTitleId:'PPSA00001_00',trophyTitles:[{npCommunicationId:'NPWR00002_00'},{npCommunicationId:'NPWR00001_00'}]}],['PPSA00001_00']);
 const games=store.db.prepare('SELECT * FROM games').all();assert.equal(store.db.prepare('SELECT count(*) AS n FROM artwork_bindings').get().n,1);
 const art=artworkForGame(store,games.find(g=>g.platform==='PS5').id,{iconUrl:'https://image.api.playstation.com/trophy.png'});assert.equal(art.gameIcon.kind,'game_icon');assert.equal(art.cover.url,null);assert.equal(art.titleIcon.kind,'trophy_set_icon');
 assert.equal(artworkForGame(store,games.find(g=>g.platform==='PS4').id,{}).bindings.length,0);
 assert.throws(()=>attachTitleBindings(store,[{npTitleId:'PPSA00002_00',trophyTitles:[]}],['PPSA00001_00']),/binding_mismatch/);
 }finally{store.close();}
});
test('metadata recovery checkpoints and resumes without trophy sync or gameplay writes',async()=>{
 const store=new LibraryStore(':memory:');let reads=0;try{
 store.replaceInventory('synthetic',[{setId:'NPWR00001_00',title:'Synthetic',platform:'PS5'}],new Date().toISOString());
 const client={async playedTitlesPage(){reads++;return {totalItemCount:1,titles:[{titleId:'PPSA00001_00',imageUrl:'https://image.api.playstation.com/icon.png'}]};},async titleBindings(){reads++;return {titles:[{npTitleId:'PPSA00001_00',trophyTitles:[{npCommunicationId:'NPWR00001_00'}]}]};},async catalogConcept(){reads++;return [];}};
 await recoverArtwork(store,client);assert.equal(reads,3);await recoverArtwork(store,client);assert.equal(reads,3);assert.equal(store.db.prepare('SELECT count(*) AS n FROM snapshots').get().n,0);
 }finally{store.close();}
});

test('cover requires exact product title; concept hero has its own type and cannot impersonate an edition',()=>{
 const store=new LibraryStore(':memory:');try{store.replaceInventory('test',[{setId:'NPWR00001_00',title:'Synthetic',platform:'PS5'}],new Date().toISOString());artworkTables(store);const g=store.db.prepare('SELECT id FROM games').get();
 store.db.prepare('INSERT INTO artwork_titles VALUES(?,?)').run('PPSA00001_00','{}');store.db.prepare('INSERT INTO artwork_bindings VALUES(?,?)').run('PPSA00001_00',g.id);
 const c=[{id:123,titleIds:['PPSA00001_00'],media:{images:[{type:'GAMEHUB_COVER_ART',url:'https://image.api.playstation.com/hero'}]},defaultProduct:{titleId:'PPSA00002_00',id:'other',media:{images:[{type:'MASTER',url:'https://image.api.playstation.com/wrong'}]}}}];store.db.prepare('INSERT INTO artwork_catalog VALUES(?,?,?,NULL)').run('PPSA00001_00',JSON.stringify(c),new Date().toISOString());
 const before=artworkForGame(store,g.id,{});assert.equal(before.cover.url,null);assert.equal(before.cover.status,'edition_unresolved');assert.equal(before.hero.kind,'concept_artwork');
 c[0].defaultProduct.titleId='PPSA00001_00';store.db.prepare('UPDATE artwork_catalog SET payload_json=?').run(JSON.stringify(c));const after=artworkForGame(store,g.id,{});assert.equal(after.cover.matching,'exact_product_title_id');assert.equal(after.cover.kind,'game_cover');
 }finally{store.close();}
});
