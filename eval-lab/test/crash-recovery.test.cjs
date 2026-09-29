const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {dispatch,files}=require('../node/engine.cjs');
async function fixture(fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-crash-')),bank=path.join(root,'bank'),q=path.join(bank,'q');
 try{
  await fs.mkdir(path.join(q,'candidate'),{recursive:true});await fs.mkdir(path.join(q,'author'));
  await fs.writeFile(path.join(q,'candidate/answer'),'paid answer');
  await fs.writeFile(path.join(q,'question.json'),JSON.stringify({id:'q',revision:'v1',title:'Fixture',scoringVersion:'v1',groups:[{id:'g',weight:'1',mode:'all',items:['a']}]}));
  await fs.writeFile(path.join(q,'author/grade.py'),"import json,sys,pathlib\npathlib.Path(sys.argv[1],'generated-test-cache').write_text('test artifact'); p=pathlib.Path(sys.argv[2]); counter=p.parent/'executions'; counter.write_text(counter.read_text()+'x' if counter.exists() else 'x'); p.write_text(json.dumps({'status':'graded','items':{'a':True}}))\n");
  await fs.writeFile(path.join(bank,'distribution.json'),JSON.stringify({format:'eval-lab-bank-v1',questions:[{key:'q@v1',path:'q',files:await files(q)}]}));
  await fn({root,bank,question:'q@v1',runId:'same-run',model:'m',provider:'p',harness:'h',effort:'e'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
async function killAtPublication(method,p,filename){
 const child=cp.fork(path.join(__dirname,'fixtures/crash-child.cjs'),[],{stdio:['ignore','ignore','pipe','ipc']});
 child.send({method,p,filename});
 const closed=new Promise(resolve=>child.once('close',resolve));let timer;
 try{await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Crash point was not reached')),10000);child.once('error',reject);child.once('message',m=>m==='paused'?resolve():reject(Error(JSON.stringify(m))));child.once('exit',()=>reject(Error('Child exited early')));});}
 finally{clearTimeout(timer);child.kill('SIGKILL');await closed;}
}
test('a killed preparation recovers exact copies, while modified paid content is preserved',()=>fixture(async p=>{
 await killAtPublication('prepare',p,'run.json');
 const workspace=path.join(p.root,'eval-lab-data/runs/same-run/workspace'),answer=path.join(workspace,'answer');
 assert.equal(await fs.readFile(answer,'utf8'),'paid answer');
 await fs.writeFile(answer,'user changed answer');await assert.rejects(dispatch('prepare',p),/保留现场/);assert.equal(await fs.readFile(answer,'utf8'),'user changed answer');
 await fs.writeFile(answer,'paid answer');const recovered=await dispatch('prepare',p);assert.equal(recovered.workspace,await fs.realpath(workspace));
 assert.equal((await dispatch('runs',p)).length,1);
}));
test('a killed result publication recovers from process evidence without running the grader again',()=>fixture(async p=>{
 const run=await dispatch('prepare',p),dir=path.join(p.root,'eval-lab-data/runs/same-run');
 const request={root:p.root,runId:run.runId,receipt:{channel:'Orca Worker',sessionId:'fixture',completedAt:new Date().toISOString()}};
 await killAtPublication('grade',request,'grading-completion.json');
 assert.equal(await fs.readFile(path.join(dir,'executions'),'utf8'),'x');
 assert.equal((await dispatch('grade',request)).score,1);
 assert.equal(await fs.readFile(path.join(dir,'executions'),'utf8'),'x');
 assert.equal(await fs.readFile(path.join(run.workspace,'answer'),'utf8'),'paid answer');
}));
test('unknown grading attempts are never replayed or mistaken for completion',()=>fixture(async p=>{
 const run=await dispatch('prepare',p),dir=path.join(p.root,'eval-lab-data/runs/same-run');await fs.writeFile(path.join(dir,'grading.lock'),'');
 await assert.rejects(dispatch('grade',{root:p.root,runId:run.runId,receipt:{channel:'Orca Worker',sessionId:'fixture',completedAt:new Date().toISOString()}}),/不会重复评分/);
 await assert.rejects(fs.access(path.join(dir,'executions')));assert.equal(await fs.readFile(path.join(run.workspace,'answer'),'utf8'),'paid answer');
}));

test('a known snapshot copy failure can retry without losing the paid workspace',()=>fixture(async p=>{
 const run=await dispatch('prepare',p),copy=fs.cp;
 const request={root:p.root,runId:run.runId,receipt:{channel:'Orca Worker',sessionId:'fixture',completedAt:new Date().toISOString()}};
 try{fs.cp=async()=>{throw Object.assign(Error('copyfile '+p.root+'/private-source -> '+p.root+'/private-output'),{code:'ENOSPC'});};await assert.rejects(dispatch('grade',request),e=>e.code==='ENOSPC'&&!e.message.includes(p.root)&&/释放磁盘/.test(e.message));}finally{fs.cp=copy;}
 assert.equal(await fs.readFile(path.join(run.workspace,'answer'),'utf8'),'paid answer');assert.equal((await dispatch('grade',request)).score,1);
}));

test('grading copy and cleanup failures preserve paid files and hide filesystem paths',async()=>{
 for(const code of ['ENOSPC','EDQUOT','EACCES','EPERM','EROFS','EIO','ENOENT','UNKNOWN'])await fixture(async p=>{
  const run=await dispatch('prepare',p),copy=fs.cp,request={root:p.root,runId:run.runId,receipt:{channel:'Orca Worker',sessionId:'fixture',completedAt:new Date().toISOString()}};
  fs.cp=async()=>{throw Object.assign(Error('copyfile '+p.root+'/private-source'),{code});};
  try{await assert.rejects(dispatch('grade',request),e=>e.code===code&&!e.message.includes(p.root)&&/评分快照复制失败/.test(e.message));}finally{fs.cp=copy;}
  assert.equal(await fs.readFile(path.join(run.workspace,'answer'),'utf8'),'paid answer');assert.equal((await dispatch('grade',request)).score,1);
 });
 await fixture(async p=>{
  const run=await dispatch('prepare',p),copy=fs.cp,remove=fs.rm,request={root:p.root,runId:run.runId,receipt:{channel:'Orca Worker',sessionId:'fixture',completedAt:new Date().toISOString()}};
  fs.cp=async()=>{throw Object.assign(Error(p.root),{code:'EIO'});};fs.rm=async()=>{throw Object.assign(Error(p.root),{code:'EACCES'});};
  try{await assert.rejects(dispatch('grade',request),e=>e.code==='EACCES'&&!e.message.includes(p.root)&&/清理未完成/.test(e.message));}finally{fs.cp=copy;fs.rm=remove;}
  await assert.rejects(dispatch('grade',request),/不会重复评分/);assert.equal(await fs.readFile(path.join(run.workspace,'answer'),'utf8'),'paid answer');
 });
});
