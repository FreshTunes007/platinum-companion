import test from 'node:test';
import assert from 'node:assert/strict';
import {recorded,fixtureBinding} from './live-fixture.mjs';
import {reconcileSources} from '../src/reconciliation.mjs';
test('reconciliation distinguishes MATCH/MISMATCH/UNKNOWN; absent fields and trademark/quotation typography are not conflicts',()=>{
  const manifest=recorded.set.catalog.map(t=>({psnId:t.id,psnName:t.name,strategeId:`fixture:${t.id}`}));
  const snapshot={counts:{all:79,base:53,dlc:26},source:{observedAt:'2026-10-02T08:58:46.378Z',syncAgeText:'1 дн. 7 часов'},trophies:manifest.map(m=>({id:m.strategeId,name:m.psnName.replace(/™/g,'').replace(/"/g,'«')+' / fixture translation',earned:recorded.account.trophies.find(t=>t.id===m.psnId).earned,earnedAt:null,earnedAtDisplay:null,earnedAtTimezone:null,groupId:null}))};
  const binding={trophyIds:Object.fromEntries(manifest.map(m=>[m.strategeId,fixtureBinding.trophyIds[m.psnId]])),groups:{baseId:'fixture-base',dlcId:'fixture-dlc'},groupEvidence:{baseEarned:4,dlcEarned:0}};
  delete snapshot.trophies[0].groupId;delete snapshot.trophies[0].earnedAt;
  const result=reconcileSources(recorded,snapshot,binding,manifest);
  assert.equal(result.summary.mismatches,0);assert.equal(result.summary.namesMatch,79);assert.equal(result.summary.earnedMatch,79);assert.equal(result.summary.unknownRowGroups,79);assert.equal(result.summary.unknownEarnedTimestampComparisons,4);assert.ok(result.aggregate.every(a=>a.status==='MATCH'));
  snapshot.trophies[0].earned=true;
  assert.equal(reconcileSources(recorded,snapshot,binding,manifest).summary.mismatches,1);
});
