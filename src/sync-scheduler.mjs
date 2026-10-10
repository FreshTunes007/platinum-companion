// Durable due time; bounded polling never starts a second queue/credential owner.
export function createSyncScheduler({store,coordinator,intervalMs=21600000,clock=Date.now}){
  const interval=Math.max(21600000,intervalMs);let ticking=false;
  if(!store.meta('autoSyncNextAt')){
    const finished=Date.parse(store.meta('lastRun')?.finishedAt);
    store.setMeta('autoSyncNextAt',new Date((Number.isFinite(finished)?finished:clock())+interval).toISOString());
  }
  const tick=async()=>{
    if(ticking||clock()<Date.parse(store.meta('autoSyncNextAt')))return {status:'not_due'};
    ticking=true;
    try{
      const requested=await coordinator.request({});
      if(requested.status==='cooldown'){store.setMeta('autoSyncNextAt',requested.nextAllowedAt);return requested;}
      if(requested.status!=='accepted')return requested;
      await coordinator.drain();
      const at=new Date(clock()).toISOString();
      store.setMeta('autoSyncLastCompletedAt',at);
      store.setMeta('autoSyncNextAt',new Date(clock()+interval).toISOString());
      return {status:'completed',nextAt:store.meta('autoSyncNextAt')};
    }finally{ticking=false;}
  };
  return {tick,intervalMs:interval};
}
