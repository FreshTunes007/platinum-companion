import test from 'node:test';
import assert from 'node:assert/strict';
import { PSNClient, ProviderError, serviceFor, installReadOnlyTransport } from '../src/provider.mjs';
const game={setId:'TEST_SET',title:'Synthetic Witcher',platform:'PS5'};
function fixture(overrides={}) {
  const calls=[];
  const auth={accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresIn:7200};
  const trophies=[0,1,2].map(trophyId=>({trophyId,trophyName:`Test ${trophyId}`,trophyGroupId:trophyId===2?'001':'default',trophyType:'bronze'}));
  const sdk={
    exchangeNpssoForAccessCode:async()=> 'synthetic-code',
    exchangeAccessCodeForAuthTokens:async()=>auth,
    exchangeRefreshTokenForAuthTokens:async()=>auth,
    getUserTrophyProfileSummary:async()=>({accountId:'synthetic-account'}),
    getUserTitles:async(_a,_id,o)=>({trophyTitles:[{npCommunicationId:game.setId,trophyTitleName:game.title,trophyTitlePlatform:game.platform}],totalItemCount:1}),
    getTitleTrophies:async(_a,_id,_group,o)=>{calls.push(o); return {trophies:trophies.slice(o.offset,o.offset+2),totalItemCount:3,nextOffset:o.offset===0?2:undefined,trophySetVersion:'01.00'};},
    getTitleTrophyGroups:async()=>({trophySetVersion:'01.00',trophyGroups:[{trophyGroupId:'default'},{trophyGroupId:'001'}]}),
    getUserTrophiesEarnedForTitle:async()=>({trophies:trophies.map(t=>({trophyId:t.trophyId,earned:t.trophyId===0,earnedDateTime:t.trophyId===0?'2020-01-01T00:00:00Z':undefined})),totalItemCount:3,trophySetVersion:'01.00'}),...overrides
  };
  const p=new PSNClient(sdk,{gapMs:0,sleep:async()=>{}});
  return {p,sdk,calls};
}
async function ready(o){const f=fixture(o);await f.p.authenticate('s'.repeat(64));return f;}
test('synthetic: all pages, groups, timestamps and secret-free normalized output',async()=>{
  const {p,calls}=await ready();const result=await p.sync(game);
  assert.equal(result.set.pages,2);assert.equal(result.set.catalog.length,3);
  assert.equal(result.account.trophies[0].earnedAt,'2020-01-01T00:00:00Z');
  assert.equal(result.account.trophies[1].earnedAt,null);
  assert.notEqual(result.account.trophies[0].earnedAt,result.account.observedAt);
  assert.equal(calls[0].npServiceName,'trophy2');
  assert.ok(!JSON.stringify(result).includes('synthetic-access'));
});
test('synthetic: platform routing never merges PS4/PS5',()=>{
  assert.equal(serviceFor('PS4'),'trophy');assert.equal(serviceFor('PS5'),'trophy2');assert.throws(()=>serviceFor('unknown'));
});
test('synthetic: malformed endpoint response fails closed',async()=>{
  const {p}=await ready({getUserTitles:async()=>({changedName:[]})});await assert.rejects(p.listGames(),{code:'schema_changed'});
});
test('synthetic: incomplete pagination is not complete progress',async()=>{
  const {p}=await ready({getTitleTrophies:async()=>({trophies:[],totalItemCount:9,nextOffset:0})});await assert.rejects(p.getTrophySet(game),{code:'schema_changed'});
});
test('synthetic: privacy error is not zero trophies',async()=>{
  const {p}=await ready({getUserTitles:async()=>{throw new ProviderError('privacy_or_access_denied');}});
  await assert.rejects(p.listGames(),{code:'privacy_or_access_denied'});assert.equal(p.getSyncStatus().state,'degraded');
});
test('synthetic: rate limit prevents repeated requests',async()=>{
  let n=0;const {p}=await ready({getUserTitles:async()=>{n++;throw new ProviderError('rate_limited',600000);}});
  await assert.rejects(p.listGames(),{code:'rate_limited'});await assert.rejects(p.listGames(),{code:'cooldown'});assert.equal(n,1);
});
test('synthetic: expired authorization refreshes once',async()=>{
  let n=0;const {p}=await ready({getUserTitles:async()=>{if(n++===0)throw new ProviderError('auth_expired');return {trophyTitles:[],totalItemCount:0};}});
  await p.listGames();assert.equal(p.getSyncStatus().refreshes,1);assert.equal(n,2);
});
test('synthetic: failed refresh does not fabricate data',async()=>{
  const {p}=await ready({exchangeRefreshTokenForAuthTokens:async()=>({}),getUserTitles:async()=>{throw new ProviderError('auth_expired');}});
  await assert.rejects(p.listGames(),{code:'invalid_auth_response'});
});
test('synthetic: catalog/account mismatch rejected',async()=>{
  const {p}=await ready({getUserTrophiesEarnedForTitle:async()=>({trophies:[],totalItemCount:0,trophySetVersion:'02.00'})});await assert.rejects(p.sync(game),{code:'schema_changed'});
});
test('transport: PSN mutation is blocked before network',async()=>{
  const guard=installReadOnlyTransport();try{await assert.rejects(fetch('https://m.np.playstation.com/api/trophy/v1/example',{method:'POST'}),{code:'request_not_allowed'});assert.equal(guard.count(),0);}finally{guard.restore();}
});
