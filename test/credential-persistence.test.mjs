import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {PersistentPSNAuth} from '../src/psn-auth.mjs';
import {ProviderError,installReadOnlyTransport} from '../src/provider.mjs';

// Entirely synthetic credentials; never read the real Windows vault in tests.
function fixture(){
  let now=Date.parse('2026-10-03T00:00:00Z');
  const accountId='synthetic-persistence-account';
  const accountKey=createHash('sha256').update(accountId).digest('hex').slice(0,20);
  const calls={bootstrap:0,refresh:[],profile:0,writes:0,deletes:0};
  const vault={
    expectedContext:{userSid:'synthetic-owner',storageDirectory:'synthetic-vault'},credential:null,
    currentContext:{userSid:'synthetic-owner',userName:'synthetic-user',storageDirectory:'synthetic-vault'},
    async context(){return structuredClone(this.currentContext);},
    async assertContext(){if(this.currentContext.userSid!==this.expectedContext.userSid)throw new Error('execution_context_mismatch');return this.context();},
    async read(){await this.assertContext();return structuredClone(this.credential);},
    async write(value){await this.assertContext();calls.writes++;this.credential=structuredClone(value);},
    async bootstrap(){calls.bootstrap++;return {npsso:'s'.repeat(64)};},
    async deleteLegacy(){calls.deletes++;},
    async clear(){this.credential=null;}
  };
  let generation=0;
  const tokens=()=>({accessToken:`synthetic-access-${++generation}`,refreshToken:`synthetic-refresh-${generation}`,idToken:`synthetic-id-${generation}`,expiresIn:3600,refreshTokenExpiresIn:86400});
  const sdk={
    exchangeNpssoForAccessCode:async()=> 'synthetic-code',
    exchangeAccessCodeForAuthTokens:async()=>tokens(),
    exchangeRefreshTokenForAuthTokens:async token=>{calls.refresh.push(token);return tokens();},
    getUserTrophyProfileSummary:async()=>{calls.profile++;return {accountId};}
  };
  const make=()=>new PersistentPSNAuth(vault,sdk,accountKey,{clock:()=>now,clientOptions:{clock:()=>now,gapMs:0,sleep:async()=>{}}});
  return {vault,sdk,calls,make,advance:ms=>{now+=ms;}};
}

test('persistence: bootstrap stores only refresh credential; a new manager uses refresh and rotates it',async()=>{
  const f=fixture(),first=f.make();
  const initial=await first.connect({bootstrapSource:'legacy'});
  assert.equal(initial.mode,'bootstrap_exchange');assert.equal(f.calls.deletes,1);
  assert.deepEqual(Object.keys(f.vault.credential).sort(),['schemaVersion','ownerSid','accountKey','refreshToken','refreshExpiresAt','requiresUserReauth','lastSuccessfulAuth','lastSuccessfulTrophySync'].sort());
  const previous=f.vault.credential.refreshToken;
  const second=f.make(),session=await second.connect();
  assert.equal(session.mode,'refresh_token');assert.deepEqual(f.calls.refresh,[previous]);
  assert.equal(f.calls.bootstrap,1);assert.notEqual(f.vault.credential.refreshToken,previous);
  await second.recordSync('2026-10-03T01:00:00Z');
  const status=await second.status();assert.equal(status.refresh_available,true);
  assert.equal(status.last_successful_trophy_sync,'2026-10-03T01:00:00Z');
  for(const secret of ['s'.repeat(64),previous,f.vault.credential.refreshToken,'synthetic-access-2','synthetic-id-2'])assert.ok(!JSON.stringify(status).includes(secret));
});

test('persistence: access refresh within a session durably rotates the refresh credential',async()=>{
  const f=fixture(),auth=f.make();const {client}=await auth.connect({bootstrapSource:'clipboard'});
  const previous=f.vault.credential.refreshToken;await client.refresh();
  assert.deepEqual(f.calls.refresh,[previous]);assert.notEqual(f.vault.credential.refreshToken,previous);
  assert.equal(f.vault.credential.accessToken,undefined);assert.equal(f.vault.credential.npsso,undefined);
});

test('persistence: wrong Windows context fails before reading or calling Sony; credentials are not blamed',async()=>{
  const f=fixture();await f.make().connect({bootstrapSource:'legacy'});
  f.vault.currentContext.userSid='synthetic-other-profile';
  const status=await f.make().status();assert.equal(status.execution_context_match,false);assert.equal(status.requires_user_reauth,false);
  await assert.rejects(f.make().connect(),{message:'execution_context_mismatch'});
  assert.equal(f.calls.refresh.length,0);assert.equal(f.calls.profile,1);
});

test('persistence: expired refresh credential requests reauth without retrying NPSSO',async()=>{
  const f=fixture();await f.make().connect({bootstrapSource:'legacy'});f.advance(86401000);
  assert.equal((await f.make().status()).refresh_available,false);
  await assert.rejects(f.make().connect(),{message:'requires_user_reauth'});
  assert.equal(f.calls.bootstrap,1);assert.equal(f.calls.refresh.length,0);assert.equal(f.vault.credential.requiresUserReauth,true);
});

test('persistence: definitive invalid grant requires reauth; network failure preserves usable credential',async()=>{
  const f=fixture();await f.make().connect({bootstrapSource:'legacy'});
  const original=structuredClone(f.vault.credential);
  f.sdk.exchangeRefreshTokenForAuthTokens=async()=>{throw new ProviderError('network_or_timeout');};
  await assert.rejects(f.make().connect(),{code:'network_or_timeout'});assert.deepEqual(f.vault.credential,original);
  f.sdk.exchangeRefreshTokenForAuthTokens=async()=>{throw new ProviderError('auth_reauth_required');};
  await assert.rejects(f.make().connect(),{code:'auth_reauth_required'});assert.equal(f.vault.credential.requiresUserReauth,true);
  assert.equal(f.calls.bootstrap,1);
});

test('persistence: wrong account cannot replace a valid credential',async()=>{
  const f=fixture();await f.make().connect({bootstrapSource:'legacy'});const original=structuredClone(f.vault.credential);
  f.sdk.getUserTrophyProfileSummary=async()=>({accountId:'synthetic-other-account'});
  await assert.rejects(f.make().connect(),{message:'account_binding_mismatch'});assert.deepEqual(f.vault.credential,original);
});

test('persistence: clear removes credential; status contains only the safe whitelist',async()=>{
  const f=fixture(),auth=f.make();await auth.connect({bootstrapSource:'legacy'});await auth.clear();
  const status=await auth.status();assert.equal(status.configured,false);assert.equal(status.requires_user_reauth,true);
  assert.deepEqual(Object.keys(status).sort(),['configured','refresh_available','last_successful_auth','last_successful_trophy_sync','requires_user_reauth','execution_context_match','windows_user','windows_sid','storage_directory'].sort());
});

test('transport: invalid_grant is classified without exposing Sony response fields',async()=>{
  const original=globalThis.fetch,privateValue=randomBytes(32).toString('hex');
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'invalid_grant',error_description:privateValue}),{status:400});
  const guard=installReadOnlyTransport();
  try{await assert.rejects(fetch('https://ca.account.sony.com/api/authz/v3/oauth/token',{method:'POST'}),error=>error.code==='auth_reauth_required'&&!String(error).includes(privateValue));}
  finally{guard.restore();globalThis.fetch=original;}
});
