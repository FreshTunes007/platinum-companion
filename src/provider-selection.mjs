// Priorities are caller configuration, never game or provider logic in the domain.
export async function fetchPreferredAccount(state, entries, ingest) {
  const attempts=[];
  for(const entry of [...entries].sort((a,b)=>b.priority-a.priority)){
    const result=await ingest(state,entry.provider,{priority:entry.priority});
    attempts.push({provider:entry.name,ok:result.ok,error:result.error??null});
    if(result.ok)return {...result,attempts,selected:entry.name};
  }
  return {ok:false,state:structuredClone(state),attempts,error:{code:'all_providers_unavailable'}};
}
