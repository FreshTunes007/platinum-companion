import {ANDROID_TEST_TITLES,WITCHER_PS5_SET} from './mobile-snapshot.mjs';
/** Exact existing bindings; never a discovery request or a title substring match. */
export function activeFive(store){
  const all=store.list({includeAll:true,limit:100000}).games;
  const games=ANDROID_TEST_TITLES.map(title=>all.filter(g=>g.title===title&&g.platform==='PS5'));
  games.push(all.filter(g=>g.providerMetadata.setId===WITCHER_PS5_SET&&g.platform==='PS5'));
  if(games.some(matches=>matches.length!==1))throw new Error('active_five_bindings_required');
  return games.map(matches=>matches[0]);
}
