const {test}=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process'),path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os');
const engine=path.resolve(__dirname,'../node/engine.cjs');
test('missing Python rejects preflight and preparation before creating answer files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-python-'));
 try{
  const result=cp.spawnSync(process.execPath,['-e',"const {dispatch}=require(process.argv[1]);(async()=>{for(const method of ['preflight','prepare']){try{await dispatch(method,{root:process.argv[2]});process.exitCode=1;}catch(e){if(!e.message.includes('Python 3'))throw e;}}})().catch(()=>process.exitCode=2);",engine,root],{env:{...process.env,PATH:root},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(await fs.readdir(root),[]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Python probe rejects nonzero interpreters and accepts successful exit',async()=>{
 const original=cp.spawn,events=require('node:events');
 try{
  for(const code of [1,0]){
   cp.spawn=(command,args)=>{assert.equal(command,'python3');assert.deepEqual(args.slice(0,2),['-I','-c']);const child=new events.EventEmitter();child.stdout=new events.EventEmitter();child.stderr=new events.EventEmitter();queueMicrotask(()=>child.emit('close',code,null));return child;};
   if(code)await assert.rejects(require(engine).dispatch('preflight',{}),/Python 3/);else assert.deepEqual(await require(engine).dispatch('preflight',{}),{ok:true});
  }
 }finally{cp.spawn=original;}
});
