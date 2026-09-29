'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const scopeLimit=()=>Error('题包公开任务范围超过宿主上限，无法完整登记；请缩短范围说明，不会截断限制。');
async function readScope(file){
 const handle=await fs.open(file,'r');
 try{
  // UTF-8 uses at most four bytes per code point; one extra byte detects overflow.
  const buffer=Buffer.alloc(8000*4+1);let size=0;
  while(size<buffer.length){const {bytesRead}=await handle.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}
  if(size===buffer.length)throw scopeLimit();
  return buffer.subarray(0,size).toString('utf8');
 }finally{await handle.close();}
}
// Called only after distribution hashes are verified. Never read the mutable answer workspace.
async function taskScope(candidate,prompt){
 const parts=[prompt,'以下是题包给作答者的公开范围说明。环境说明明确要求的编辑探针属于允许的验证步骤；其余原有测试和运行环境保持只读。'];
 for(const name of ['TASK.md','ENVIRONMENT.md']){
  try{parts.push(name+'\n'+await readScope(path.join(candidate,name)));}
  catch(e){if(e.code!=='ENOENT')throw e;}
 }
 const value=parts.join('\n\n');
 if(value.length>8000)throw scopeLimit();
 return value;
}
module.exports={taskScope};
