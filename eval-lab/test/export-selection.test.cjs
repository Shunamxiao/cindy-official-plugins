const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('share action exports only the selected valid results, excluding failed attempts',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../view.js'),'utf8');
 const action=source.split('\n').find(line=>line.startsWith("bind('#export',"));
 let click,request;
 vm.runInNewContext(action,{
  bind:(_,fn)=>click=fn,standingsRows:[{details:[{records:[{runId:'failed'},{runId:'old'},{runId:'valid'}],selected:[{runId:'valid'}]}]}],
  state:{banks:[{id:'bank',name:'Fixture'}]},historyBankId:'bank',scoreMode:'latest',standingsQuestions:[],
  rpc:async(_,args)=>{request=args;return {saved:true};},message:()=>{},Set,
 });
 await click();assert.deepEqual(Array.from(request.runIds),['valid']);
});
