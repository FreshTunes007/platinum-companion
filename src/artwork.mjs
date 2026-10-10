// Artwork observations never alter trophy observations or manual gameplay facts.
export const IMAGE_HOSTS=new Set(['image.api.playstation.com','psnobj.prod.dl.playstation.net']);
export function safeImageUrl(value){try{const u=new URL(value);return typeof value==='string'&&value.length<=2048&&u.protocol==='https:'&&IMAGE_HOSTS.has(u.hostname)&&!u.username&&!u.password&&(!u.port||u.port==='443')&&!u.hash?u.href:null;}catch{return null;}}
export function artworkTables(store){store.db.exec(`CREATE TABLE IF NOT EXISTS artwork_titles(title_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artwork_bindings(title_id TEXT NOT NULL,game_id TEXT NOT NULL REFERENCES games(id),PRIMARY KEY(title_id,game_id));
CREATE TABLE IF NOT EXISTS artwork_catalog(title_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,observed_at TEXT NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS artwork_assets(game_id TEXT PRIMARY KEY REFERENCES games(id),payload_json TEXT NOT NULL);`);}
export function attachTitleBindings(store,rows,requested){
  if(!Array.isArray(rows))throw Error('artwork_schema_changed');
  for(const row of rows){if(!requested.includes(row.npTitleId)||!Array.isArray(row.trophyTitles))throw Error('artwork_binding_mismatch');
    for(const set of row.trophyTitles){const platform=row.npTitleId.startsWith('PPSA')?'PS5':'PS4';
      const games=store.db.prepare('SELECT g.id,g.platform FROM games g JOIN provider_bindings b ON b.game_id=g.id WHERE b.external_set_id=?').all(set.npCommunicationId);
      for(const g of games)if(g.platform===platform)store.db.prepare('INSERT OR IGNORE INTO artwork_bindings VALUES(?,?)').run(row.npTitleId,g.id);
    }
  }
}
export function artworkForGame(store,gameId,inventory){
  if(store.db.prepare("SELECT name FROM sqlite_master WHERE name='artwork_assets'").get()){
    const row=store.db.prepare('SELECT payload_json FROM artwork_assets WHERE game_id=?').get(gameId);
    if(row)return JSON.parse(row.payload_json);
  }
  return resolveArtworkForGame(store,gameId,inventory);
}
export function resolveArtworkForGame(store,gameId,inventory){
  const titleIcon=safeImageUrl(inventory?.iconUrl);
  const tables=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artwork_titles'").get();
  const rows=tables?store.db.prepare('SELECT t.title_id,t.payload_json,c.payload_json AS catalog,c.observed_at,c.error FROM artwork_bindings b JOIN artwork_titles t ON t.title_id=b.title_id LEFT JOIN artwork_catalog c ON c.title_id=t.title_id WHERE b.game_id=? ORDER BY t.title_id').all(gameId):[];
  const artwork={titleIcon:{kind:'trophy_set_icon',url:titleIcon,status:titleIcon?'source_available':'missing',source:'sony_trophy_api'},cover:{kind:'game_cover',url:null,status:rows.length?'catalog_pending':'identity_unresolved'},gameIcon:null,hero:null,bindings:rows.map(r=>r.title_id)};
  for(const r of rows){const t=JSON.parse(r.payload_json);const url=safeImageUrl(t.imageUrl);if(!artwork.gameIcon&&url)artwork.gameIcon={kind:'game_icon',url,status:'source_available',source:'sony_played_titles',npTitleId:r.title_id};
    if(r.error)artwork.cover.status='catalog_unavailable';
    if(r.catalog&&!r.error){const records=JSON.parse(r.catalog);if(!Array.isArray(records))continue;
      for(const concept of records){if(!concept?.titleIds?.includes(r.title_id))continue;
        const image=(images,types)=>types.map(type=>images?.find(m=>m.type===type&&safeImageUrl(m.url))).find(Boolean);
        const hero=image(concept.media?.images,['GAMEHUB_COVER_ART','FOUR_BY_THREE_BANNER']);
        if(hero&&!artwork.hero)artwork.hero={kind:'concept_artwork',url:safeImageUrl(hero.url),status:'source_available',source:'sony_catalog',npTitleId:r.title_id,conceptId:String(concept.id),mediaType:hero.type,matching:'concept_contains_exact_title_id',observedAt:r.observed_at};
        const product=concept.defaultProduct;
        if(product?.titleId!==r.title_id){if(!artwork.cover.url)artwork.cover.status='edition_unresolved';continue;}
        const cover=image(product.media?.images,['PORTRAIT_BANNER','EDITION_KEY_ART','MASTER']);
        if(cover&&!artwork.cover.url)artwork.cover={kind:'game_cover',url:safeImageUrl(cover.url),status:'source_available',source:'sony_catalog',npTitleId:r.title_id,conceptId:String(concept.id),productId:product.id,mediaType:cover.type,matching:'exact_product_title_id',observedAt:r.observed_at};
      }
    }
  }
  return artwork;
}
export function refreshArtworkAssets(store){artworkTables(store);const counts={sets:0,titleIcons:0,covers:0,gameIcons:0,conceptArtwork:0,missingCoverReasons:{}};
  store.transaction(()=>{for(const g of store.db.prepare('SELECT g.id,i.payload_json FROM games g LEFT JOIN inventory_details i ON i.game_id=g.id WHERE g.present=1').all()){
    const art=resolveArtworkForGame(store,g.id,g.payload_json?JSON.parse(g.payload_json):{});store.db.prepare('INSERT INTO artwork_assets VALUES(?,?) ON CONFLICT(game_id) DO UPDATE SET payload_json=excluded.payload_json').run(g.id,JSON.stringify(art));counts.sets++;counts.titleIcons+=!!art.titleIcon.url;counts.covers+=!!art.cover.url;counts.gameIcons+=!!art.gameIcon?.url;counts.conceptArtwork+=!!art.hero?.url;if(!art.cover.url)counts.missingCoverReasons[art.cover.status]=(counts.missingCoverReasons[art.cover.status]??0)+1;
  }store.bump();});store.setMeta('artworkCoverage',{...counts,checkedAt:new Date().toISOString()});return counts;
}

export async function recoverArtwork(store,client,{catalogLimit=5,onProgress=()=>{}}={}){
  artworkTables(store);let calls=0;
  if(!store.meta('artworkTitleIndexComplete')){
    let offset=0,total=null,count=0;const seen=new Set();
    for(let page=0;page<20;page++){
      const response=await client.playedTitlesPage(offset);calls++;
      if(!Array.isArray(response.titles)||!Number.isInteger(response.totalItemCount)||(total!==null&&total!==response.totalItemCount))throw Error('artwork_schema_changed');total=response.totalItemCount;
      for(const t of response.titles){if(!/^(PPSA|CUSA)\d{5}_00$/.test(t.titleId)||seen.has(t.titleId))throw Error('artwork_schema_changed');seen.add(t.titleId);count++;
        store.db.prepare('INSERT INTO artwork_titles VALUES(?,?) ON CONFLICT(title_id) DO UPDATE SET payload_json=excluded.payload_json').run(t.titleId,JSON.stringify({titleId:t.titleId,imageUrl:safeImageUrl(t.imageUrl),category:t.category,concept:t.concept??null}));}
      if(count===total){store.setMeta('artworkTitleIndexComplete',{count,at:new Date().toISOString()});break;}
      if(!response.titles.length||!Number.isInteger(response.nextOffset)||response.nextOffset<=offset)throw Error('artwork_pagination_incomplete');offset=response.nextOffset;
    }
    if(!store.meta('artworkTitleIndexComplete'))throw Error('artwork_pagination_incomplete');
  }
  const titles=store.db.prepare('SELECT title_id FROM artwork_titles ORDER BY title_id').all().map(x=>x.title_id);
  const done=new Set(store.meta('artworkBindingsChecked')??[]);
  for(let n=0;n<titles.length;n+=5){const ids=titles.slice(n,n+5).filter(id=>!done.has(id));if(!ids.length)continue;
    try{const response=await client.titleBindings(ids);calls++;attachTitleBindings(store,response.titles,ids);for(const id of ids)done.add(id);}
    catch(e){if(!['endpoint_or_title_missing','privacy_or_access_denied'].includes(e.code))throw e;client.continueAfterTitleFailure();for(const id of ids)done.add(id);}
    store.setMeta('artworkBindingsChecked',[...done]);onProgress();
  }
  const pending=store.db.prepare(`SELECT DISTINCT b.title_id,coalesce(a.active,0) AS priority FROM artwork_bindings b LEFT JOIN active_games a ON a.game_id=b.game_id LEFT JOIN artwork_catalog c ON c.title_id=b.title_id WHERE c.title_id IS NULL ORDER BY priority DESC,b.title_id LIMIT ?`).all(catalogLimit);
  for(const r of pending){const at=new Date().toISOString();try{const data=await client.catalogConcept(r.title_id);calls++;store.db.prepare('INSERT INTO artwork_catalog VALUES(?,?,?,NULL)').run(r.title_id,JSON.stringify(data),at);}
    catch(e){if(!['endpoint_or_title_missing','privacy_or_access_denied'].includes(e.code))throw e;client.continueAfterTitleFailure();store.db.prepare('INSERT INTO artwork_catalog VALUES(?,?,?,?)').run(r.title_id,'null',at,e.code);}
    onProgress();
  }
  refreshArtworkAssets(store);return {status:'success',type:'artwork_metadata',freshTrophyFetchPerformed:false,calls,titleCount:titles.length,bindingCount:store.db.prepare('SELECT count(*) AS n FROM artwork_bindings').get().n,catalogCount:store.db.prepare('SELECT count(*) AS n FROM artwork_catalog').get().n};
}
