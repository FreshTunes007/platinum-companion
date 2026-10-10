import {readFile,writeFile,rename,mkdir,unlink,realpath,stat} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
function outsideProject(path){const r=relative(appRoot,resolve(path));if(!r||!r.startsWith('..')&&!isAbsolute(r))throw new Error('secret_path_inside_project');}
// Deployment adapter only. No Windows secrets are uploaded or migrated implicitly.
// The AES key is injected as a protected Secret Manager/CSI file, not an env value.
export class CloudCredentialVault{
  constructor({credentialPath,keyPath,ownerContext,accountKey}){
    if(!credentialPath||!keyPath||!ownerContext||!accountKey)throw new Error('cloud_vault_not_configured');
    outsideProject(credentialPath);outsideProject(keyPath);this.path=credentialPath;this.keyPath=keyPath;this.accountKey=accountKey;
    this.expectedContext={userSid:ownerContext,storageDirectory:dirname(credentialPath)};
  }
  async context(){return {userSid:this.expectedContext.userSid,userName:'cloud_service_identity',storageDirectory:this.expectedContext.storageDirectory};}
  async assertContext(){return this.context();}
  async key(){outsideProject(await realpath(this.keyPath));const info=await stat(this.keyPath);if(process.getuid&&((info.mode&0o077)!==0||info.uid!==process.getuid()))throw new Error('cloud_vault_key_permissions');const key=await readFile(this.keyPath);if(key.length!==32)throw new Error('cloud_vault_key_invalid');return key;}
  async read(){
    let bytes;try{bytes=await readFile(this.path);}catch(e){if(e.code==='ENOENT')return null;throw new Error('cloud_vault_unavailable');}
    try{
      const key=await this.key(),d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAAD(Buffer.from(`${this.expectedContext.userSid}:${this.accountKey}`));d.setAuthTag(bytes.subarray(12,28));
      const plain=Buffer.concat([d.update(bytes.subarray(28)),d.final()]);key.fill(0);
      try{const payload=JSON.parse(plain.toString());if(payload.ownerSid!==this.expectedContext.userSid||payload.accountKey!==this.accountKey)throw new Error();return payload;}finally{plain.fill(0);}
    }catch{throw new Error('cloud_vault_decryption_failed');}
  }
  async write(payload){
    const keys=['schemaVersion','ownerSid','accountKey','refreshToken','refreshExpiresAt','requiresUserReauth','lastSuccessfulAuth','lastSuccessfulTrophySync'];
    if(payload.ownerSid!==this.expectedContext.userSid||payload.accountKey!==this.accountKey||!payload.refreshToken||Object.keys(payload).some(k=>!keys.includes(k)))throw new Error('invalid_refresh_payload');
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});const key=await this.key(),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(`${this.expectedContext.userSid}:${this.accountKey}`));
    const plain=Buffer.from(JSON.stringify(payload)),encrypted=Buffer.concat([c.update(plain),c.final()]);plain.fill(0);key.fill(0);
    const temp=`${this.path}.${randomUUID()}.tmp`;
    try{await writeFile(temp,Buffer.concat([iv,c.getAuthTag(),encrypted]),{mode:0o600,flag:'wx'});await rename(temp,this.path);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw new Error('cloud_vault_cleanup_failed');});}
  }
  async clear(){await unlink(this.path).catch(e=>{if(e.code!=='ENOENT')throw new Error('cloud_vault_unavailable');});}
  async deleteLegacy(){}
  async bootstrap(){throw new Error('cloud_bootstrap_requires_separate_authorization');}
}
