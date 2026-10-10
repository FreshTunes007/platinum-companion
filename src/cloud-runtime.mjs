import {seedActiveGames} from './library-index.mjs';
import {readFile} from 'node:fs/promises';
import {LibraryStore} from './library-store.mjs';
import {CloudCredentialVault} from './cloud-vault.mjs';
import {syncLocalLibrary} from './library-runtime.mjs';
import {activeFive} from './active-scope.mjs';
export async function loadCloudRuntime(configPath){
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const binding=JSON.parse(await readFile(config.bindingPath,'utf8'));
  if(!binding.externalAccountKey)throw new Error('cloud_account_binding_required');
  const vault=new CloudCredentialVault({credentialPath:config.credentialPath,keyPath:config.vaultKeyPath,ownerContext:config.ownerContext,accountKey:binding.externalAccountKey});
  const store=new LibraryStore(config.databasePath);
  try{
    if(!store.meta('accountKey')){
      if(!Array.isArray(config.selectedSets)||config.selectedSets.length!==5||config.selectedSets.some(g=>g.platform!=='PS5'||!/^NPWR\d{5,8}_\d{2}$/.test(g.setId)))throw new Error('cloud_five_bindings_required');
      store.replaceInventory(binding.externalAccountKey,config.selectedSets,new Date().toISOString());
      // Configured bindings are not a fresh Sony inventory observation.
      store.setMeta('inventoryLastSuccessAt',null);
    }
    if(store.meta('accountKey')!==binding.externalAccountKey)throw new Error('account_binding_mismatch');
    seedActiveGames(store);const games=activeFive(store);
    if(store.meta('groupSemanticsVersion')!==2){store.setMeta('groupSemanticsVersion',2);store.bump();}
    store.setMeta('syncSelection',{gameIds:games.map(g=>g.gameId),platform:'PS5',source:'deployment_configuration'});
    return {config,vault,store,sync:options=>{if(options?.initialImport&&!config.fullLibraryImportApproved)throw Error('full_import_not_approved');return syncLocalLibrary(store,{...options,vault,bindingPath:config.bindingPath,activeScopeOnly:true});}};
  }catch(e){store.close();throw e;}
}
