import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LibraryStore} from '../src/library-store.mjs';
import {createAIProvider,validateCompanionImages,validateAIOutput} from '../src/ai-provider.mjs';
const output={reply:'Контрактный тест, не live AI.',updates:[],advice:[],questions:[]};
const response=()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}],usage:{input_tokens:100,output_tokens:100}}));
const configured=(keyFile,more={})=>({enabled:true,budgetApproved:true,provider:'openai-responses',model:'gpt-5.4-mini',keyFile,visionEnabled:true,maxMonthlyUsd:5,inputPricePerMillion:.75,outputPricePerMillion:4.5,...more});
test('production default makes no request; approved budget and per-request external consent are both required',async()=>{
 let calls=0;const provider=createAIProvider({fetchImpl:()=>{calls++;assert.fail('must not call');}});assert.equal(provider.status().configured,false);await assert.rejects(provider.generate({text:'hello'}),/not_configured/);assert.equal(calls,0);
 const store=new LibraryStore(':memory:');try{const p=createAIProvider({config:configured('/outside/config/key'),store,fetchImpl:()=>{calls++;}});await assert.rejects(p.generate({text:'hello',context:{}}),/consent_required/);assert.equal(calls,0);}finally{store.close();}
});
test('image validation rejects URLs, wrong MIME/magic, excessive counts and pixel bombs',()=>{
 assert.throws(()=>validateCompanionImages([{mimeType:'image/png',dataBase64:'https://example.invalid/image.png'}]),/invalid_companion_images/);assert.throws(()=>validateCompanionImages(new Array(4).fill({})),/invalid_companion_images/);
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(400,16);png.writeUInt32BE(800,20);const valid={mimeType:'image/png',dataBase64:png.toString('base64')};assert.equal(validateCompanionImages([valid])[0].width,400);assert.throws(()=>validateCompanionImages([{...valid,mimeType:'image/jpeg'}]),/invalid_companion_images/);png.writeUInt32BE(8192,16);png.writeUInt32BE(8192,20);assert.throws(()=>validateCompanionImages([{...valid,dataBase64:png.toString('base64')}]),/invalid_companion_images/);
 assert.throws(()=>validateAIOutput({...output,earned:true}),/invalid_output/);assert.throws(()=>validateAIOutput({...output,advice:[{ruleId:'invented',category:'MUST'}]}),/invalid_output/);
});
test('an extracted update without any observation evidence is rejected rather than becoming a proposal',()=>{
 const update={field:'currentRegion',value:'Оксенфурт',operation:'set',wording:'Предполагаемая локация',evidence:[],confidence:'clear'};
 assert.throws(()=>validateAIOutput({...output,updates:[update]}),/ai_invalid_output/);
 assert.equal(validateAIOutput({...output,updates:[{...update,evidence:['text']}]}).updates[0].value,'Оксенфурт');
});
test('Responses adapter sends strict text+vision format and reserves/reconciles persistent budget without leaking key in status',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pc-ai-contract-')),keyFile=join(dir,'test-key');writeFileSync(keyFile,'sk-fixture_only_0000',{mode:0o600});const store=new LibraryStore(':memory:');let time=Date.now(),calls=0;
 try{const provider=createAIProvider({config:configured(keyFile,{dailyRequestLimit:1}),store,clock:()=>time,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'error');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal(body.max_output_tokens,3000);assert.equal(body.input[0].content[1].type,'input_image');return response();}});
 const result=await provider.generate({requestId:'contract_budget_request1',text:'Скриншот',context:{only:'safe'},images:[{index:0,mimeType:'image/png',dataBase64:'contract-test-bytes',width:400,height:800}],consentExternal:true});assert.deepEqual(result,output);assert.equal(calls,1);assert.ok(!JSON.stringify(provider.status()).includes('CONTRACT_TEST_ONLY'));
 const ledger=store.db.prepare('SELECT * FROM ai_budget_events').get();assert.ok(ledger.reserved_microusd>ledger.charged_microusd);assert.equal(ledger.status,'usage_confirmed');time+=11_000;await assert.rejects(provider.generate({requestId:'contract_budget_request2',text:'hello',context:{},consentExternal:true}),/daily_limit/);assert.equal(calls,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('hard monthly cap is checked before fetch; unknown outcome keeps reservation and same request is never paid twice',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pc-ai-contract-')),keyFile=join(dir,'test-key');writeFileSync(keyFile,'sk-fixture_only_0000',{mode:0o600});const store=new LibraryStore(':memory:');let time=Date.now(),calls=0;
 try{const tooSmall=createAIProvider({config:configured(keyFile,{maxMonthlyUsd:.001}),store,clock:()=>time,fetchImpl:()=>{calls++;assert.fail('over budget must fail before request');}});await assert.rejects(tooSmall.generate({requestId:'denied_budget',text:'test',context:{},consentExternal:true}),/budget_exhausted/);assert.equal(calls,0);
 const provider=createAIProvider({config:configured(keyFile),store,clock:()=>time,fetchImpl:async()=>{calls++;throw Object.assign(new Error('raw vendor credential error must be discarded'),{name:'TimeoutError'});}});const input={requestId:'unknown_budget_request',text:'test',context:{},consentExternal:true};await assert.rejects(provider.generate(input),/^Error: ai_timeout$/);assert.equal(calls,1);const ledger=store.db.prepare('SELECT * FROM ai_budget_events').get();assert.equal(ledger.status,'outcome_unknown');assert.equal(ledger.charged_microusd,null);assert.ok(ledger.reserved_microusd>0);time+=11_000;await assert.rejects(provider.generate(input),/already_attempted/);assert.equal(calls,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('unexpected provider usage is recorded in full and halts future requests instead of silently understating spend',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pc-ai-contract-')),keyFile=join(dir,'test-key');writeFileSync(keyFile,'sk-fixture_only_0000',{mode:0o600});const store=new LibraryStore(':memory:');let calls=0,time=Date.now();
 try{const provider=createAIProvider({config:configured(keyFile),store,clock:()=>time,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({status:'completed',output:[],usage:{input_tokens:100_000_000,output_tokens:3000}}));}});await assert.rejects(provider.generate({requestId:'unexpected_usage1',text:'test',context:{},consentExternal:true}),/budget_estimate_exceeded/);const ledger=store.db.prepare('SELECT * FROM ai_budget_events').get();assert.equal(ledger.status,'estimate_exceeded');assert.ok(ledger.charged_microusd>ledger.reserved_microusd);time+=11_000;await assert.rejects(provider.generate({requestId:'unexpected_usage2',text:'test',context:{},consentExternal:true}),/budget_estimate_exceeded/);assert.equal(calls,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
