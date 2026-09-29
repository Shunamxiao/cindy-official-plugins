'use strict';
const fs=require('node:fs/promises');
// Match the online index budget; archive/workspace limits do not apply to JSON metadata.
const limit=16*1024*1024;
const invalid=()=>Object.assign(Error('Question metadata exceeds 16 MiB; reduce the metadata file.'),{code:'PACKAGE_INVALID'});
module.exports=async function readMetadata(file){
 const handle=await fs.open(file,'r');
 try{
  if((await handle.stat()).size>limit)throw invalid();
  const chunks=[];let size=0;
  while(size<=limit){
   const buffer=Buffer.alloc(Math.min(64*1024,limit+1-size));
   const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
   if(!bytesRead)break;
   size+=bytesRead;if(size>limit)throw invalid();chunks.push(buffer.subarray(0,bytesRead));
  }
  return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
 }finally{await handle.close();}
};
