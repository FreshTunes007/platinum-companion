import {PSNClient} from './provider.mjs';

export class PersistentPSNAuth {
  #vault;#sdk;#accountKey;#clock;#audit;#credential=null;
  constructor(vault,sdk,accountKey,{clock=Date.now,audit=()=>{},clientOptions={}}={}){this.#vault=vault;this.#sdk=sdk;this.#accountKey=accountKey;this.#clock=clock;this.#audit=audit;this.clientOptions=clientOptions;}
  async status(){
    const context=await this.#vault.context();
    const mismatch=context.userSid!==this.#vault.expectedContext.userSid;
    const credential=mismatch?null:await this.#vault.read();
    const expired=credential?.refreshExpiresAt&&Date.parse(credential.refreshExpiresAt)<=this.#clock();
    return {configured:!!credential,refresh_available:!!credential?.refreshToken&&!expired&&!credential.requiresUserReauth,
      last_successful_auth:credential?.lastSuccessfulAuth??null,last_successful_trophy_sync:credential?.lastSuccessfulTrophySync??null,
      requires_user_reauth:!mismatch&&(!credential||!!expired||!!credential.requiresUserReauth),execution_context_match:!mismatch,
      windows_user:context.userName,windows_sid:context.userSid,storage_directory:this.#vault.expectedContext.storageDirectory};
  }
  async connect({bootstrapSource=null}={}){
    const context=await this.#vault.assertContext();
    let credential=await this.#vault.read(),staged=null,identityVerified=false;
    const persist=async tokens=>{
      for(const key of ['accessToken','refreshToken','idToken'])if(tokens[key])this.#audit(tokens[key]);
      if(!tokens.refreshToken||!Number.isFinite(tokens.refreshTokenExpiresIn))throw new Error('invalid_refresh_lifecycle');
      staged={schemaVersion:2,ownerSid:context.userSid,accountKey:this.#accountKey,refreshToken:tokens.refreshToken,
        refreshExpiresAt:new Date(this.#clock()+tokens.refreshTokenExpiresIn*1000).toISOString(),requiresUserReauth:false,
        lastSuccessfulAuth:new Date(this.#clock()).toISOString(),lastSuccessfulTrophySync:credential?.lastSuccessfulTrophySync??null};
      if(identityVerified){await this.#vault.write(staged);credential=staged;this.#credential=staged;}
    };
    const client=new PSNClient(this.#sdk,{...this.clientOptions,onTokenUpdate:persist});
    try{
      if(bootstrapSource){
        let bootstrap=await this.#vault.bootstrap(bootstrapSource);this.#audit(bootstrap.npsso);
        try{await client.authenticate(bootstrap.npsso);}finally{bootstrap.npsso='';bootstrap=null;}
      }else{
        if(!credential?.refreshToken||credential.requiresUserReauth||Date.parse(credential.refreshExpiresAt)<=this.#clock())throw new Error('requires_user_reauth');
        if(credential.ownerSid!==context.userSid||credential.accountKey!==this.#accountKey)throw new Error('credential_identity_mismatch');
        this.#audit(credential.refreshToken);
        await client.authenticateWithRefreshToken(credential.refreshToken);
      }
      if(client.accountKey!==this.#accountKey)throw new Error('account_binding_mismatch');
      identityVerified=true;await this.#vault.write(staged);credential=staged;this.#credential=staged;
      if(bootstrapSource==='legacy')await this.#vault.deleteLegacy();
      return {client,mode:bootstrapSource?'bootstrap_exchange':'refresh_token',context};
    }catch(error){
      if(credential&&['auth_expired','auth_reauth_required','requires_user_reauth','invalid_auth_response'].includes(error.code??error.message))await this.#vault.write({...credential,requiresUserReauth:true});
      throw error;
    }
  }
  async recordSync(observedAt){
    if(!this.#credential)throw new Error('auth_not_established');
    this.#credential={...this.#credential,lastSuccessfulTrophySync:observedAt};await this.#vault.write(this.#credential);
  }
  async clear(){await this.#vault.clear();await this.#vault.deleteLegacy();this.#credential=null;}
}
