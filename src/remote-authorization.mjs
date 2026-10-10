import {createPublicKey,verify} from 'node:crypto';
export class OidcResourceAuthorization{
  constructor(config,{fetcher=fetch,clock=Date.now,isRevoked=()=>false}={}){
    for(const k of ['resource','issuer','jwksUri'])if(!config[k]||new URL(config[k]).protocol!=='https:')throw new Error('https_authorization_config_required');
    if(!config.ownerSubject||!config.audience)throw new Error('owner_authorization_required');
    this.config=config;this.fetcher=fetcher;this.clock=clock;this.isRevoked=isRevoked;this.keys=null;this.keysAt=0;
  }
  metadata(){return {resource:this.config.resource,authorization_servers:[this.config.issuer],scopes_supported:['platinum:read','platinum:sync'],bearer_methods_supported:['header']};}
  async authorize(header){
    try{
      if(typeof header!=='string'||!header.startsWith('Bearer ')||header.length>16000)throw new Error();
      const token=header.slice(7),parts=token.split('.');if(parts.length!==3)throw new Error();
      const h=JSON.parse(Buffer.from(parts[0],'base64url')),p=JSON.parse(Buffer.from(parts[1],'base64url'));
      if(h.alg!=='RS256'||typeof h.kid!=='string'||h.jku||h.x5u||h.crit)throw new Error();
      if(!this.keys||this.clock()-this.keysAt>300000){
        const response=await this.fetcher(this.config.jwksUri,{redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error();
        const text=await response.text();if(text.length>256000)throw new Error();this.keys=JSON.parse(text).keys;this.keysAt=this.clock();
      }
      const key=this.keys.find(k=>k.kid===h.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256'));
      if(!key||!verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw new Error();
      const now=this.clock()/1000,aud=Array.isArray(p.aud)?p.aud:[p.aud];
      if(p.iss!==this.config.issuer||!aud.includes(this.config.audience)||p.sub!==this.config.ownerSubject||!Number.isFinite(p.exp)||p.exp<=now||p.nbf!==undefined&&p.nbf>now||typeof p.scope!=='string')throw new Error();
      const scopes=p.scope.split(' ');if(!scopes.includes('platinum:read'))throw new Error();
      if(this.config.allowedClientIds&&!this.config.allowedClientIds.includes(p.azp??p.client_id))throw new Error();
      if(this.config.maxTokenLifetimeSeconds&&(!Number.isFinite(p.iat)||p.iat>now||p.exp-p.iat>this.config.maxTokenLifetimeSeconds))throw new Error();
      if(p.nbf!==undefined&&!Number.isFinite(p.nbf))throw new Error();
      const principal={scopes,subject:p.sub,issuer:p.iss,sessionId:typeof p.sid==='string'&&p.sid.length>0&&p.sid.length<512?p.sid:null};
      if(this.config.requireSessionId&&!principal.sessionId)throw new Error();
      if(this.isRevoked(principal))throw new Error();
      return principal;
    }catch{throw new Error('unauthorized');}
  }
}
