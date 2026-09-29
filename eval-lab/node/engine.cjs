'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {createReadStream}=require('node:fs');
const {validateStorage,link}=require('./storage.cjs');
const inputError=require('./input-error.cjs');
const {sha,id,validateSpec,score,report,publicResult}=require('../lib/core.cjs');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
// Immutable JSON becomes visible only after the complete file is closed; never replace a winner.
const write=async(p,x)=>{
 await fs.mkdir(path.dirname(p),{recursive:true});
 const tmp=path.join(path.dirname(p),path.parse(p).name+'-'+crypto.randomUUID()+'.tmp');let handle;
 try{handle=await fs.open(tmp,'wx');await handle.writeFile(JSON.stringify(x,null,2)+'\n');await handle.close();handle=null;await link(tmp,p);}
 finally{if(handle)await handle.close();await fs.unlink(tmp).catch(()=>{});}
};
async function within(root,rel){if(typeof rel!=='string'||path.isAbsolute(rel)||rel.split(/[\\/]/).some(s=>!s||s==='.'||s==='..'))throw Error('Unsafe path');const base=await fs.realpath(root),p=path.resolve(base,rel);if(!p.startsWith(base+path.sep))throw Error('Outside root');let cur=base;for(const segment of rel.split('/')){cur=path.join(cur,segment);try{if((await fs.lstat(cur)).isSymbolicLink())throw Error('Symlink refused');}catch(e){if(e.code!=='ENOENT')throw e;}}return p;}
async function files(root,dir='',signal){signal?.throwIfAborted();const rows={};for(const e of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){signal?.throwIfAborted();const rel=dir?dir+'/'+e.name:e.name;if(e.isSymbolicLink())throw Object.assign(Error('Symlink refused'),{code:'SYMLINK_REFUSED'});if(e.isDirectory())Object.assign(rows,await files(root,rel,signal));else if(e.isFile()){const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(path.join(root,rel),{signal}))hash.update(chunk);rows[rel]=hash.digest('hex');}}return rows;}
async function base(root){if(!path.isAbsolute(root))throw Error('Choose an absolute storage directory');root=await fs.realpath(root);const out=await within(root,'eval-lab-data');await fs.mkdir(out,{recursive:true});return out;}
async function bankInfo(bank){const root=await fs.realpath(bank);const manifest=await read(path.join(root,'distribution.json'));if(!manifest||manifest.format!=='eval-lab-bank-v1')throw Error('Not an Eval Lab bank');return {root,manifest};}
async function verifyQuestion(bank,key){const {root,manifest}=await bankInfo(bank);const q=manifest.questions.find(q=>q.key===key);if(!q)throw Error('Question not found');const dir=await within(root,q.path);const actual=await files(dir);if(Object.keys(actual).length!==Object.keys(q.files).length)throw Error('Question package has unregistered or missing files');for(const [rel,h] of Object.entries(q.files)){if(actual[rel]!==h)throw Error('Question package changed: '+rel);}const spec=await read(path.join(dir,'question.json'));validateSpec(spec);if(q.key!==spec.id+'@'+spec.revision||(q.revision!==undefined&&q.revision!==spec.revision))throw Error('Question identity mismatch');return {q,dir,spec};}
async function runCommand(command,args,{cwd,timeout=840000,signal}={}){
 signal?.throwIfAborted();
 return new Promise(resolve=>{
  const p=cp.spawn(command,args,{cwd,detached:process.platform!=='win32',env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8',PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
  let out='',err='',timedOut=false;
  const kill=()=>{try{process.platform==='win32'?p.kill('SIGKILL'):process.kill(-p.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;kill();},timeout);
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',kill);};
  signal?.addEventListener('abort',kill,{once:true});if(signal?.aborted)kill();
  p.stdout.on('data',d=>out=(out+d).slice(-100000));p.stderr.on('data',d=>err=(err+d).slice(-100000));
  p.on('error',e=>{cleanup();resolve({code:null,error:e.message,timedOut,stdout:out,stderr:err});});
  // Wait for close before callers remove staging files the child may be writing.
  p.on('close',(code,exitSignal)=>{cleanup();resolve({code,signal:exitSignal,timedOut,stdout:out,stderr:err});});
 });
}
const {environmentEvidence,timing,ms}=require('./execution-quality.cjs');
const {taskScope}=require('./task-scope.cjs');
const online=require('./online.cjs').service({base,within,files,runCommand});
const RUN_PROMPT='独立检查此项目，依据 TASK.md 与产品约定修复可证实的问题，运行验证，在 BUGS_FOUND.md 记录问题、证据与结果并报告。仅使用本工作目录，不修改题面、已有测试或运行环境，不委派。';
async function preflight(){
 const r=await runCommand('python3',['-I','-c','import sys; sys.exit(0 if sys.version_info.major == 3 else 1)'],{timeout:10000});
 if(r.code!==0||r.timedOut)throw Error('Python 3 无法运行，请安装 Python 3 并确保 Cindy 的 PATH 能找到 python3，重启 Cindy 后重试；尚未开始模型作答。');
 return {ok:true};
}
async function prepare(p){await preflight();if(p.question.startsWith('imported:')){const [,bankId,...keys]=p.question.split(':');const b=(p.importedBanks||[]).find(b=>b.id===bankId);if(!b)throw Error('Imported bank unavailable');p={...p,bank:b.path,question:keys.join(':')};}if(p.question.startsWith('online:')){const [,release,...key]=p.question.split(':');if(!/^[a-f0-9]{64}$/.test(release))throw Error('Invalid release');p={...p,bank:await within(await base(p.root),'online/banks/'+release),question:key.join(':')};}if(p.question.startsWith('custom:'))p={...p,bank:path.join(await base(p.root),'custom-bank'),question:p.question.slice(7)};const home=await base(p.root);const {q,dir,spec}=await verifyQuestion(p.bank,p.question);const authorizationScope=await taskScope(path.join(dir,'candidate'),RUN_PROMPT);require('./question-platform.cjs').checkPlatform(spec.environment);for(const k of ['model','harness','effort','provider'])if(typeof p[k]!=='string'||!p[k].trim())throw Error('Actual '+k+' is required');const runId=p.runId?id(p.runId):crypto.randomUUID(),runDir=await within(home,'runs/'+runId);await fs.mkdir(runDir,{recursive:true});const workspace=p.workspace?await fs.realpath(p.workspace):path.join(runDir,'workspace');if(p.workspace){if(!path.isAbsolute(p.workspace)||(await fs.lstat(p.workspace)).isSymbolicLink())throw Error('Workspace must be a real absolute directory');}try{const old=await read(path.join(runDir,'run.json'));if(old.question!==p.question||old.model!==p.model||old.provider!==p.provider||old.effort!==p.effort||old.harness!==p.harness||old.workspace!==workspace)throw Error('Run identity conflict');return {...old,workspace,prompt:RUN_PROMPT,authorizationScope};}catch(e){if(e.code!=='ENOENT')throw e;}const record={runId,batchId:p.batchId??null,questionId:spec.id,title:spec.title,revision:spec.revision,releaseHash:q.sourceManifestSha256,distributionHash:sha(JSON.stringify(q.files)),bank:await fs.realpath(p.bank),question:p.question,model:p.model,harness:p.harness,effort:p.effort,provider:p.provider,status:'prepared',createdAt:new Date().toISOString(),workspace,executionChannel:p.executionChannel==='Cindy task'?'Cindy task':'Orca Worker',costUSD:null};const r=await require('./prepare-copy.cjs')({runDir,workspace,candidate:path.join(dir,'candidate'),record,read,write,files,within});return {...r,workspace,prompt:RUN_PROMPT,authorizationScope};}

async function loadRun(p){const dir=await within(await base(p.root),'runs/'+id(p.runId));return {dir,r:await read(path.join(dir,'run.json'))};}
// Keep ungraded terminal failures in the existing run record before freeing a Worker slot.
async function recordFailure(p){
 const {dir,r}=await loadRun(p),receipt=p.receipt;
 if(!receipt?.workerId||!receipt.sessionId||(!Number.isFinite(ms(receipt.completedAt))||ms(receipt.completedAt)<=0)||!['done','error'].includes(receipt.status))throw Error('Terminal receipt required');
 try{return publicResult(await effectiveResult(dir));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(r.status==='failed'){
  if(['workerId','sessionId','completedAt','status'].some(k=>r.terminalReceipt?.[k]!==receipt[k]))throw Error('Terminal receipt conflict');
  return publicResult(r);
 }
 const failed={...r,status:'failed',score:null,scoreExact:null,...timing(receipt),reason:typeof p.reason==='string'?p.reason:'Worker did not complete',terminalReceipt:receipt};
 const target=await within(dir,'run.json'),tmp=await within(dir,'run-'+crypto.randomUUID()+'.tmp');
 try{await write(tmp,failed);await fs.rename(tmp,target);}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 return publicResult(failed);
}
async function grade(p){
 const {dir,r}=await loadRun(p);
 if(!['Orca Worker','Cindy task'].includes(p.receipt?.channel)||!p.receipt.sessionId||!p.receipt.completedAt)throw Error('Terminal receipt required');
 if(p.receipt.channel==='Cindy task'&&(!p.receipt.runId||!p.receipt.execution||p.receipt.acceptedConfig?.model!==r.model||p.receipt.acceptedConfig?.providerId!==r.provider||p.receipt.acceptedConfig?.effort!==r.effort))throw Error('Host execution receipt mismatch');
 try{await read(path.join(dir,'result.json'));return reconcileResult(p);}catch(e){if(e.code!=='ENOENT')throw e;}
 const resultPath=path.join(dir,'result.json'),completionPath=path.join(dir,'grading-completion.json');
 async function publish(result){
  if(result.runId!==r.runId||result.distributionHash!==r.distributionHash||!['graded','environment_invalid'].includes(result.status))throw Error('Grading receipt mismatch');
  try{await write(resultPath,result);}catch(e){if(e.code!=='EEXIST')throw e;if(JSON.stringify(await read(resultPath))!==JSON.stringify(result))throw e;}
  return {...publicResult(result),runId:r.runId};
 }
 try{return await publish(await read(completionPath));}catch(e){if(e.code!=='ENOENT')throw e;}
 const {q,dir:questionDir,spec}=await verifyQuestion(r.bank,r.question);
 if(sha(JSON.stringify(q.files))!==r.distributionHash)throw Error('Distribution changed');
 const snapshot=path.join(dir,'submission'),output=path.join(dir,'external-grade.json'),contextPath=path.join(dir,'grading-context.json');
 let execution,context;
 try{execution=await read(path.join(dir,'grader-execution.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(execution){
  // A complete process receipt permits publication, never another execution.
  if(typeof execution.timedOut!=='boolean'||!(execution.code===null||Number.isInteger(execution.code)))throw Error('Grading receipt mismatch');
  const expected=execution.submissionHashes||await read(path.join(dir,'submission-hashes.json'));
  if(JSON.stringify(expected)!==JSON.stringify(await files(snapshot)))throw Error('Submission changed; existing evidence preserved');
  try{context=await read(contextPath);}catch(e){if(e.code!=='ENOENT')throw e;context={receipt:p.receipt,gradingStartedAt:null};}
 }else{
  let lock;
  try{lock=await fs.open(path.join(dir,'grading.lock'),'wx');}catch(e){if(e.code!=='EEXIST')throw e;throw Error('评分仍在运行或执行状态未知，已有作答保留，不会重复评分。');}
  // This is an attempt marker, not a timeout lease. Keep it until evidence exists.
  await lock.close();
  context={receipt:p.receipt,gradingStartedAt:Date.now()};let contextWritten=false,snapshotCreated=false;
  try{
   await write(contextPath,context);contextWritten=true;
   await fs.mkdir(snapshot);snapshotCreated=true;
   const source=r.workspace||path.join(dir,'workspace');
   for(const name of await fs.readdir(source))await fs.cp(path.join(source,name),path.join(snapshot,name),{recursive:true,errorOnExist:true,force:false});
   await write(path.join(dir,'submission-hashes.json'),await files(snapshot));
  }catch(error){
   // This call has not spawned a grader. Only its newly created preparation may be removed.
   try{
    if(snapshotCreated)await fs.rm(snapshot,{recursive:true,force:true});
    if(contextWritten)await fs.unlink(contextPath);
    await fs.unlink(path.join(dir,'grading.lock'));
   }catch(cleanup){throw inputError(cleanup,true,'评分快照');}
   throw inputError(error,false,'评分快照');
  }
  execution=await runCommand('python3',['-B',path.join(questionDir,'author/grade.py'),snapshot,output]);
  execution={...execution,submissionHashes:await files(snapshot)};
  await write(path.join(dir,'grader-execution.json'),execution);
 }
 if(!context.receipt||context.receipt.sessionId!==p.receipt.sessionId||context.receipt.completedAt!==p.receipt.completedAt)throw Error('Terminal receipt conflict');
 let raw;try{raw=await read(output);}catch{raw={status:'environment_invalid',reason:'Grader produced no result'};}
 const environmentDiagnostic=await environmentEvidence(r.workspace,path.join(questionDir,'candidate'));
 if(execution.code!==0||execution.timedOut)raw={status:'environment_invalid',reason:'Grader process failed or timed out'};
 let calculated=null;if(raw?.status==='graded'){try{calculated=score(spec,raw.items);}catch(e){raw={status:'environment_invalid',reason:e.message};}}
 const receipt=context.receipt;
 const result={...r,environmentDiagnostic,status:raw?.status==='graded'?'graded':'environment_invalid',score:calculated?.value??null,scoreExact:calculated?.exact??null,receipt:{...receipt,provenance:receipt.channel==='Cindy task'?'host-api-observed':receipt.provenance==='host-team-observed'?'host-team-observed':'coordinator-reported'},gradedAt:new Date().toISOString(),...timing(receipt,context.gradingStartedAt,Date.now()),reason:raw?.reason??null};
 try{await write(completionPath,result);}catch(e){if(e.code!=='EEXIST')throw e;return publish(await read(completionPath));}
 return publish(result);
}
// Review sidecars may add timing and diagnostics, never overwrite independent scores.
function reviewMetadata(review){const out={};for(const k of ['qualityVersion','environmentDiagnostic','durationSeconds','queueSeconds','gradingSeconds','timingBasis','costUSD','costBasis'])if(review[k]!==undefined)out[k]=review[k];return out;}
async function effectiveResult(dir){const result=await read(path.join(dir,'result.json'));try{return {...result,...reviewMetadata(await read(path.join(dir,'assessment-review.json')))};}catch(e){if(e.code!=='ENOENT')throw e;return result;}}
async function reconcileResult(p){
 const {dir,r}=await loadRun(p),old=await effectiveResult(dir),bank=await bankInfo(r.bank),questionDir=await within(bank.root,bank.manifest.questions.find(q=>q.key===r.question).path);
 const environmentDiagnostic=await environmentEvidence(r.workspace,path.join(questionDir,'candidate'));
 const updates={qualityVersion:2,environmentDiagnostic};
 if(p.receipt){const t=timing(p.receipt);for(const [k,v] of Object.entries(t))if(v!=null&&v!=='unavailable'&&v!=='unknown')updates[k]=v;}
 const target=path.join(dir,'assessment-review.json'),tmp=target+'.'+crypto.randomUUID()+'.tmp';let prior={};try{prior=await read(target);}catch(e){if(e.code!=='ENOENT')throw e;}
 // Keep old review records for audit, but retire their untrusted score overrides.
 if(prior.qualityVersion===1)await fs.copyFile(target,path.join(dir,'assessment-review-v1.json'),require('node:fs').constants.COPYFILE_EXCL).catch(e=>{if(e.code!=='EEXIST')throw e;});
 await write(tmp,{...reviewMetadata(prior),...updates});await fs.rename(tmp,target);
 return {...publicResult({...old,...updates}),runId:r.runId};
}
async function list(p){const home=await base(p.root);let names;try{names=await fs.readdir(path.join(home,'runs'));}catch(e){if(e.code==='ENOENT')return [];throw e;}const batches=new Map();try{for(const f of await fs.readdir(path.join(home,'coordination'))){if(!f.endsWith('.json')||f.endsWith('-state.json'))continue;try{const plan=await read(path.join(home,'coordination',f));for(const item of plan.items||[])if(item.runId)batches.set(item.runId,f.slice(0,-5));}catch{}}}catch(e){if(e.code!=='ENOENT')throw e;}const out=[];for(const name of names){const dir=await within(home,'runs/'+id(name));let r;try{r=await effectiveResult(dir);}catch(e){if(e.code!=='ENOENT')throw e;try{r=await read(path.join(dir,'run.json'));}catch(missing){if(missing.code==='ENOENT')continue;throw missing;}}out.push({...publicResult(r),runId:r.runId,batchId:r.batchId||batches.get(r.runId)||null});}return out;}
async function exportReport(p){if(!Array.isArray(p.runIds)||!p.runIds.length)throw Error('Select results');const selected=[];for(const runId of [...new Set(p.runIds)]){const {dir}=await loadRun({...p,runId});try{selected.push(await effectiveResult(dir));}catch(e){if(e.code!=='ENOENT')throw e;selected.push(await read(path.join(dir,'run.json')));}}return {html:p.standings?require('../lib/standings-report.cjs')(selected.map(publicResult),{...p.standings,locale:p.locale}):report(selected,p.locale),name:'evaluation-'+new Date().toISOString().slice(0,10)+'.html'};}
async function draft(p){
 const home=await base(p.root);id(p.id);id(p.revision);
 const dir=await within(home,'drafts/'+p.id+'/'+p.revision);await fs.mkdir(dir,{recursive:true});
 const source=await within(dir,'sources.private.json');
 let records;
 try{records=p.records===undefined&&p.resume?await read(source):p.records;}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return {status:'input_required'};throw e;}
 if(!Array.isArray(records)||!records.length||records.some(r=>!r||typeof r.text!=='string'||!r.text.trim()||!r.sessionId||r.text.length>60000))return {status:'input_required'};
 const normalized=records.map(r=>{if(typeof r.text!=='string'||!r.text.trim()||!r.sessionId)throw Error('Source records need sessionId and text');if(r.text.length>60000)throw Error('单段记录超过60000字符，请缩小选择范围');return {sessionId:String(r.sessionId),text:r.text};});
 try{await write(source,normalized);}catch(e){
  if(e.code!=='EEXIST')throw e;
  let old;try{old=await read(source);}catch(error){if(error instanceof SyntaxError)return {status:'input_required'};throw error;}
  if(JSON.stringify(old)!==JSON.stringify(normalized))throw Error('Draft source conflict; existing records preserved');
 }
 const task=await fs.readFile(path.join(__dirname,'../manual/workflows/author-prompt.md'),'utf8'),prompt=await within(dir,'AUTHOR_TASK.md');
 try{await fs.writeFile(prompt,task,{flag:'wx'});}catch(e){
  if(e.code!=='EEXIST')throw e;
  if(await fs.readFile(prompt,'utf8')!==task)throw Error('Draft prompt conflict; existing files preserved');
 }
 return {directory:dir,prompt:task,status:'draft'};
}
const authorHandoff=require('./author-handoff.cjs')({base,within,files,read,write,id,validateSpec});
const calibration=require('./calibration.cjs')({base,within,files,read,write,id,validateSpec,score,runCommand,draftDirectory:authorHandoff.directory});
async function freezeUnlocked(p){
 const home=await base(p.root),cal=await read(await within(home,'calibrations/'+id(p.checkId)+'/calibration.json'));if(!cal.ok)throw Error('Calibration did not pass');const dir=await authorHandoff.directory({...p,id:cal.id,revision:cal.revision});if(JSON.stringify(cal.hashes)!==JSON.stringify(await files(dir)))throw Error('Draft changed; recalibrate');
 const bank=path.join(home,'custom-bank');await fs.mkdir(bank,{recursive:true});
 const key=cal.id+'@'+cal.revision;
 const staging=await fs.mkdtemp(path.join(bank,'staging-'));let published=false;
 try{
  for(const f of ['candidate','reference','author'])await fs.cp(path.join(dir,f),path.join(staging,f),{recursive:true,errorOnExist:true,force:false});await fs.copyFile(path.join(dir,'question.json'),path.join(staging,'question.json'));
  const spec=await read(path.join(staging,'question.json')),hashes=await files(staging),hash=sha(JSON.stringify(hashes));
  const rel='questions/'+cal.id+'/'+cal.revision+'-'+hash.slice(0,16),dest=await within(bank,rel);await fs.mkdir(path.dirname(dest),{recursive:true});
  try{await fs.rename(staging,dest);published=true;}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;if(JSON.stringify(await files(dest))!==JSON.stringify(hashes))throw Error('Unregistered release conflicts');}
  const entry={key,title:spec.title,revision:spec.revision,environment:spec.environment,path:rel,sourceManifestSha256:hash,files:hashes};
  // Old builds did not record lock ownership. Never guess whether that writer lives.
  let legacyLock=false;try{await fs.lstat(path.join(home,'freeze.lock'));legacyLock=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(legacyLock){let old;try{old=await read(path.join(bank,'distribution.json'));}catch(e){if(e.code!=='ENOENT')throw e;}if(JSON.stringify(old?.questions?.find(q=>q.key===key))===JSON.stringify(entry))return {key:'custom:'+key,status:'frozen'};throw Error('旧冻结操作状态未知，请先核对原执行；已有题目与材料保留。');}
  const request=path.join(bank,'freeze-'+crypto.randomUUID()+'.json');
  try{await write(request,entry);const execution=await runCommand('python3',['-I',path.join(__dirname,'freeze-publish.py'),bank,request],{timeout:30000});if(execution.code!==0||execution.timedOut)throw Error('题库发布尚未确认，请重试核对；已有题目与材料保留。');}finally{await fs.unlink(request).catch(()=>{});}
  return {key:'custom:'+key,status:'frozen'};
 }finally{if(!published)await fs.rm(staging,{recursive:true,force:true});}
}
async function freeze(p){return freezeUnlocked(p);}
async function catalog(p){
 const questions=[],errors=[],home=await base(p.root);
 const append=(info,prefix='',onlineSource=false)=>{for(const q of info.manifest.questions)questions.push({...q,key:prefix+q.key,sourceKey:sha(info.root),...(onlineSource&&typeof info.manifest.online?.url==='string'?{sourceIndexUrl:info.manifest.online.url}:{})});};
 if(p.bank)append(await bankInfo(p.bank));
 for(const b of await online.banks(p)){try{const m=await bankInfo(b.path);if(!Array.isArray(m.manifest.questions))throw Error('Invalid online manifest');append(m,'online:'+b.id+':',true);}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError)&&!['Not an Eval Lab bank','Invalid online manifest'].includes(e.message))throw e;errors.push({id:'online:'+b.id,message:'已安装题库损坏，请重新运行默认题库以下载修复；已有成绩保留。'});}}
 try{append(await bankInfo(path.join(home,'custom-bank')),'custom:');}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const b of p.importedBanks||[]){try{append(await bankInfo(b.path),'imported:'+b.id+':');}catch{errors.push({id:b.id,message:'导入题库不可用，请重新连接存储设备或在高级设置中重新导入。'});}}
 return {errors,questions:questions.map(({key,title,revision,environment,sourceManifestSha256,files,sourceKey,sourceIndexUrl})=>({key,title,revision,environment,sourceKey,...(sourceIndexUrl?{sourceIndexUrl}:{}),questionId:key.split(':').pop().split('@')[0],releaseHash:sourceManifestSha256,distributionHash:files?sha(JSON.stringify(files)):undefined}))};
}

async function drafts(p){const home=await base(p.root);let dirs;try{dirs=await fs.readdir(path.join(home,'calibrations'));}catch(e){if(e.code==='ENOENT')return [];throw e;}let published=[];try{published=(await bankInfo(path.join(home,'custom-bank'))).manifest.questions;}catch(e){if(e.code!=='ENOENT')throw e;}const out=[];for(const x of dirs){try{const c=await read(await within(home,'calibrations/'+id(x)+'/calibration.json'));if(published.some(q=>q.key===c.id+'@'+c.revision))continue;out.push({checkId:c.checkId,id:c.id,revision:c.revision,passed:c.ok});}catch(e){if(e.code!=='ENOENT')throw e;}}return out;}

async function coordinatorWorkspace(p){
 if(typeof p.workspace!=='string'||!path.isAbsolute(p.workspace)||(await fs.lstat(p.workspace)).isSymbolicLink())throw Error('评测主任务目录不可用，请检查任务目录后重试；已有作答保留。');
 return fs.realpath(p.workspace);
}
async function coordinatorState(p){const dest=await within(await coordinatorWorkspace(p),'eval-coordination/'+id(p.id)+'-state.json');const tmp=dest+'.'+crypto.randomUUID()+'.tmp';await write(tmp,{assignments:p.assignments,active:p.active,settled:p.settled,capacity:p.capacity});await fs.rename(tmp,dest);return {path:dest};}
async function coordinatorPlan(p){
 const workspace=await coordinatorWorkspace(p),dest=await within(workspace,'eval-coordination/'+id(p.id)+'.json');
 // Recover the exact frozen membership, never reconstruct it from unfinished items.
 if(p.legacy){const old=await read(await within(await base(p.root),'coordination/'+id(p.id)+'.json'));p={...p,items:old.items,concurrency:old.concurrency};}
 const concurrency=p.concurrency??null;if(concurrency!==null&&(!Number.isInteger(concurrency)||concurrency<1))throw Error('同时作答数必须为正整数');
 const data={concurrency,items:p.items};
 try{await write(dest,data);}catch(e){if(e.code!=='EEXIST')throw e;if(JSON.stringify(await read(dest))!==JSON.stringify(data))throw Error('Coordinator plan changed');}
 return {workspace,path:dest,prompt:'你是此批评测的主任务。读取 '+JSON.stringify(dest)+'，通过 Orca 协同完成计划。每次派发前读取同目录 '+id(p.id)+'-state.json，只创建 assignments 中的 Worker；active 和 settled 不得再派发。插件更新此清单并负责评分后释放槽位。按宿主登记的计划为每份作答创建独立 Worker。每份使用计划指定的模型、来源、强度、workingDir 和唯一 label，fast=false；initial_task 只包含该项 prompt，不泄漏其他作答或评分材料。并行执行：'+(concurrency===null?'默认填满宿主实际可用 Worker 槽位':('同时最多 '+concurrency+' 份作答，并受宿主实际槽位上限约束'))+'。用 create_workers 批量派发可容纳的作答，依据返回的实际派发结果与 remainingSlots/hard_limit 安排剩余作答，不把 ui_capacity 当作并发上限。容量不足时等待已有 Worker 回报，不忙重试、不提高宿主限制。每完成一份即补充空闲名额；已完成且插件已记录终态的闲置 Worker 可按宿主规则释放槽位，不删除作答文件或成绩。创建前核对现有 label 和队列，恢复时不得重复派发；配置不可用不得替换模型。你只协调，不修改候选答案、不自行评分；插件按宿主 Worker 终态独立评分。单题失败保留证据后继续其他题。报告每份 label、Worker 身份、实际配置、完成或受阻原因。派发后结束当前轮次，等待 Worker 回报，不轮询空等。'};
}
async function dispatch(method,p){if(method==='validate_storage')return validateStorage(await base(p.root));switch(method){case 'preflight':return preflight();case 'author_stage':return authorHandoff.stage(p);case 'author_collect':return authorHandoff.collect(p);case 'record_failure':return recordFailure(p);case 'coordinator_state':return coordinatorState(p);case 'coordinator_plan':return coordinatorPlan(p);case 'defaults':{const result=await require('./defaults.cjs').defaultRoot(p.profile);await validateStorage(await base(result.root));return result;}case 'online_inspect':return online.inspect(p);case 'online_cached':return online.cached(p);case 'online_plan':return online.plan(p);case 'online_begin':return online.begin(p);case 'online_cancel':return online.cancel(p);case 'online_install':return online.install(p);case 'online_step':return online.step(p);case 'bank':return catalog(p);case 'drafts':return drafts(p);case 'calibrate_idle':return calibration.idle(p);case 'calibrate':return calibration.all(p);case 'calibrate_begin':return calibration.begin(p);case 'calibrate_step':return calibration.step(p);case 'calibrate_finish':return calibration.finish(p);case 'freeze':return freeze(p);case 'prepare':return prepare(p);case 'grade':return grade(p);case 'reconcile_result':return reconcileResult(p);case 'runs':return list(p);case 'export':return exportReport(p);case 'draft':return draft(p);default:throw Error('Unknown operation');}}
module.exports={dispatch,within,files,runCommand};
