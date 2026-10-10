import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {StateStore} from './state-store.mjs';
import {progressContext} from './context.mjs';
import {validatePack} from './knowledge-validation.mjs';
import {safeSyncError} from './library-sync.mjs';
import {journeyContext,journeyState} from './journey.mjs';
const page={offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50)};
const readOnly={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
export async function legacyProgressContext(){
  const store=new StateStore(process.env.PLATINUM_STATE_PATH??fileURLToPath(new URL('../private/live-state.json',import.meta.url)));
  const state=await store.read();let pack=null,evaluate=null;
  try{pack=JSON.parse(await readFile(new URL('../knowledge/witcher3-ps5-v0.json',import.meta.url),'utf8'));validatePack(pack);({buildRoadmap:evaluate}=await import('./roadmap.mjs'));}catch(e){if(e.code!=='ENOENT')throw e;}
  return progressContext(state,pack,evaluate);
}
export function createCompanionMcp({getLibrary,runSync,getLegacyContext=legacyProgressContext,getDefaultGameId=()=>null}){
  const server=new McpServer({name:'platinum-companion',version:'0.2.0'});
  const tool=(name,schema,description,fn,annotations=readOnly)=>server.registerTool(name,{description,inputSchema:schema,annotations},async args=>{
    try{return reply(await fn(args));}catch(e){const value={status:'error',code:['game_not_found','local_run_context_unavailable'].includes(e.message)?e.message:safeSyncError(e),freshFetchPerformed:false};return {...reply(value),isError:true};}
  });
  tool('get_journey_context',{game_id:z.string().regex(/^[a-f0-9]{24}$/)},'Read compact Active Journey with current Sony snapshot, user-confirmed run, evidence, revision and hidden spoilers. Does not start a run or sync Sony.',args=>journeyContext(getLibrary(),args.game_id));
  tool('sync_psn',{game_id:z.string().min(1).optional()},'Request actual Sony read-only sync. In cloud deployment omitted game_id refreshes active sets; initial full import is a separate resumable operation. Writes private snapshots. Cached reads are never a fresh fetch.',args=>runSync({gameId:args.game_id??null}),{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true});
  tool('list_games',{query:z.string().max(200).default(''),platform:z.enum(['PS5','PS4','PS3','PSVITA']).optional(),...page},'List persisted Sony trophy-library sets with per-game source, latest successful sync time and explicit cache status.',args=>getLibrary().list(args));
  tool('game_status',{game_id:z.string().min(1)},'Read earned/total, base/DLC groups, platinum state, freshness and last failure for one game.',args=>getLibrary().status(args.game_id));
  tool('list_trophies',{game_id:z.string().min(1),group_id:z.string().optional(),...page},'Paginated persisted trophies, earned flags and provider earnedAt. No new PSN request.',args=>getLibrary().trophies(args.game_id,{...args,groupId:args.group_id??null}));
  tool('unearned_trophies',{game_id:z.string().min(1),group_id:z.string().optional(),...page},'Only provider-observed unearned trophies; missing state is unknown rather than false.',args=>getLibrary().trophies(args.game_id,{...args,groupId:args.group_id??null,earned:false}));
  tool('get_progress_context',{game_id:z.string().min(1).optional()},'Compact latest context. No arguments preserves the existing Witcher run interface. game_id returns library progress without inventing manual run facts or a Knowledge Pack.',async args=>{
    if(!args.game_id){const defaultId=await getDefaultGameId();if(defaultId)args={...args,game_id:defaultId};}
    if(!args.game_id){
      const context=await getLegacyContext();
      return {...context,librarySync:getLibrary().meta('lastRun'),libraryRevision:getLibrary().meta('revision')??0};
    }
    const library=getLibrary(),status=library.status(args.game_id);
    const journey=journeyContext(library,args.game_id);
    const earned=library.trophies(args.game_id,{earned:true,limit:12});
    const context={identity:{gameId:status.gameId,title:status.title,platform:status.platform},accountTrophySummary:status.summary,
      relevantEarnedTrophies:earned.trophies,earnedTrophySelection:{returned:earned.trophies.length,totalEarned:earned.total},
      activeRun:null,currentRunFacts:{},roadmap:null,knowledgePackVersion:null,evidenceCoverage:{knowledgePackAvailable:false},
      criticalUnknowns:[{kind:'manual_run_context_not_confirmed'},{kind:'knowledge_pack_not_available'}],
      freshness:{source:status.source,lastSuccessfulSyncAt:status.lastSuccessfulSyncAt,readMode:status.readMode,freshFetchPerformed:false,lastError:status.lastError},stateRevision:status.libraryRevision};
    // Existing run information is attached only to the explicitly bound Witcher set.
    try{
      const binding=JSON.parse(await readFile(new URL('../private/psn-binding.json',import.meta.url),'utf8'));
      if(binding.externalSetId===status.providerMetadata.setId&&binding.set.platform===status.platform){
        const legacy=await getLegacyContext();context.manualContext={source:'user_confirmation',activeRun:legacy.activeRun,currentRunFacts:legacy.currentRunFacts,stateRevision:legacy.stateRevision,roadmap:legacy.roadmap,roadmapAccountSnapshotAt:legacy.freshness.observedAt};
        context.criticalUnknowns=legacy.criticalUnknowns;context.knowledgePackVersion=legacy.knowledgePackVersion;context.evidenceCoverage=legacy.evidenceCoverage;
      }
    }catch(e){if(e.code!=='ENOENT')throw e;}
    return {...context,journey,activeRun:journey.run,currentRunFacts:journey.currentRunFacts,roadmap:{actions:journey.actions,updateRequests:journey.updateRequests,coach:journey.coach},knowledgePackVersion:journey.coverage.packVersion??null,evidenceCoverage:journey.coverage,criticalUnknowns:journey.criticalUnknowns,runRevision:journey.revision};
  });
  return server;
}
