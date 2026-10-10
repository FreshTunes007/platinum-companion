/** One queue for Android, MCP and scheduler. SQLite retains the cross-process lease. */
export function createSyncCoordinator({store,sync,clock=Date.now}){
  let pending=null;
  const request=async(options={})=>{
    if(pending)return {status:'in_progress',freshFetchPerformed:false};
    const lease=store.db?.prepare("SELECT id,started_at FROM sync_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").get();
    const heartbeat=store.meta('syncHeartbeat');
    if(lease&&clock()-Date.parse(heartbeat?.runId===lease.id?heartbeat.observedAt:lease.started_at)<300000)return {status:'in_progress',freshFetchPerformed:false};
    const next=store.meta('nextAllowedAt');
    if(next&&Date.parse(next)>clock())return {status:'cooldown',nextAllowedAt:next,freshFetchPerformed:false};
    // syncLocalLibrary acquires the persistent lease before its first await.
    pending=Promise.resolve().then(()=>sync(options)).catch(()=>({status:'failed',errors:[{code:'worker_failed'}]})).finally(()=>{pending=null;});
    return {status:'accepted',freshFetchPerformed:false};
  };
  return {request,drain:()=>pending??Promise.resolve(),get running(){return pending!==null;}};
}
