const fs=require('node:fs/promises'),path=require('node:path');
process.once('message',async({method,p,filename})=>{
 const link=fs.link;
 fs.link=async(a,b)=>{if(path.basename(b)===filename){process.send('paused');await new Promise(()=>{});}return link(a,b);};
 try{await require('../../node/engine.cjs').dispatch(method,p);}catch(e){process.send({error:e.message});process.exitCode=1;process.disconnect();}
});
