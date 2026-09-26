const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {dispatch}=require('../node/engine.cjs');
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
