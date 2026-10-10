import {createServer} from 'node:http';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createCompanionMcp} from './mcp-tools.mjs';
export function createRemoteMcp({authorization,getLibrary,runSync,getLegacyContext,getDefaultGameId,mobileApi=null,mobileConfiguration=null,allowedHosts=['127.0.0.1','localhost'],allowedOrigins=[]}){
  const http=createServer(async(req,res)=>{
    const json=(code,payload)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(payload));};
    try{
      const host=(req.headers.host??'').split(':')[0];if(!allowedHosts.includes(host))return json(403,{error:'host_not_allowed'});
      if(req.headers.origin&&!allowedOrigins.includes(req.headers.origin))return json(403,{error:'origin_not_allowed'});
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/.well-known/oauth-protected-resource'&&req.method==='GET')return json(200,authorization.metadata());
      if(path==='/.well-known/platinum-companion'&&req.method==='GET'&&mobileConfiguration)return json(200,mobileConfiguration);
      if(path!=='/mcp'&&!(mobileApi&&/^\/api\/v[12]\//.test(path)))return json(404,{error:'not_found'});
      let principal;
      try{principal=await authorization.authorize(req.headers.authorization);}catch{
        res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource',authorization.config.resource)}"`);return json(401,{error:'unauthorized'});
      }
      if(/^\/api\/v[12]\//.test(path))return await mobileApi(req,res,principal,path);
      if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!String(req.headers['content-type']??'').startsWith('application/json'))return json(415,{error:'json_required'});
      if(Number(req.headers['content-length']??0)>65536)return json(413,{error:'request_too_large'});
      let bytes=0,body='';for await(const b of req){bytes+=b.length;if(bytes>65536)return json(413,{error:'request_too_large'});body+=b;}
      let parsed;try{parsed=JSON.parse(body);}catch{return json(400,{error:'invalid_json'});}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return json(400,{error:'single_rpc_object_required'});
      if(parsed.method==='tools/call'&&parsed.params?.name==='sync_psn'&&!principal.scopes.includes('platinum:sync'))return json(403,{error:'sync_scope_required'});
      const server=createCompanionMcp({getLibrary,runSync,getLegacyContext,getDefaultGameId});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on('close',()=>{transport.close().catch(()=>{});server.close().catch(()=>{});});
      await server.connect(transport);await transport.handleRequest(req,res,parsed);
    }catch{if(!res.headersSent)json(500,{error:'remote_request_failed'});else res.end();}
  });
  http.maxConnections=64;http.headersTimeout=10000;http.requestTimeout=30000;
  return http;
}
