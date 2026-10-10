import {libraryIndex,setActiveGame} from './library-index.mjs';
import {initJourney,journeyContext,journeyCommand} from './journey.mjs';
import {companionGet,handleCompanion,COMPANION_ERRORS} from './companion.mjs';
import {createHash} from 'node:crypto';
import {activeFive} from './active-scope.mjs';
import {snapshotFromStore} from './mobile-snapshot.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export const sessionKey=p=>hash(`${p.issuer}\n${p.subject}\n${p.sessionId}`);
export function bindAppOwner(store,{issuer,subject}){
  const owner=hash(`${issuer}\n${subject}`),previous=store.meta('appOwner');
  if(previous&&previous!==owner)throw new Error('app_owner_migration_required');
  store.setMeta('appOwner',owner);
}
export const sessionRevoked=(store,p)=>p.sessionId&&!!store.db.prepare('SELECT revoked_at FROM app_sessions WHERE id=?').get(sessionKey(p))?.revoked_at;

/** Single-owner deployment; never accepts an account ID from a request. */
export function createMobileApi({store,runSync,clock=Date.now,aiProvider=null}){
  initJourney(store);
  let companionPosts=0;
  store.db.exec(`CREATE TABLE IF NOT EXISTS app_sessions(id TEXT PRIMARY KEY,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,revoked_at TEXT);`);
  return async(req,res,principal,path)=>{
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    if(!principal.subject||!principal.sessionId)return json(403,{error:'oidc_session_required'});
    const id=sessionKey(principal),ownerId=hash(`${principal.issuer}\n${principal.subject}`);
    if(store.meta('appOwner')&&store.meta('appOwner')!==ownerId)return json(403,{error:'owner_mismatch'});
    const at=new Date(clock()).toISOString();
    const session=store.db.prepare('SELECT revoked_at FROM app_sessions WHERE id=?').get(id);
    if(session?.revoked_at)return json(403,{error:'device_revoked'});
    store.db.prepare('INSERT INTO app_sessions(id,first_seen,last_seen) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen').run(id,at,at);
    if(path.startsWith('/api/v2/')){
      const params=new URL(req.url,'http://localhost').searchParams;
      const companion=/^\/api\/v2\/games\/([a-f0-9]{24})\/companion$/.exec(path);
      if(companion){
        const post=req.method==='POST';
        if(post&&companionPosts>=2)return json(429,{error:'companion_busy'});
        if(post)companionPosts++;
        try{
          const options={ownerId,provider:aiProvider,now:at,reveal:params.get('reveal')==='true'};
          if(req.method==='GET')return json(200,companionGet(store,companion[1],options));
          if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
          if(!principal.scopes.includes('platinum:sync'))return json(403,{error:'sync_scope_required'});
          if(!String(req.headers['content-type']??'').startsWith('application/json'))return json(415,{error:'json_required'});
          if(Number(req.headers['content-length']??0)>14*1024*1024)return json(413,{error:'request_too_large'});
          const parts=[];let bytes=0;for await(const part of req){const b=Buffer.from(part);bytes+=b.length;if(bytes>14*1024*1024)return json(413,{error:'request_too_large'});parts.push(b);}
          let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return json(400,{error:'invalid_json'});}
          return json(200,await handleCompanion(store,companion[1],body,options));
        }catch(e){
          const code=e.message;
          if(!COMPANION_ERRORS.includes(code))throw e;
          return json(code==='game_not_found'?404:code.includes('conflict')?409:400,{error:code});
        }finally{if(post)companionPosts--;}
      }
      const journey=/^\/api\/v2\/games\/([a-f0-9]{24})\/journey$/.exec(path);
      if(journey){
        try{
          if(req.method==='POST'){
            if(!principal.scopes.includes('platinum:sync'))return json(403,{error:'sync_scope_required'});
            let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>16384)return json(413,{error:'request_too_large'});}
            let command;try{command=JSON.parse(body);}catch{return json(400,{error:'invalid_json'});}
            journeyCommand(store,journey[1],command,at);
          }else if(req.method!=='GET')return json(405,{error:'method_not_allowed'});
          return json(200,{ownerId,...journeyContext(store,journey[1],{reveal:params.get('reveal')==='true'})});
        }catch(e){const known=['game_not_found','invalid_journey_command','invalid_journey_field','invalid_journey_value','invalid_journey_target','active_game_required','journey_revision_conflict','idempotency_conflict','journey_not_started','journey_already_started','already_retracted'];if(!known.includes(e.message))throw e;return json(e.message==='game_not_found'?404:e.message.includes('conflict')?409:400,{error:e.message});}
      }
      if(req.method==='GET'&&path==='/api/v2/library')return json(200,{ownerId,...libraryIndex(store,{query:(params.get('query')??'').slice(0,200),platform:['PS4','PS5','PS3','PSVITA'].includes(params.get('platform'))?params.get('platform'):null,activeOnly:params.get('active')==='true',sort:params.get('sort')??'title',offset:Math.min(100000,Math.floor(Math.max(0,Number(params.get('offset'))||0))),limit:Math.min(100,Math.max(1,Math.floor(Number(params.get('limit'))||40)))})});
      if(req.method==='GET'&&path==='/api/v2/import')return json(200,{ownerId,revision:store.meta('revision'),initialImport:store.meta('initialImport')});
      const match=/^\/api\/v2\/games\/([a-f0-9]{24})(\/active)?$/.exec(path);
      if(match){
        if(!store.rawGame(match[1]))return json(404,{error:'game_not_found'});
        if(req.method==='GET'&&!match[2]){
          if(!store.latest(match[1]))return json(409,{error:'catalog_not_ready'});
          const neutralGroups=params.get('neutralGroups')==='true';
          return json(200,{ownerId,revision:store.meta('revision'),groupSemantics:neutralGroups?'source_supported':'legacy_group_id_heuristic',snapshot:snapshotFromStore(store,[match[1]],new Date(clock()).toISOString(),{neutralGroups})});
        }
        if(req.method==='PUT'&&match[2]){
          if(!principal.scopes.includes('platinum:sync'))return json(403,{error:'sync_scope_required'});
          let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>128)return json(413,{error:'request_too_large'});}
          let value;try{value=JSON.parse(body);}catch{return json(400,{error:'invalid_json'});}
          if(!value||Object.keys(value).length!==1||typeof value.active!=='boolean')return json(400,{error:'invalid_active_flag'});
          setActiveGame(store,match[1],value.active);return json(200,{ownerId,active:value.active,revision:store.meta('revision')});
        }
      }
      return json(404,{error:'not_found'});
    }
    if(req.method==='GET'&&path==='/api/v1/me')return json(200,{ownerId,deviceId:id,revision:store.meta('revision')??0});
    if(req.method==='GET'&&path==='/api/v1/devices')return json(200,{devices:store.db.prepare('SELECT id,first_seen AS firstSeen,last_seen AS lastSeen,revoked_at AS revokedAt FROM app_sessions ORDER BY first_seen').all().map(d=>({...d,current:d.id===id}))});
    if(req.method==='DELETE'&&/^\/api\/v1\/devices\/[a-f0-9]{64}$/.test(path)){
      store.db.prepare('UPDATE app_sessions SET revoked_at=? WHERE id=?').run(at,path.split('/').at(-1));return json(200,{status:'revoked'});
    }
    if(req.method==='GET'&&path==='/api/v1/snapshot'){
      const games=activeFive(store),revision=store.meta('revision')??0;
      const snapshot=snapshotFromStore(store,games.map(g=>g.gameId));
      return json(200,{ownerId,revision,snapshot});
    }
    if(req.method==='GET'&&path==='/api/v1/status'){
      const games=activeFive(store),run=store.meta('lastRun');
      const sources=[...new Set(games.map(g=>g.source))];
      const running=store.db.prepare("SELECT started_at FROM sync_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").get();
      return json(200,{ownerId,revision:store.meta('revision')??0,source:sources.length===1?sources[0]:'mixed',freshFetchPerformed:false,
        games:games.map(g=>({id:g.gameId,source:g.source,observedAt:g.lastObservationAt,lastSuccessfulSyncAt:g.lastSuccessfulSyncAt,lastAttemptAt:g.lastAttemptAt,lastError:g.lastError})),
        lastAttemptAt:running?.started_at??run?.startedAt??null,lastResult:run?.status??null,lastErrors:run?.errors??[],nextAllowedAt:store.meta('nextAllowedAt'),
        running:!!running});
    }
    if(req.method==='POST'&&path==='/api/v1/sync'){
      if(!principal.scopes.includes('platinum:sync'))return json(403,{error:'sync_scope_required'});
      // Bodyless command: no arbitrary game, account, path or provider input.
      if(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding'])return json(400,{error:'body_not_allowed'});
      return json(202,await runSync({}));
    }
    return json(404,{error:'not_found'});
  };
}
