import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {testState,pack} from './live-fixture.mjs';
import {StateStore} from '../src/state-store.mjs';
import {recordAnswer} from '../src/interview.mjs';
import {startSession,endSession} from '../src/sessions.mjs';
test('actual MCP rereads a changed roadmap and a new client resumes from persisted Session Snapshot; isolated test run',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'platinum-resume-')),store=new StateStore(join(dir,'state.json'));
  const clients=[];
  const connect=async()=>{const client=new Client({name:'explicit-test-run',version:'0.1.0'});clients.push(client);await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp-server.mjs',import.meta.url))],env:{...process.env,PLATINUM_STATE_PATH:store.path}}));return client;};
  const call=async client=>{const result=await client.callTool({name:'get_progress_context',arguments:{}});assert.notEqual(result.isError,true);return JSON.parse(result.content[0].text);};
  try{
    const state=await testState({goal:'base_platinum',gamePatch:'4.x',currentMilestone:'keira_chain',mode:'NG',startDeathMarch:'yes',difficultyLowered:'no',keiraChain:'active',keiraOutcome:'pending'});await store.writeInitial(state);
    const firstClient=await connect();const before=await call(firstClient);assert.equal(before.stateRevision,1);assert.equal(before.roadmap.mode,'roadmap_v0');
    await startSession(store,{expectedRevision:1});await recordAnswer(store,pack,{fact:'currentMilestone',value:'keira_final_choice',expectedRevision:2});
    const changed=await call(firstClient);assert.equal(changed.stateRevision,3);assert.ok(changed.roadmap.beforeProgressing.some(r=>r.ruleId==='w3.keira.save'));assert.notDeepEqual(changed.roadmap,before.roadmap);
    await endSession(store,pack,{expectedRevision:3});await firstClient.close();
    const secondClient=await connect(),resumed=await call(secondClient);assert.equal(resumed.stateRevision,4);assert.equal(resumed.lastSessionSnapshot.lastKnownMilestone.value,'keira_final_choice');assert.equal(resumed.lastSessionSnapshot.resultingStateRevision,4);assert.equal(resumed.activeRun.id,state.player.activeRun.id);assert.equal(resumed.accountTrophySummary.total,79);assert.equal(resumed.freshness.source,'direct_psn_api');assert.ok(Buffer.byteLength(JSON.stringify(resumed))<20000);
  }finally{for(const client of clients)await client.close();await unlink(store.path);await rmdir(dir);}
});
