import { spawnSync } from 'node:child_process';
const root=process.cwd();
function run(args){const result=spawnSync(process.execPath,args,{stdio:'inherit',cwd:root,env:process.env});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
// The local runtime uses Node SQLite. Hosted deployments keep the same D1 store.
run(['scripts/run-framework.mjs','build']);
run(['scripts/server.mjs','--init-db']);
console.log('\nBanco local preparado. Execute npm run dev e abra a URL exibida.');
