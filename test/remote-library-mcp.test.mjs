import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {LibraryStore,normalizeLibrarySnapshot} from '../src/library-store.mjs';
import {OidcResourceAuthorization} from '../src/remote-authorization.mjs';
import {createRemoteMcp} from '../src/remote-mcp.mjs';
import {CloudCredentialVault} from '../src/cloud-vault.mjs';
import {mkdir,mkdtemp,writeFile,readFile,unlink,rmdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const oauth={resource:'https://synthetic.example.invalid/mcp',audience:'https://synthetic.example.invalid/mcp',issuer:'https://issuer.example.invalid/',jwksUri:'https://issuer.example.invalid/jwks',ownerSubject:'synthetic-owner'};
function identity(){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-key',use:'sig',alg:'RS256'};
  const token=overrides=>{const parts=[{alg:'RS256',kid:jwk.kid},{iss:oauth.issuer,aud:oauth.audience,sub:oauth.ownerSubject,exp:Math.floor(Date.now()/1000)+3600,scope:'platinum:read platinum:sync',...overrides}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url'));return `${parts.join('.')}.${sign('RSA-SHA256',Buffer.from(parts.join('.')),privateKey).toString('base64url')}`;};
  return {token,authorization:new OidcResourceAuthorization(oauth,{fetcher:async()=>new Response(JSON.stringify({keys:[jwk]}))})};
}
function fixture(){
  const store=new LibraryStore(':memory:');store.replaceInventory('synthetic-account',[{setId:'SYNTHETIC_SET',title:'Hades II (synthetic)',platform:'PS5'}],'2026-10-08T00:00:00Z');
  const gameId=store.list().games[0].gameId;
  const raw={dataKind:'live_psn',set:{setId:'SYNTHETIC_SET',platform:'PS5',version:'1',pages:1,catalog:[{id:'0',groupId:'default',name:'Synthetic platinum',grade:'platinum'},{id:'1',groupId:'default',name:'Synthetic earned',grade:'bronze'}],groups:[{trophyGroupId:'default',definedTrophies:{platinum:1,bronze:1}}]},
    account:{setId:'SYNTHETIC_SET',version:'1',observedAt:'2026-10-08T00:00:00Z',pages:1,trophies:[{id:'0',earned:false,earnedAt:null},{id:'1',earned:true,earnedAt:'2026-10-07T23:00:00Z'}]}};
  store.commit(normalizeLibrarySnapshot(raw,gameId));return {store,gameId,raw};
}

test('remote OAuth: deny wrong user/audience/issuer/expired tokens; no token passthrough to Sony',async()=>{
  const {token,authorization}=identity();assert.ok((await authorization.authorize(`Bearer ${token()}`)).scopes.includes('platinum:read'));
  for(const override of [{sub:'another-owner'},{aud:'another-resource'},{iss:'another-issuer'},{exp:1},{scope:'platinum:sync'}])await assert.rejects(authorization.authorize(`Bearer ${token(override)}`),/unauthorized/);
  await assert.rejects(authorization.authorize('Bearer arbitrary'),/unauthorized/);
  assert.equal(authorization.metadata().resource,oauth.resource);
});

test('real Streamable HTTP MCP: seven tools, paginated Hades status/context, automatic snapshot update and legacy compatibility',async()=>{
  const {token,authorization}=identity(),{store,gameId,raw}=fixture();let syncCalls=0,selectedDefault=null;
  const http=createRemoteMcp({authorization,getLibrary:()=>store,getDefaultGameId:()=>selectedDefault,runSync:async()=>{syncCalls++;return {status:'synthetic_no_psn_request'};},getLegacyContext:async()=>({stateRevision:15,currentRunFacts:{synthetic:true}})});
  await new Promise(r=>http.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${http.address().port}/mcp`;
  const client=new Client({name:'synthetic-http-verification',version:'1'});
  try{
    const denied=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,401);assert.ok(denied.headers.has('WWW-Authenticate'));
    await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token()}`}}}));
    const tools=await client.listTools();assert.equal(tools.tools.length,7);
    const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError);return JSON.parse(r.content[0].text);};
    assert.equal((await call('list_games',{query:'Hades'})).total,1);
    assert.equal((await call('game_status',{game_id:gameId})).summary.earned,1);
    const page=await call('list_trophies',{game_id:gameId,limit:1});assert.equal(page.trophies.length,1);assert.equal(page.nextOffset,1);
    assert.equal((await call('unearned_trophies',{game_id:gameId})).total,1);
    const first=await call('get_progress_context',{game_id:gameId});assert.equal(first.activeRun,null);assert.deepEqual(first.currentRunFacts,{});assert.equal(first.freshness.freshFetchPerformed,false);
    assert.equal((await call('get_progress_context')).stateRevision,15);
    selectedDefault=gameId;assert.equal((await call('get_progress_context')).identity.gameId,gameId);selectedDefault=null;
    raw.account.observedAt='2026-10-08T01:00:00Z';raw.account.trophies[0]={id:'0',earned:true,earnedAt:'2026-10-08T00:59:00Z'};store.commit(normalizeLibrarySnapshot(raw,gameId));
    const second=await call('get_progress_context',{game_id:gameId});assert.ok(second.stateRevision>first.stateRevision);assert.equal(second.accountTrophySummary.earned,2);
    assert.equal((await call('sync_psn',{game_id:gameId})).status,'synthetic_no_psn_request');assert.equal(syncCalls,1);
    const forbidden=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token({scope:'platinum:read'})}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sync_psn',arguments:{}}})});assert.equal(forbidden.status,403);assert.equal(syncCalls,1);
    const batch=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token({scope:'platinum:read'})}`,'Content-Type':'application/json'},body:JSON.stringify([{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sync_psn'}}])});assert.equal(batch.status,400);
    const badOrigin=await fetch(url,{method:'POST',headers:{Origin:'https://untrusted.example.invalid'},body:'{}'});assert.equal(badOrigin.status,403);
  }finally{await client.close();await new Promise(r=>http.close(r));store.close();}
});

test('cloud vault: refresh-only ciphertext rotation, cross-owner rejection and no secret file in application root',async()=>{
  // Synthetic-only protected storage is outside the application directory.
  const testRoot=fileURLToPath(new URL('../../.platinum-cloud-verification/',import.meta.url));await mkdir(testRoot,{recursive:true});const dir=await mkdtemp(join(testRoot,'synthetic-'));
  const keyPath=join(dir,'synthetic-key'),credentialPath=join(dir,'synthetic-refresh.encrypted');await writeFile(keyPath,randomBytes(32),{mode:0o600});
  const vault=new CloudCredentialVault({keyPath,credentialPath,ownerContext:'synthetic-service',accountKey:'synthetic-account'});
  try{
    const refreshToken=randomBytes(48).toString('hex'),payload={schemaVersion:2,ownerSid:'synthetic-service',accountKey:'synthetic-account',refreshToken,refreshExpiresAt:'2026-12-01T00:00:00Z',requiresUserReauth:false,lastSuccessfulAuth:null,lastSuccessfulTrophySync:null};
    await vault.write(payload);assert.ok(!(await readFile(credentialPath)).includes(Buffer.from(refreshToken)));assert.deepEqual(await vault.read(),payload);
    await vault.write({...payload,refreshToken:'rotated-synthetic-only'});assert.equal((await vault.read()).refreshToken,'rotated-synthetic-only');
    await assert.rejects(vault.write({...payload,accessToken:'synthetic-disallowed'}),/invalid_refresh_payload/);
    const other=new CloudCredentialVault({keyPath,credentialPath,ownerContext:'synthetic-other',accountKey:'synthetic-account'});await assert.rejects(other.read(),/cloud_vault_decryption_failed/);
    assert.throws(()=>new CloudCredentialVault({credentialPath:fileURLToPath(new URL('../private/no-secret',import.meta.url)),keyPath,ownerContext:'x',accountKey:'x'}),/secret_path_inside_project/);
    await vault.clear();assert.equal(await vault.read(),null);
  }finally{await unlink(keyPath);await unlink(credentialPath).catch(()=>{});await rmdir(dir);await rmdir(testRoot).catch(()=>{});}
});
