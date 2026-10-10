import test from 'node:test';
import assert from 'node:assert/strict';
import {cutoverRefresh} from '../src/credential-cutover.mjs';
const fixture=()=>{
 let value={refreshToken:'synthetic-cutover-only',refreshExpiresAt:'2099-01-01T00:00:00Z',accountKey:'synthetic',requiresUserReauth:false};
 return {assertContext:async()=>{},read:async()=>({...value}),write:async v=>{value={...v};}};
};
test('cutover suspends local owner before any transfer and leaves only cloud active',async()=>{
 const vault=fixture(),receipts=[];
 const result=await cutoverRefresh({vault,record:async r=>receipts.push(r),transfer:async input=>{assert.equal((await vault.read()).requiresUserReauth,true);assert.equal(input.refreshToken,'synthetic-cutover-only');return {installed:true,identityVerified:true};}});
 assert.equal(result.localSuspended,true);assert.equal((await vault.read()).requiresUserReauth,true);assert.equal(JSON.stringify(receipts).includes('synthetic-cutover-only'),false);
});
test('unknown transfer never re-enables an old possibly rotated token; retry is blocked',async()=>{
 const vault=fixture();let calls=0;
 const transfer=async()=>{calls++;throw Error('transfer_outcome_unknown');};
 await assert.rejects(cutoverRefresh({vault,transfer}),/transfer_outcome_unknown/);
 await assert.rejects(cutoverRefresh({vault,transfer}),/local_refresh_unavailable/);
 assert.equal(calls,1);assert.equal((await vault.read()).requiresUserReauth,true);
});
