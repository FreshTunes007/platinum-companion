import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
let config=null;
try{config=JSON.parse(await readFile(new URL('../docs/psn-execution-context.json',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
export class WindowsCredentialVault {
  constructor(){this.expectedContext=config;}
  async #invoke(action,payload=null){
    if(!config||process.platform!=='win32')throw new Error('windows_vault_unavailable');
    const quote=p=>p.replaceAll("'","''");
    const helper=quote(fileURLToPath(new URL('../scripts/psn-secret.ps1',import.meta.url)));
    const legacy=quote(fileURLToPath(new URL('../private/psn-auth.dpapi',import.meta.url)));
    const command=`& ([scriptblock]::Create([IO.File]::ReadAllText('${helper}'))) -Action ${action} -ExpectedSid '${config.userSid}' -LegacyPath '${legacy}'`;
    return new Promise((resolve,reject)=>{
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      let captured='';
      child.stdout.on('data',b=>{captured+=b;if(captured.length>65536)child.kill();});
      child.stderr.resume();child.on('error',()=>reject(new Error('credential_helper_unavailable')));
      child.on('close',code=>{if(code!==0){captured='';reject(new Error('credential_operation_failed'));}else{try{const result=JSON.parse(captured);captured='';resolve(result);}catch{captured='';reject(new Error('credential_payload_invalid'));}}});
      child.stdin.on('error',()=>{});child.stdin.end(payload===null?'':JSON.stringify(payload));
    });
  }
  async context(){return this.#invoke('Context');}
  async assertContext(){const context=await this.context();if(context.userSid!==config.userSid||context.storageDirectory.toLowerCase()!==config.storageDirectory.toLowerCase())throw new Error('execution_context_mismatch');return context;}
  async read(){await this.assertContext();return this.#invoke('Read');}
  async write(payload){await this.assertContext();const allowed=['schemaVersion','ownerSid','accountKey','refreshToken','refreshExpiresAt','requiresUserReauth','lastSuccessfulAuth','lastSuccessfulTrophySync'];if(payload.ownerSid!==config.userSid||!payload.refreshToken||Object.keys(payload).some(k=>!allowed.includes(k)))throw new Error('invalid_refresh_payload');return this.#invoke('Write',payload);}
  async clear(){await this.assertContext();return this.#invoke('Clear');}
  async bootstrap(source='clipboard'){await this.assertContext();return this.#invoke(source==='legacy'?'LegacyBootstrap':'ClipboardBootstrap');}
  async deleteLegacy(){return this.#invoke('DeleteLegacy');}
}
