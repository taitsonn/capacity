import { registerHooks } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { openLocalDatabase } from './sqlite-d1.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const outputIndex=process.argv.indexOf('--output');
const filename=path.resolve(root,outputIndex>=0?process.argv[outputIndex+1]:'demo/capacity-demo.sqlite');
if(existsSync(filename)){console.log('Banco demonstrativo já existe; nenhuma alteração realizada.');process.exit(0);}
mkdirSync(path.dirname(filename),{recursive:true});
const database=openLocalDatabase(filename,path.join(root,'drizzle'));
globalThis.__capacityDemoEnv={DB:database.binding};
registerHooks({
 resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'capacity-demo:env',shortCircuit:true};if(specifier.startsWith('.')){const url=new URL(specifier,context.parentURL);if(!path.extname(url.pathname)&&existsSync(fileURLToPath(url.href+'.ts')))return next(url.href+'.ts',context);}return next(specifier,context);},
 load(url,context,next){if(url==='capacity-demo:env')return {format:'module',source:'export const env = globalThis.__capacityDemoEnv;',shortCircuit:true};return next(url,context);}
});
try{const {getState}=await import(pathToFileURL(path.join(root,'lib/store.ts')).href);const state=await getState();console.log(`Banco demonstrativo: ${state.employees.length} colaboradores, ${state.demands.length} demandas; nenhum usuário ou senha cadastrado.`);}finally{database.close();}
