import fs from 'node:fs';
// Some Windows filesystem brokers support Node's portable realpath algorithm
// but return EPERM from GetFinalPathNameByHandle. Keep normal native behavior
// elsewhere; the fallback still performs the same filesystem access checks.
if(process.platform==='win32'){
  const native=fs.realpathSync.native;
  try{native(process.cwd());}catch(error){
    if(error.code!=='EPERM')throw error;
    fs.realpathSync.native=function(file,options){try{return native(file,options);}catch(e){if(e.code!=='EPERM')throw e;return fs.realpathSync(file,options);}};
  }
}
