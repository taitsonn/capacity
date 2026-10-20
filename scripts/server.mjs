import http from 'node:http';
import { registerHooks } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openLocalDatabase } from './sqlite-d1.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const initOnly = process.argv.includes('--init-db');
const entry = path.join(root, 'dist/server/index.js'), clientRoot = path.join(root, 'dist/client');
const port = Number(process.env.PORT || 5173), host = '0.0.0.0';
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 ou superior para executar o servidor SQLite local.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve ser uma porta entre 1 e 65535.');
if (!initOnly && !existsSync(entry)) { console.error('Build não encontrado. Execute npm run build antes de iniciar a aplicação.'); process.exit(1); }
const filename = process.argv.includes('--smoke')?':memory:':path.resolve(root, process.env.CAPACITY_DB_PATH || '.data/capacity.sqlite');
const localDatabase = openLocalDatabase(filename, path.join(root, 'drizzle'));
if (initOnly) { localDatabase.close(); console.log(`Banco SQLite inicializado e migrações aplicadas: ${filename}`); process.exit(0); }

const mime = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };
function inside(base, target) { const relative = path.relative(base, target); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
async function staticAsset(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  let pathname; try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Caminho inválido', { status: 400 }); }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return new Response('Não encontrado', { status: 404 });
  const target = path.resolve(clientRoot, `.${pathname}`); if (!inside(clientRoot, target)) return new Response('Não encontrado', { status: 404 });
  try {
    if (!(await stat(target)).isFile() || !inside(realpathSync(clientRoot), realpathSync(target))) return null;
    const data = request.method === 'HEAD' ? null : await readFile(target);
    return new Response(data, { headers: { 'Content-Type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': pathname.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}
const localSetupToken=randomBytes(32).toString('hex');
const environment = { DB: localDatabase.binding, CAPACITY_LOCAL_SETUP_TOKEN:localSetupToken, ASSETS: { async fetch(input) { return await staticAsset(input instanceof Request ? input : new Request(input)) || new Response('Não encontrado', { status: 404 }); } } };
globalThis.__capacityLocalEnv = environment;
registerHooks({ resolve(specifier, context, next) { if (specifier === 'cloudflare:workers') return { url: 'capacity-local:bindings', shortCircuit: true }; return next(specifier, context); }, load(url, context, next) { if (url === 'capacity-local:bindings') return { format: 'module', source: 'export const env = globalThis.__capacityLocalEnv;', shortCircuit: true }; return next(url, context); } });
process.env.NODE_ENV = 'production';
const worker = (await import(pathToFileURL(entry).href)).default;
if (typeof worker?.fetch !== 'function') throw new Error('O build não exporta um handler fetch compatível. Execute npm run build novamente.');
const pending = new Set();
function waitUntil(task) { const promise = Promise.resolve(task).catch(error => console.error('Tarefa em segundo plano:', error)).finally(() => pending.delete(promise)); pending.add(promise); }

if(process.argv.includes('--smoke')){
  let cookie='';
  const probe=async(url,options={})=>{const headers={'x-capacity-local-setup':localSetupToken,...(cookie?{cookie}:{}),...options.headers};const request=new Request(`http://${host}:${port}${url}`,{...options,headers});const response=await staticAsset(request)||await worker.fetch(request,environment,{props:{},waitUntil,passThroughOnException(){}});if(response.status!==200)throw new Error(`${url}: HTTP ${response.status}`);return response;};
  try{
    const html=await(await probe('/')).text();const session=await(await probe('/api/session')).json();if(session.session!==null||!session.needsSetup)throw new Error('A aplicação deve iniciar na tela de login/configuração.');
    const setup=await probe('/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Smoke Admin',username:'smoke-admin',password:randomBytes(24).toString('hex')})});cookie=setup.headers.get('set-cookie').split(';')[0];
    const state=await(await probe('/api/state')).json();
    if(!state.state?.employees?.length||state.session?.role!=='admin')throw new Error('Estado ou sessão inválido.');
    const assets=[...html.matchAll(/(?:src|href)="(\/_next\/[^"?#]+\.(?:js|css))"/g)].map(m=>m[1]);
    if(!assets.length)throw new Error('HTML não contém os bundles de cliente.');
    for(const asset of new Set([...assets,'/favicon.svg','/spread-logo-white.svg','/fonts/dm-sans-latin.woff2','/fonts/outfit-latin.woff2']))await probe(asset);
    // Exercise the compiled write API and the exact capacity calculation used by
    // the dashboard; all accounts and mutations remain in the in-memory database.
    const {typeCapacity}=await import('../lib/type-capacity.ts');
    const {addDays,zoned,weekStart}=await import('../lib/time.ts');
    const {getAvailability}=await import('../lib/engine.ts');
    const smokeDate=addDays(state.state.demands.map(d=>d.date).sort().at(-1),28);
    const people=state.state.employees.filter(e=>e.active&&e.journey==='day').slice(0,2);
    if(people.length!==2)throw new Error('O smoke de alocação exige duas pessoas diurnas de demonstração.');
    const start=zoned(smokeDate,'09:00',state.state.settings.timezone),end=zoned(smokeDate,'11:00',state.state.settings.timezone);
    const demand={id:'smoke-capacity-cycle',code:'SMOKE-CAP',title:'Validação de atualização do painel',type:'BSIM',project:'',requester:'',priority:'medium',date:smokeDate,start,end,required:2,status:'planning',notes:'',allocations:people.map((person,index)=>({id:`smoke-person-${index}`,employeeId:person.id,start,end}))};
    const baseline=typeCapacity(state.state,smokeDate,smokeDate);
    let snapshot=state.state;
    const writeEntity=async(entity,data,action='upsert')=>{snapshot=(await(await probe('/api/mutate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity,action,data,revision:snapshot.revision})})).json()).state;};
    const save=async(data,action='upsert')=>{await writeEntity('demand',data,action);return typeCapacity(snapshot,smokeDate,smokeDate);};
    const planned=await save(demand);
    if(planned.committed!==baseline.committed||planned.free!==baseline.free||planned.reserved!==baseline.reserved+4)throw new Error('Reservar duas pessoas por duas horas deve acrescentar 4h às reservas.');
    const confirmed=await save({...demand,status:'confirmed'});
    if(confirmed.committed!==baseline.committed+4||confirmed.free!==baseline.free-4||confirmed.reserved!==baseline.reserved)throw new Error('Confirmar a alocação deve transferir 4h para comprometidas e descontar 4h das livres.');
    const removed=await save({id:demand.id},'delete');
    if(removed.committed!==baseline.committed||removed.free!==baseline.free)throw new Error('Remover a demanda deve restaurar a capacidade livre.');
    const smokeWeek=weekStart(smokeDate,snapshot.settings.weekStartsOn),weekEnd=addDays(smokeWeek,6);
    const chg=()=>typeCapacity(snapshot,smokeWeek,weekEnd,'CHG');
    const quota=chg().weeklyPlanning.find(value=>value.weekStart===smokeWeek);
    if(quota?.regular!==30||quota.extraQuota!==24||quota.total!==54)throw new Error('A capacidade semanal CHG inicial deve ser 30h regulares + 24h de cota extraordinária.');
    const nightPerson=snapshot.employees.find(person=>person.name==='Lucas Cordeiro');
    const nightStart=zoned(smokeDate,'23:00',snapshot.settings.timezone),nightEnd=zoned(addDays(smokeDate,1),'05:00',snapshot.settings.timezone);
    const late=getAvailability(snapshot,nightPerson.id,zoned(addDays(smokeDate,1),'02:00',snapshot.settings.timezone),nightEnd);
    if(!late.available)throw new Error('02h–05h faz parte da jornada 23h–05h de Lucas e não deve gerar descanso falso.');
    const nightDemand={...demand,id:'smoke-night',code:'SMOKE-NIGHT',title:'CHG noturna regular',type:'CHG',start:nightStart,end:nightEnd,required:1,status:'confirmed',allocations:[{id:'smoke-night-person',employeeId:nightPerson.id,start:nightStart,end:nightEnd}]};
    await writeEntity('demand',nightDemand);
    if(chg().committed!==6||chg().planningFree!==48)throw new Error('Uma CHG regular de 6h deve comprometer 6h e deixar 48h do orçamento semanal planejável.');
    await writeEntity('demand',{id:nightDemand.id},'delete');
    const extraDate=addDays(smokeWeek,2),returnDate=addDays(extraDate,1);
    const priorAdjustment={id:'smoke-before-extra',employeeId:people[0].id,date:extraDate,kind:'override',startTime:'09:00',endTime:'12:00',approved:true,note:'Ajuste anterior à CHG para assegurar 11 horas de descanso.'};
    const extra={id:'smoke-extra',employeeId:people[0].id,date:extraDate,kind:'extra',startTime:'23:00',endTime:'05:00',approved:true,note:'Janela extraordinária de teste em memória.'};
    await writeEntity('exception',priorAdjustment);await writeEntity('exception',extra);
    const activated=chg(),activatedQuota=activated.weeklyPlanning.find(value=>value.weekStart===smokeWeek);
    if(activated.confirmed!==36||activated.planningTotal!==54||activatedQuota.extraActivated!==6||activatedQuota.extraQuotaRemaining!==18)throw new Error('Aprovar uma extra deve consumir 6h da cota sem aumentar o total semanal de 54h.');
    const beforeReturn=getAvailability(snapshot,people[0].id,zoned(returnDate,'09:00',snapshot.settings.timezone),zoned(returnDate,'10:00',snapshot.settings.timezone));
    const afterReturn=getAvailability(snapshot,people[0].id,zoned(returnDate,'16:00',snapshot.settings.timezone),zoned(returnDate,'18:00',snapshot.settings.timezone));
    if(beforeReturn.available||!beforeReturn.issues.some(value=>value.code==='MIN_REST')||!afterReturn.available)throw new Error('Depois de terminar às 05h, o diurno deve retornar somente às 16h e poder trabalhar até 18h.');
    await writeEntity('exception',{id:extra.id},'delete');await writeEntity('exception',{id:priorAdjustment.id},'delete');
    for(const format of ['xlsx','pdf']){const response=await probe(`/api/export?format=${format}`);if((await response.arrayBuffer()).byteLength<100)throw new Error('Relatório vazio.');}
    await probe('/api/auth',{method:'DELETE'});cookie='';if((await(await probe('/api/session')).json()).session!==null)throw new Error('Logout deve remover a sessão.');
    console.log(`Smoke aprovado: login, bootstrap/logout, API, ciclo de alocacao 4h, CHG 30+24=54h, Lucas 23h-05h sem descanso falso, cota extra sem duplicacao e retorno diurno 16h-18h, ${new Set(assets).size} bundles, favicon, logo, fontes locais, Excel e PDF; ${state.state.employees.length} colaboradores e ${state.state.demands.length} demandas. Banco temporario em memoria.`);
  }finally{await Promise.allSettled([...pending]);localDatabase.close();}
  process.exit(0);
}

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const expectedHost = incoming.headers.host || `${host}:${port}`;
    // Permite acesso local e hosts explicitamente autorizados.
    const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...(process.env.ALLOWED_HOSTS || '') .split(',') .map(value => value.trim().toLowerCase()).filter(Boolean) ]);
    if (!allowedHosts.has(expectedHost.toLowerCase())) { outgoing.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'}); outgoing.end('Host inválido. Acesse pelo endereço autorizado.'); return;}
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) { if (name.toLowerCase().startsWith('oai-') || name.toLowerCase().startsWith('x-forwarded-') || name.toLowerCase().startsWith('x-capacity-') || value === undefined) continue; if (Array.isArray(value)) for (const item of value) headers.append(name, item); else headers.set(name, value); }
    headers.set('x-capacity-local-setup',localSetupToken);
    const chunks = []; let size = 0;
    for await (const chunk of incoming.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > 1024 * 1024) { incoming.resume(); outgoing.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }); outgoing.end('Requisição excede o limite de 1 MB.'); return; } chunks.push(chunk); }
    const body = chunks.length ? Buffer.concat(chunks) : undefined, method = incoming.method || 'GET';
    const request = new Request(`http://${expectedHost}${incoming.url || '/'}`, { method, headers, ...(body && !['GET', 'HEAD'].includes(method) ? { body } : {}) });
    const response = await staticAsset(request) || await worker.fetch(request, environment, { props: {}, waitUntil, passThroughOnException() {} });
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => { if (name !== 'set-cookie' && name !== 'transfer-encoding') outgoing.setHeader(name, value); });
    const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
    if (method === 'HEAD' || !response.body) { outgoing.end(); return; }
    await pipeline(Readable.fromWeb(response.body), outgoing);
  } catch (error) { console.error('Erro do servidor local:', error); if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); outgoing.end('Não foi possível atender à requisição. Consulte o terminal.'); }
});
server.requestTimeout = 30_000;
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `A porta ${port} já está em uso. Defina PORT com outra porta disponível.` : error); localDatabase.close(); process.exitCode = 1; });
server.listen(port, host, () => { console.log(`Capacity Manager: http://${host}:${port}`); console.log(`SQLite persistente: ${filename}`); console.log('Entre com seu usuário e senha. No primeiro acesso, configure o administrador na aplicação.'); });
let closing = false;
async function shutdown() { if (closing) return; closing = true; await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...pending]); localDatabase.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
