// Fail closed after suspension, including unknown SSH outcomes. Never reactivate
// the old refresh token automatically: the remote exchange may have rotated it.
export async function cutoverRefresh({vault,transfer,record=async()=>{}}){
  await vault.assertContext();
  const credential=await vault.read();
  if(!credential?.refreshToken||credential.requiresUserReauth||Date.parse(credential.refreshExpiresAt)<=Date.now())throw new Error('local_refresh_unavailable');
  await vault.write({...credential,requiresUserReauth:true});
  try{
    await record({phase:'local_suspended',checkedAt:new Date().toISOString()});
    const result=await transfer({refreshToken:credential.refreshToken,refreshExpiresAt:credential.refreshExpiresAt,accountKey:credential.accountKey});
    if(result?.installed!==true||result.identityVerified!==true)throw new Error('transfer_outcome_unknown');
    await record({phase:'cloud_owner_active',localSuspended:true,checkedAt:new Date().toISOString()});
    return {installed:true,identityVerified:true,localSuspended:true};
  }catch(e){
    await record({phase:'reconciliation_required',localSuspended:true,checkedAt:new Date().toISOString()});
    throw e;
  }finally{credential.refreshToken='';}
}
