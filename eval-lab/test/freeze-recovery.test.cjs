const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),{once}=require('node:events');
const script=path.resolve(__dirname,'../node/freeze-publish.py');
function publish(root,entry){return new Promise((resolve,reject)=>cp.execFile('python3',['-I',script,root,entry],e=>e?reject(e):resolve()));}
test('OS lock releases after the manifest writer is killed; a retry preserves old entries and is idempotent',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-freeze-crash-'));
 try{
  const manifest=path.join(root,'distribution.json'),entry=path.join(root,'entry.json');
  const old={format:'eval-lab-bank-v1',questions:[{key:'old@v1',files:{a:'old'}}]},next={key:'new@v1',files:{a:'new'}};
  await fs.writeFile(manifest,JSON.stringify(old));await fs.writeFile(entry,JSON.stringify(next));
  const code="import os,sys,time; original=os.replace\ndef pause(a,b):\n print('paused',flush=True)\n time.sleep(60)\nos.replace=pause\nexec(compile(open(sys.argv[1]).read(),sys.argv[1],'exec'),{'__name__':'__main__'})";
  // The helper expects bank and entry at argv[1:]; load its source before fixing argv.
  const wrapped=code.replace("exec(compile(open(sys.argv[1]).read(),sys.argv[1],'exec'),{'__name__':'__main__'})","source=open(sys.argv[1]).read(); sys.argv=sys.argv[1:]; exec(compile(source,sys.argv[0],'exec'),{'__name__':'__main__'})");
  const child=cp.spawn('python3',['-I','-c',wrapped,script,root,entry],{stdio:['ignore','pipe','pipe']});const closed=once(child,'close');let timer;
  try{await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Publication pause not reached')),10000))]);assert.deepEqual(JSON.parse(await fs.readFile(manifest)),old);await assert.rejects(publish(root,entry));}
  finally{clearTimeout(timer);child.kill('SIGKILL');await closed;}
  await publish(root,entry);assert.deepEqual(JSON.parse(await fs.readFile(manifest)),{...old,questions:[...old.questions,next]});
  const bytes=await fs.readFile(manifest);await publish(root,entry);assert.deepEqual(await fs.readFile(manifest),bytes);
  await fs.writeFile(entry,JSON.stringify({...next,files:{a:'different'}}));await assert.rejects(publish(root,entry));assert.deepEqual(await fs.readFile(manifest),bytes);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
