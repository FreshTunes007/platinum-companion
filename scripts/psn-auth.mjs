import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import * as sdk from 'psn-api';
import {WindowsCredentialVault} from '../src/credential-vault.mjs';
import {PersistentPSNAuth} from '../src/psn-auth.mjs';
import {installReadOnlyTransport} from '../src/provider.mjs';
import {scanSecretLeaks} from '../src/secret-leak-audit.mjs';
const action=process.argv[2]??'status',vault=new WindowsCredentialVault();
let guard=null;
try{
  const binding=JSON.parse(await readFile(new URL('../private/psn-binding.json',import.meta.url),'utf8'));
  const secrets=new Set();
  const auth=new PersistentPSNAuth(vault,sdk,binding.externalAccountKey,{audit:s=>secrets.add(s)});
  if(action==='clear'){await auth.clear();console.log(JSON.stringify({status:'cleared',...await auth.status()}));}
  else if(action==='status')console.log(JSON.stringify(await auth.status()));
  else if(['install','update','refresh'].includes(action)){
    guard=installReadOnlyTransport();
    const mode=action==='refresh'?null:process.argv.includes('--migrate')?'legacy':'clipboard';
    const session=await auth.connect({bootstrapSource:mode});
    const output={status:'success',authMode:session.mode,processId:process.pid,requests:guard.count(),...await auth.status()};
    const leak=await scanSecretLeaks([...secrets],[JSON.stringify(output)],{protectedPath:join(vault.expectedContext.storageDirectory,'psn-refresh.dpapi')});secrets.clear();
    if(!leak.clean)throw new Error('secret_leak_detected');
    console.log(JSON.stringify({...output,secretLeakCheck:leak}));
  }else throw new Error('unknown_auth_command');
}catch(error){
  const codes=['execution_context_mismatch','credential_operation_failed','credential_identity_mismatch','requires_user_reauth','account_binding_mismatch','auth_expired','auth_reauth_required','network_or_timeout','invalid_refresh_lifecycle','secret_leak_detected'];
  console.log(JSON.stringify({status:'failed',error:codes.includes(error.code??error.message)?error.code??error.message:'auth_operation_failed',secretPrinted:false}));process.exitCode=1;
}finally{guard?.restore();}
