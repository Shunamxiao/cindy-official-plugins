const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const {service}=require('../node/online.cjs'),{within,files,runCommand}=require('../node/engine.cjs');
const url='https://github.com/makecindy/eval-bank/releases/download/test/index.json';
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(root){const name='a'.repeat(64)+'.zip',index={format:'eval-lab-online-v1',platform:'darwin-arm64',questions:[{key:'fixture@v1',path:'questions/fixture',files:{},layers:[{artifact:name,mount:''}]}],artifacts:{[name]:{url:url.replace('index.json',name),bytes:1,expandedBytes:1,sha256:'a'.repeat(64)}}},text=JSON.stringify(index);return {id:digest(text),svc:service({base:async()=>root,within,files,runCommand,fetchFile:async(u,d)=>{await fs.writeFile(d,text);return {sha256:digest(text)};}})};}
test('offline cache isolates damaged entries and an online check repairs the same index',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'index-recovery-'));
 try{const {svc,id}=fixture(root),valid=await svc.inspect({root,url});
  for(const [i,text] of ['{truncated','null',JSON.stringify({url,index:{format:'invalid'}}),JSON.stringify({url:url.replace('/test/','/other/'),index:null})].entries()){
   const dir=path.join(root,'online/indices',String(i).repeat(64));await fs.mkdir(dir);await fs.writeFile(path.join(dir,'index.json'),text);
  }
  assert.deepEqual((await svc.cached({root,url})).questions,valid.questions);
  const target=path.join(root,'online/indices',id,'index.json');await fs.writeFile(target,'{partial');
  assert.deepEqual(await svc.cached({root,url}),{questions:[]});
  await svc.inspect({root,url});assert.deepEqual((await svc.cached({root,url})).questions,valid.questions);
  assert.equal((await svc.plan({root,indexId:id,question:'fixture@v1'})).artifacts.length,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('partial index writes leave published data intact, preserve storage error codes and clean temp files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'index-write-')),write=fs.writeFile;
 try{const {svc,id}=fixture(root);await svc.inspect({root,url});const dest=path.join(root,'online/indices',id),target=path.join(dest,'index.json'),before=await fs.readFile(target,'utf8');
  for(const code of ['ENOSPC','EACCES']){
   fs.writeFile=async(p,...args)=>{if(String(p).endsWith('.tmp')){await write(p,'{partial');throw Object.assign(Error('PRIVATE disk path'),{code});}return write(p,...args);};
   await assert.rejects(svc.inspect({root,url}),e=>e.code===code&&/磁盘空间.*存储权限/.test(e.message)&&!e.message.includes('PRIVATE'));
   assert.equal(await fs.readFile(target,'utf8'),before);assert.deepEqual(await fs.readdir(dest),['index.json']);
  }
 }finally{fs.writeFile=write;await fs.rm(root,{recursive:true,force:true});}
});
test('download sink errors retain actionable storage diagnostics',async()=>{
 const source=await fs.readFile(path.join(__dirname,'../node/online.cjs'),'utf8'),{EventEmitter}=require('node:events'),{Readable,Writable}=require('node:stream');
 for(const code of ['ENOSPC','EACCES','EDQUOT']){
  const module={exports:{}};vm.runInNewContext(source,{module,require:id=>id==='node:https'?{get:(u,o,cb)=>{const req=new EventEmitter();req.setTimeout=()=>{};process.nextTick(()=>{const s=Readable.from(['data']);s.statusCode=200;cb(s);});return req;}}:id==='node:fs'?{...require(id),createWriteStream:()=>new Writable({write(c,e,done){done(Object.assign(Error('PRIVATE output'),{code,syscall:'write'}));}})}:require(id),setTimeout,clearTimeout,URL,AbortController});
  await assert.rejects(module.exports.download(url,'unused',100),e=>e.code===code&&/磁盘空间/.test(e.message)&&!e.message.includes('PRIVATE'));
 }
});
test('Node operations heartbeat until resolve or reject and never emit heartbeat on stdout',async()=>{
 const source=await fs.readFile(path.join(__dirname,'../node/worker.cjs'),'utf8');
 for(const method of ['grade','calibrate','online_install','prepare'])for(const fail of [false,true]){
  let line,tick,resolve,reject,cleared=false;const stderr=[],stdout=[],pending=new Promise((a,b)=>{resolve=a;reject=b;});
  vm.runInNewContext(source,{require:id=>id==='node:readline'?{createInterface:()=>({on:(name,fn)=>{line=fn;}})}:{dispatch:()=>pending},process:{stdin:{},stderr:{write:s=>stderr.push(s)},stdout:{write:s=>stdout.push(s)}},setInterval:(fn,ms)=>{assert.equal(ms,10000);tick=fn;return 1;},clearInterval:()=>{cleared=true;}});
  const running=line(JSON.stringify({id:1,method}));tick();assert.equal(stderr.length,1);assert.equal(stdout.length,0);assert.equal(cleared,false);
  fail?reject(Error('failed')):resolve({ok:true});await running;assert.equal(cleared,true);assert.equal(stdout.length,1);assert.equal(JSON.parse(stdout[0]).id,1);
 }
});
