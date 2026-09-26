'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const names=['candidate','reference','controls/incomplete'];
const publicStep=({name,status,scoreExact})=>({name,status,scoreExact});
module.exports=function calibration({base,within,files,read,write,id,validateSpec,score,runCommand}){
 async function begin(p){
  const home=await base(p.root),dir=await within(home,'drafts/'+id(p.id)+'/'+id(p.revision));
  const spec=await read(path.join(dir,'question.json'));validateSpec(spec);
  if(spec.id!==p.id||spec.revision!==p.revision)throw Error('Question identity mismatch');
  for(const name of [...names,'author'])if(!(await fs.stat(path.join(dir,name))).isDirectory())throw Error('Missing '+name);
  const hashes=await files(dir),checkId=crypto.randomUUID(),checks=await within(home,'calibrations/'+checkId);
  await fs.mkdir(checks,{recursive:true});
  await write(path.join(checks,'plan.json'),{checkId,id:p.id,revision:p.revision,hashes});
  return {checkId};
 }
 async function context(p){
  const home=await base(p.root),checks=await within(home,'calibrations/'+id(p.checkId)),plan=await read(path.join(checks,'plan.json'));
  const dir=await within(home,'drafts/'+id(plan.id)+'/'+id(plan.revision));
  if(JSON.stringify(plan.hashes)!==JSON.stringify(await files(dir)))throw Error('Draft changed; recalibrate');
  const spec=await read(path.join(dir,'question.json'));validateSpec(spec);
  return {checks,plan,dir,spec};
 }
 async function step(p){
  if(!Number.isInteger(p.step)||p.step<0||p.step>=names.length)throw Error('Invalid calibration step');
  const {checks,dir,spec}=await context(p),name=names[p.step],resultPath=path.join(checks,'step-'+p.step+'.json');
  try{return publicStep(await read(resultPath));}catch(e){if(e.code!=='ENOENT')throw e;}
  // A durable attempt marker prevents replay of an unknown or still-running process.
  // Completed receipts are reusable; incomplete attempts require a new calibration.
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
