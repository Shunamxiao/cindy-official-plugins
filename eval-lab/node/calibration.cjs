'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const names=['candidate','reference','controls/incomplete'];
const publicStep=({name,status,scoreExact})=>({name,status,scoreExact});
module.exports=function calibration({base,within,files,read,write,id,validateSpec,score,runCommand,draftDirectory=async p=>within(await base(p.root),'drafts/'+id(p.id)+'/'+id(p.revision))}){
 async function begin(p){
  const home=await base(p.root),dir=await draftDirectory(p);
  const spec=await read(path.join(dir,'question.json'));validateSpec(spec);
  if(spec.id!==p.id||spec.revision!==p.revision)throw Error('Question identity mismatch');
  for(const name of [...names,'author'])if(!(await fs.stat(path.join(dir,name))).isDirectory())throw Error('Missing '+name);
  const hashes=await files(dir),identity={id:p.id,revision:p.revision,hashes};
  // The draft snapshot owns the ID, so a lost begin/step response cannot create
  // another execution of the same unknown attempt on the next request.
  const checkId='snapshot-'+crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const checks=await within(home,'calibrations/'+checkId),plan={checkId,...identity};
  await fs.mkdir(path.dirname(checks),{recursive:true});
  // Earlier builds used random IDs. Reuse their recorded snapshot as well;
  // otherwise an upgrade could replay an already-running legacy attempt.
  const matches=[];
  for(const entry of await fs.readdir(path.dirname(checks))){
   const folder=await within(home,'calibrations/'+id(entry));let old;
   try{old=await read(path.join(folder,'plan.json'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
   if(old.id===p.id&&old.revision===p.revision&&JSON.stringify(old.hashes)===JSON.stringify(hashes)){
    if(old.checkId!==entry)throw Error('Calibration identity conflict');matches.push(entry);
   }
  }
  if(matches.length>1)throw Error('同一草稿存在多个校准记录，请先核对原执行状态；不会重复执行评分。');
  if(matches.length===1)return {checkId:matches[0]};
  await fs.mkdir(checks,{recursive:true});
  const dest=path.join(checks,'plan.json');
  try{
   const existing=await read(dest);
   if(JSON.stringify(existing)!==JSON.stringify(plan))throw Error('Calibration identity conflict');
   return {checkId};
  }catch(e){if(e.code!=='ENOENT')throw e;}
  // No execution can precede a published plan. Recover only preparation files;
  // unknown attempts or receipts require execution recovery, never reinitialization.
  if((await fs.readdir(checks)).some(name=>name!=='plan.json'&&!/^plan-[0-9a-f-]+\.tmp$/.test(name)))throw Error('Calibration preparation has execution evidence; recovery required');
  const tmp=path.join(checks,'plan-'+crypto.randomUUID()+'.tmp');
  try{
   await write(tmp,plan);
   try{await fs.link(tmp,dest);}catch(e){if(e.code!=='EEXIST')throw e;if(JSON.stringify(await read(dest))!==JSON.stringify(plan))throw Error('Calibration identity conflict');}
  }finally{await fs.rm(tmp,{force:true});}
  return {checkId};
 }
 async function context(p){
  const home=await base(p.root),checks=await within(home,'calibrations/'+id(p.checkId)),plan=await read(path.join(checks,'plan.json'));
  const dir=await draftDirectory({...p,id:plan.id,revision:plan.revision});
  if(JSON.stringify(plan.hashes)!==JSON.stringify(await files(dir)))throw Error('Draft changed; recalibrate');
  const spec=await read(path.join(dir,'question.json'));validateSpec(spec);
  return {checks,plan,dir,spec};
 }
 async function step(p){
  if(!Number.isInteger(p.step)||p.step<0||p.step>=names.length)throw Error('Invalid calibration step');
  const {checks,dir,spec}=await context(p),name=names[p.step],resultPath=path.join(checks,'step-'+p.step+'.json');
  try{return publicStep(await read(resultPath));}catch(e){if(e.code!=='ENOENT')throw e;}
  // A durable attempt marker prevents replay of an unknown or still-running process.
  // Completed receipts are reusable; unknown attempts are never replayed.
  const attempt=path.join(checks,'attempt-'+p.step);await fs.mkdir(attempt);
  const source=path.join(attempt,'source'),output=path.join(attempt,'grade.json');
  await fs.cp(path.join(dir,name),source,{recursive:true,errorOnExist:true,force:false});
  const execution=await runCommand('python3',['-B',path.join(dir,'author/grade.py'),source,output]);
  let raw,calculated;
  try{raw=await read(output);if(execution.code!==0||execution.timedOut)raw={status:'environment_invalid',reason:'Grader process failed or timed out'};if(raw.status==='graded')calculated=score(spec,raw.items);}catch(e){raw={status:'environment_invalid',reason:e.message};}
  const result={name,status:raw.status,score:calculated?.value??null,scoreExact:calculated?.exact??null,execution,raw};
  const tmp=path.join(attempt,'receipt.json');await write(tmp,result);await fs.rename(tmp,resultPath);
  return publicStep(result);
 }
 async function finish(p){
  const {checks,plan}=await context(p),results=[];
  for(let i=0;i<names.length;i++){const r=await read(path.join(checks,'step-'+i+'.json'));if(r.name!==names[i])throw Error('Calibration receipt mismatch');results.push(r);}
  const ok=results.every(x=>x.status==='graded')&&results[1].score===1&&results[0].score<1&&results[2].score<1;
  const cal={...plan,ok,results},dest=path.join(checks,'calibration.json');
  const tmp=path.join(checks,'finish-'+crypto.randomUUID()+'.tmp');
  try{
   await write(tmp,cal);
   try{await fs.link(tmp,dest);}catch(e){if(e.code!=='EEXIST')throw e;if(JSON.stringify(await read(dest))!==JSON.stringify(cal))throw Error('Calibration result conflict');}
  }finally{await fs.rm(tmp,{force:true});}
  return {checkId:plan.checkId,ok,results:results.map(({name,status,scoreExact})=>({name,status,scoreExact}))};
 }
 async function all(p){const {checkId}=await begin(p);for(let stepIndex=0;stepIndex<names.length;stepIndex++)await step({...p,checkId,step:stepIndex});return finish({...p,checkId});}
 return {begin,step,finish,all};
};
