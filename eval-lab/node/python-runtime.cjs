'use strict';
const unavailable=()=>Object.assign(Error('Python 3 无法运行，请安装 Python 3 并确保 Cindy 的 PATH 能找到 python3，重启 Cindy 后重试；已有作答和成绩保留。'),{code:'PYTHON_UNAVAILABLE'});
async function preflight(runCommand){
 const r=await runCommand('python3',['-I','-c','import sys; sys.exit(0 if sys.version_info.major == 3 else 1)'],{timeout:10000});
 if(r.code!==0||r.timedOut)throw unavailable();
 return {ok:true};
}
module.exports={preflight,unavailable};
