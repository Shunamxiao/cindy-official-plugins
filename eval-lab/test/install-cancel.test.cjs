const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const {service}=require('../node/online.cjs'),{within,files,runCommand}=require('../node/engine.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('cancel drains the unpack process, removes staging, preserves installed banks and permits retry',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'install-cancel-'));
 try{
  const src=path.join(root,'source');await fs.mkdir(src);await fs.writeFile(path.join(src,'question.json'),JSON.stringify({id:'fixture',revision:'v1',scoringVersion:'v1',title:'Fixture',groups:[{id:'core',weight:'1',mode:'all',items:['a']}]}));
  const archive=path.join(root,'archive.zip');cp.execFileSync('python3',['-c',"import zipfile,sys;z=zipfile.ZipFile(sys.argv[2],'w');z.write(sys.argv[1],'question.json');z.close()",path.join(src,'question.json'),archive]);
  const bytes=await fs.readFile(archive),sha=hash(bytes),name=sha+'.zip',url='https://github.com/makecindy/eval-bank/releases/download/test/index.json';
  const question={key:'fixture@v1',revision:'v1',path:'questions/fixture/v1',files:await files(src),layers:[{artifact:name,mount:''}]};
  const index={format:'eval-lab-online-v1',platform:'darwin-arm64',questions:[question],artifacts:{[name]:{url:url.replace('index.json',name),sha256:sha,bytes:bytes.length,expandedBytes:(await fs.stat(path.join(src,'question.json'))).size}}};
  let phase='unpack',started,release;
  let ready=new Promise(r=>started=r),barrier=new Promise(r=>release=r);
  const marker=path.join(root,'child-ready');
  const svc=service({platform:'darwin',arch:'arm64',base:async()=>root,within,
   files:async(...args)=>{if(phase==='verify'&&args[0].includes('staging-')){started();await barrier;}return files(...args);},
   fetchFile:async(_,dest)=>{const b=Buffer.from(JSON.stringify(index));await fs.writeFile(dest,b);return {sha256:hash(b),bytes:b.length};},
   runCommand:async(command,args,options)=>{
    if(phase!=='unpack'||args[0]==='-I')return runCommand(command,args,options);
    const running=runCommand('python3',['-c',"import pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text('ready');time.sleep(30)",marker],options);
    for(let i=0;i<200;i++){try{await fs.stat(marker);started();break;}catch{await new Promise(r=>setTimeout(r,10));}}
    return running;
   }});
  const inspected=await svc.inspect({root,url});
  const params={root,indexId:inspected.indexId,question:question.key,hostArtifacts:{[sha]:archive}};
  const old=path.join(root,'online/banks','f'.repeat(64));await fs.mkdir(old,{recursive:true});await fs.writeFile(path.join(old,'keep'),'existing');
  for(const target of ['unpack','verify']){
   phase=target;ready=new Promise(r=>started=r);barrier=new Promise(r=>release=r);
   const operation=svc.begin({root}),running=svc.install({...params,...operation});
   const rejected=assert.rejects(running,/取消|abort/i);await ready;
   let cancelled=false;const cancelling=svc.cancel({root,...operation}).then(()=>{cancelled=true;});
   if(target==='verify'){await Promise.resolve();assert.equal(cancelled,false);release();}
   await cancelling;await rejected;
   assert.equal((await fs.readdir(path.join(root,'online'))).some(x=>x.startsWith('staging-')),false);
   assert.deepEqual(await fs.readdir(path.join(root,'online/banks')),['f'.repeat(64)]);
   assert.equal(await fs.readFile(path.join(old,'keep'),'utf8'),'existing');
  }
  const early=svc.begin({root});await svc.cancel({root,...early});assert.throws(()=>svc.install({...params,...early}),/取消/);
  phase='normal';const result=await svc.install({...params,...svc.begin({root})});assert.ok(await fs.stat(result.bank));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
