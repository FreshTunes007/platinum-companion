import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {exportAndroidSnapshot,writeMobileSnapshotAtomic,assertPrivateExportPath,readJsonFile} from '../src/mobile-snapshot.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
try{
  if(!args.includes('--consent-personal-progress'))throw new Error('personal_progress_consent_required');
  const values={};
  for(let i=0;i<args.length;i++){
    const arg=args[i];if(arg==='--consent-personal-progress')continue;
    if(!['--database','--output'].includes(arg)||!args[i+1]||args[i+1].startsWith('--')||values[arg])throw new Error('invalid_export_arguments');
    values[arg]=args[++i];
  }
  const output=assertPrivateExportPath(root,values['--output']??resolve(root,'private/android-export/library.json'));
  const snapshot=exportAndroidSnapshot({databasePath:values['--database']??resolve(root,'private/psn-library.sqlite'),legacyState:readJsonFile(resolve(root,'private/live-state.json')),legacyBinding:readJsonFile(resolve(root,'private/psn-binding.json'))});
  writeMobileSnapshotAtomic(snapshot,output);
  process.stdout.write(`${JSON.stringify({status:'exported',schemaVersion:snapshot.schemaVersion,freshFetchPerformed:false,personalProgressConsent:true,games:snapshot.games.map(g=>({title:g.title,platform:g.platform,source:g.source,observedAt:g.observedAt,...g.summary,sonyIdsKnown:g.trophies.filter(t=>t.sonyTrophyId!==null).length})),output:'private/android-export/library.json'})}\n`);
}catch(e){
  const allowed=['personal_progress_consent_required','invalid_export_arguments','export_requires_private_android_directory','android_selection_mismatch','android_snapshot_missing','witcher_snapshot_missing','invalid_mobile_snapshot','legacy_snapshot_binding_mismatch','legacy_snapshot_incomplete','legacy_snapshot_observation_mismatch','legacy_snapshot_summary_mismatch','library_snapshot_summary_mismatch'];
  process.stderr.write(`${JSON.stringify({status:'error',code:allowed.includes(e.message)?e.message:'export_failed'})}\n`);process.exitCode=1;
}
