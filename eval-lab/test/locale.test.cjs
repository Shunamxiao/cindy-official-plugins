const {test}=require('node:test'),assert=require('node:assert/strict');
const {translate}=require('../i18n.js'),{report}=require('../lib/core.cjs'),standings=require('../lib/standings-report.cjs');
test('all static accessible names follow Host locale while ARIA references remain identifiers',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 const html=fs.readFileSync(path.join(__dirname,'../main-view.html'),'utf8'),code=fs.readFileSync(path.join(__dirname,'../i18n.js'),'utf8');
 for(const locale of ['zh-CN','en','ja','ko']){
  const elements=[...html.matchAll(/(aria-label|aria-labelledby|placeholder|title|alt)="([^"]*)"/g)].map(([,key,value])=>({key,original:value,value,getAttribute(k){return k===this.key?this.value:null;},setAttribute(k,v){if(k===this.key)this.value=v;}}));
  const context={window:{},fetch:async()=>({json:async()=>({context:{locale}})}),NodeFilter:{SHOW_TEXT:4},document:{documentElement:{},body:{},createTreeWalker:()=>({nextNode:()=>false}),querySelectorAll:selector=>elements.filter(e=>selector.includes('['+e.key+']'))}};
  vm.runInNewContext(code,context);await context.window.evalLocaleReady;
  for(const e of elements){if(locale==='zh-CN'||e.key==='aria-labelledby')assert.equal(e.value,e.original);else assert.doesNotMatch(e.value,/[\u3400-\u9fff]/,e.key+': '+e.original);}
 }
});
test('status polling does not wait for a hanging locale request',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),code=fs.readFileSync(require('node:path').join(__dirname,'../view.js'),'utf8');let calls=0;
 const context={window:{evalLocaleReady:new Promise(()=>{})},document:{hidden:false},refresh:async()=>{calls++;}};
 vm.runInNewContext(code.slice(code.indexOf('async function syncProgress(){'),code.indexOf('\nsyncProgress();')),context);
 context.syncProgress();context.syncProgress();await Promise.resolve();assert.equal(calls,2);
});
test('browser dates follow Host language with English fallback',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 for(const locale of ['zh-CN','en','ja','ko']){
  const context={window:{},fetch:async()=>({json:async()=>({context:{locale}})}),document:{documentElement:{},body:{},createTreeWalker:()=>({nextNode:()=>false}),querySelectorAll:()=>[]},NodeFilter:{SHOW_TEXT:4},Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../i18n.js'),'utf8'),context);await context.window.evalLocaleReady;
  const code=fs.readFileSync(path.join(__dirname,'../view.js'),'utf8');vm.runInNewContext(code.match(/^const dateText=.*$/m)[0]+';result=dateText(1700000000000);',context);
  assert.equal(context.result,new Date(1700000000000).toLocaleDateString(locale==='zh-CN'?'zh-CN':'en'));
 }
});
test('dynamic batch messages, parameterized counts and diagnostic prefixes use English fallback',()=>{
 for(const text of ['Worker 实际配置或目录不匹配，未计分','本批已结束；环境受阻的作答不计入正式总分。','宿主正在核对执行结果；不会重复发送，也不会计为零分。','等待自动审批或用户确认']){
  assert.equal(translate('zh-CN',text),text);assert.doesNotMatch(translate('ja',text),/[\u3400-\u9fff]/);
 }
 assert.equal(translate('en','{count} 份同时作答',{count:3}),'3 concurrent answers');
 assert.equal(translate('zh-CN','{count} 份同时作答',{count:3}),'3 份同时作答');
 assert.equal(translate('en','评分受阻：ENOENT <file>'),'Grading blocked: ENOENT <file>');
 assert.equal(translate('en','Custom 中文 diagnostic'),'Custom 中文 diagnostic');
});
test('both report formats localize labels while preserving scores, escaping and sanitized diagnostics',()=>{
 const q={questionId:'q',title:'User <title>',revision:'v1',releaseHash:'r',distributionHash:'d'};
 const rows=[{...q,runId:'a',model:'<model>',status:'graded',scoreExact:'1/2',gradedAt:'2026-01-01'}, {...q,runId:'b',model:'<model>',status:'environment_invalid',reason:'private-token /secret',gradedAt:'2026-01-02'}];
 for(const locale of ['en','zh-CN','ko']){
  const html=report(rows,locale),board=standings(rows,{title:'User <bank>',questions:[q,{...q,questionId:'missing'}],mode:'average',locale});
  for(const output of [html,board]){assert.match(output,locale==='zh-CN'?/lang="zh-CN"/:/lang="en"/);assert.doesNotMatch(output,/private-token|\/secret|<model>|<bank>/);assert.match(output,/&lt;model&gt;/);if(locale!=='zh-CN')assert.doesNotMatch(output,/[\u3400-\u9fff]/);}
  assert.match(html,/1\/2/);assert.match(board,/0.50/);assert.match(html,locale==='zh-CN'?/详细诊断保留在本地/:/Detailed diagnostics remain local/);
 }
 assert.match(report([{...rows[0],title:'评测成绩'}],'en'),/评测成绩/,'user title is not translated');
});
test('production job rendering translates persisted batch messages and every active answer',()=>{
 const fs=require('node:fs'),vm=require('node:vm');const code=fs.readFileSync(require('node:path').join(__dirname,'../view.js'),'utf8');const elements=new Map();
 const $=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
 const item={question:'custom',model:'Model',status:'running',waitReason:'等待自动审批或用户确认',error:'评分受阻：<diagnostic>'};
 vm.runInNewContext(code.slice(code.indexOf('function renderJob(){'),code.indexOf('\nasync function refresh()'))+';renderJob();',{$,state:{banks:[],job:{status:'running',phase:'answering',message:'部分作答受阻，已有成绩已保存。',items:[item,{...item}]}},dismissedJobId:null,busy:false,tr:(text,params)=>translate('en',text,params),esc:x=>String(x).replaceAll('<','&lt;').replaceAll('>','&gt;'),settledStatus:()=>false,questionTitle:()=> 'User question',modelTitle:()=> 'Model',elapsed:()=> 'Waiting'});
 assert.match($('#current-stage').textContent,/2 concurrent answers/);assert.match($('#job-note').textContent,/Some answers are blocked/);
 assert.match($('#job-items').innerHTML,/Grading blocked: &lt;diagnostic&gt;/);assert.match($('#active-tests').innerHTML,/Waiting for automatic review/);
 for(const value of elements.values())assert.doesNotMatch((value.textContent||'')+(value.innerHTML||''),/[\u3400-\u9fff]/);
});
test('Node export dispatch passes the requested locale to both actual report formats',async()=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{dispatch}=require('../node/engine.cjs');const root=await fs.mkdtemp(path.join(os.tmpdir(),'eval-locale-'));
 try{
  const run={runId:'sample',questionId:'q',title:'Question',revision:'v1',releaseHash:'r',distributionHash:'d',model:'Model',status:'graded',scoreExact:'1'};
  const dir=path.join(root,'eval-lab-data/runs/sample');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(run));
  for(const locale of ['en','zh-CN'])for(const standings of [undefined,{title:'Bank',mode:'latest',questions:[run]}]){
   const {html}=await dispatch('export',{root,runIds:['sample'],locale,standings});assert.match(html,locale==='en'?/lang="en"/:/lang="zh-CN"/);assert.match(html,locale==='en'?/Cost USD/:/费用 USD/);
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('default bank display and export title follow locale without translating user bank names',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),code=fs.readFileSync(require('node:path').join(__dirname,'../view.js'),'utf8');
 for(const locale of ['zh-CN','en','ja','ko']){
  const elements=new Map(),calls=[],$=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};let exportAction;
  const context={$,refreshing:false,state:{models:[]},bankId:'default',modelStamp:'[]',picks:new Map(),tr:t=>translate(locale,t),esc:String,summary(){},history(){},renderJob(){},message(){},renderModels(){},historyBankId:'default',standingsRows:[],standingsQuestions:[],scoreMode:'latest',bind:(id,fn)=>{exportAction=fn;},rpc:async(action,args)=>{calls.push({action,args});return action==='status'?{banks:[{id:'default',name:'Cindy 实战题库',questions:[]},{id:'imported:user',name:'Cindy 实战题库',questions:[]}],models:[],drafts:[],runs:[]}:{saved:true};}};
  context.bank=()=>context.state.banks.find(b=>b.id===context.bankId);
  vm.runInNewContext(code.slice(code.indexOf('async function refresh(){'),code.indexOf('\nfunction bind(')),context);await context.refresh();
  const expected=locale==='zh-CN'?'Cindy 实战题库':'Cindy Practical Evaluation Bank';
  assert.equal(context.state.banks[0].name,expected);assert.equal(context.state.banks[1].name,'Cindy 实战题库');
  assert.ok($('#bank').innerHTML.includes(expected));
  vm.runInNewContext(code.match(/^bind\('#export'.*$/m)[0],context);await exportAction();
  assert.equal(calls.at(-1).args.standings.title,expected);
 }
});
