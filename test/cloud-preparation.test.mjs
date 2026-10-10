import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkCloudPreparation} from '../src/cloud-preparation.mjs';
const fixture=()=>[JSON.parse(readFileSync(new URL('../deploy/companion.example.json',import.meta.url))),JSON.parse(readFileSync(new URL('../deploy/keycloak-realm.example.json',import.meta.url)))];
test('prepared templates never imply production readiness or DNS ownership',()=>{
  const report=checkCloudPreparation(...fixture());assert.equal(report.preparation,'PASS');assert.equal(report.production,'NOT_VERIFIED');assert.ok(report.pending.includes('public_tls_chain'));assert.ok(report.pending.includes('real_owner_subject_missing'));assert.equal(report.performedNetworkRequests,false);
});
test('cross-file issuer, audience and scope drift fails closed',()=>{
  for(const modify of [c=>c.oauth.jwksUri='https://other.invalid/certs',c=>c.oauth.audience='other',c=>c.oauth.requireSessionId=false]){const [c,r]=fixture();modify(c);assert.equal(checkCloudPreparation(c,r).preparation,'FAIL');}
});
test('native client cannot silently lose PKCE or gain wildcard redirects/password grants',()=>{
  for(const modify of [c=>delete c.attributes['pkce.code.challenge.method'],c=>c.redirectUris=['*'],c=>c.directAccessGrantsEnabled=true,c=>c.optionalClientScopes=[],c=>c.fullScopeAllowed=true]){const [c,r]=fixture();modify(r.clients[0]);assert.equal(checkCloudPreparation(c,r).preparation,'FAIL');}
});
test('Sony transfer/scheduler remain disabled during preparation',()=>{
  for(const key of ['credentialInstallApproved','scheduledSyncEnabled']){const [c,r]=fixture();c[key]=true;assert.ok(checkCloudPreparation(c,r).errors.includes('sony_disabled_until_separate_approval'));}
});
