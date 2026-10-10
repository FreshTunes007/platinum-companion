import test from 'node:test';
import assert from 'node:assert/strict';
import {assertListenPolicy} from '../src/listen-policy.mjs';
import {readFileSync} from 'node:fs';
test('private container bind requires both explicit configuration and container environment',()=>{
  assert.doesNotThrow(()=>assertListenPolicy({},{}));
  assert.throws(()=>assertListenPolicy({bindHost:'0.0.0.0'},{}));
  assert.throws(()=>assertListenPolicy({bindHost:'0.0.0.0',privateNetworkApproved:true},{}));
  assert.throws(()=>assertListenPolicy({bindHost:'0.0.0.0'},{PLATINUM_PRIVATE_CONTAINER:'1'}));
  assert.doesNotThrow(()=>assertListenPolicy({bindHost:'0.0.0.0',privateNetworkApproved:true},{PLATINUM_PRIVATE_CONTAINER:'1'}));
  assert.throws(()=>assertListenPolicy({bindHost:'192.0.2.1',privateNetworkApproved:true},{PLATINUM_PRIVATE_CONTAINER:'1'}));
  assert.doesNotThrow(()=>assertListenPolicy({bindHost:'0.0.0.0',publicationApproved:true},{}));
});

test('Keycloak realm explicitly supplies subject required by strict resource authorization',()=>{
  const realm=JSON.parse(readFileSync(new URL('../deploy/keycloak-realm.example.json',import.meta.url)));
  const client=realm.clients.find(c=>c.clientId==='companion-android');
  assert.ok(client.protocolMappers.some(m=>m.protocolMapper==='oidc-sub-mapper'&&m.config['access.token.claim']==='true'));
  assert.equal(client.attributes['pkce.code.challenge.method'],'S256');
  assert.equal(client.directAccessGrantsEnabled,false);
  assert.deepEqual(client.redirectUris,['app.platinumcompanion.android:/oauthredirect']);
});
