import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validatePack} from '../src/knowledge-validation.mjs';
const pack=JSON.parse(await readFile(new URL('../knowledge/witcher3-ps5-v0.json',import.meta.url),'utf8'));
test('knowledge v0 has 12 fully attributed rules, narrow scope and explicit version limits',()=>{
  assert.deepEqual(validatePack(pack),{rules:12,valid:true});
  assert.equal(pack.scope.fullGame,false);assert.equal(pack.appliesTo.patchVerified,false);
  assert.ok(pack.rules.every(r=>r.appliesTo.platform==='PS5' && r.checkedAt==='2026-10-02'));
  assert.ok(pack.rules.some(r=>r.verificationStatus==='DISPUTED'&&r.contradictions.length));
  assert.equal(pack.sources.find(s=>s.id==='psnp').access,'unavailable');
});
test('unknown/disputed rules cannot declare unconditional safe deferral',()=>{
  const bad=structuredClone(pack);bad.rules.find(r=>r.verificationStatus==='DISPUTED').canDefer.policy='yes';
  assert.throws(()=>validatePack(bad),/unsafe_deferral/);
});
