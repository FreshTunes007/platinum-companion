import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// PSN SDK's temporary global fetch guard stays out of the API/OIDC process.
// Credentials are loaded from the protected vault in the child, never argv/env.
export function runCloudSyncWorker({gameId=null,initialImport=false}={}){
  if(gameId!==null&&!/^[a-f0-9]{24}$/.test(gameId))return Promise.reject(Error('game_outside_active_scope'));
  return new Promise(resolve=>{
    let output='',finished=false;
    const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/sync-cloud-library.mjs',import.meta.url)),...(initialImport?['--initial']:gameId?[gameId]:[])],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    const done=result=>{if(finished)return;finished=true;resolve(result);};
    child.stdout.on('data',b=>{output+=b;if(output.length>32768){output='';child.kill();}});
    child.stderr.resume(); // Never print upstream exception bodies.
    child.on('error',()=>done({status:'failed',errors:[{code:'worker_failed'}]}));
    child.on('close',()=>{try{const result=JSON.parse(output);output='';if(!['success','partial','failed'].includes(result.status))throw Error();done({status:result.status});}catch{done({status:'failed',errors:[{code:'worker_failed'}]});}});
  });
}
