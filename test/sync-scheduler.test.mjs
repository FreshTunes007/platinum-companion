import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncScheduler} from '../src/sync-scheduler.mjs';
function fixture(){const data=new Map();return {meta:k=>data.get(k),setMeta:(k,v)=>data.set(k,v)};}
test('six-hour deadline survives restart, performs one catch-up and waits six hours again',async()=>{
 const store=fixture();let now=Date.parse('2026-10-09T00:00:00Z'),calls=0;
 const coordinator={request:async()=>{calls++;return {status:'accepted'};},drain:async()=>{}};
 let scheduler=createSyncScheduler({store,coordinator,clock:()=>now,intervalMs:100});
 assert.equal(scheduler.intervalMs,21600000);const due=store.meta('autoSyncNextAt');
 now+=3600000;scheduler=createSyncScheduler({store,coordinator,clock:()=>now});assert.equal(store.meta('autoSyncNextAt'),due);
 assert.equal((await scheduler.tick()).status,'not_due');now+=21600000;
 await scheduler.tick();await scheduler.tick();assert.equal(calls,1);assert.equal(Date.parse(store.meta('autoSyncNextAt')),now+21600000);
});
test('scheduled catch-up honors Sony cooldown and shares in-progress queue',async()=>{
 const store=fixture(),now=Date.now();store.setMeta('autoSyncNextAt',new Date(now-1).toISOString());
 const next=new Date(now+300000).toISOString();let status='cooldown',drains=0;
 const scheduler=createSyncScheduler({store,clock:()=>now,coordinator:{request:async()=>({status,nextAllowedAt:next}),drain:async()=>{drains++;}}});
 await scheduler.tick();assert.equal(store.meta('autoSyncNextAt'),next);assert.equal(drains,0);
 store.setMeta('autoSyncNextAt',new Date(now-1).toISOString());status='in_progress';await scheduler.tick();assert.equal(drains,0);
});
