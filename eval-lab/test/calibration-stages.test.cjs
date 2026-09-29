const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {dispatch}=require('../node/engine.cjs');
test('explicit retry retains the failed report and has a stable identity after lost replies',()=>fixture(async(root)=>{
 const p={root,id:'sample',revision:'v1'},child=require('node:child_process'),spawn=child.spawn;
 child.spawn=(command,args,options)=>spawn(path.join(root,'missing-python'),args,options);
 let failed;
 try{failed=await dispatch('calibrate',p);}finally{child.spawn=spawn;}
 const old=path.join(root,'eval-lab-data/calibrations',failed.checkId,'calibration.json'),bytes=await fs.readFile(old);
 const retry={...p,retryFrom:failed.checkId};
 const [a,b]=await Promise.all([dispatch('calibrate_begin',retry),dispatch('calibrate_begin',retry)]);
 assert.notEqual(a.checkId,failed.checkId);assert.deepEqual(a,b);
 assert.deepEqual(await dispatch('calibrate_begin',p),a);
 const result=await dispatch('calibrate',retry);assert.equal(result.ok,true);
 assert.deepEqual(await dispatch('calibrate',retry),result);
 assert.deepEqual(await fs.readFile(old),bytes);
 await assert.rejects(dispatch('calibrate_begin',{...p,retryFrom:a.checkId}),/retry|重试/);
}));
test('retry captures a corrected draft while keeping the failed snapshot and refusing unknown execution',()=>fixture(async(root,directory)=>{
 const p={root,id:'sample',revision:'v1'},grade=path.join(directory,'author/grade.py'),original=await fs.readFile(grade);
 await fs.writeFile(grade,"import json,sys,pathlib\npathlib.Path(sys.argv[2]).write_text(json.dumps({'status':'graded','items':{'a':True}}))\n");
 const failed=await dispatch('calibrate',p),old=path.join(root,'eval-lab-data/calibrations',failed.checkId,'calibration.json'),bytes=await fs.readFile(old);
 await fs.writeFile(grade,original.toString().replace("'a':","'b':"));
 const specFile=path.join(directory,'question.json'),spec=JSON.parse(await fs.readFile(specFile));spec.title='Corrected';spec.groups[0].items=['b'];await fs.writeFile(specFile,JSON.stringify(spec));
 await assert.rejects(dispatch('calibrate_begin',p),/明确重试/);
 assert.equal((await fs.readdir(path.join(root,'eval-lab-data/calibrations'))).length,1);
 const retry={...p,retryFrom:failed.checkId},a=await dispatch('calibrate_begin',retry);
 assert.notEqual(a.checkId,failed.checkId);assert.deepEqual(await dispatch('calibrate_begin',retry),a);assert.deepEqual(await dispatch('calibrate_begin',p),a);
 assert.equal((await dispatch('calibrate',retry)).ok,true);assert.deepEqual(await fs.readFile(old),bytes);
 await fs.appendFile(grade,'\n# later edit');assert.deepEqual(await dispatch('calibrate_begin',retry),a);await assert.rejects(dispatch('calibrate',retry),/Draft changed/);
}));
test('explicit retry rejects unfinished or unknown calibration executions',()=>fixture(async(root)=>{
 const p={root,id:'sample',revision:'v1'},a=await dispatch('calibrate_begin',p);
 await fs.mkdir(path.join(root,'eval-lab-data/calibrations',a.checkId,'attempt-0'));
 await fs.appendFile(path.join(root,'eval-lab-data/drafts/sample/v1/author/grade.py'),'\n# changed while unknown');
 await assert.rejects(dispatch('calibrate_begin',{...p,retryFrom:a.checkId}),/retry|重试/);
 assert.equal((await fs.readdir(path.join(root,'eval-lab-data/calibrations'))).length,1);
}));
test('spawn failure receipts remain readable and finish without re-executing',()=>fixture(async(root)=>{
 const cp=require('node:child_process'),spawn=cp.spawn;
 const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId};
 let starts=0;cp.spawn=(command,args,options)=>{starts++;return spawn(path.join(root,'missing-python'),args,options);};
 try{for(let step=0;step<3;step++)assert.equal((await dispatch('calibrate_step',{...p,step})).status,'environment_invalid');}finally{cp.spawn=spawn;}
 const folder=path.join(root,'eval-lab-data/calibrations',checkId);
 const file=path.join(folder,'step-0.json'),value=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(value.execution.timedOut,false);assert.equal(starts,3);
 // Old versions wrote this exact spawn-error shape, without timedOut.
 value.execution={code:null,error:value.execution.error};await fs.writeFile(file,JSON.stringify(value));
 await fs.rename(file,path.join(folder,'attempt-0/receipt.json'));
 assert.equal((await dispatch('calibrate_step',{...p,step:0})).status,'environment_invalid');
 assert.equal((await dispatch('calibrate_step',{...p,step:1})).status,'environment_invalid');
 assert.equal((await dispatch('calibrate_finish',p)).ok,false);
 assert.equal((await dispatch('calibrate_finish',p)).ok,false);
 value.status='graded';value.raw={status:'graded',items:{a:false}};value.score=0;value.scoreExact='0';
 await fs.writeFile(file,JSON.stringify(value));
 await assert.rejects(dispatch('calibrate_step',{...p,step:0}),/receipt mismatch/);
}));
test('completed unpublished calibration receipt recovers without executing the grader again',()=>fixture(async(root)=>{
 const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId,step:0};
 const result=await dispatch('calibrate_step',p),folder=path.join(root,'eval-lab-data/calibrations',checkId);
 await fs.rename(path.join(folder,'step-0.json'),path.join(folder,'attempt-0/receipt.json'));
 await fs.unlink(path.join(folder,'attempt-0/source/answer'));
 assert.deepEqual(await Promise.all([dispatch('calibrate_step',p),dispatch('calibrate_step',p)]),[result,result]);
 assert.deepEqual(await dispatch('calibrate_step',p),result);
}));
test('malformed completed receipts are preserved but never published or replayed',()=>fixture(async(root)=>{
 const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId,step:0};
 await dispatch('calibrate_step',p);const folder=path.join(root,'eval-lab-data/calibrations',checkId),published=path.join(folder,'step-0.json'),pending=path.join(folder,'attempt-0/receipt.json');
 const result=JSON.parse(await fs.readFile(published,'utf8'));result.score=1;await fs.writeFile(pending,JSON.stringify(result));await fs.unlink(published);
 await assert.rejects(dispatch('calibrate_step',p),/receipt mismatch/);await assert.rejects(fs.access(published));
 assert.equal(await fs.readFile(pending,'utf8'),JSON.stringify(result));
}));
async function fixture(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-calibration-'));try{
 const {directory}=await dispatch('draft',{root,id:'sample',revision:'v1',records:[{sessionId:'synthetic',text:'Fixture'}]});
 for(const name of ['candidate','reference','controls/incomplete','author'])await fs.mkdir(path.join(directory,name),{recursive:true});
 await fs.writeFile(path.join(directory,'question.json'),JSON.stringify({id:'sample',revision:'v1',title:'Fixture',scoringVersion:'v1',groups:[{id:'g',weight:'1',mode:'all',items:['a']}]}));
 for(const name of ['candidate','reference','controls/incomplete'])await fs.writeFile(path.join(directory,name,'answer'),name==='reference'?'yes':'no');
 await fs.writeFile(path.join(directory,'author/grade.py'),"import pathlib,json,sys\np=pathlib.Path(sys.argv[1]); (p/'executed').write_text('once')\npathlib.Path(sys.argv[2]).write_text(json.dumps({'status':'graded','items':{'a':(p/'answer').read_text()=='yes'}}))\n");
 await fn(root,directory);
}finally{await fs.rm(root,{recursive:true,force:true});}}
test('calibration stages persist receipts and cannot finish before all controls',()=>fixture(async(root)=>{
 const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId};
 const one=await dispatch('calibrate_step',{...p,step:0});assert.equal(one.scoreExact,'0');assert.equal(one.execution,undefined);
 assert.equal((await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'})).checkId,checkId);
 const check=path.join(root,'eval-lab-data/calibrations',checkId);
 await fs.unlink(path.join(check,'attempt-0/source/answer'));
 assert.deepEqual(await dispatch('calibrate_step',{...p,step:0}),one);
 await assert.rejects(dispatch('calibrate_finish',p),{code:'ENOENT'});
 await dispatch('calibrate_step',{...p,step:1});await dispatch('calibrate_step',{...p,step:2});
 const result=await dispatch('calibrate_finish',p);assert.equal(result.ok,true);assert.equal(result.results.length,3);
 const original=await fs.readFile(path.join(check,'calibration.json'),'utf8');
 assert.deepEqual(await dispatch('calibrate_finish',p),result);assert.equal(await fs.readFile(path.join(check,'calibration.json'),'utf8'),original);
}));
test('unknown attempts are not replayed and changed drafts cannot finish',()=>fixture(async(root,directory)=>{
 const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId};
 const check=path.join(root,'eval-lab-data/calibrations',checkId);await fs.mkdir(path.join(check,'attempt-0'));
 assert.equal((await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'})).checkId,checkId);
 await assert.rejects(dispatch('calibrate_step',{...p,step:0}),{code:'EEXIST'});
 await fs.appendFile(path.join(directory,'reference/answer'),'changed');
 await assert.rejects(dispatch('calibrate_step',{...p,step:1}),/Draft changed/);
 await assert.rejects(dispatch('calibrate_finish',p),/Draft changed/);
}));
test('legacy random check IDs survive a lost response without replaying an unknown attempt',()=>fixture(async(root)=>{
 const p={root,id:'sample',revision:'v1'},current=await dispatch('calibrate_begin',p);
 const parent=path.join(root,'eval-lab-data/calibrations'),legacy='legacy-check';
 await fs.rename(path.join(parent,current.checkId),path.join(parent,legacy));
 const file=path.join(parent,legacy,'plan.json'),plan=JSON.parse(await fs.readFile(file,'utf8'));
 plan.checkId=legacy;await fs.writeFile(file,JSON.stringify(plan));await fs.mkdir(path.join(parent,legacy,'attempt-0'));
 assert.equal((await dispatch('calibrate_begin',p)).checkId,legacy);
 await assert.rejects(dispatch('calibrate_step',{root,checkId:legacy,step:0}),{code:'EEXIST'});
 assert.deepEqual(await fs.readdir(parent),[legacy]);
}));
test('missing plan recovers preparation only, publishes atomically and preserves unknown attempts',()=>fixture(async(root)=>{
 const p={root,id:'sample',revision:'v1'},first=await dispatch('calibrate_begin',p),folder=path.join(root,'eval-lab-data/calibrations',first.checkId),plan=path.join(folder,'plan.json');
 const bytes=await fs.readFile(plan);await fs.unlink(plan);await fs.writeFile(path.join(folder,'plan-deadbeef.tmp'),'{partial');
 const open=fs.open;let failed=false;
 fs.open=async(file,...args)=>{const h=await open(file,...args);if(String(file).includes('/plan-')&&!failed){failed=true;h.writeFile=async()=>{await h.write('{partial');throw Object.assign(Error('disk full'),{code:'ENOSPC'});};}return h;};
 try{await assert.rejects(dispatch('calibrate_begin',p),{code:'ENOSPC'});}finally{fs.open=open;}
 await assert.rejects(fs.access(plan));
 const recovered=await Promise.all([dispatch('calibrate_begin',p),dispatch('calibrate_begin',p)]);assert.deepEqual(recovered,[first,first]);assert.deepEqual(await fs.readFile(plan),bytes);
 await fs.unlink(plan);await fs.mkdir(path.join(folder,'attempt-0'));await assert.rejects(dispatch('calibrate_begin',p),/execution evidence/);await assert.rejects(fs.access(plan));
 await fs.writeFile(plan,'{broken');await assert.rejects(dispatch('calibrate_begin',p));assert.equal(await fs.readFile(plan,'utf8'),'{broken');
}));

test('malformed grader output becomes a readable ungraded receipt without replay',async()=>{
 for(const raw of [{},{status:'unexpected'},[],null,{status:'graded',items:{}},{status:'environment_invalid',reason:'fixture'}])await fixture(async(root,directory)=>{
  const text=JSON.stringify(raw);
  await fs.writeFile(path.join(directory,'author/grade.py'),"import pathlib,sys\np=pathlib.Path(sys.argv[1]); (p/'executed').write_text('once')\npathlib.Path(sys.argv[2]).write_text("+JSON.stringify(text)+")\n");
  const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId},folder=path.join(root,'eval-lab-data/calibrations',checkId);
  for(let step=0;step<3;step++){
   const result=await dispatch('calibrate_step',{...p,step});assert.equal(result.status,'environment_invalid');assert.equal(result.scoreExact,null);
   const attempt=path.join(folder,'attempt-'+step);assert.equal(await fs.readFile(path.join(attempt,'grade.json'),'utf8'),text);
   // Removing the execution input would make a replay observably fail.
   await fs.rm(path.join(attempt,'source'),{recursive:true});
   if(step===0)await fs.rename(path.join(folder,'step-0.json'),path.join(attempt,'receipt.json'));
   assert.deepEqual(await dispatch('calibrate_step',{...p,step}),result);
  }
  const result=await dispatch('calibrate_finish',p);assert.equal(result.ok,false);assert.ok(result.results.every(r=>r.status==='environment_invalid'&&r.scoreExact===null));
  assert.deepEqual(await dispatch('calibrate_finish',p),result);
 });
});

test('known input copy failure removes only its unstarted attempt and permits retry',()=>fixture(async(root)=>{
 const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId,step:0};
 const copy=fs.cp,child=require('node:child_process'),spawn=child.spawn;let starts=0;
 child.spawn=(...args)=>{starts++;return spawn(...args);};
 try{
  fs.cp=async(...args)=>{await copy(...args);throw Object.assign(Error('copy full'),{code:'ENOSPC'});};
  await assert.rejects(dispatch('calibrate_step',p),/磁盘空间/);assert.equal(starts,0);
  await assert.rejects(fs.access(path.join(root,'eval-lab-data/calibrations',checkId,'attempt-0')));
  fs.cp=copy;assert.equal((await dispatch('calibrate_step',p)).status,'graded');assert.equal(starts,1);
  await dispatch('calibrate_step',p);assert.equal(starts,1);
 }finally{fs.cp=copy;child.spawn=spawn;}
}));

test('calibration copy and cleanup errors never expose source or destination paths',async()=>{
 for(const code of ['ENOSPC','EDQUOT','EACCES','EPERM','EROFS','EIO','ENOENT','UNKNOWN'])await fixture(async(root)=>{
  const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId,step:0},copy=fs.cp;
  fs.cp=async()=>{throw Object.assign(Error(code+' copyfile '+root+'/private-source -> '+root+'/private-output'),{code});};
  try{await assert.rejects(dispatch('calibrate_step',p),e=>{assert.equal(e.code,code);assert.ok(!e.message.includes(root));assert.match(e.message,/校准材料.*重试/);return true;});}finally{fs.cp=copy;}
 });
 await fixture(async(root)=>{
  const {checkId}=await dispatch('calibrate_begin',{root,id:'sample',revision:'v1'}),p={root,checkId,step:0},copy=fs.cp,remove=fs.rm;
  fs.cp=async()=>{throw Object.assign(Error(root),{code:'EIO'});};fs.rm=async()=>{throw Object.assign(Error(root),{code:'EACCES'});};
  try{await assert.rejects(dispatch('calibrate_step',p),e=>!e.message.includes(root)&&/清理未完成/.test(e.message));}finally{fs.cp=copy;fs.rm=remove;}
  await assert.rejects(dispatch('calibrate_step',p),/execution is unknown/);
 });
});
test('ending authoring requires complete matching receipts, not merely a finished-looking report',()=>fixture(async(root)=>{
 const p={root,id:'sample',revision:'v1'};
 assert.deepEqual(await dispatch('calibrate_idle',p),{ok:true});
 const {checkId}=await dispatch('calibrate_begin',p);
 await dispatch('calibrate_step',{root,checkId,step:0});
 await assert.rejects(dispatch('calibrate_idle',p),/不能结束/);
 for(const step of [1,2])await dispatch('calibrate_step',{root,checkId,step});
 await dispatch('calibrate_finish',{root,checkId});
 assert.deepEqual(await dispatch('calibrate_idle',p),{ok:true});
 const file=path.join(root,'eval-lab-data/calibrations',checkId,'step-1.json');
 const saved=await fs.readFile(file,'utf8');await fs.writeFile(file,saved.replace('"code": 0','"code": 9'));
 await assert.rejects(dispatch('calibrate_idle',p),/不能结束/);
}));
