// Official catalogue text is separate from account observations. No translation.
const russian = value => typeof value === 'string' && /[А-Яа-яЁё]/u.test(value);
export function mergeOfficialCatalogs(original, requestedRussian) {
  if(original.setId!==requestedRussian.setId || original.version!==requestedRussian.version || original.catalog.length!==requestedRussian.catalog.length) throw new Error('catalog_localization_mismatch');
  const catalog=original.catalog.map(t=>{
    const ru=requestedRussian.catalog.find(x=>x.id===t.id);
    if(!ru||ru.groupId!==t.groupId||ru.grade!==t.grade||ru.hidden!==t.hidden)throw new Error('catalog_localization_mismatch');
    // Equal English fallback is not evidence of a Russian translation.
    const name=russian(ru.name)&&ru.name!==t.name?ru.name:null;
    const description=russian(ru.description)&&ru.description!==t.description?ru.description:null;
    return {...t,official:{iconUrl:t.iconUrl??null,originalLocale:'en-US',localizations:{
      'en-US':{name:t.name,description:t.description,source:'sony_catalog',observedAt:original.observedAt},
      ...(name||description?{'ru-RU':{name,description,source:'sony_catalog',observedAt:requestedRussian.observedAt}}:{})
    }}};
  });
  return {...original,catalog};
}
export function metadataCoverage(set){
  const rows=set.catalog;
  return {total:rows.length,officialDescriptions:rows.filter(t=>t.description?.trim()).length,
    russianNames:rows.filter(t=>t.official?.localizations['ru-RU']?.name).length,
    russianDescriptions:rows.filter(t=>t.official?.localizations['ru-RU']?.description).length,
    fallbackNames:rows.filter(t=>!t.official?.localizations['ru-RU']?.name).length,
    fallbackDescriptions:rows.filter(t=>!t.official?.localizations['ru-RU']?.description&&t.description?.trim()).length,
    missingDescriptions:rows.filter(t=>!t.description?.trim()&&!t.official?.localizations['ru-RU']?.description).length,
    icons:rows.filter(t=>t.iconUrl).length};
}
