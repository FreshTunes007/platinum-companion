import {createMobileApi,sessionRevoked,bindAppOwner} from '../src/mobile-api.mjs';
import {createSyncCoordinator} from '../src/sync-coordinator.mjs';
import {loadCloudRuntime} from '../src/cloud-runtime.mjs';
import {OidcResourceAuthorization} from '../src/remote-authorization.mjs';
import {createRemoteMcp} from '../src/remote-mcp.mjs';
import {assertListenPolicy} from '../src/listen-policy.mjs';
import {runCloudSyncWorker} from '../src/cloud-sync-worker.mjs';
import {createSyncScheduler} from '../src/sync-scheduler.mjs';
import {createAIProvider} from '../src/ai-provider.mjs';
let runtime,http;
try{
  const configPath=process.env.PLATINUM_CLOUD_CONFIG;if(!configPath)throw new Error('cloud_configuration_required');
  runtime=await loadCloudRuntime(configPath);const {config,store}=runtime;
  assertListenPolicy(config);
  const coordinator=createSyncCoordinator({store,sync:runCloudSyncWorker});
  const aiProvider=await createAIProvider({config:config.ai??{},store});
  const mobileApi=createMobileApi({store,runSync:coordinator.request,aiProvider});
  bindAppOwner(store,{issuer:config.oauth.issuer,subject:config.oauth.ownerSubject});
  const authorization=new OidcResourceAuthorization(config.oauth,{isRevoked:p=>sessionRevoked(store,p)});
  if(!config.mobileClientId||!config.oauth.allowedClientIds?.includes(config.mobileClientId)||!config.oauth.maxTokenLifetimeSeconds)throw new Error('mobile_oidc_configuration_required');
  http=createRemoteMcp({authorization,mobileApi,mobileConfiguration:{schemaVersion:1,issuer:config.oauth.issuer,clientId:config.mobileClientId,audience:config.oauth.audience},getLibrary:()=>store,allowedHosts:config.allowedHosts,allowedOrigins:config.allowedOrigins,
    getDefaultGameId:()=>store.list({query:config.defaultContextTitle??'Hades II',platform:'PS5',limit:100}).games.find(g=>g.title===(config.defaultContextTitle??'Hades II'))?.gameId??null,
    getLegacyContext:async()=>({identity:null,activeRun:null,currentRunFacts:{},accountTrophySummary:null,roadmap:null,stateRevision:store.meta('revision')??0,knowledgePackVersion:null,criticalUnknowns:[{kind:'first_cloud_sync_required'}],freshness:{source:null,lastSuccessfulSyncAt:null,readMode:'unavailable',freshFetchPerformed:false}}),
    runSync:coordinator.request});
  const scheduler=config.scheduledSyncEnabled===true?createSyncScheduler({store,coordinator,intervalMs:config.scheduleIntervalMs}):null;
  const schedule=scheduler?setInterval(()=>{scheduler.tick().catch(()=>{});},60000):null;
  if(scheduler)scheduler.tick().catch(()=>{});
  http.listen(config.port??8787,config.bindHost??'127.0.0.1',()=>console.log(JSON.stringify({status:'listening',publicEndpointPrinted:false,requiresAuthorization:true})));
  const resumeImport=config.fullLibraryImportApproved?setInterval(()=>{const state=store.meta('initialImport');if(state&&['running','paused','partial'].includes(state.status)&&state.retryable>0&&Date.now()>=Date.parse(state.nextAllowedAt??0)&&!coordinator.running){const running=store.db.prepare("SELECT started_at FROM sync_runs WHERE status='running'").get();if(!running||Date.now()-Date.parse(store.meta('syncHeartbeat')?.observedAt??running.started_at)>300000)coordinator.request({initialImport:true}).catch(()=>{});}},60000):null;
  const stop=()=>{if(resumeImport)clearInterval(resumeImport);if(schedule)clearInterval(schedule);http.close(async()=>{await coordinator.drain();store.close();process.exit(0);});};process.once('SIGTERM',stop);process.once('SIGINT',stop);
}catch{runtime?.store.close();console.log(JSON.stringify({status:'not_started',code:'secure_remote_configuration_required'}));process.exitCode=1;}
