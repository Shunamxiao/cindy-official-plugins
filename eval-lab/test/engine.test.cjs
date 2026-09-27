const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const {dispatch}=require('../node/engine.cjs');
test('unavailable imported banks do not hide valid banks or existing results',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-missing-import-'));
 try{
  const good=path.join(root,'good');await fs.mkdir(good);
  await fs.writeFile(path.join(good,'distribution.json'),JSON.stringify({format:'eval-lab-bank-v1',questions:[{key:'fixture@v1',title:'Fixture'}]}));
  const catalog=await dispatch('bank',{root,importedBanks:[{id:'offline',path:path.join(root,'missing')},{id:'good',path:good}]});
  assert.equal(catalog.questions[0].key,'imported:good:fixture@v1');assert.equal(catalog.errors[0].id,'offline');
  assert.ok(!JSON.stringify(catalog.errors).includes(root));assert.deepEqual(await dispatch('runs',{root}),[]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('real default question: prepare isolated workspace, grade frozen baseline, export selected result',async()=>{const bank=process.env.EVAL_TEST_BANK;if(!bank)return;const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-engine-'));try{const p={root,bank};const catalog=await dispatch('bank',p);assert.equal(catalog.questions.length,7);const importedBanks=[{id:'first-bank',path:bank},{id:'second-bank',path:bank}];const imported=await dispatch('bank',{root,importedBanks});assert.equal(imported.questions.length,14);assert.ok(imported.questions.some(q=>q.key==='imported:second-bank:task-switch-cache@v3'));const r=await dispatch('prepare',{root,importedBanks,question:'imported:first-bank:task-switch-cache@v3',model:'test-fixture-not-a-model-run',harness:'test',provider:'test',effort:'test'});await assert.rejects(fs.access(path.join(r.workspace,'author')));const grade=await dispatch('grade',{...p,runId:r.runId,receipt:{channel:'Orca Worker',sessionId:'mock-receipt-for-engine-test',completedAt:new Date().toISOString()}});assert.equal(grade.status,'graded');assert.equal(grade.score,0);const rows=await dispatch('runs',p);assert.equal(rows.length,1);const exported=await dispatch('export',{...p,runIds:[r.runId]});assert.ok(exported.html.includes('0 / 1'));assert.ok(!exported.html.includes(root));const again=await dispatch('grade',{...p,runId:r.runId,receipt:{channel:'Orca Worker',sessionId:'mock',completedAt:new Date().toISOString()}});assert.equal(again.score,0);assert.equal(again.bank,undefined);assert.equal(again.receipt,undefined);}finally{await fs.rm(root,{recursive:true});}});
test('host-owned empty workspace is populated once, real task receipt grades the same files',async()=>{
 const bank=process.env.EVAL_TEST_BANK;if(!bank)return;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-host-workspace-'));
 try{
  const workspace=path.join(root,'host-task');await fs.mkdir(workspace);
  const p={root,bank,runId:'host-owned-run',workspace,question:'task-switch-cache@v3',model:'fixture-model',harness:'codex',provider:'fixture-provider',effort:'high',executionChannel:'Cindy task'};
  const r=await dispatch('prepare',p);assert.equal(r.workspace,await fs.realpath(workspace));assert.equal((await dispatch('prepare',p)).runId,r.runId);
  await assert.rejects(dispatch('prepare',{...p,runId:'different-run'}),/不是空目录/);
  const receipt={channel:'Cindy task',sessionId:'fixture-task',runId:'fixture-host-run',acceptedAt:1000,startedAt:1000,timingBasis:'host-message-window',completedAt:new Date(2000).toISOString(),execution:{instanceId:'fixture',generation:1},acceptedConfig:{agentKind:'codex',model:p.model,providerId:p.provider,effort:p.effort,fastMode:false}};
  const grade=await dispatch('grade',{root,runId:r.runId,receipt});assert.equal(grade.status,'graded');assert.equal(grade.score,0);assert.equal(grade.durationSeconds,1);assert.equal(grade.executionChannel,'Cindy task');
 }finally{await fs.rm(root,{recursive:true});}
});
test('coordinator parallel capacity and explicit concurrency are frozen in plan',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-parallel-'));
 try{
  const a=await dispatch('coordinator_plan',{root,workspace:root,id:'parallel-auto',items:[]});
  assert.match(a.prompt,/填满宿主实际可用/);assert.match(a.prompt,/create_workers/);
  assert.equal(JSON.parse(await fs.readFile(a.path)).concurrency,null);
  const b=await dispatch('coordinator_plan',{root,workspace:root,id:'parallel-two',items:[],concurrency:2});
  assert.match(b.prompt,/同时最多 2 份/);
  assert.equal(JSON.parse(await fs.readFile(b.path)).concurrency,2);
  await assert.rejects(dispatch('coordinator_plan',{root,workspace:root,id:'invalid',items:[],concurrency:0}),/正整数/);
 }finally{await fs.rm(root,{recursive:true});}
});

test('ungraded terminal failures survive reload without replacing existing scores',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-failed-run-'));
 try{
  const dir=path.join(root,'eval-lab-data/runs/failed-run');await fs.mkdir(dir,{recursive:true});
  const run={runId:'failed-run',batchId:'old-batch',title:'Fixture',status:'prepared',questionId:'fixture',revision:'v1',model:'model',provider:'fixture',harness:'codex',effort:'high'};
  await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(run));
  const p={root,runId:run.runId,reason:'private diagnostic /local/path',receipt:{workerId:'w',sessionId:'s',completedAt:2000,status:'error'}};
  await dispatch('record_failure',p);await dispatch('record_failure',p);await dispatch('record_failure',{...p,receipt:{...p.receipt,usage:{costUSD:1}}});
  const rows=await dispatch('runs',{root});assert.equal(rows[0].status,'failed');assert.equal(rows[0].score,null);assert.equal(rows[0].batchId,'old-batch');assert.ok(!JSON.stringify(rows).includes('/local/path'));
  const stored=JSON.parse(await fs.readFile(path.join(dir,'run.json')));assert.equal(stored.reason,p.reason);assert.deepEqual(stored.terminalReceipt,p.receipt);
  await assert.rejects(dispatch('record_failure',{...p,receipt:{...p.receipt,sessionId:'other'}}),/conflict/);
  const result={...run,status:'graded',score:0.5,scoreExact:'1/2'};await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result));
  await dispatch('record_failure',p);assert.equal((await dispatch('runs',{root}))[0].scoreExact,'1/2');assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'result.json'))),result);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('file manifests hash streams and respond to cancellation without whole-file reads',async()=>{
 const {files}=require('../node/engine.cjs'),crypto=require('node:crypto');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-stream-hash-')),data=Buffer.alloc(2*1024*1024,31),original=fs.readFile;
 try{
  await fs.writeFile(path.join(root,'large'),data);
  fs.readFile=async()=>{throw Error('whole-file read forbidden');};
  assert.deepEqual(await files(root),{large:crypto.createHash('sha256').update(data).digest('hex')});
  const controller=new AbortController();controller.abort(Error('cancelled'));
  await assert.rejects(files(root,'',controller.signal),/cancelled/);
 }finally{fs.readFile=original;await fs.rm(root,{recursive:true,force:true});}
});
test('prepare cleans partial copies and records, then retries the same run',async()=>{
 const {files}=require('../node/engine.cjs');
 for(const external of [false,true])for(const fail of ['copy','record']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-prepare-failure-')),bank=path.join(root,'bank'),q=path.join(bank,'q'),candidate=path.join(q,'candidate');
  const cp=fs.cp,open=fs.open;
  try{
   await fs.mkdir(candidate,{recursive:true});await fs.writeFile(path.join(candidate,'a.txt'),'answer');
   await fs.writeFile(path.join(q,'question.json'),JSON.stringify({id:'fixture',revision:'v1',scoringVersion:'v1',title:'Fixture',groups:[{id:'core',weight:'1',mode:'all',items:['a']}]}));
   await fs.writeFile(path.join(bank,'distribution.json'),JSON.stringify({format:'eval-lab-bank-v1',questions:[{key:'fixture@v1',path:'q',files:await files(q)}]}));
   const workspace=path.join(root,'host');if(external)await fs.mkdir(workspace);
   const p={root,bank,question:'fixture@v1',runId:'retry',model:'m',provider:'p',harness:'h',effort:'e',...(external?{workspace}:{})};
   fs.cp=async(...args)=>{await cp(...args);if(fail==='copy')throw Error('copy interrupted');};
   fs.open=async(...args)=>{const h=await open(...args);if(fail==='record'&&String(args[0]).endsWith('/run.json')){h.writeFile=async()=>{throw Error('record interrupted');};}return h;};
   await assert.rejects(dispatch('prepare',p),/interrupted/);fs.cp=cp;fs.open=open;
   assert.deepEqual(await dispatch('runs',{root}),[]);
   const abandoned=path.join(root,'eval-lab-data/runs/abandoned');await fs.mkdir(abandoned,{recursive:true});
   assert.deepEqual(await dispatch('runs',{root}),[]);
   if(external)assert.deepEqual(await fs.readdir(workspace),[]);
   const r=await dispatch('prepare',p);assert.equal(await fs.readFile(path.join(r.workspace,'a.txt'),'utf8'),'answer');
   assert.equal((await dispatch('prepare',p)).runId,r.runId);
  }finally{fs.cp=cp;fs.open=open;await fs.rm(root,{recursive:true,force:true});}
 }
});

test('coordinator handoff preserves exact legacy membership and writes state inside Host workspace',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-coordinator-'));
 try{
  const workspace=path.join(root,'host');await fs.mkdir(workspace);
  const old=path.join(root,'eval-lab-data/coordination/batch.json'),data={concurrency:2,items:[{runId:'already-done'},{runId:'still-pending'}]};await fs.mkdir(path.dirname(old),{recursive:true});await fs.writeFile(old,JSON.stringify(data));
  const p={root,workspace,id:'batch',legacy:true,items:[]},plan=await dispatch('coordinator_plan',p);
  assert.equal(path.dirname(plan.path),path.join(await fs.realpath(workspace),'eval-coordination'));
  assert.deepEqual(JSON.parse(await fs.readFile(plan.path)),data);assert.deepEqual(await dispatch('coordinator_plan',p),plan);
  const state=await dispatch('coordinator_state',{root,workspace,id:'batch',assignments:[],settled:['already-done']});
  assert.equal(path.dirname(state.path),path.dirname(plan.path));assert.match(plan.prompt,new RegExp('batch-state.json'));
  await dispatch('coordinator_state',{root,workspace,id:'batch',assignments:['still-pending']});assert.deepEqual(JSON.parse(await fs.readFile(state.path)).assignments,['still-pending']);
  assert.deepEqual(JSON.parse(await fs.readFile(old)),data);
  await assert.rejects(dispatch('coordinator_plan',{root,workspace,id:'batch',items:[]}),/changed/);
  for(const method of ['coordinator_plan','coordinator_state'])await assert.rejects(dispatch(method,{root,id:'batch'}),/主任务目录/);
  const alias=path.join(root,'alias');await fs.symlink(workspace,alias,'junction');
  for(const method of ['coordinator_plan','coordinator_state'])await assert.rejects(dispatch(method,{root,workspace:alias,id:'batch'}),/主任务目录/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
