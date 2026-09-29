'use strict';
const unavailable=()=>Object.assign(Error('Python 3 无法运行，请安装 Python 3 并确保 Cindy 的 PATH 能找到 python3，重启 Cindy 后重试；已有作答和成绩保留。'),{code:'PYTHON_UNAVAILABLE'});
function startupError(code){
 if(code==='ENOENT')return unavailable();
 const action=['EACCES','EPERM'].includes(code)?'Check Python execution permissions.':['EMFILE','ENFILE','EAGAIN','ENOMEM'].includes(code)?'Close unused programs to free system resources, then retry.':'Check the Python executable and system resources, then retry.';
 return Object.assign(Error(`Python could not start (${code||'UNKNOWN'}). ${action} Existing answers and results are preserved.`),{code:code||'PYTHON_START_FAILED',pythonStartup:true});
}
async function preflight(runCommand){
 const r=await runCommand('python3',['-I','-c','import sys; sys.exit(0 if sys.version_info.major == 3 else 1)'],{timeout:10000});
 if(r.errorCode)throw startupError(r.errorCode);
 if(r.code!==0||r.timedOut)throw unavailable();
 return {ok:true};
}
module.exports={preflight,unavailable,startupError};
