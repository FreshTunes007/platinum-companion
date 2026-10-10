import test from 'node:test';
import assert from 'node:assert/strict';
import {migrationTransport} from '../src/migration-transport.mjs';
const approved={transferApproved:true,hostIdentityVerified:true,remoteLayout:'compose-production',sshDestination:'platinum-vps',sshConfigPath:'C:/Users/Test Owner/.ssh/config'};
test('migration cannot proceed without transfer permission and an explicit host trust decision',()=>{
  for(const change of [{transferApproved:false},{hostIdentityVerified:false},{transferApproved:undefined},{hostIdentityVerified:undefined}])assert.throws(()=>migrationTransport({...approved,...change}));
});

test('accepted TOFU permits preparation but never authorizes Sony transfer or key replacement',()=>{
  const config={...approved,hostIdentityVerified:false,hostTrust:'TRUST_ON_FIRST_USE',tofuRiskAccepted:true};
  const args=migrationTransport(config);
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('UpdateHostKeys=no'));
  for(const change of [{transferApproved:false},{transferApproved:undefined},{tofuRiskAccepted:false},{tofuRiskAccepted:undefined},{hostTrust:'UNVERIFIED'}])
    assert.throws(()=>migrationTransport({...config,...change}));
});
test('production migration uses pinned SSH config and current production compose with sudo',()=>{
  const args=migrationTransport(approved);
  assert.equal(args[args.indexOf('-F')+1],approved.sshConfigPath);
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.match(args.at(-1),/^sudo -n docker compose -p platinum-companion /);
  assert.match(args.at(-1),/\/current\/deploy\/compose.production.yaml exec -T companion/);
  assert.ok(!args.some(a=>a.includes('refreshToken')));
});
test('migration transport rejects injected hosts, layouts and malformed config paths',()=>{
  for(const change of [{sshDestination:'-oProxyCommand=bad'},{sshDestination:'host;bad'},{remoteLayout:'compose;bad'},{sshConfigPath:'relative/path'},{sshConfigPath:'/etc/ssh\nconfig'}])assert.throws(()=>migrationTransport({...approved,...change}));
});

test('Freshoryx preparation targets the actual production project and preserves both approval gates',()=>{
  const config={...approved,remoteLayout:'freshoryx-production'};
  const command=migrationTransport(config).at(-1);
  assert.match(command,/compose -p platinum-production --env-file \/var\/lib\/platinum-companion\/compose.env/);
  assert.match(command,/compose.freshoryx.yaml exec -T companion/);
  for(const field of ['transferApproved','hostIdentityVerified'])assert.throws(()=>migrationTransport({...config,[field]:false}),/migration_approval_and_verified_host_required/);
});
