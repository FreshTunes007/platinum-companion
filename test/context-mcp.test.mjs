import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,unlink,rmdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {providers} from './fixtures.mjs';
import {emptyAccountState,ingestProvider} from '../src/account-state.mjs';
import {StateStore} from '../src/state-store.mjs';
import {recordAnswer} from '../src/interview.mjs';
const pack=JSON.parse(await readFile(new URL('../knowledge/witcher3-ps5-v0.json',import.meta.url),'utf8'));

test('actual SDK MCP tools/list + call: independent writes visible without reconnect or state in tool arguments',async()=>{
  const p=providers(),account=(await ingestProvider(emptyAccountState(p.binding.accountId,p.binding.set.id),p.stratege)).state;
  const dir=await mkdtemp(join(tmpdir(),'platinum-mcp-')),path=join(dir,'state.json'),store=new StateStore(path);
  const client=new Client({name:'synthetic-mcp-test',version:'0.1.0'});
  const state={identity:{accountId:account.accountId},account,trophyMapping:{},player:{dataKind:'synthetic_test',stateRevision:1,activeRun:{id:'synthetic',gameSetId:account.setId},facts:{currentRegion:{value:'White Orchard',source:'synthetic_test'},currentMilestone:{value:'before_griffin',source:'synthetic_test'}},conflicts:[]}};
  await store.writeInitial(state);
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp-server.mjs',import.meta.url))],env:{...process.env,PLATINUM_STATE_PATH:path}}));
    const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),['game_status','get_journey_context','get_progress_context','list_games','list_trophies','sync_psn','unearned_trophies']);
    assert.equal(tools.tools.find(t=>t.name==='get_progress_context').annotations.readOnlyHint,true);
    const call=async()=>{const result=await client.callTool({name:'get_progress_context',arguments:{}});assert.notEqual(result.isError,true);return JSON.parse(result.content[0].text);};
    const first=await call();assert.equal(first.stateRevision,1);assert.equal(first.currentRunFacts.currentRegion.value,'White Orchard');
    await store.update(1,s=>{s.player.facts.currentRegion={value:'Velen',source:'synthetic_test'};s.player.facts.currentMilestone={value:'first_visit_crow_perch',source:'synthetic_test'};return s;});
    const second=await call();assert.equal(second.stateRevision,2);assert.equal(second.currentRunFacts.currentRegion.value,'Velen');
    assert.equal(second.currentRunFacts.currentMilestone.value,'first_visit_crow_perch');
    assert.equal(second.knowledgePackVersion,pack.version);assert.equal(second.evidenceCoverage.ruleCount,12);
    assert.equal(second.activeRun.dataKind,'synthetic_test');assert.ok(!('observations' in second));
    assert.ok(Buffer.byteLength(JSON.stringify(second))<14000);
    await recordAnswer(store,pack,{fact:'goal',value:'base_platinum',expectedRevision:2});
    const third=await call();assert.equal(third.stateRevision,3);assert.equal(third.currentRunFacts.goal.source,'user_confirmation');
    assert.equal(third.currentRunFacts.goal.value,'base_platinum');
    await assert.rejects(store.update(2,s=>s),/state_revision_conflict/);
    assert.equal((await call()).stateRevision,3);
  }finally{await client.close();await unlink(path);await rmdir(dir);}
});
